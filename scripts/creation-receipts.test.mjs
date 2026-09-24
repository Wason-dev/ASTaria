import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { mergeConversation, mergeOperationReceipt } from '../src/xixi/conversationTimeline.ts'

const requestId = 'creation-with-placement'
const at = '2026-09-21T01:00:00.000Z'
const task = { id: 'receipt-math', title: '数学作业', area: null, source: 'ai', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo', due: '2026-09-24', estimateMin: 30, createdAt: at, updatedAt: at, deletedAt: null }
const block = { id: 'initial-math', taskId: task.id, date: '2026-09-22', start: '20:30', end: '21:00', locked: false }
async function request(service, path, input) {
  const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
  req.url = `/api${path}`; req.method = input === undefined ? 'GET' : 'POST'
  req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
  req.headers = { host: '127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
  return new Promise(resolve => service.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, value: JSON.parse(body) }) } }, () => resolve({ status: 404 })))
}
function fixture(t) {
  const db = createDatabase(':memory:')
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw Error('No model call expected') } })
  t.after(() => service.close())
  db.beginTurn({ requestId, conversationId: 'main', text: '记下数学作业并安排', context: {} })
  const parent = db.applyOperation({ id: 'create-math', requestId, summary: '创建 1 项事项：数学作业', changes: [{ table: 'tasks', id: task.id, before: null, after: task }] })
  const child = db.applyPlannerOperation({ id: 'place-math', requestId, parentOperationId: parent.id, summary: '自动安排数学作业', expectedRevision: db.getPlanner().revision, actions: [{ type: 'save-block', block }] })
  db.finishTurn(requestId, { status: 'completed' })
  return { db, service, parent, child }
}

test('creation and automatic placement expose one receipt in chat and notifications, retaining title, DDL and slot', async t => {
  const { db, service, parent, child } = fixture(t)
  const conversation = await request(service, '/conversation?id=main')
  const notifications = await request(service, '/operations')
  assert.equal(conversation.value.operations.length, 1)
  assert.deepEqual(notifications.value, conversation.value.operations)
  const receipt = conversation.value.operations[0]
  assert.equal(receipt.id, parent.id)
  assert.equal(receipt.undoLabel, '撤销创建与安排')
  assert.deepEqual(receipt.relatedOperationIds, [child.id])
  assert.match(receipt.summary, /已安排 1 段时间/)
  assert.ok(receipt.details.some(detail => /数学作业.*截止 2026-09-24.*预计 30/.test(detail)))
  assert.ok(receipt.details.some(detail => /数学作业.*2026-09-22 20:30–21:00/.test(detail)))
  assert.equal(receipt.createdTasks[0].id, task.id)
  assert.equal(receipt.createdTasks[0].estimateMin, 30)
  assert.equal(receipt.changes, undefined)
  assert.equal(receipt.plannerBefore, undefined)
  assert.equal(db.listOperations().length, 2, 'internal durable receipts remain intact')
})

test('DDL and estimate quick edits share a fresh version and project to every task view without silently moving plans', async t => {
  const { db, service } = fixture(t)
  const planner = db.getPlanner()
  let current = (await request(service, '/conversation?id=main')).value.operations[0].createdTasks[0]
  const ddl = await request(service, '/tasks/update', { id: current.id, patch: { due: '2026-09-25' }, expectedUpdatedAt: current.updatedAt })
  assert.equal(ddl.status, 200)
  current = ddl.value
  const estimate = await request(service, '/tasks/update', { id: current.id, patch: { estimateMin: 45 }, expectedUpdatedAt: current.updatedAt })
  assert.equal(estimate.status, 200)
  const conversation = (await request(service, '/conversation?id=main')).value
  const notifications = (await request(service, '/operations')).value
  const tasks = (await request(service, '/tasks')).value
  const projected = conversation.operations[0].createdTasks[0]
  assert.equal(projected.due, '2026-09-25')
  assert.equal(projected.estimateMin, 45)
  assert.equal(projected.updatedAt, estimate.value.updatedAt)
  assert.equal(tasks.find(item => item.id === current.id).estimateMin, 45)
  assert.deepEqual(notifications[0].createdTasks[0], projected)
  assert.deepEqual(db.getPlanner(), planner, 'quick metadata edits never resize or add time blocks')
  assert.equal(db.listOperations().length, 2, 'metadata shortcuts do not create extra execution receipts')
})

