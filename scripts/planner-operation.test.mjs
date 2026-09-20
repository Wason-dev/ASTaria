import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-planner-operation-')), filename = join(directory, 'qa.sqlite')
  const connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db: open(), open }
}
const block = (taskId, patch = {}) => ({ id: randomUUID(), taskId, date: '2026-09-21', start: '18:00', end: '18:35', locked: false, ...patch })
const detail = (patch = {}) => ({ items: ['计算器'], preparation: '整理数据', needsSubmission: true, submittedAt: null, ...patch })
const request = () => ({ requestId: randomUUID(), conversationId: 'main', text: '把报告安排到晚自习', context: {} })
const operation = (db, actions, patch = {}) => ({ id: randomUUID(), requestId: randomUUID(), summary: '已安排报告', actions, expectedRevision: db.getPlanner().revision, ...patch })
const conflict = error => error.status === 409
const invalid = error => error.status === 400

test('AI planner operations produce persistent receipts and undo restores the snapshot with a newer revision', t => {
  const { db, open } = fixture(t), task = db.createTask({ title: '实验报告' })
  const before = db.getPlanner(), proposed = block(task.id)
  const input = operation(db, [{ type: 'save-block', block: proposed }, { type: 'save-details', taskId: task.id, details: detail() }])
  const inputCopy = structuredClone(input), receipt = db.applyPlannerOperation(input)
  assert.deepEqual(input, inputCopy)
  assert.equal(receipt.kind, 'planner'); assert.equal(receipt.undoable, true)
  assert.deepEqual(receipt.changes, []); assert.deepEqual(receipt.plannerBefore, before)
  assert.equal(receipt.plannerAfterRevision, 2)
  assert.deepEqual(db.getPlanner().blocks, [proposed])
  const second = open()
  assert.deepEqual(second.listOperations(), [receipt])
  const undone = second.undoOperation(receipt.id)
  assert.ok(undone.undoneAt)
  assert.deepEqual(db.getPlanner(), { ...before, revision: 3 })
  assert.deepEqual(second.undoOperation(receipt.id), undone)
  assert.equal(db.getPlanner().revision, 3)
})

test('planner operation retries return the original receipt but reject ID reuse with different content', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' }), proposed = block(task.id)
  const input = operation(db, [{ type: 'save-block', block: proposed }]), receipt = db.applyPlannerOperation(input)
  assert.deepEqual(db.applyPlannerOperation(input), receipt)
  assert.equal(db.getPlanner().blocks.length, 1); assert.equal(db.getPlanner().revision, 1)
  for (const patch of [{ expectedRevision: 1 }, { summary: '别的内容' }, { requestId: randomUUID() }, { actions: [{ type: 'delete-block', id: proposed.id }] }]) {
    assert.throws(() => db.applyPlannerOperation({ ...input, ...patch }), conflict)
  }
  db.undoOperation(receipt.id)
  assert.ok(db.applyPlannerOperation(input).undoneAt)
  assert.deepEqual(db.getPlanner().blocks, [])
})

test('planner receipt cannot overwrite later manual changes or stale expected revisions', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' })
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(task.id) }]))
  const later = db.updatePlanner({ type: 'check-item', date: '2026-09-21', key: 'calculator', checked: true }, db.getPlanner().revision)
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner(), later)
  assert.equal(db.listOperations()[0].undoneAt, null)
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: task.id, details: detail() }], { expectedRevision: 0 })), conflict)
  assert.deepEqual(db.getPlanner(), later)
})

