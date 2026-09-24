import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { initialTaskSchedule } from '../server/autoSchedule.mjs'
import { carryItems, dayCapacity, routinesForDay, visibleTimetableRoutines, weeklyRoutineSource } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const date = '2026-09-23', nextDate = '2026-09-24', at = new Date(`${date}T12:00:00+08:00`)
const event = (patch = {}) => ({ id: 'school-anniversary', title: '校庆活动', date, start: '17:00', end: '20:00', location: '礼堂', items: ['校服'], ...patch })
const routine = (patch = {}) => ({ id: 'weekly-class', title: '物理', kind: 'class', weekdays: [3], start: '16:30', end: '17:30', location: '教室', items: [], enabled: true, ...patch })
const block = (taskId, patch = {}) => ({ id: randomUUID(), taskId, date, start: '18:00', end: '19:00', locked: false, ...patch })
const save = value => ({ type: 'save-day-event', event: value })
const operation = (db, actions, patch = {}) => ({ id: randomUUID(), requestId: randomUUID(), summary: '记录当天固定活动', actions, expectedRevision: db.getPlanner().revision, ...patch })
const sign = backup => { backup.checksum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex'); return backup }
const invalid = error => error.status === 400
const conflict = error => error.status === 409

function fixture(t, persistent = false) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'astaria-day-events-')) : null
  const filename = directory ? join(directory, 'qa.sqlite') : ':memory:', connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  const close = db => { db.close(); connections.delete(db) }
  t.after(() => { for (const db of connections) db.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })
  const db = open(), edit = action => db.updatePlanner(action, db.getPlanner().revision)
  return { db, edit, open, close }
}

test('fixed events save outside availability without creating tasks or changing weekly routines', t => {
  const f = fixture(t, true), before = f.db.getPlanner()
  const events = [event(), event({ id: 'evening-class', title: '晚课', start: '20:15', end: '21:15', items: ['课本'] })]
  f.db.applyPlannerOperation(operation(f.db, events.map(save)))
  const state = f.db.getPlanner()
  assert.deepEqual(state.dayEvents, events)
  assert.deepEqual(state.routines, before.routines)
  assert.deepEqual(state.dayOverrides, before.dayOverrides)
  assert.deepEqual(f.db.listTasks(), [])
  assert.equal(dayCapacity(state, [], date, at).totalMin, 0)
  assert.equal(dayCapacity(state, [], nextDate, at).totalMin, 120)
  assert.equal(routinesForDay(state, nextDate).some(row => row.sourceDate), false)
  const rows = routinesForDay(state, date).filter(row => row.sourceDate)
  assert.deepEqual(rows.map(row => [row.id, row.sourceDate, row.start, row.end]), events.map(value => [value.id, date, value.start, value.end]))
  assert.equal(weeklyRoutineSource(state, rows[0]), undefined)
  assert.equal(visibleTimetableRoutines(routinesForDay(state, date)).some(row => row.kind === 'available'), false)
  assert.deepEqual(new Set(carryItems(state, [], date).map(item => item.label)), new Set(['校服', '课本']))
  rows[0].items.push('不应写回'); rows[0].weekdays.push(6)
  assert.deepEqual(f.db.getPlanner(), state)
  f.close(f.db)
  assert.deepEqual(f.open().getPlanner(), state)
})

test('reported events preserve locked tasks and expose collisions with tasks, classes and other events', t => {
  const { db, edit } = fixture(t)
  edit({ type: 'save-routine', routine: routine() })
  const task = db.createTask({ title: '已有任务' }), planned = block(task.id, { locked: true })
  edit({ type: 'save-block', block: planned })
  const legacy = db.createTask({ title: '旧版定时任务', startAt: `${date}T19:30:00+08:00`, estimateMin: 15 })
  const tasksBefore = db.listTasks()
  edit(save(event()))
  edit(save(event({ id: 'second-event', title: '同时活动', start: '17:30', end: '18:00' })))
  assert.deepEqual(db.listTasks(), tasksBefore)
  assert.deepEqual(db.getPlanner().blocks, [planned])
  assert.deepEqual(new Set(dayCapacity(db.getPlanner(), db.listTasks(), date, at).conflicts),
    new Set([planned.id, `task:${legacy.id}`, 'weekly-class', 'school-anniversary', 'second-event']))
  assert.equal(db.getPlanner().blocks[0].locked, true)
  // Unlocking the old task is still possible after a real event exposes it.
  edit({ type: 'save-block', block: { ...planned, locked: false } })
})

