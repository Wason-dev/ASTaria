import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { dayCapacity } from '../src/planner/model.ts'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-planner-test-'))
  const filename = join(directory, 'qa.sqlite')
  const connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  const close = db => { db.close(); connections.delete(db) }
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }) })
  const db = open()
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  return { db, edit, open, close, filename }
}
const routine = (patch = {}) => ({ id: 'class-monday', title: '物理', kind: 'class', weekdays: [1], start: '08:00', end: '09:00', location: '实验室', items: ['计算器'], enabled: true, ...patch })
const block = (taskId, patch = {}) => ({ id: randomUUID(), taskId, date: '2026-09-21', start: '18:00', end: '18:35', locked: false, ...patch })
const details = (patch = {}) => ({ items: ['笔记本'], preparation: '整理实验记录', needsSubmission: false, submittedAt: null, ...patch })
const conflict = error => error.status === 409
const invalid = error => error.status === 400

function invoke(service, path = '/planner', payload) {
  return new Promise(resolve => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
    req.url = `/api${path}`; req.method = payload === undefined ? 'GET' : 'POST'
    req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } }
    service.middleware(req, res, () => resolve({ status: 404 }))
  })
}

test('planner starts with weekday evening and weekend availability and no confirmed timetable', t => {
  const { db } = fixture(t), state = db.getPlanner()
  assert.equal(state.revision, 0); assert.equal(state.timetableConfirmed, false)
  assert.deepEqual(state.routines.map(({ id, ...entry }) => entry), [
    { title: '晚自习', kind: 'available', weekdays: [1, 2, 3, 4, 5], start: '18:00', end: '20:00', location: '学校', items: [], enabled: true },
    { title: '周末可安排时间', kind: 'available', weekdays: [0, 6], start: '09:00', end: '22:00', location: '', items: [], enabled: true },
  ])
  assert.deepEqual(state.blocks, []); assert.deepEqual(state.details, {}); assert.deepEqual(state.checked, {})
  state.routines[0].title = 'mutated caller'
  assert.equal(db.getPlanner().routines[0].title, '晚自习')
})

test('legacy planner gets weekend availability once and keeps the migration marker', t => {
  const f = fixture(t)
  const raw = new DatabaseSync(f.filename)
  raw.prepare('INSERT INTO state (key,value) VALUES (?,?)').run('planner-v1', JSON.stringify({
    revision: 4, timetableConfirmed: true, routines: [routine({ id: 'legacy-class', weekdays: [6], kind: 'class' })],
    blocks: [], details: {}, checked: {},
  }))
  raw.close()
  const migrated = f.db.getPlanner()
  assert.equal(migrated.revision, 5)
  assert.equal(migrated.timetableConfirmed, true)
  assert.deepEqual(migrated.routines.map(item => item.id), ['legacy-class', 'default-weekend-availability'])
  assert.equal(f.db.getPlanner().revision, 5)
  const check = new DatabaseSync(f.filename)
  const marker = check.prepare('SELECT value FROM state WHERE key=?').get('planner-v1-weekend-defaults-v1')
  assert.equal(JSON.parse(marker.value).version, 1)
  check.close()
})

test('weekend migration preserves any existing weekend availability and fixed routines', t => {
  const f = fixture(t)
  const raw = new DatabaseSync(f.filename)
  raw.prepare('INSERT INTO state (key,value) VALUES (?,?)').run('planner-v1', JSON.stringify({
    revision: 2, timetableConfirmed: false, routines: [
      routine({ id: 'saturday-free', weekdays: [6], kind: 'available', start: '11:00', end: '12:00' }),
      routine({ id: 'sunday-class', weekdays: [0], kind: 'class', start: '09:00', end: '10:00' }),
    ], blocks: [], details: {}, checked: {},
  }))
  raw.close()
  const state = f.db.getPlanner()
  assert.equal(state.revision, 2)
  assert.deepEqual(state.routines.map(item => item.id), ['saturday-free', 'sunday-class'])
})

