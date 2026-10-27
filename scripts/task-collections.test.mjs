import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createServiceCore } from '../server/serviceCore.mjs'
import { validLocalResponse } from '../src/xixi/localResponse.ts'
import { publicOperations } from '../server/operationReceipts.mjs'
import { taskCollectionChanges } from '../server/taskCollections.mjs'
import { taskInput } from '../server/validation.mjs'
import { taskEntries, taskCollectionKey, collectionProgress, collectionRemaining } from '../src/domain/taskCollections.ts'
import { receiptEntries } from '../src/xixi/receiptCollections.ts'
import { finishResponse } from './fixtures/model-receipt.mjs'

process.env.TZ = 'Asia/Shanghai'
const NOW = new Date('2026-10-20T10:00:00+08:00')
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const refs = tasks => tasks.map(task => ({ id: task.id, expectedUpdatedAt: task.updatedAt }))
const draft = (index, extra = {}) => ({ title: `${index < 5 ? '阅读' : '数学'}练习 ${index + 1}`, collection: 'SAT 作业', due: '2026-10-25', estimateMin: 35, ...extra })
const group = tasks => taskEntries(tasks).find(entry => entry.kind === 'collection')
const input = text => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', date: '2026-10-20', page: 'home' } })
function fixture(t) { const db = createDatabase(':memory:'); t.after(() => db.close()); return db }

test('8+2 model creations form one collection across subjects and preserve independent placement, receipts and undo', async t => {
  const db = fixture(t), drafts = Array.from({ length: 10 }, (_, index) => draft(index))
  const replies = [call('create_tasks', { tasks: drafts.slice(0, 8) }), call('create_tasks', { tasks: drafts.slice(8) }),
    payload => finishResponse(payload, '十份已记好，按真实安排来。', '十份练习都在10月25日前，按真实空档各排了一段。')]
  const xixi = createXixi({ db, now: () => NOW, complete: async payload => {
    const next = replies.shift()
    return typeof next === 'function' ? next(payload) : next ?? reply('按回执核对。')
  } })
  const result = await xixi.chat(input('SAT 作业一共十份，每份35分钟，10月25日截止，记下并安排。'))
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  const tasks = db.listTasks(), plans = db.getPlanner().blocks
  assert.equal(tasks.length, 10)
  assert.equal(plans.length, 10)
  for (const task of tasks) {
    assert.equal(task.collection, 'SAT 作业')
    assert.equal(task.estimateMin, 35)
    assert.equal(plans.filter(plan => plan.taskId === task.id).length, 1)
  }
  assert.equal(taskEntries(tasks).length, 1)
  assert.equal(group(tasks).tasks.length, 10)
  assert.equal(collectionProgress(group(tasks)), '10 项 · 已完成 0/10')
  assert.equal(collectionRemaining(group(tasks)), '剩余估时 350 分钟')
  const receipts = publicOperations(db.listOperations(), db)
  assert.equal(receipts.length, 2)
  assert.equal(receiptEntries(receipts).length, 1)
  assert.equal(receiptEntries(receipts)[0].tasks.length, 10)
  assert.equal(receiptEntries(receipts)[0].operations.length, 2)
  assert.equal(receipts.reduce((sum, receipt) => sum + receipt.scheduledCount, 0), 10)
  assert.ok(db.listMessages('main').some(message => message.content === '十份已记好，按真实安排来。'), 'natural reply is untouched')
  const second = receipts.find(receipt => receipt.createdTasks.length === 2)
  db.undoOperation(second.id)
  assert.equal(db.listTasks().length, 8)
  assert.equal(db.getPlanner().blocks.length, 8)
  const current = receiptEntries(publicOperations(db.listOperations(), db))
  assert.equal(current.find(entry => entry.kind === 'collection').tasks.length, 8)
  assert.ok(current.some(entry => entry.kind === 'operation' && entry.operation.undoneAt), 'undone batch remains visible')
})

test('only explicit themes group: same DDL alone, different themes and different DDL stay separate', t => {
  const db = fixture(t)
  const a = db.createTask(draft(0)), b = db.createTask(draft(5))
  db.createTask(draft(1, { collection: 'SAT 作业', due: '2026-10-26' }))
  db.createTask(draft(2, { collection: '物理作业' }))
  db.createTask({ title: '商务月考', due: '2026-10-25' })
  db.createTask({ title: '另一场考试', due: '2026-10-25' })
  const entries = taskEntries(db.listTasks())
  assert.equal(entries.length, 5)
  assert.deepEqual(new Set(group([a, b]).tasks.map(task => task.id)), new Set([a.id, b.id]))
  assert.notEqual(taskCollectionKey(a), taskCollectionKey({ ...a, due: '2026-10-25T00:00:00Z' }))
  assert.equal(taskCollectionKey({ ...a, due: '2026-10-25T08:00:00+08:00' }), taskCollectionKey({ ...a, due: '2026-10-25T00:00:00Z' }))
  assert.equal(taskCollectionKey({ ...a, collection: undefined }), null)
})