test('new task placements avoid fixed events while touching boundaries remain valid', t => {
  const { db, edit } = fixture(t), task = db.createTask({ title: '报告' })
  edit(save(event()))
  const before = db.getPlanner()
  for (const timing of [{ start: '16:50', end: '17:01' }, { start: '19:59', end: '20:05' }, { start: '18:00', end: '19:00' }]) {
    assert.throws(() => edit({ type: 'save-block', block: block(task.id, timing) }), conflict)
    assert.deepEqual(db.getPlanner(), before)
  }
  edit({ type: 'save-block', block: block(task.id, { start: '16:30', end: '17:00' }) })
  edit({ type: 'save-block', block: block(task.id, { start: '20:00', end: '20:15' }) })
  assert.deepEqual(dayCapacity(db.getPlanner(), db.listTasks(), date, at).conflicts, [])
})

test('event and task batches validate their final state atomically in either action order', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' }), proposed = block(task.id)
  const before = db.getPlanner()
  for (const actions of [[save(event()), { type: 'save-block', block: proposed }], [{ type: 'save-block', block: proposed }, save(event())]]) {
    assert.throws(() => db.applyPlannerOperation(operation(db, actions)), conflict)
    assert.deepEqual(db.getPlanner(), before)
    assert.deepEqual(db.listOperations(), [])
  }
  assert.throws(() => db.applyPlannerOperation(operation(db, [save(event()), save(event({ id: 'invalid', end: '16:00' }))])), invalid)
  assert.deepEqual(db.getPlanner(), before)
  const receipt = db.applyPlannerOperation(operation(db, [save(event()), { type: 'save-block', block: { ...proposed, start: '20:00', end: '20:15' } }]))
  assert.equal(db.getPlanner().dayEvents.length, 1)
  assert.equal(db.getPlanner().blocks.length, 1)
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 3 })
})

test('event create, edit and delete receipts are idempotent, undoable and revision protected', t => {
  const { db, edit } = fixture(t), before = db.getPlanner()
  const input = operation(db, [save(event())]), created = db.applyPlannerOperation(input)
  assert.deepEqual(db.applyPlannerOperation(input), created)
  assert.equal(db.getPlanner().dayEvents.length, 1)
  db.undoOperation(created.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 2 })
  edit(save(event()))
  for (const action of [save(event({ title: '校庆调整', date: nextDate, start: '16:00' })), { type: 'delete-day-event', id: event().id }]) {
    const previous = db.getPlanner(), receipt = db.applyPlannerOperation(operation(db, [action]))
    if (action.type === 'save-day-event') {
      assert.equal(routinesForDay(db.getPlanner(), date).some(row => row.sourceDate), false)
      assert.equal(routinesForDay(db.getPlanner(), nextDate).find(row => row.sourceDate)?.sourceDate, nextDate)
    }
    db.undoOperation(receipt.id)
    assert.deepEqual(db.getPlanner(), { ...previous, revision: previous.revision + 2 })
  }
  const stale = db.getPlanner().revision, deleted = db.applyPlannerOperation(operation(db, [{ type: 'delete-day-event', id: event().id }]))
  edit({ type: 'check-item', date, key: '校服', checked: true })
  const current = db.getPlanner()
  assert.throws(() => db.undoOperation(deleted.id), conflict)
  assert.throws(() => db.updatePlanner(save(event()), stale), conflict)
  assert.deepEqual(db.getPlanner(), current)
})

test('weekday edits, template refreshes and restoring the original day never replace fixed events', t => {
  t.mock.timers.enable({ apis: ['Date'], now: at.getTime() })
  const { db, edit } = fixture(t)
  edit({ type: 'save-routine', routine: routine({ weekdays: [4] }) })
  edit(save(event()))
  edit({ type: 'set-day-template', date, sourceWeekday: 4 })
  edit({ type: 'save-routine', routine: routine({ weekdays: [4], title: '物理实验' }) })
  edit({ type: 'edit-weekday', weekday: 4, replacements: [{ routineId: 'weekly-class', title: '化学', kind: 'class' }], syncDates: [date] })
  assert.deepEqual(db.getPlanner().dayEvents, [event()])
  assert.equal(routinesForDay(db.getPlanner(), date).find(row => row.sourceDate)?.title, '校庆活动')
  edit({ type: 'remove-day-template', date })
  assert.deepEqual(db.getPlanner().dayEvents, [event()])
  assert.equal(routinesForDay(db.getPlanner(), date).find(row => row.sourceDate)?.title, '校庆活动')
})