test('migration adds availability around weekend class or break without replacing it', t => {
  const f = fixture(t)
  const raw = new DatabaseSync(f.filename)
  raw.prepare('INSERT INTO state (key,value) VALUES (?,?)').run('planner-v1', JSON.stringify({
    revision: 7, timetableConfirmed: false, routines: [
      routine({ id: 'saturday-class', weekdays: [6], kind: 'class', start: '10:00', end: '11:00' }),
      routine({ id: 'sunday-break', weekdays: [0], kind: 'break', start: '12:00', end: '13:00' }),
    ], blocks: [], details: {}, checked: {},
  }))
  raw.close()
  const state = f.db.getPlanner()
  assert.equal(state.revision, 8)
  assert.deepEqual(state.routines.map(item => item.id), ['saturday-class', 'sunday-break', 'default-weekend-availability'])
})

test('deleting the default weekend routine is durable across a reopened connection', t => {
  const f = fixture(t), initial = f.db.getPlanner()
  f.edit({ type: 'delete-routine', id: 'default-weekend-availability' })
  assert.equal(f.db.getPlanner().routines.some(item => item.id === 'default-weekend-availability'), false)
  f.close(f.db)
  const reopened = f.open()
  assert.equal(reopened.getPlanner().routines.some(item => item.id === 'default-weekend-availability'), false)
  assert.equal(reopened.getPlanner().revision, initial.revision + 1)
})

test('a stale writer cannot overwrite the revision created by weekend migration', t => {
  const f = fixture(t)
  const raw = new DatabaseSync(f.filename)
  raw.prepare('INSERT INTO state (key,value) VALUES (?,?)').run('planner-v1', JSON.stringify({
    revision: 0, timetableConfirmed: false, routines: [], blocks: [], details: {}, checked: {},
  }))
  raw.close()
  assert.throws(() => f.db.updatePlanner({ type: 'import-routines', routines: [] }, 0), conflict)
  assert.equal(f.db.getPlanner().revision, 1)
})

test('independent connections migrate once and preserve a subsequent edit', t => {
  const f = fixture(t), second = f.open(), raw = new DatabaseSync(f.filename)
  raw.prepare('INSERT INTO state (key,value) VALUES (?,?)').run('planner-v1', JSON.stringify({
    revision: 9, timetableConfirmed: true, routines: [], blocks: [], details: {}, checked: {},
  }))
  raw.close()
  assert.equal(second.getPlanner().revision, 10)
  assert.equal(f.db.getPlanner().revision, 10)
  const weekend = second.getPlanner().routines.find(item => item.id === 'default-weekend-availability')
  second.updatePlanner({ type: 'save-routine', routine: { ...weekend, start: '10:00', end: '21:00' } }, 10)
  assert.equal(f.db.getPlanner().revision, 11)
  assert.equal(f.db.getPlanner().routines.filter(item => item.id === weekend.id).length, 1)
  assert.equal(f.db.getPlanner().routines.find(item => item.id === weekend.id).start, '10:00')
  f.close(f.db); f.close(second)
  assert.equal(f.open().getPlanner().routines.find(item => item.id === weekend.id).end, '21:00')
})

test('disabled user weekend availability is not silently replaced by migration', t => {
  const f = fixture(t), raw = new DatabaseSync(f.filename)
  const disabled = routine({ id: 'my-weekend', kind: 'available', weekdays: [0, 6], enabled: false })
  raw.prepare('INSERT INTO state (key,value) VALUES (?,?)').run('planner-v1', JSON.stringify({
    revision: 3, timetableConfirmed: true, routines: [disabled], blocks: [], details: {}, checked: {},
  }))
  raw.close()
  assert.deepEqual(f.db.getPlanner().routines, [disabled])
  assert.equal(f.db.getPlanner().revision, 3)
})

test('weekend capacity subtracts courses, breaks and task blocks from the 13-hour window', t => {
  const { db, edit } = fixture(t), date = '2026-09-19', at = new Date('2026-09-18T12:00:00')
  assert.equal(dayCapacity(db.getPlanner(), [], date, at).totalMin, 780)
  assert.equal(dayCapacity(db.getPlanner(), [], '2026-09-20', at).totalMin, 780)
  edit({ type: 'save-routine', routine: routine({ weekdays: [6], start: '10:00', end: '11:00' }) })
  edit({ type: 'save-routine', routine: routine({ id: 'lunch', kind: 'break', weekdays: [6], start: '12:00', end: '13:00' }) })
  const task = db.createTask({ title: '周末报告' })
  edit({ type: 'save-block', block: block(task.id, { date, start: '14:00', end: '15:30' }) })
  const capacity = dayCapacity(db.getPlanner(), db.listTasks(), date, at)
  assert.equal(capacity.totalMin, 660)
  assert.equal(capacity.scheduledMin, 90)
  assert.equal(capacity.freeMin, 570)
  assert.equal(capacity.remainingMin, 570)
  assert.deepEqual(capacity.conflicts, [])
})