test('a conflicting later action rolls back the entire planner batch and its receipt', t => {
  const { db } = fixture(t), first = db.createTask({ title: '甲' }), second = db.createTask({ title: '乙' })
  const before = db.getPlanner()
  assert.throws(() => db.applyPlannerOperation(operation(db, [
    { type: 'save-block', block: block(first.id) },
    { type: 'save-block', block: block(second.id, { start: '18:20', end: '19:00' }) },
  ])), conflict)
  assert.deepEqual(db.getPlanner(), before); assert.deepEqual(db.listOperations(), [])
  assert.throws(() => db.transaction(() => {
    db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: first.id, details: detail() }]))
    throw new Error('outer rollback')
  }), /outer rollback/)
  assert.deepEqual(db.getPlanner(), before); assert.deepEqual(db.listOperations(), [])
})

test('retracted turns cannot schedule new planner operations and existing receipts remain explicitly undoable', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' }), input = request()
  db.beginTurn(input)
  const planned = operation(db, [{ type: 'save-block', block: block(task.id) }], { requestId: input.requestId })
  const receipt = db.applyPlannerOperation(planned)
  db.retractRequest(input)
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: task.id, details: detail() }], { requestId: input.requestId })), conflict)
  assert.throws(() => db.applyPlannerOperation(planned), conflict)
  assert.equal(db.getPlanner().blocks.length, 1)
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner().blocks, [])
})

test('undo refuses to restore task references deleted after their block was removed', t => {
  const { db } = fixture(t), task = db.createTask({ title: '删除任务' }), proposed = block(task.id)
  db.updatePlanner({ type: 'save-block', block: proposed }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: proposed.id }]))
  const revision = db.getPlanner().revision
  db.deleteTask(task.id)
  // No planner reference remains to clean, so revision alone cannot detect this.
  assert.equal(db.getPlanner().revision, revision)
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner().blocks, [])
  assert.equal(db.listOperations()[0].undoneAt, null)
})

test('completed tasks continue occupying recorded blocks and legacy slots; dropped tasks release them', t => {
  const { db } = fixture(t), first = db.createTask({ title: '已完成' }), second = db.createTask({ title: '待开始' }), proposed = block(first.id)
  db.updatePlanner({ type: 'save-block', block: proposed }, 0)
  db.updateTask(first.id, { status: 'done' })
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id) }])), conflict)
  db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: first.id, details: detail({ submittedAt: '2026-09-19T00:00:00Z' }) }]))
  assert.equal(db.getPlanner().details[first.id].submittedAt, '2026-09-19T00:00:00.000Z')
  db.updateTask(first.id, { status: 'dropped' })
  db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id) }]))
  const legacy = db.createTask({ title: '做完的旧安排', status: 'done', startAt: new Date('2026-09-21T20:00:00').toISOString(), estimateMin: 60 })
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id, { start: '20:20', end: '20:40' }) }])), conflict)
  db.updateTask(legacy.id, { status: 'dropped' })
  db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id, { start: '20:20', end: '20:40' }) }]))
})

test('AI planner accepts only bounded permitted actions and preserves locked blocks', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' }), locked = block(task.id, { locked: true })
  db.updatePlanner({ type: 'save-block', block: locked }, 0)
  const before = db.getPlanner()
  for (const actions of [[], Array(9).fill({ type: 'save-details', taskId: task.id, details: detail() }), [{ type: 'import-routines', routines: [] }], [{ type: 'check-item', date: '2026-09-21', key: 'book', checked: true }]]) {
    assert.throws(() => db.applyPlannerOperation(operation(db, actions)), invalid)
  }
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: locked.id }])), conflict)
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: { ...locked, locked: false } }])), conflict)
  assert.deepEqual(db.getPlanner(), before); assert.deepEqual(db.listOperations(), [])
})

