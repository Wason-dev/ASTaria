import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-task-reopen-'))
  const filename = join(directory, 'test.sqlite')
  const connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  const close = db => { db.close(); connections.delete(db) }
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db: open(), filename, open, close }
}
const conflict = error => error.status === 409
const baseTask = status => ({ title: '物理报告', notes: '已经写好提纲', status, due: '2026-10-01', estimateMin: 105,
  importance: 3, inbox: false, context: ['library'], subSteps: [{ title: '整理数据', done: true }] })
const operationFor = (before, patch = {}) => ({ id: randomUUID(), requestId: randomUUID(), summary: '标记完成',
  changes: [{ table: 'tasks', id: before.id, before, after: { ...before, status: 'done', doneAt: before.updatedAt, ...patch } }] })

function invoke(service, path, payload) {
  return new Promise(resolve => {
    const request = Readable.from([Buffer.from(JSON.stringify(payload))])
    request.url = `/api${path}`
    request.method = 'POST'
    request.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    request.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    const response = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } }
    service.middleware(request, response, () => resolve({ status: 404 }))
  })
}

for (const status of ['todo', 'doing']) {
  test(`manual completion durably reopens to ${status} while preserving task details and schedules`, t => {
    const { db } = fixture(t)
    const before = db.createTask(baseTask(status))
    const assignment = db.saveAssignment({ taskId: before.id, blockId: '2026-09-18:P3', plannedMin: 35, reason: '已有空课安排' })
    const done = db.updateTask(before.id, { status: 'done' })
    const reopened = db.reopenTask(done.id, done.updatedAt)
    assert.equal(reopened.status, status)
    assert.equal(Object.hasOwn(reopened, 'doneAt'), false)
    const { updatedAt: beforeVersion, ...beforeFields } = before
    const { updatedAt: reopenedVersion, ...reopenedFields } = reopened
    assert.deepEqual(reopenedFields, beforeFields)
    assert.ok(Date.parse(reopenedVersion) > Date.parse(done.updatedAt))
    assert.deepEqual(db.listAssignments(), [assignment])
    const history = db.listTaskCompletionHistory(done.id)
    assert.equal(history.length, 1)
    assert.equal(history[0].beforeStatus, status)
    assert.equal(history[0].completionDoneAt, done.doneAt)
    assert.ok(history[0].closedAt)
  })
}

test('AI operations record the prior state and retain idempotency plus operation undo with monotonic versions', t => {
  const { db } = fixture(t)
  const before = db.createTask(baseTask('doing'))
  const input = operationFor(before)
  const inputSnapshot = structuredClone(input)
  const operation = db.applyOperation(input)
  assert.deepEqual(input, inputSnapshot)
  assert.deepEqual(db.applyOperation(input), operation)
  const done = db.getTask(before.id)
  assert.ok(Date.parse(done.updatedAt) > Date.parse(before.updatedAt))
  assert.deepEqual(operation.changes[0].after, done)
  assert.equal(db.listTaskCompletionHistory(done.id).length, 1)
  db.undoOperation(operation.id)
  const undone = db.getTask(before.id)
  assert.equal(undone.status, 'doing')
  assert.equal(undone.doneAt, undefined)
  assert.ok(Date.parse(undone.updatedAt) > Date.parse(done.updatedAt))
  db.applyOperation(operationFor(undone))
  const again = db.getTask(before.id)
  assert.equal(db.reopenTask(again.id, again.updatedAt).status, 'doing')
  assert.equal(db.listTaskCompletionHistory(again.id).length, 2)
})

test('completion history survives deleting its AI conversation and removing operation receipts', t => {
  const { db } = fixture(t)
  const conversation = db.getActiveConversation()
  db.createConversation()
  const before = db.createTask(baseTask('doing'))
  const requestId = randomUUID()
  db.beginTurn({ requestId, conversationId: conversation.id, text: '报告完成了', context: {} })
  db.applyOperation({ ...operationFor(before), requestId })
  db.finishTurn(requestId, { status: 'completed' })
  const done = db.getTask(before.id)
  db.deleteConversation(conversation.id)
  assert.equal(db.listOperations({ requestId }).length, 0)
  assert.equal(db.reopenTask(done.id, done.updatedAt).status, 'doing')
  assert.equal(db.listTaskCompletionHistory(done.id)[0].completionDoneAt, done.doneAt)
})