test('independent connections and restarts share revisions without stale overwrites', t => {
  const f = fixture(t), second = f.open()
  const baseline = second.getPlanner()
  f.edit({ type: 'save-routine', routine: routine() })
  assert.throws(() => second.updatePlanner({ type: 'check-item', date: '2026-09-21', key: 'book', checked: true }, baseline.revision), conflict)
  assert.equal(second.getPlanner().revision, 1)
  second.updatePlanner({ type: 'check-item', date: '2026-09-21', key: 'book', checked: true }, 1)
  f.close(f.db); f.close(second)
  const restarted = f.open()
  assert.equal(restarted.getPlanner().revision, 2)
  assert.deepEqual(restarted.getPlanner().checked, { '2026-09-21': ['book'] })
  const raw = new DatabaseSync(f.filename)
  assert.equal(JSON.parse(raw.prepare('SELECT value FROM state WHERE key=?').get('planner-v1').value).revision, 2)
  raw.close()
})

test('imports merge by stable id, preserve custom/default routines and explicitly confirm timetable', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'save-routine', routine: routine({ id: 'custom' }) })
  assert.equal(db.getPlanner().timetableConfirmed, false)
  edit({ type: 'import-routines', routines: [routine({ id: 'legacy-math', title: '数学' })] })
  edit({ type: 'import-routines', routines: [routine({ id: 'legacy-math', title: '数学 A' })] })
  assert.deepEqual(db.getPlanner().routines.map(item => item.title), ['晚自习', '周末可安排时间', '物理', '数学 A'])
  assert.equal(db.getPlanner().timetableConfirmed, true)
  const before = db.getPlanner()
  assert.throws(() => edit({ type: 'import-routines', routines: [routine(), routine()] }), invalid)
  assert.deepEqual(db.getPlanner(), before)
  edit({ type: 'import-routines', routines: [] })
  assert.deepEqual(db.getPlanner().routines, before.routines)
})

test('overlapping availability and fixed routines remain representable but occupied time rejects new blocks', t => {
  const { db, edit } = fixture(t), task = db.createTask({ title: '报告' })
  edit({ type: 'save-routine', routine: routine({ id: 'available-extra', kind: 'available', start: '17:00', end: '19:00' }) })
  edit({ type: 'save-routine', routine: routine({ id: 'class-evening', start: '18:00', end: '18:30' }) })
  edit({ type: 'save-routine', routine: routine({ id: 'break-overlap', kind: 'break', start: '18:20', end: '18:45' }) })
  const before = db.getPlanner()
  assert.throws(() => edit({ type: 'save-block', block: block(task.id) }), conflict)
  assert.deepEqual(db.getPlanner(), before)
  const scheduled = block(task.id, { start: '18:45', end: '19:20' })
  edit({ type: 'save-block', block: scheduled })
  assert.throws(() => edit({ type: 'save-routine', routine: routine({ start: '19:00', end: '20:00' }) }), conflict)
  edit({ type: 'save-routine', routine: routine({ start: '19:00', end: '20:00', enabled: false }) })
  assert.equal(db.getPlanner().blocks.length, 1)
})

test('blocks reject other blocks, missing/deleted/finished tasks while allowing adjacent slots', t => {
  const { db, edit } = fixture(t), first = db.createTask({ title: '甲' }), second = db.createTask({ title: '乙' })
  edit({ type: 'save-block', block: block(first.id) })
  assert.throws(() => edit({ type: 'save-block', block: block(second.id, { start: '18:20', end: '19:00' }) }), conflict)
  edit({ type: 'save-block', block: block(second.id, { start: '18:35', end: '19:00' }) })
  for (const status of ['done', 'dropped']) {
    const finished = db.createTask({ title: status, status })
    assert.throws(() => edit({ type: 'save-block', block: block(finished.id, { start: '20:00', end: '21:00' }) }), conflict)
  }
  const deleted = db.createTask({ title: '删除' }); db.deleteTask(deleted.id)
  for (const id of ['missing', deleted.id]) assert.throws(() => edit({ type: 'save-block', block: block(id) }), conflict)
  assert.equal(db.getPlanner().blocks.length, 2)
})

