import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { blocksForDay, carryItems, dayCapacity, routinesForDay } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const sunday = '2026-09-20', thursday = '2026-09-24', nextSunday = '2026-09-27'
const now = new Date('2026-09-19T12:00:00+08:00')
const routine = (patch = {}) => ({ id: 'thursday-class', title: '物理实验', kind: 'class', weekdays: [4], start: '09:00', end: '10:00', location: '实验室', items: ['实验手册'], enabled: true, ...patch })
const block = (taskId, patch = {}) => ({ id: randomUUID(), taskId, date: sunday, start: '09:15', end: '09:45', locked: false, ...patch })
const operation = (db, actions, patch = {}) => ({ id: randomUUID(), requestId: randomUUID(), summary: '周日按周四课表上课', actions, expectedRevision: db.getPlanner().revision, ...patch })
const change = { type: 'set-day-template', date: sunday, sourceWeekday: 4 }
const sign = backup => { backup.checksum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex'); return backup }
const invalid = error => error.status === 400
const conflict = error => error.status === 409

function fixture(t, { persistent = false } = {}) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'astaria-day-override-')) : null
  const filename = directory ? join(directory, 'qa.sqlite') : ':memory:'
  const connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  const close = db => { db.close(); connections.delete(db) }
  t.after(() => { for (const db of connections) db.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })
  const db = open(), edit = action => db.updatePlanner(action, db.getPlanner().revision)
  const seed = () => edit({ type: 'import-routines', routines: [
    routine(),
    routine({ id: 'thursday-morning', title: '上午可安排', kind: 'available', start: '09:00', end: '12:00', items: [] }),
    routine({ id: 'thursday-break', title: '课间休息', kind: 'break', start: '10:30', end: '11:00', items: ['水杯'] }),
    routine({ id: 'disabled-class', title: '停课', start: '11:00', end: '12:00', enabled: false, items: ['不该携带'] }),
    routine({ id: 'sunday-class', title: '周日旧课表', weekdays: [0], start: '11:00', end: '12:00', items: ['周日课本'] }),
  ] })
  return { db, edit, seed, open, close }
}

test('one Sunday uses a durable Thursday snapshot including availability, breaks and carry items', t => {
  const f = fixture(t, { persistent: true })
  f.seed()
  const before = f.db.getPlanner(), state = f.edit(change)
  assert.deepEqual(state.routines, before.routines)
  assert.equal(state.dayOverrides[sunday].sourceWeekday, 4)
  assert.equal(state.dayOverrides[sunday].date, sunday)
  assert.deepEqual(routinesForDay(state, sunday), routinesForDay(before, thursday))
  assert.deepEqual(routinesForDay(state, thursday), routinesForDay(before, thursday))
  assert.deepEqual(routinesForDay(state, nextSunday), routinesForDay(before, nextSunday))
  assert.deepEqual(new Set(carryItems(state, [], sunday).map(item => item.label)), new Set(['实验手册', '水杯']))
  assert.equal(dayCapacity(state, [], sunday, now).totalMin, 210)
  assert.equal(dayCapacity(state, [], nextSunday, now).totalMin, 720)
  // Reading an override must not allow callers to mutate its durable snapshot.
  const returned = routinesForDay(state, sunday)
  returned[0].items.push('外部修改'); returned[0].weekdays.push(6)
  assert.deepEqual(f.db.getPlanner(), state)
  f.close(f.db)
  assert.deepEqual(f.open().getPlanner(), state)
})

test('historical snapshot remains stable after its source class is edited or deleted and backups retain it', t => {
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() })
  const { db, seed, edit } = fixture(t)
  const historicalSunday = '2026-09-13'
  seed(); edit({ ...change, date: historicalSunday })
  const original = routinesForDay(db.getPlanner(), historicalSunday)
  edit({ type: 'save-routine', routine: routine({ title: '周四新课程', items: ['新课本'] }) })
  assert.equal(routinesForDay(db.getPlanner(), thursday).find(item => item.id === 'thursday-class').title, '周四新课程')
  assert.deepEqual(routinesForDay(db.getPlanner(), historicalSunday), original)
  edit({ type: 'delete-routine', id: 'thursday-class' })
  assert.deepEqual(routinesForDay(db.getPlanner(), historicalSunday), original)
  const backup = db.exportData()
  edit({ type: 'remove-day-template', date: historicalSunday })
  assert.ok(routinesForDay(db.getPlanner(), historicalSunday).some(item => item.id === 'sunday-class'))
  assert.equal(db.importData(backup).restored, true)
  assert.deepEqual(routinesForDay(db.getPlanner(), historicalSunday), original)
})

