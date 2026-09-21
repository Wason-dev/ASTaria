import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { deadlineOnDay, deadlineParts, deadlineShortcuts, plansAfterDeadline } from '../src/xixi/deadlineShortcuts.ts'

test('deadline shortcuts use local calendar days across months and years', () => {
  assert.deepEqual(deadlineShortcuts(new Date(2026, 11, 31, 23, 59)), [
    { label: '今天', date: '2026-12-31' }, { label: '明天', date: '2027-01-01' }, { label: '后天', date: '2027-01-02' },
  ])
  assert.equal(deadlineShortcuts(new Date(2028, 1, 28))[1].date, '2028-02-29')
})

test('shortcuts preserve an explicit clock time while date-only deadlines stay date-only', () => {
  const current = new Date(2026, 8, 22, 12, 30).toISOString()
  assert.deepEqual(deadlineParts(current), { date: '2026-09-22', time: '12:30' })
  assert.equal(deadlineOnDay('2026-09-23', deadlineParts(current).time), new Date(2026, 8, 23, 12, 30).toISOString())
  assert.equal(deadlineOnDay('2026-09-23'), '2026-09-23')
  assert.equal(deadlineOnDay(''), null)
  assert.throws(() => deadlineOnDay('2026-02-30'), /有效/)
  assert.throws(() => deadlineOnDay('2026-09-23', '25:00'), /有效/)
})

test('an earlier deadline reports existing plans that end after it without moving them', () => {
  const plans = [{ taskId: 'target', date: '2026-09-22', end: '22:00' }, { taskId: 'other', date: '2026-09-23', end: '21:00' }]
  assert.equal(plansAfterDeadline('2026-09-22', 'target', plans), 0)
  assert.equal(plansAfterDeadline('2026-09-21', 'target', plans), 1)
  assert.equal(plansAfterDeadline(new Date(2026, 8, 22, 21).toISOString(), 'target', plans), 1)
  assert.equal(plansAfterDeadline(null, 'target', plans), 0)
})

async function request(service, path, input) {
  const req = Readable.from(input === undefined ? [] : [Buffer.from(JSON.stringify(input))])
  req.url = `/api${path}`; req.method = input === undefined ? 'GET' : 'POST'
  req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
  req.headers = { host: '127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
  return new Promise(resolve => service.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, value: JSON.parse(body) }) } }, () => resolve({ status: 404 })))
}

test('creation receipts expose current task IDs and DDL edits persist without a model call or duplicate task', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const service = createLocalService({ db, vault: { status: async () => true }, complete: async () => { throw Error('No model call expected') } })
  db.beginTurn({ requestId: 'ddl-create', conversationId: 'main', text: '物理作业，ddl明天', context: {} })
  const at = '2026-09-21T01:00:00.000Z'
  const task = { id: 'physics-ddl', title: '物理作业', area: null, source: 'ai', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo', due: '2026-09-22', createdAt: at, updatedAt: at, deletedAt: null }
  db.applyOperation({ id: 'created-task', requestId: 'ddl-create', summary: '创建 1 项事项：物理作业', changes: [{ table: 'tasks', id: task.id, before: null, after: task }] })
  db.finishTurn('ddl-create', { status: 'completed' })
  const first = await request(service, '/conversation?id=main')
  assert.deepEqual(first.value.operations[0].createdTasks, [{ id: task.id, title: task.title, due: task.due, updatedAt: at }])
  assert.equal(first.value.operations[0].changes, undefined)
  const saved = await request(service, '/tasks/update', { id: task.id, patch: { due: '2026-09-23' }, expectedUpdatedAt: at })
  assert.equal(saved.status, 200)
  const refreshed = await request(service, '/conversation?id=main')
  assert.equal(refreshed.value.operations[0].createdTasks[0].due, '2026-09-23')
  assert.match(refreshed.value.operations[0].details[0], /截止 2026-09-23/)
  assert.equal(refreshed.value.operations[0].createdTasks[0].updatedAt, saved.value.updatedAt)
  assert.equal(db.listTasks().length, 1)
  assert.equal((await request(service, '/tasks/update', { id: task.id, patch: { due: '2026-09-24' }, expectedUpdatedAt: at })).status, 409)
  const timed = await request(service, '/tasks/update', { id: task.id, patch: { due: deadlineOnDay('2026-09-23', '20:00') }, expectedUpdatedAt: saved.value.updatedAt })
  assert.equal(timed.status, 200)
  const timedReceipt = (await request(service, '/conversation?id=main')).value.operations[0]
  assert.match(timedReceipt.details[0], /20:00/)
  assert.doesNotMatch(timedReceipt.details[0], /T\d{2}:|\.000Z/)
  const cleared = await request(service, '/tasks/update', { id: task.id, patch: { due: null }, expectedUpdatedAt: timed.value.updatedAt })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.value.due, undefined)
  assert.doesNotMatch((await request(service, '/conversation?id=main')).value.operations[0].details[0], /截止/)
  db.deleteTask(task.id)
  assert.deepEqual((await request(service, '/conversation?id=main')).value.operations[0].createdTasks, [])
})