test('legacy task start and estimate occupy actual local time, including across midnight, until replaced by blocks', t => {
  const { db, edit } = fixture(t)
  const legacy = db.createTask({ title: '旧安排', startAt: new Date('2026-09-20T23:30:00').toISOString(), estimateMin: 90 })
  const other = db.createTask({ title: '新安排' })
  assert.throws(() => edit({ type: 'save-block', block: block(other.id, { start: '00:20', end: '00:40' }) }), conflict)
  edit({ type: 'save-block', block: block(legacy.id, { start: '19:00', end: '20:00' }) })
  edit({ type: 'save-block', block: block(other.id, { start: '00:20', end: '00:40' }) })
  assert.throws(() => edit({ type: 'save-block', block: block(other.id, { start: '19:30', end: '20:10' }) }), conflict)
  const dateOnly = db.createTask({ title: '仅日期未定时', startAt: '2026-09-21', estimateMin: 60 })
  edit({ type: 'save-block', block: block(dateOnly.id, { start: '00:40', end: '01:00' }) })
  assert.equal(db.getPlanner().blocks.length, 3)
})

test('all-day DDL uses local end of day and timed DDL enforces its exact instant', t => {
  const { db, edit } = fixture(t)
  const allDay = db.createTask({ title: '全天截止', due: '2026-09-21' })
  edit({ type: 'save-block', block: block(allDay.id, { start: '22:00', end: '23:59' }) })
  assert.throws(() => edit({ type: 'save-block', block: block(allDay.id, { date: '2026-09-22' }) }), conflict)
  const precise = db.createTask({ title: '定时截止', due: new Date('2026-09-21T18:35:00').toISOString() })
  const exact = block(precise.id)
  edit({ type: 'save-block', block: exact })
  assert.throws(() => edit({ type: 'save-block', block: { ...exact, end: '18:36' } }), conflict)
  assert.equal(db.getPlanner().blocks.find(item => item.id === exact.id).end, '18:35')
})

test('locked blocks require separate unchanged unlock, even if a later task deadline creates a conflict', t => {
  const { db, edit } = fixture(t), task = db.createTask({ title: '锁定任务' })
  const locked = block(task.id, { locked: true })
  edit({ type: 'save-block', block: locked })
  const before = db.getPlanner()
  assert.throws(() => edit({ type: 'delete-block', id: locked.id }), conflict)
  assert.throws(() => edit({ type: 'save-block', block: { ...locked, locked: false, end: '19:00' } }), conflict)
  assert.deepEqual(db.getPlanner(), before)
  db.updateTask(task.id, { due: '2026-09-20' })
  edit({ type: 'save-block', block: { ...locked, locked: false } })
  edit({ type: 'delete-block', id: locked.id })
  assert.deepEqual(db.getPlanner().blocks, [])
})

test('submission data is independent of task completion and validates real ISO timestamps', t => {
  const { db, edit } = fixture(t), task = db.createTask({ title: '待提交作业' })
  edit({ type: 'save-details', taskId: task.id, details: details({ needsSubmission: true, submittedAt: '2026-09-18T18:00:00+08:00' }) })
  assert.equal(db.getTask(task.id).status, 'todo')
  assert.equal(db.getPlanner().details[task.id].submittedAt, '2026-09-18T10:00:00.000Z')
  edit({ type: 'save-details', taskId: task.id, details: details({ needsSubmission: true }) })
  db.updateTask(task.id, { status: 'done' })
  assert.equal(db.getPlanner().details[task.id].submittedAt, null)
  for (const value of ['2026-09-18', '2026-02-30T10:00:00Z', 'yesterday', undefined]) {
    assert.throws(() => edit({ type: 'save-details', taskId: task.id, details: details({ needsSubmission: true, submittedAt: value }) }), invalid)
  }
  assert.throws(() => edit({ type: 'save-details', taskId: task.id, details: details({ submittedAt: '2026-09-18T10:00:00Z' }) }), invalid)
})

