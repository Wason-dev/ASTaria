import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'

const routine = { id: 'evening', title: '晚自习', kind: 'available', weekdays: [2, 3], start: '18:00', end: '20:00', location: '', items: [], enabled: true }
function fixture() {
  const db = createDatabase(':memory:')
  let revision = db.getPlanner().revision
  db.updatePlanner({ type: 'delete-routine', id: 'default-evening-study' }, revision)
  revision = db.getPlanner().revision
  db.updatePlanner({ type: 'save-routine', routine }, revision)
  return db
}
function task(db, date = '2026-09-22', minutes = 20) {
  return db.createTask({ title: `重复事项 ${date}`, estimateMin: minutes, startAt: date,
    occurrence: { seriesId: 'series-a', date, allowFallback: true, placement: 'start' } })
}
function place(db, taskId, date = '2026-09-22', start = '18:00', end = '18:20') {
  db.updatePlanner({ type: 'save-block', block: { id: `block-${taskId}`, taskId, date, start, end, locked: false } }, db.getPlanner().revision)
}

test('editing an occurrence date preserves its existing block id and duration independently of estimate', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db); place(db, item.id)
  const before = db.getTask(item.id)
  db.updateTask(item.id, { occurrence: { ...item.occurrence, date: '2026-09-23' }, startAt: '2026-09-23', estimateMin: 35 }, item.updatedAt)
  const block = db.getPlanner().blocks[0]
  assert.equal(block.id, `block-${item.id}`)
  assert.equal(block.date, '2026-09-23')
  assert.equal(block.start, '18:00')
  assert.equal(block.end, '18:20')
  assert.equal(db.getTask(item.id).estimateMin, 35)
  assert.equal(db.getTask(item.id).occurrence.date, '2026-09-23')
  assert.notEqual(db.getTask(item.id).updatedAt, before.updatedAt)
})

test('quick estimate edits leave every calendar block and planner revision unchanged', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db); place(db, item.id)
  const before = db.getPlanner()
  db.updateTask(item.id, { estimateMin: 35 }, item.updatedAt)
  assert.equal(db.getTask(item.id).estimateMin, 35)
  assert.deepEqual(db.getPlanner(), before)
  const companion = createCompanion({ db, now: () => new Date('2026-09-22T10:00:00+08:00') })
  assert.deepEqual(companion.previewScenario({ date: '2026-09-22', days: 1, mode: 'rebalance' }).unscheduled, [])
})

test('an impossible occurrence edit rolls back both task and block', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db); place(db, item.id)
  const before = { task: db.getTask(item.id), planner: db.getPlanner() }
  assert.throws(() => db.updateTask(item.id, { occurrence: { ...item.occurrence, date: '2026-09-24' }, startAt: '2026-09-24' }, item.updatedAt), /完整时段/u)
  assert.deepEqual(db.getTask(item.id), before.task)
  assert.deepEqual(db.getPlanner(), before.planner)
})

test('the same series cannot contain two live instances on one date', t => {
  const db = fixture(); t.after(() => db.close())
  task(db)
  assert.throws(() => task(db), /已有实例/u)
})

test('decision previews refuse date-bound instances instead of producing a cross-day draft', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db); place(db, item.id)
  const companion = createCompanion({ db, now: () => new Date('2026-09-22T10:00:00+08:00') })
  assert.throws(() => companion.previewDecision({ date: '2026-09-22', taskId: item.id, strategy: 'defer', recurrence: 'once', todayMin: 20 }), /每日实例/u)
})