test('applying the real school day preserves tasks and exposes collisions; later plan writes obey the override', t => {
  const { db, seed, edit } = fixture(t)
  seed()
  const explicit = db.createTask({ title: '已经安排的报告' })
  const planned = block(explicit.id, { locked: true })
  edit({ type: 'save-block', block: planned })
  const legacy = db.createTask({ title: '旧版定时任务', startAt: `${sunday}T09:00:00+08:00`, estimateMin: 10 })
  const beforeTasks = db.listTasks()
  edit(change)
  assert.deepEqual(db.getPlanner().blocks, [planned])
  assert.deepEqual(db.listTasks(), beforeTasks)
  assert.deepEqual(new Set(dayCapacity(db.getPlanner(), db.listTasks(), sunday, now).conflicts), new Set([planned.id, `task:${legacy.id}`]))
  assert.equal(blocksForDay(db.getPlanner(), db.listTasks(), sunday).length, 2)
  const other = db.createTask({ title: '另一个任务' }), before = db.getPlanner()
  for (const timing of [{ start: '09:50', end: '10:00' }, { start: '10:30', end: '10:40' }]) {
    assert.throws(() => edit({ type: 'save-block', block: block(other.id, timing) }), conflict)
    assert.deepEqual(db.getPlanner(), before)
  }
  // The replaced Sunday class no longer occupies 11:00; next Sunday still does.
  edit({ type: 'save-block', block: block(other.id, { start: '11:00', end: '11:30' }) })
  assert.throws(() => edit({ type: 'save-block', block: block(other.id, { date: nextSunday, start: '11:00', end: '11:30' }) }), conflict)
  edit({ type: 'save-block', block: block(other.id, { date: nextSunday }) })
  // An existing locked task remains unlockable so a collision can be resolved.
  edit({ type: 'save-block', block: { ...planned, locked: false } })
  edit({ type: 'delete-block', id: planned.id })
  assert.ok(!dayCapacity(db.getPlanner(), db.listTasks(), sunday, now).conflicts.includes(planned.id))
})

test('weekly edits ignore overridden dates while keeping ordinary weekday conflict checks', t => {
  const { db, seed, edit } = fixture(t)
  seed(); edit(change)
  const task = db.createTask({ title: '计划' })
  edit({ type: 'save-block', block: block(task.id, { start: '11:00', end: '11:30' }) })
  edit({ type: 'save-routine', routine: routine({ id: 'sunday-new-class', weekdays: [0], start: '11:00', end: '12:00' }) })
  assert.ok(!routinesForDay(db.getPlanner(), sunday).some(item => item.id === 'sunday-new-class'))
  edit({ type: 'save-block', block: block(task.id, { date: nextSunday }) })
  assert.throws(() => edit({ type: 'save-routine', routine: routine({ id: 'sunday-overlap', weekdays: [0] }) }), conflict)
})

test('undo restores a previous override or the original weekday without losing task blocks', t => {
  const { db, seed, edit } = fixture(t)
  seed()
  const task = db.createTask({ title: '已有任务' }), planned = block(task.id)
  edit({ type: 'save-block', block: planned })
  const before = db.getPlanner(), receipt = db.applyPlannerOperation(operation(db, [change]))
  assert.equal(receipt.undoable, true)
  assert.deepEqual(receipt.requestedActions, [change])
  assert.deepEqual(dayCapacity(db.getPlanner(), db.listTasks(), sunday, now).conflicts, [planned.id])
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 2 })
  edit(change)
  const overrideBefore = db.getPlanner()
  const removed = db.applyPlannerOperation(operation(db, [{ type: 'remove-day-template', date: sunday }]))
  db.undoOperation(removed.id)
  assert.deepEqual(db.getPlanner(), { ...overrideBefore, revision: overrideBefore.revision + 2 })
  assert.deepEqual(db.getPlanner().blocks, [planned])
  assert.equal(db.importData(db.exportData()).restored, true)
})

test('undo and stale set requests cannot overwrite concurrent manual changes', t => {
  const { db, seed, edit } = fixture(t)
  seed()
  const before = db.getPlanner(), receipt = db.applyPlannerOperation(operation(db, [change]))
  edit({ type: 'check-item', date: sunday, key: '水杯', checked: true })
  const latest = db.getPlanner()
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.throws(() => db.updatePlanner(change, before.revision), conflict)
  assert.deepEqual(db.getPlanner(), latest)
})