test('task deletion cleans blocks and details in the same transaction and invalidates old planner revisions', t => {
  const { db, edit } = fixture(t), task = db.createTask({ title: '删除关联' })
  edit({ type: 'save-block', block: block(task.id, { locked: true }) })
  edit({ type: 'save-details', taskId: task.id, details: details() })
  const before = db.getPlanner()
  assert.throws(() => db.transaction(() => { db.deleteTask(task.id); throw new Error('rollback') }), /rollback/)
  assert.deepEqual(db.getPlanner(), before); assert.equal(db.getTask(task.id).deletedAt, null)
  db.deleteTask(task.id)
  const after = db.getPlanner()
  assert.equal(after.revision, before.revision + 1); assert.deepEqual(after.blocks, []); assert.deepEqual(after.details, {})
  assert.throws(() => db.updatePlanner({ type: 'import-routines', routines: [] }, before.revision), conflict)
  const aiTask = db.createTask({ title: 'AI 删除关联' })
  edit({ type: 'save-details', taskId: aiTask.id, details: details() })
  db.applyOperation({ id: randomUUID(), requestId: randomUUID(), summary: '移除任务', changes: [{ table: 'tasks', id: aiTask.id, before: aiTask, after: { ...aiTask, deletedAt: new Date().toISOString() } }] })
  assert.equal(Object.hasOwn(db.getPlanner().details, aiTask.id), false)
  const hardTask = db.createTask({ title: '删除记录' })
  edit({ type: 'save-block', block: block(hardTask.id) })
  db.applyOperation({ id: randomUUID(), requestId: randomUUID(), summary: '删除记录', changes: [{ table: 'tasks', id: hardTask.id, before: hardTask, after: null }] })
  assert.equal(db.getPlanner().blocks.some(item => item.taskId === hardTask.id), false)
})

test('invalid action fields and sizes leave the planner and revision unchanged', t => {
  const { db, edit } = fixture(t), task = db.createTask({ title: '验证' })
  const invalidActions = [
    { type: 'toString' }, { type: 'import-routines', routines: [], overwrite: true },
    { type: 'save-routine', routine: routine({ weekdays: [1, 1] }) },
    { type: 'save-routine', routine: routine({ start: '9:00' }) },
    { type: 'save-routine', routine: routine({ end: '08:00' }) },
    { type: 'save-routine', routine: routine({ enabled: 'true' }) },
    { type: 'save-routine', routine: routine({ items: Array(101).fill('a') }) },
    { type: 'save-routine', routine: routine({ unexpected: 1 }) },
    { type: 'save-block', block: block(task.id, { date: '2026-02-30' }) },
    { type: 'save-block', block: block(task.id, { start: '23:00', end: '01:00' }) },
    { type: 'save-details', taskId: task.id, details: details({ preparation: 'x'.repeat(4001) }) },
    { type: 'check-item', date: '2026-09-21', key: 'book', checked: 1 },
  ]
  for (const action of invalidActions) assert.throws(() => edit(action), invalid)
  for (const revision of [-1, 0.5, '0', undefined]) assert.throws(() => db.updatePlanner({ type: 'import-routines', routines: [] }, revision), invalid)
  assert.equal(db.getPlanner().revision, 0)
})

test('HTTP planner exposes shared state without key/provider access and validates envelope/revisions', async t => {
  const { db } = fixture(t)
  const service = createLocalService({ db, vault: { status: () => { throw new Error('key must not be touched') } }, complete: () => { throw new Error('provider must not be called') } })
  assert.equal((await invoke(service)).body.revision, 0)
  const action = { type: 'check-item', date: '2026-09-21', key: 'calculator', checked: true }
  assert.equal((await invoke(service, '/planner', { action, expectedRevision: 0, unknown: 1 })).status, 400)
  const saved = await invoke(service, '/planner', { action, expectedRevision: 0 })
  assert.equal(saved.status, 200); assert.deepEqual(saved.body.checked, { '2026-09-21': ['calculator'] })
  assert.equal((await invoke(service, '/planner', { action, expectedRevision: 0 })).status, 409)
  assert.equal((await invoke(service)).body.revision, 1)
})