test('stale estimate edit cannot overwrite another window, and rereading allows recovery while retaining its DDL', async t => {
  const { db, service } = fixture(t)
  const current = (await request(service, '/conversation?id=main')).value.operations[0].createdTasks[0]
  const other = db.updateTask(task.id, { due: '2026-09-26', estimateMin: 60 }, current.updatedAt)
  const conflict = await request(service, '/tasks/update', { id: current.id, patch: { estimateMin: 20 }, expectedUpdatedAt: current.updatedAt })
  assert.equal(conflict.status, 409)
  assert.equal(db.getTask(task.id).estimateMin, 60)
  const fresh = (await request(service, `/tasks/${task.id}`)).value
  assert.equal(fresh.updatedAt, other.updatedAt)
  const recovered = await request(service, '/tasks/update', { id: fresh.id, patch: { estimateMin: 20 }, expectedUpdatedAt: fresh.updatedAt })
  assert.equal(recovered.status, 200)
  assert.equal(recovered.value.due, '2026-09-26')
  assert.equal(recovered.value.estimateMin, 20)
  const projected = (await request(service, '/conversation?id=main')).value.operations[0].createdTasks[0]
  assert.equal(projected.estimateMin, 20)
  assert.equal(projected.updatedAt, recovered.value.updatedAt)
})

for (const target of ['parent', 'child']) test(`${target} receipt undo atomically deletes the task and slot, returns the canonical receipt and is idempotent`, async t => {
  const f = fixture(t)
  const result = await request(f.service, `/operations/${f[target].id}/undo`, {})
  assert.equal(result.status, 200)
  assert.equal(result.value.id, f.parent.id)
  assert.ok(result.value.undoneAt)
  assert.deepEqual(result.value.createdTasks, [])
  assert.equal(f.db.getTask(task.id), null)
  assert.deepEqual(f.db.getPlanner().blocks, [])
  assert.ok(f.db.listOperations().every(operation => operation.undoneAt))
  const revision = f.db.getPlanner().revision
  const repeated = await request(f.service, `/operations/${f[target].id}/undo`, {})
  assert.deepEqual(repeated.value, result.value)
  assert.equal(f.db.getPlanner().revision, revision)
  assert.equal((await request(f.service, '/operations')).value.length, 1)
})

for (const change of ['task', 'slot', 'unrelated-plan']) test(`a later ${change} edit blocks unified undo without partial deletion or overwriting newer data`, async t => {
  const { db, service, child } = fixture(t)
  if (change === 'task') db.updateTask(task.id, { title: '用户修正的数学作业' }, task.updatedAt)
  else if (change === 'slot') db.updatePlanner({ type: 'save-block', block: { ...block, start: '21:00', end: '21:30' } }, db.getPlanner().revision)
  else db.updatePlanner({ type: 'check-item', date: block.date, key: '用户后来的独立修改', checked: true }, db.getPlanner().revision)
  const tasks = db.listTasks(), planner = db.getPlanner(), operations = db.listOperations()
  const result = await request(service, `/operations/${child.id}/undo`, {})
  assert.equal(result.status, 409)
  assert.deepEqual(db.listTasks(), tasks)
  assert.deepEqual(db.getPlanner(), planner)
  assert.deepEqual(db.listOperations(), operations)
})

test('reading either legacy child or merged parent marks the whole action read with no repeated notification', async t => {
  for (const target of ['parent', 'child']) {
    const f = fixture(t)
    const result = await request(f.service, '/operations/read', { ids: [f[target].id] })
    assert.equal(result.status, 200)
    assert.ok(f.db.listOperations().every(operation => operation.readAt))
    assert.ok((await request(f.service, '/operations')).value[0].readAt)
  }
})

test('unified undo and full refresh preserve loaded history and remove obsolete child receipts', async t => {
  const { service, parent, child } = fixture(t)
  const latest = (await request(service, '/conversation?id=main')).value
  const historical = { id: 'older-message', seq: 0, role: 'user', content: 'earlier', createdAt: at, requestId: 'earlier-turn' }
  const cached = { ...latest, messages: [historical, ...latest.messages], oldestSeq: 0, hasOlder: true,
    operations: [{ ...latest.operations[0], relatedOperationIds: undefined }, { id: child.id, requestId, summary: child.summary, createdAt: child.createdAt, readAt: null, undoneAt: null }] }
  const undone = (await request(service, `/operations/${child.id}/undo`, {})).value
  const optimistic = mergeOperationReceipt(cached, undone)
  assert.deepEqual(optimistic.operations.map(operation => operation.id), [parent.id])
  assert.ok(optimistic.operations[0].undoneAt)
  const refreshed = mergeConversation(optimistic, (await request(service, '/conversation?id=main')).value)
  assert.equal(refreshed.conversationId, 'main')
  assert.equal(refreshed.messages[0].id, historical.id)
  assert.equal(refreshed.oldestSeq, 0)
  assert.equal(refreshed.hasOlder, true)
  assert.equal(refreshed.operations.length, 1)
  assert.ok(refreshed.operations[0].undoneAt)
})