test('AI occurrence edits undo their linked block and remain exportable', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db); place(db, item.id)
  const before = db.getPlanner().blocks
  const after = { ...item, occurrence: { ...item.occurrence, date: '2026-09-23' }, startAt: '2026-09-23',
    estimateMin: 35, updatedAt: new Date(Date.parse(item.updatedAt) + 1).toISOString() }
  const operation = db.applyOperation({ id: 'reschedule-instance', requestId: 'test-occurrence-update', summary: '更改此次安排',
    changes: [{ table: 'tasks', id: item.id, before: item, after }] })
  assert.equal(db.getPlanner().blocks[0].date, '2026-09-23')
  assert.equal(db.getPlanner().blocks[0].end, '18:20')
  const restored = createDatabase(':memory:'); t.after(() => restored.close())
  restored.importData(db.exportData())
  assert.equal(restored.getTask(item.id).occurrence.date, '2026-09-23')
  db.undoOperation(operation.id)
  assert.equal(db.getTask(item.id).occurrence.date, item.occurrence.date)
  assert.equal(db.getTask(item.id).estimateMin, item.estimateMin)
  assert.deepEqual(db.getPlanner().blocks, before)
})

test('duplicate series dates in a backup are rejected without changing local records', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db), backup = db.exportData()
  backup.tables.tasks.push({ id: 'duplicate-instance', document: JSON.stringify({ ...item, id: 'duplicate-instance' }) })
  backup.checksum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex')
  assert.throws(() => db.importData(backup), /已有实例/u)
  assert.deepEqual(db.listTasks(), [item])
})

test('backup restore rejects wrong-date or multiple occurrence blocks while allowing revised estimates', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db); place(db, item.id)
  db.updateTask(item.id, { estimateMin: 35 }, item.updatedAt)
  const beforeTask = db.getTask(item.id), before = db.getPlanner(), original = db.exportData()
  const restored = createDatabase(':memory:'); t.after(() => restored.close())
  restored.importData(original)
  assert.equal(restored.getPlanner().blocks[0].end, '18:20')
  assert.equal(restored.getTask(item.id).estimateMin, 35)
  for (const mutate of [planner => { planner.blocks[0].date = '2026-09-23' },
    planner => planner.blocks.push({ ...planner.blocks[0], id: 'duplicate-block', start: '19:00', end: '19:20' })]) {
    const backup = structuredClone(original), row = backup.tables.state.find(row => row.key === 'planner-v1')
    const planner = JSON.parse(row.value)
    mutate(planner)
    row.value = JSON.stringify(planner)
    backup.checksum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex')
    assert.throws(() => db.importData(backup), /重复实例/u)
    assert.deepEqual(db.getPlanner(), before)
    assert.deepEqual(db.getTask(item.id), beforeTask)
  }
})

test('an occupied destination and later planner edits cannot partially overwrite or undo an instance', t => {
  const db = fixture(); t.after(() => db.close())
  const item = task(db); place(db, item.id)
  const other = db.createTask({ title: '原有安排' }); place(db, other.id, '2026-09-23', '18:00', '18:30')
  const before = { task: db.getTask(item.id), planner: db.getPlanner() }
  assert.throws(() => db.updateTask(item.id, { occurrence: { ...item.occurrence, date: '2026-09-23' }, startAt: '2026-09-23' }, item.updatedAt), /其他任务/u)
  assert.deepEqual(db.getTask(item.id), before.task)
  assert.deepEqual(db.getPlanner(), before.planner)
  const operation = db.applyOperation({ id: 'move-instance', requestId: 'test-instance-move', summary: '修改日期',
    changes: [{ table: 'tasks', id: item.id, before: item, after: { ...item, occurrence: { ...item.occurrence, date: '2026-09-29' }, startAt: '2026-09-29',
      updatedAt: new Date(Date.parse(item.updatedAt) + 1).toISOString() } }] })
  const latest = db.getTask(item.id)
  db.updatePlanner({ type: 'save-routine', routine: { ...routine, location: '新地点' } }, db.getPlanner().revision)
  assert.throws(() => db.undoOperation(operation.id), /新的修改/u)
  assert.deepEqual(db.getTask(item.id), latest)
  assert.equal(db.getPlanner().blocks.find(block => block.taskId === item.id).date, '2026-09-29')
})