test('automatic and recurring task scheduling use event occupancy', t => {
  const { db, edit } = fixture(t)
  edit(save(event({ start: '18:00', end: '19:00' })))
  const task = db.createTask({ title: '报告', startAt: date, due: date, estimateMin: 30 })
  const result = initialTaskSchedule({ state: db.getPlanner(), allTasks: db.listTasks(), tasks: [task], now: at, idForBlock: () => 'auto-report' })
  assert.equal(result.plans.length, 1)
  assert.deepEqual([result.plans[0].start, result.plans[0].end], ['19:00', '19:30'])
  const recurring = db.createTask({ title: '重复练习', startAt: nextDate, estimateMin: 20,
    occurrence: { seriesId: 'practice', date: nextDate, allowFallback: true, placement: 'start' } })
  edit({ type: 'save-block', block: block(recurring.id, { date: nextDate, end: '18:20' }) })
  const previous = db.getPlanner(), taskBefore = db.getTask(recurring.id)
  assert.throws(() => db.updateTask(recurring.id, { occurrence: { ...recurring.occurrence, date }, startAt: date }, recurring.updatedAt), conflict)
  assert.deepEqual(db.getPlanner(), previous)
  assert.deepEqual(db.getTask(recurring.id), taskBefore)
})

test('backups retain fixed events and validate state, action and undo snapshot event payloads', t => {
  const { db, edit } = fixture(t)
  edit(save(event()))
  db.applyPlannerOperation(operation(db, [save(event({ id: 'class', start: '20:15', end: '21:15' }))]))
  const original = db.exportData(), before = db.getPlanner()
  const mutations = [
    state => { state.dayEvents = null }, state => { state.dayEvents = {} },
    state => { state.dayEvents = [event(), event()] },
    state => { state.dayEvents[0].date = '2026-02-30' },
    state => { state.dayEvents[0].start = '25:00' },
    state => { state.dayEvents[0].end = '16:00' },
    state => { state.dayEvents[0].items = ['校服', '校服'] },
    state => { state.dayEvents[0].sourceDate = date },
    state => { state.dayEvents = Array.from({ length: 3001 }, (_, index) => event({ id: `event-${index}` })) },
  ]
  for (const mutate of mutations) {
    const backup = structuredClone(original), row = backup.tables.state.find(item => item.key === 'planner-v1'), state = JSON.parse(row.value)
    mutate(state); row.value = JSON.stringify(state)
    assert.throws(() => db.importData(sign(backup)), invalid)
    assert.deepEqual(db.getPlanner(), before)
  }
  for (const mutate of [
    receipt => { receipt.requestedActions[0].event.date = 'bad' },
    receipt => { receipt.plannerBefore.dayEvents = [event({ extra: true })] },
  ]) {
    const backup = structuredClone(original), row = backup.tables.operations[0], receipt = JSON.parse(row.document)
    mutate(receipt); row.document = JSON.stringify(receipt)
    assert.throws(() => db.importData(sign(backup)), invalid)
    assert.deepEqual(db.getPlanner(), before)
  }
  edit({ type: 'delete-day-event', id: event().id })
  assert.equal(db.importData(original).restored, true)
  assert.deepEqual(db.getPlanner().dayEvents, before.dayEvents)
  assert.equal(db.listOperations()[0].undoable, false)
  assert.equal(db.importData(db.exportData()).restored, true)
})

test('legacy backups without dayEvents can add an event and undo to the legacy snapshot', t => {
  const { db } = fixture(t)
  db.getPlanner()
  const backup = db.exportData(), row = backup.tables.state.find(item => item.key === 'planner-v1'), state = JSON.parse(row.value)
  delete state.dayEvents; row.value = JSON.stringify(state)
  db.importData(sign(backup))
  const before = db.getPlanner()
  assert.equal(Object.hasOwn(before, 'dayEvents'), false)
  const receipt = db.applyPlannerOperation(operation(db, [save(event())]))
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 2 })
})

test('malformed live event writes fail without changing other planner data', t => {
  const { db, edit } = fixture(t), before = db.getPlanner()
  for (const value of [event({ date: '2026-02-30' }), event({ end: '17:00' }), event({ start: '25:00' }),
    event({ title: '' }), event({ taskId: 'unrelated' }), event({ items: ['校服', '校服'] })]) {
    assert.throws(() => edit(save(value)), invalid)
  }
  assert.throws(() => edit({ ...save(event()), extra: true }), invalid)
  assert.throws(() => edit({ type: 'delete-day-event', id: 'missing' }), error => error.status === 404)
  assert.deepEqual(db.getPlanner(), before)
})