test('subset counts include completed members; dropped/deleted excluded, unknown estimates are explicit', t => {
  const db = fixture(t)
  const a = db.createTask(draft(0)), done = db.createTask(draft(1, { status: 'done' }))
  db.createTask(draft(2, { status: 'dropped' }))
  const deleted = db.createTask(draft(3)); db.deleteTask(deleted.id)
  const unknown = db.createTask(draft(4, { estimateMin: undefined }))
  const item = taskEntries([a], db.listTasks())[0]
  assert.equal(item.tasks.length, 3)
  assert.equal(item.visible.length, 1)
  assert.equal(collectionProgress(item), '3 项 · 已完成 1/3')
  assert.equal(collectionRemaining(item), '剩余估时 35 分钟 · 1 项用时待估')
  const moved = db.updateTask(unknown.id, { due: '2026-10-26' }, unknown.updatedAt)
  assert.notEqual(taskCollectionKey(a), taskCollectionKey(moved))
  assert.equal(taskEntries([done], db.listTasks())[0].tasks.length, 2)
})

test('manual batch is atomic, version checked, undoable and does not change schedules, status or IDs', t => {
  const db = fixture(t), tasks = [db.createTask(draft(0, { collection: undefined })), db.createTask(draft(1, { collection: undefined }))]
  db.updatePlanner({ type: 'save-block', block: { id: randomUUID(), taskId: tasks[0].id, date: '2026-10-20', start: '18:00', end: '18:35', locked: false } }, db.getPlanner().revision)
  const beforePlan = db.getPlanner(), beforeTasks = db.listTasks()
  const patch = taskCollectionChanges(db, { collection: 'SAT 作业', tasks: refs(tasks) }, NOW.toISOString())
  const operation = db.applyOperation({ id: randomUUID(), requestId: randomUUID(), ...patch })
  assert.deepEqual(db.getPlanner(), beforePlan)
  for (const task of db.listTasks()) {
    const { collection, updatedAt, ...unchanged } = task
    const { updatedAt: oldStamp, ...original } = beforeTasks.find(item => item.id === task.id)
    assert.equal(collection, 'SAT 作业'); assert.deepEqual(unchanged, original)
    assert.ok(updatedAt > oldStamp)
  }
  assert.throws(() => taskCollectionChanges(db, { collection: '新组', tasks: refs(tasks) }), /其他窗口/)
  assert.equal(db.listOperations().length, 1)
  db.undoOperation(operation.id)
  assert.ok(db.listTasks().every(task => !task.collection))
  assert.deepEqual(db.getPlanner(), beforePlan)
  const fresh = db.listTasks()
  const stalePatch = taskCollectionChanges(db, { collection: '新组', tasks: refs(fresh) })
  db.updateTask(fresh[1].id, { notes: '另一窗口的新内容' }, fresh[1].updatedAt)
  const snapshot = db.listTasks()
  assert.throws(() => db.applyOperation({ id: randomUUID(), requestId: randomUUID(), ...stalePatch }), /已被修改/)
  assert.deepEqual(db.listTasks(), snapshot, 'transaction rolls back all members')
})

test('bulk endpoint has stable retries, rejects conflicting reuse, supports removal and protects newer edits on undo', async t => {
  const db = fixture(t), tasks = [db.createTask(draft(0)), db.createTask(draft(1))]
  const core = createServiceCore({ db, vault: { status: async () => false }, xixiFactory: createXixi, dataDirectory: ':memory:' })
  const request = { collection: 'SAT 阅读', tasks: refs(tasks), requestId: randomUUID() }
  const result = await core.dispatch('/tasks/collection', request)
  assert.equal(validLocalResponse('/tasks/collection', result), true)
  assert.deepEqual(await core.dispatch('/tasks/collection', request), result)
  await assert.rejects(core.dispatch('/tasks/collection', { ...request, collection: 'SAT 数学' }), /其他归类/)
  const fresh = db.listTasks()
  const removed = await core.dispatch('/tasks/collection', { collection: null, tasks: refs([fresh[0]]), requestId: randomUUID() })
  assert.equal(db.getTask(fresh[0].id).collection, undefined)
  db.undoOperation(removed.operation.id)
  assert.equal(db.getTask(fresh[0].id).collection, 'SAT 阅读')
  const a = db.getTask(fresh[0].id)
  db.updateTask(a.id, { notes: '后续修改必须保留' }, a.updatedAt)
  assert.throws(() => db.undoOperation(result.operation.id), /修改|变化|撤销/)
  assert.equal(db.getTask(a.id).notes, '后续修改必须保留')
})