test('completed-at-creation and pre-feature historical tasks reopen to todo and retain original completion dates', t => {
  const { db, filename } = fixture(t)
  const originallyDone = db.createTask({ title: '已完成任务', status: 'done', doneAt: '2026-09-01T10:00:00+08:00' })
  assert.equal(db.reopenTask(originallyDone.id, originallyDone.updatedAt).status, 'todo')
  assert.equal(db.listTaskCompletionHistory(originallyDone.id)[0].completionDoneAt, originallyDone.doneAt)
  const old = db.createTask({ title: '旧数据', status: 'done', doneAt: '2026-08-01T10:00:00+08:00' })
  // Only this temporary test database is edited to reproduce pre-feature data.
  const raw = new DatabaseSync(filename)
  raw.prepare('DELETE FROM task_completion_history WHERE taskId = ?').run(old.id)
  raw.close()
  assert.equal(db.listTaskCompletionHistory(old.id).length, 0)
  assert.equal(db.reopenTask(old.id, old.updatedAt).status, 'todo')
  const historical = db.listTaskCompletionHistory(old.id)
  assert.equal(historical.length, 1)
  assert.equal(historical[0].completionDoneAt, old.doneAt)
  assert.ok(historical[0].closedAt)
  const dropped = db.createTask(baseTask('dropped'))
  const done = db.updateTask(dropped.id, { status: 'done' })
  assert.equal(db.reopenTask(done.id, done.updatedAt).status, 'todo')
})

test('refresh and independent database connections share the current completion batch', t => {
  const f = fixture(t)
  const task = f.db.createTask(baseTask('doing'))
  const done = f.db.updateTask(task.id, { status: 'done' })
  f.close(f.db)
  const reopenedConnection = f.open(), otherBrowser = f.open()
  assert.equal(reopenedConnection.getTask(task.id).status, 'done')
  const reopened = otherBrowser.reopenTask(done.id, done.updatedAt)
  assert.equal(reopened.status, 'doing')
  assert.deepEqual(reopenedConnection.getTask(task.id), reopened)
  assert.ok(reopenedConnection.listTaskCompletionHistory(task.id)[0].closedAt)
})

test('stale edits, deleted tasks and repeated requests cannot partially reopen a task', t => {
  const { db } = fixture(t)
  const task = db.createTask(baseTask('doing'))
  const done = db.updateTask(task.id, { status: 'done' })
  const edited = db.updateTask(task.id, { notes: '另一窗口刚更新' })
  assert.throws(() => db.reopenTask(done.id, done.updatedAt), conflict)
  assert.deepEqual(db.getTask(task.id), edited)
  assert.equal(db.listTaskCompletionHistory(task.id)[0].closedAt, null)
  const reopened = db.reopenTask(edited.id, edited.updatedAt)
  assert.equal(reopened.notes, '另一窗口刚更新')
  assert.throws(() => db.reopenTask(edited.id, edited.updatedAt), conflict)
  const again = db.updateTask(task.id, { status: 'done' })
  const deleted = db.deleteTask(task.id)
  assert.throws(() => db.reopenTask(deleted.id, deleted.updatedAt), conflict)
  assert.deepEqual(db.getTask(task.id), deleted)
  assert.equal(db.listTaskCompletionHistory(task.id).filter(item => !item.closedAt).length, 1)
  assert.throws(() => db.reopenTask('missing', again.updatedAt), error => error.status === 404)
})

test('old double click never reopens a later AI completion even when it supplies the old timestamp', t => {
  const { db } = fixture(t)
  const task = db.createTask(baseTask('doing'))
  const firstDone = db.updateTask(task.id, { status: 'done' })
  db.reopenTask(task.id, firstDone.updatedAt)
  const todo = db.updateTask(task.id, { status: 'todo' })
  db.applyOperation(operationFor(todo, { updatedAt: firstDone.updatedAt, doneAt: firstDone.doneAt }))
  const secondDone = db.getTask(task.id)
  assert.ok(Date.parse(secondDone.updatedAt) > Date.parse(todo.updatedAt))
  assert.throws(() => db.reopenTask(task.id, firstDone.updatedAt), conflict)
  assert.equal(db.getTask(task.id).status, 'done')
  assert.equal(db.reopenTask(task.id, secondDone.updatedAt).status, 'todo')
  const batches = db.listTaskCompletionHistory(task.id)
  assert.equal(batches.length, 2)
  assert.equal(batches[0].beforeStatus, 'doing')
  assert.equal(batches[1].beforeStatus, 'todo')
  assert.notEqual(batches[0].completionDoneAt, batches[1].completionDoneAt)
})