for (const association of ['block', 'details']) {
  test(`undoing AI task creation preserves a user's later planner ${association} and the entire task batch`, t => {
    const { db } = fixture(t)
    const shape = db.createTask({ title: 'shape only' })
    db.deleteTask(shape.id)
    const tasks = ['one', 'two'].map(title => ({ ...shape, id: randomUUID(), title, deletedAt: null }))
    const receipt = db.applyOperation({ id: randomUUID(), requestId: randomUUID(), summary: '创建两件事项',
      changes: tasks.map(task => ({ table: 'tasks', id: task.id, before: null, after: task })) })
    db.updatePlanner(association === 'block'
      ? { type: 'save-block', block: block(tasks[0].id, { locked: true }) }
      : { type: 'save-details', taskId: tasks[0].id, details: detail() }, 0)
    const before = db.getPlanner()
    assert.throws(() => db.undoOperation(receipt.id), conflict)
    assert.deepEqual(db.getPlanner(), before)
    for (const task of tasks) assert.deepEqual(db.getTask(task.id), task)
    assert.equal(db.listOperations()[0].undoneAt, null)
  })
}

for (const due of ['2026-09-20', new Date('2026-09-21T18:34:00').toISOString()]) {
  test(`undoing a removed block rechecks the task's later deadline (${due})`, t => {
    const { db } = fixture(t), task = db.createTask({ title: '截止修改', due: '2026-09-22' }), proposed = block(task.id)
    db.updatePlanner({ type: 'save-block', block: proposed }, 0)
    const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: proposed.id }]))
    db.updateTask(task.id, { due })
    const before = db.getPlanner()
    assert.throws(() => db.undoOperation(receipt.id), error => conflict(error) && /截止时间/u.test(error.message))
    assert.deepEqual(db.getPlanner(), before)
    assert.equal(db.listOperations()[0].undoneAt, null)
  })
}

test('undoing a moved block rejects a later precise task occupying its old position', t => {
  const { db } = fixture(t), task = db.createTask({ title: '被挪动的任务' }), other = db.createTask({ title: '后来安排' }), original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: { ...original, start: '19:00', end: '19:35' } }]))
  db.updateTask(other.id, { startAt: new Date('2026-09-21T18:20:00').toISOString(), estimateMin: 60 })
  const before = db.getPlanner()
  assert.throws(() => db.undoOperation(receipt.id), error => conflict(error) && /开始时间/u.test(error.message))
  assert.deepEqual(db.getPlanner(), before)
  assert.equal(db.listOperations()[0].undoneAt, null)
})

test('undo restores valid completed history and uses final explicit blocks instead of superseded legacy start times', t => {
  const { db } = fixture(t), task = db.createTask({ title: '已完成历史', due: '2026-09-21' }), other = db.createTask({ title: '另有明确安排' })
  const original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  db.updatePlanner({ type: 'save-block', block: block(other.id, { start: '20:00', end: '20:35' }) }, 1)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: original.id }]))
  db.updateTask(task.id, { status: 'done' })
  db.updateTask(other.id, { startAt: new Date('2026-09-21T18:20:00').toISOString(), estimateMin: 60 })
  assert.ok(db.undoOperation(receipt.id).undoneAt)
  assert.deepEqual(db.getPlanner().blocks.find(item => item.id === original.id), original)
  assert.equal(db.getTask(task.id).status, 'done')
})

test('undo of preparation alone preserves unchanged history even if the task subsequently has a deadline conflict', t => {
  const { db } = fixture(t), task = db.createTask({ title: '既有历史', due: '2026-09-22' }), original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: task.id, details: detail() }]))
  db.updateTask(task.id, { due: '2026-09-20' })
  assert.ok(db.undoOperation(receipt.id).undoneAt)
  assert.deepEqual(db.getPlanner().blocks, [original])
  assert.deepEqual(db.getPlanner().details, {})
})

test('undo cannot restore time after a later fixed course edit and leaves that course intact', t => {
  const { db } = fixture(t), task = db.createTask({ title: '课表后来修改' }), original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: original.id }]))
  db.updatePlanner({ type: 'save-routine', routine: { id: 'late-course', title: '新增课程', kind: 'class', weekdays: [1], start: '18:00', end: '19:00', location: '学校', items: [], enabled: true } }, 2)
  const before = db.getPlanner()
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner(), before)
})