test('retracted requests cannot apply day changes while an existing receipt stays explicitly undoable', t => {
  const { db, seed } = fixture(t)
  seed()
  const request = { requestId: randomUUID(), conversationId: 'main', text: '明天按周四课表上课', context: {} }
  db.beginTurn(request)
  const before = db.getPlanner(), input = operation(db, [change], { requestId: request.requestId })
  const receipt = db.applyPlannerOperation(input)
  assert.deepEqual(db.applyPlannerOperation(input), receipt)
  db.retractRequest(request)
  assert.throws(() => db.applyPlannerOperation(input), conflict)
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'remove-day-template', date: sunday }], { requestId: request.requestId })), conflict)
  assert.ok(db.getPlanner().dayOverrides[sunday])
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 2 })
})

test('a later conflicting plan in the same batch rolls back both the override and receipt', t => {
  const { db, seed } = fixture(t)
  seed()
  const task = db.createTask({ title: '不能排进课程的任务' }), before = db.getPlanner()
  assert.throws(() => db.applyPlannerOperation(operation(db, [change, { type: 'save-block', block: block(task.id) }])), conflict)
  assert.deepEqual(db.getPlanner(), before)
  assert.deepEqual(db.listOperations(), [])
})

test('unknown source courses and malformed day operations fail without inventing a timetable', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'save-routine', routine: routine({ enabled: false }) })
  const before = db.getPlanner()
  assert.throws(() => edit(change), error => error.status === 409 && /先录入或导入.*真实课表/u.test(error.message))
  for (const action of [
    { ...change, sourceWeekday: -1 }, { ...change, sourceWeekday: 7 }, { ...change, sourceWeekday: '4' }, { ...change, sourceWeekday: 4.5 },
    { ...change, date: '2026-02-30' }, { ...change, date: '__proto__' }, { ...change, routines: [] },
    { type: 'remove-day-template', date: 'tomorrow' }, { type: 'remove-day-template', date: sunday, sourceWeekday: 4 },
  ]) assert.throws(() => edit(action), invalid)
  assert.throws(() => edit({ type: 'remove-day-template', date: sunday }), error => error.status === 404)
  assert.deepEqual(db.getPlanner(), before)
})

test('legacy backups without dayOverrides keep working and can gain and undo a day override', t => {
  const { db, seed } = fixture(t)
  seed()
  const backup = db.exportData(), row = backup.tables.state.find(item => item.key === 'planner-v1'), legacy = JSON.parse(row.value)
  delete legacy.dayOverrides
  row.value = JSON.stringify(legacy)
  db.importData(sign(backup))
  const before = db.getPlanner()
  assert.equal(Object.hasOwn(before, 'dayOverrides'), false)
  assert.deepEqual(routinesForDay(before, sunday).map(item => item.id), ['default-weekend-availability', 'sunday-class'])
  const receipt = db.applyPlannerOperation(operation(db, [change]))
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 2 })
})

test('malformed or oversized override backups are rejected transactionally', t => {
  const { db, seed, edit } = fixture(t)
  seed(); edit(change)
  const before = db.getPlanner(), original = db.exportData()
  const mutations = [
    state => { state.dayOverrides = null }, state => { state.dayOverrides = [] },
    state => { state.dayOverrides = { '2026-02-30': state.dayOverrides[sunday] } },
    state => { state.dayOverrides[sunday].date = nextSunday },
    state => { state.dayOverrides[sunday].sourceWeekday = 9 },
    state => { state.dayOverrides[sunday].extra = true },
    state => { state.dayOverrides[sunday].routines = [] },
    state => { state.dayOverrides[sunday].routines = [routine({ kind: 'available' })] },
    state => { state.dayOverrides[sunday].routines = [routine({ enabled: false })] },
    state => { state.dayOverrides[sunday].routines = [routine({ weekdays: [0] })] },
    state => { state.dayOverrides[sunday].routines = [routine(), routine()] },
    state => { state.dayOverrides[sunday].routines = Array.from({ length: 301 }, (_, i) => routine({ id: `course-${i}` })) },
    state => {
      state.dayOverrides = Object.fromEntries(Array.from({ length: 3661 }, (_, i) => {
        const date = new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10)
        return [date, { date, sourceWeekday: 4, routines: [routine()] }]
      }))
    },
  ]
  for (const mutate of mutations) {
    const backup = structuredClone(original), row = backup.tables.state.find(item => item.key === 'planner-v1'), state = JSON.parse(row.value)
    mutate(state); row.value = JSON.stringify(state)
    assert.throws(() => db.importData(sign(backup)), invalid)
    assert.deepEqual(db.getPlanner(), before)
  }
})