test('set_task_collection tool reuses existing task versions without creating more tasks or changing plans', async t => {
  const db = fixture(t), tasks = [db.createTask(draft(0, { collection: undefined })), db.createTask(draft(5, { collection: undefined }))]
  const plan = db.getPlanner(), replies = [call('set_task_collection', { collection: 'SAT 作业', tasks: refs(tasks) }), reply('已归到一起。')]
  const xixi = createXixi({ db, now: () => NOW, complete: async () => replies.shift() ?? reply('完成。') })
  const result = await xixi.chat(input('把这两项归为 SAT 作业。'))
  assert.equal(result.status, 'completed')
  assert.equal(db.listTasks().length, 2)
  assert.ok(db.listTasks().every(task => task.collection === 'SAT 作业'))
  assert.deepEqual(db.getPlanner(), plan)
})

test('metadata survives disk reopen and a verified backup restore', t => {
  const dir = mkdtempSync(join(tmpdir(), 'astaria-collections-')); t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'test.sqlite')
  let db = createDatabase(file)
  const task = db.createTask(draft(0)); db.close()
  db = createDatabase(file); t.after(() => db.close())
  assert.equal(db.getTask(task.id).collection, 'SAT 作业')
  const restored = createDatabase(':memory:'); t.after(() => restored.close())
  restored.importData(db.exportData())
  assert.equal(restored.getTask(task.id).collection, 'SAT 作业')
})

test('collection validation rejects empty, excessive or non-text labels and duplicate references', t => {
  const db = fixture(t), task = db.createTask(draft(0))
  for (const collection of ['', '   ', 'a'.repeat(61), 22, {}, []]) assert.throws(() => taskInput({ title: 'test', collection }))
  for (const tasks of [[], Array.from({ length: 51 }, () => refs([task])[0]), refs([task, task])]) assert.throws(() => taskCollectionChanges(db, { collection: '组', tasks }))
  assert.equal(taskInput({ collection: null }, { partial: true }).collection, undefined)
})

test('editing membership removes unchecked members atomically and one undo restores the entire set', async t => {
  const db = fixture(t), tasks = [db.createTask(draft(0)), db.createTask(draft(1))], outside = db.createTask({ title: '新阅读作业', due: '2026-10-25' })
  const core = createServiceCore({ db, vault: { status: async () => false }, xixiFactory: createXixi, dataDirectory: ':memory:' })
  const request = { collection: 'SAT 作业', tasks: refs([tasks[0], outside]), removeTasks: refs([tasks[1]]), requestId: randomUUID() }
  const result = await core.dispatch('/tasks/collection', request)
  assert.equal(db.getTask(tasks[1].id).collection, undefined)
  assert.equal(db.getTask(outside.id).collection, 'SAT 作业')
  assert.deepEqual(await core.dispatch('/tasks/collection', request), result)
  db.undoOperation(result.operation.id)
  assert.equal(db.getTask(tasks[1].id).collection, 'SAT 作业')
  assert.equal(db.getTask(outside.id).collection, undefined)
})

test('collection metadata synchronizes as ordinary task documents without losing independent fields', t => {
  const a = fixture(t), b = fixture(t)
  for (const db of [a, b]) { db.listAreas(); db.getPlanner(); db.sync.configure({ groupId: 'c'.repeat(32), directory: '/synthetic-offline-collection', mode: 'shared' }) }
  const send = (from, to) => { for (const operation of from.sync.outbox()) {
    assert.ok(['applied', 'duplicate'].includes(to.sync.receive(operation)))
    from.sync.exported(operation.operationId)
  } }
  send(a, b); send(b, a)
  const task = a.createTask(draft(0)); send(a, b)
  assert.equal(b.getTask(task.id).collection, 'SAT 作业')
  const patch = taskCollectionChanges(b, { collection: 'SAT 复习', tasks: refs([b.getTask(task.id)]) })
  b.applyOperation({ id: randomUUID(), requestId: randomUUID(), ...patch }); send(b, a)
  assert.equal(a.getTask(task.id).collection, 'SAT 复习')
  assert.equal(a.getTask(task.id).estimateMin, task.estimateMin)
  assert.equal(a.getTask(task.id).title, task.title)
})

test('mobile SQLite engine persists collections and validates atomic membership edits', async t => {
  const { default: initSqlJs } = await import('sql.js'), { sqliteDriver } = await import('../mobile/runtime/sqlite.mjs')
  const { createDatabaseCore } = await import('../server/databaseCore.mjs'), SQL = await initSqlJs()
  const { createBackupStore, validateCompanionState } = await import('../server/backup.mjs'), { createSyncStore } = await import('../server/syncStore.mjs')
  const raw = new SQL.Database(), db = createDatabaseCore(sqliteDriver(raw), { createBackupStore, validateCompanionState, createSyncStore })
  t.after(() => { db.close(); raw.close() })
  const tasks = [db.createTask(draft(0)), db.createTask(draft(1))]
  const patch = taskCollectionChanges(db, { collection: 'SAT 复习', tasks: refs(tasks) })
  const operation = db.applyOperation({ id: randomUUID(), requestId: randomUUID(), ...patch })
  assert.ok(db.listTasks().every(task => task.collection === 'SAT 复习'))
  db.undoOperation(operation.id)
  assert.ok(db.listTasks().every(task => task.collection === 'SAT 作业'))
})