test('failed multi-task AI operation rolls back both completion and history', t => {
  const { db } = fixture(t)
  const first = db.createTask(baseTask('doing')), second = db.createTask({ title: '第二项' })
  const operation = operationFor(first)
  operation.changes.push({ table: 'tasks', id: second.id, before: null, after: second })
  assert.throws(() => db.applyOperation(operation), conflict)
  assert.deepEqual(db.getTask(first.id), first)
  assert.deepEqual(db.listTaskCompletionHistory(first.id), [])
  assert.equal(db.listOperations().length, 0)
  const done = db.updateTask(first.id, { status: 'done' })
  assert.throws(() => db.transaction(() => { db.reopenTask(done.id, done.updatedAt); throw new Error('rollback') }), /rollback/u)
  assert.deepEqual(db.getTask(done.id), done)
  assert.equal(db.listTaskCompletionHistory(done.id)[0].closedAt, null)
})

test('HTTP reopen enforces exact fields and returns persisted Task without exposing private history', async t => {
  const { db } = fixture(t)
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw new Error('provider must not run') } })
  const task = db.createTask(baseTask('doing'))
  const done = db.updateTask(task.id, { status: 'done' })
  for (const payload of [
    { id: task.id, expectedUpdatedAt: done.updatedAt, status: 'todo' },
    { id: task.id }, { expectedUpdatedAt: done.updatedAt }, { id: task.id, expectedUpdatedAt: 'yesterday' },
  ]) assert.equal((await invoke(service, '/tasks/reopen', payload)).status, 400)
  assert.equal(db.getTask(task.id).status, 'done')
  const response = await invoke(service, '/tasks/reopen', { id: task.id, expectedUpdatedAt: done.updatedAt })
  assert.equal(response.status, 200)
  assert.equal(response.body.status, 'doing')
  assert.deepEqual(response.body, db.getTask(task.id))
  assert.equal(response.body.doneAt, undefined)
  assert.equal(response.body.completionHistory, undefined)
  assert.equal((await invoke(service, '/tasks/reopen', { id: task.id, expectedUpdatedAt: done.updatedAt })).status, 409)
})

test('undo restoring a completed task keeps historical doneAt and the original reopen status', t => {
  const { db, open } = fixture(t)
  const task = db.createTask(baseTask('doing'))
  const done = db.updateTask(task.id, { status: 'done' })
  const after = { ...done, status: 'todo' }
  delete after.doneAt
  const operation = db.applyOperation({ id: randomUUID(), requestId: randomUUID(), summary: '重新排入待办',
    changes: [{ table: 'tasks', id: task.id, before: done, after }] })
  const todo = db.getTask(task.id)
  open().undoOperation(operation.id)
  const restored = db.getTask(task.id)
  assert.equal(restored.status, 'done')
  assert.equal(restored.doneAt, done.doneAt)
  assert.ok(Date.parse(restored.updatedAt) > Date.parse(todo.updatedAt))
  assert.throws(() => db.reopenTask(task.id, done.updatedAt), conflict)
  assert.equal(db.reopenTask(task.id, restored.updatedAt).status, 'doing')
  assert.equal(db.listTaskCompletionHistory(task.id).length, 1)
})

test('monotonic task versions preserve consecutive operation undo while ordinary edits still conflict', t => {
  const { db, open } = fixture(t)
  const task = db.createTask(baseTask('todo'))
  const edit = notes => {
    const before = db.getTask(task.id)
    return db.applyOperation({ id: randomUUID(), requestId: randomUUID(), summary: '更新备注',
      changes: [{ table: 'tasks', id: task.id, before, after: { ...before, notes } }] })
  }
  const first = edit('第一版'), second = edit('第二版')
  db.undoOperation(second.id)
  const afterSecondUndo = db.getTask(task.id)
  assert.equal(afterSecondUndo.notes, '第一版')
  open().undoOperation(first.id)
  assert.equal(db.getTask(task.id).notes, task.notes)
  assert.ok(Date.parse(db.getTask(task.id).updatedAt) > Date.parse(afterSecondUndo.updatedAt))
  const third = edit('第三版'), fourth = edit('第四版')
  db.undoOperation(fourth.id)
  db.updateTask(task.id, { notes: '第三版' })
  assert.throws(() => db.undoOperation(third.id), conflict)
})
