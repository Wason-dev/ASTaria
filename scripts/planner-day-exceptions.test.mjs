import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { blocksForDay, carryItems, dayCapacity, routinesForDay } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
// The whole file runs against a real SQLite database through createDatabase, so
// every assertion below is about durable planner state, not an in-memory model.
// Exception actions are driven through the browser planner endpoint
// (updatePlanner), the path this suite owns. Assistant receipt actions carry
// their own action whitelist in server/database.mjs and are not pinned here.
const now = new Date('2026-09-19T12:00:00+08:00')
const sunday = '2026-09-20', thursday = '2026-09-24', saturday = '2026-09-26', nextSunday = '2026-09-27'
const holidayStart = '2026-10-01', holidayEnd = '2026-10-07'
const holidayDates = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
const ids = rows => rows.map(row => row.id)
const labels = rows => rows.map(row => row.label)

const routine = (patch = {}) => ({ id: 'thursday-class', title: '物理实验', kind: 'class', weekdays: [4], start: '09:00', end: '10:00', location: '实验室', items: ['实验手册'], enabled: true, ...patch })
const dayEvent = (date, patch = {}) => ({ id: 'ceremony', title: '校庆典礼', date, start: '09:30', end: '10:30', location: '礼堂', items: ['活动手册'], ...patch })
const exception = (date, kind, patch = {}) => ({ type: 'set-day-exception', date, kind, ...patch })
const sign = backup => { backup.checksum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex'); return backup }
const invalid = error => error.status === 400
const conflict = error => error.status === 409
const missing = error => error.status === 404

function fixture(t, { persistent = false } = {}) {
  // A frozen clock keeps "future" template refreshes and capacity remaining
  // windows deterministic while the real database does the storing.
  t.mock.timers.enable({ apis: ['Date'], now: now.getTime() })
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'astaria-day-exceptions-')) : null
  const filename = directory ? join(directory, 'qa.sqlite') : ':memory:'
  const connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  const close = db => { db.close(); connections.delete(db) }
  t.after(() => { for (const db of connections) db.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })
  const db = open(), edit = action => db.updatePlanner(action, db.getPlanner().revision)
  const state = () => db.getPlanner(), tasks = () => db.listTasks()
  const seed = () => edit({ type: 'import-routines', routines: [
    routine(),
    routine({ id: 'thursday-available', title: '上午可安排', kind: 'available', start: '09:00', end: '12:00', items: [] }),
    routine({ id: 'thursday-break', title: '课间休息', kind: 'break', start: '10:30', end: '11:00', items: ['水杯'] }),
    routine({ id: 'sunday-class', title: '周日旧课表', weekdays: [0], start: '11:00', end: '12:00', items: ['周日课本'] }),
  ] })
  const block = (taskId, patch = {}) => ({ id: randomUUID(), taskId, date: sunday, start: '09:15', end: '09:45', locked: false, ...patch })
  const operation = (actions, patch = {}) => ({ id: randomUUID(), requestId: randomUUID(), summary: '日历例外操作', actions, expectedRevision: db.getPlanner().revision, ...patch })
  return { db, filename, edit, state, tasks, seed, block, operation, open, close }
}

test('a consecutive holiday replaces classes with free-day availability and survives a reopen', t => {
  const f = fixture(t, { persistent: true })
  f.seed()
  // A task already planned inside the span keeps its block and its task record.
  const task = f.db.createTask({ title: '假期里的任务' })
  const tasksBefore = f.tasks()
  const planned = f.block(task.id, { date: holidayStart, start: '13:00', end: '13:30' })
  f.edit({ type: 'save-block', block: planned })
  f.edit({ type: 'save-day-event', event: dayEvent('2026-10-03') })
  // A legacy template written inside the span is superseded by the holiday.
  f.edit({ type: 'set-day-template', date: '2026-10-02', sourceWeekday: 4 })
  const before = f.state()
  assert.equal(before.dayOverrides['2026-10-02'].sourceWeekday, 4)
  const beforeCapacity = dayCapacity(before, f.tasks(), holidayStart, now)
  assert.equal(beforeCapacity.totalMin, 210)
  f.edit(exception(holidayStart, 'holiday', { endDate: holidayEnd }))
  const state = f.state()
  assert.equal(state.revision, before.revision + 1)
  assert.deepEqual(state.dayOverrides, {})
  assert.deepEqual(f.tasks(), tasksBefore)
  assert.deepEqual(blocksForDay(state, f.tasks(), holidayStart), [planned])
  assert.deepEqual(Object.keys(state.dayExceptions).sort(), holidayDates)
  for (const date of holidayDates) {
    assert.equal(state.dayExceptions[date].kind, 'holiday')
    assert.deepEqual(ids(state.dayExceptions[date].routines), ['default-weekend-availability'])
    // A single-day event remains a fixed fact inside the holiday window.
    assert.deepEqual(ids(routinesForDay(state, date)), date === '2026-10-03' ? ['default-weekend-availability', 'ceremony'] : ['default-weekend-availability'])
    assert.equal(dayCapacity(state, f.tasks(), date, now).totalMin, date === '2026-10-03' ? 720 : 780)
    assert.equal(dayCapacity(state, f.tasks(), date, now).freeMin, date === '2026-10-03' ? 720 : date === holidayStart ? 750 : 780)
  }
  assert.deepEqual(carryItems(state, f.tasks(), holidayStart), [])
  assert.deepEqual(labels(carryItems(state, f.tasks(), '2026-10-03')), ['活动手册'])
  // Control: without the holiday that Sunday carries its class items.
  assert.deepEqual(labels(carryItems(before, f.tasks(), '2026-10-04')), ['周日课本'])
  assert.deepEqual(carryItems(state, f.tasks(), '2026-10-04'), [])
  // Days outside the span keep the weekly timetable untouched.
  assert.deepEqual(routinesForDay(state, '2026-09-30'), routinesForDay(before, '2026-09-30'))
  assert.deepEqual(routinesForDay(state, '2026-10-08'), routinesForDay(before, '2026-10-08'))
  assert.equal(dayCapacity(state, f.tasks(), '2026-10-08', now).totalMin, beforeCapacity.totalMin)
  // The rows are really in SQLite, not only in the returned object.
  f.close(f.db)
  const raw = new DatabaseSync(f.filename)
  try {
    const stored = JSON.parse(raw.prepare("SELECT value FROM state WHERE key = 'planner-v1'").get().value)
    assert.deepEqual(Object.keys(stored.dayExceptions).sort(), holidayDates)
    assert.equal(stored.dayExceptions[holidayEnd].kind, 'holiday')
    assert.deepEqual(ids(stored.dayExceptions[holidayEnd].routines), ['default-weekend-availability'])
    assert.deepEqual(ids(stored.dayEvents), ['ceremony'])
  } finally { raw.close() }
  const reopened = f.open()
  assert.deepEqual(reopened.getPlanner(), state)
  f.close(reopened)
})

test('holiday windows are saved snapshots; old records and missing windows stay honest', t => {
  const f = fixture(t)
  f.seed()
  const monday = '2026-10-05', tuesday = '2026-10-06'
  f.edit(exception(monday, 'holiday'))
  const saved = f.state().dayExceptions[monday]
  assert.deepEqual(saved.routines.map(row => [row.start, row.end]), [['09:00', '22:00']])

  const weekend = f.state().routines.find(row => row.id === 'default-weekend-availability')
  f.edit({ type: 'save-routine', routine: { ...weekend, start: '08:00', end: '22:30' } })
  assert.deepEqual(f.state().dayExceptions[monday], saved)
  assert.equal(dayCapacity(f.state(), f.tasks(), monday, now).totalMin, 780)
  f.edit(exception(tuesday, 'holiday'))
  assert.deepEqual(f.state().dayExceptions[tuesday].routines.map(row => [row.start, row.end]), [['08:00', '22:30']])

  // A pre-upgrade holiday has no snapshot and resolves from the current free-day template.
  const legacy = f.state()
  legacy.dayExceptions[monday] = { date: monday, kind: 'holiday' }
  assert.equal(dayCapacity(legacy, f.tasks(), monday, now).totalMin, 870)

  f.edit({ type: 'delete-routine', id: 'default-weekend-availability' })
  f.edit({ type: 'delete-routine', id: 'default-evening-study' })
  f.edit(exception('2026-10-08', 'holiday'))
  assert.deepEqual(f.state().dayExceptions['2026-10-08'].routines.filter(row => row.kind === 'available').map(row => [row.start, row.end]), [['09:00', '12:00']])
  f.edit(exception('2026-10-07', 'holiday'))
  assert.deepEqual(f.state().dayExceptions['2026-10-07'].routines, [])
  assert.equal(dayCapacity(f.state(), f.tasks(), '2026-10-07', now).totalMin, 0)
})

test('a Sunday holiday can use Saturday availability when Sunday has none', t => {
  const f = fixture(t)
  f.seed()
  const weekend = f.state().routines.find(row => row.id === 'default-weekend-availability')
  f.edit({ type: 'save-routine', routine: { ...weekend, weekdays: [6] } })
  f.edit(exception('2026-10-04', 'holiday'))
  const state = f.state()
  assert.equal(state.dayExceptions['2026-10-04'].kind, 'holiday')
  assert.deepEqual(ids(routinesForDay(state, '2026-10-04')), ['default-weekend-availability'])
  assert.equal(dayCapacity(state, f.tasks(), '2026-10-04', now).totalMin, 780)
})

test('a cancelled day works where the legacy weekday template refuses a week without classes', t => {
  const f = fixture(t)
  f.seed()
  const before = f.state()
  // Saturday has no class row, so the old mechanism cannot even name it.
  assert.throws(() => f.edit({ type: 'set-day-template', date: saturday, sourceWeekday: 6 }),
    error => error.status === 409 && /真实课表/u.test(error.message))
  assert.deepEqual(f.state(), before)
  f.edit(exception(saturday, 'cancelled'))
  // Control: Saturday is a real 13-hour weekend window before it is cancelled.
  assert.deepEqual(ids(routinesForDay(before, saturday)), ['default-weekend-availability'])
  assert.equal(dayCapacity(before, f.tasks(), saturday, now).totalMin, 780)
  const state = f.state()
  assert.equal(state.revision, before.revision + 1)
  assert.deepEqual(state.dayExceptions[saturday], { date: saturday, kind: 'cancelled' })
  assert.deepEqual(routinesForDay(state, saturday), [])
  assert.equal(dayCapacity(state, f.tasks(), saturday, now).totalMin, 0)
  assert.equal(dayCapacity(state, f.tasks(), nextSunday, now).totalMin, 720)
  // Cancelling a class day is the same action and clears its carry items.
  assert.deepEqual(labels(carryItems(before, f.tasks(), sunday)), ['周日课本'])
  f.edit(exception(sunday, 'cancelled'))
  const cancelled = f.state()
  assert.deepEqual(routinesForDay(cancelled, sunday), [])
  assert.deepEqual(labels(carryItems(cancelled, f.tasks(), sunday)), [])
  assert.deepEqual(routinesForDay(cancelled, nextSunday), routinesForDay(before, nextSunday))
})

test('a rescheduled day copies one weekday onto a date and keeps that snapshot after the source changes', t => {
  const f = fixture(t)
  f.seed()
  const before = f.state()
  f.edit(exception(sunday, 'rescheduled', { sourceWeekday: 4 }))
  const state = f.state()
  assert.equal(state.revision, before.revision + 1)
  const record = state.dayExceptions[sunday]
  assert.equal(record.sourceWeekday, 4)
  assert.deepEqual(ids(record.routines).sort(), ids(routinesForDay(before, thursday)).sort())
  assert.deepEqual(routinesForDay(state, sunday), routinesForDay(before, thursday))
  assert.deepEqual(routinesForDay(state, thursday), routinesForDay(before, thursday))
  assert.deepEqual(routinesForDay(state, nextSunday), routinesForDay(before, nextSunday))
  assert.equal(dayCapacity(state, f.tasks(), sunday, now).totalMin, 210)
  assert.deepEqual(new Set(labels(carryItems(state, f.tasks(), sunday))), new Set(['实验手册', '水杯']))
  // The copied timetable governs task placement on that single date.
  const task = f.db.createTask({ title: '周日安排' })
  assert.throws(() => f.edit({ type: 'save-block', block: f.block(task.id) }), conflict)
  const placed = f.block(task.id, { start: '11:00', end: '11:30' })
  f.edit({ type: 'save-block', block: placed })
  assert.deepEqual(blocksForDay(f.state(), f.tasks(), sunday), [placed])
  // Editing or deleting the source class never rewrites a durable snapshot.
  f.edit({ type: 'save-routine', routine: routine({ title: '周四新课程', items: ['新课本'] }) })
  assert.deepEqual(f.state().dayExceptions[sunday], record)
  assert.deepEqual(routinesForDay(f.state(), sunday), routinesForDay(before, thursday))
  assert.equal(routinesForDay(f.state(), thursday).find(item => item.id === 'thursday-class').title, '周四新课程')
  f.edit({ type: 'delete-routine', id: 'thursday-class' })
  assert.deepEqual(f.state().dayExceptions[sunday], record)
  assert.deepEqual(routinesForDay(f.state(), sunday), routinesForDay(before, thursday))
  // A rescheduled span copies the same source weekday onto every date in it.
  f.edit(exception(nextSunday, 'rescheduled', { sourceWeekday: 4, endDate: '2026-09-28' }))
  const span = f.state()
  assert.deepEqual(Object.keys(span.dayExceptions).sort(), [sunday, nextSunday, '2026-09-28'].sort())
  for (const date of [nextSunday, '2026-09-28']) {
    assert.equal(span.dayExceptions[date].sourceWeekday, 4)
    assert.deepEqual(routinesForDay(span, date), routinesForDay(span, thursday))
  }
  // Reading a rescheduled day never exposes the stored snapshot to mutation.
  const exposed = routinesForDay(span, nextSunday)
  exposed[0].items.push('外部修改')
  exposed[0].weekdays.push(6)
  assert.deepEqual(f.state().dayExceptions[nextSunday], span.dayExceptions[nextSunday])
  // Unlike a legacy template, a reschedule from a class-free weekday is valid.
  f.edit(exception('2026-10-06', 'rescheduled', { sourceWeekday: 2 }))
  const empty = f.state().dayExceptions['2026-10-06']
  assert.deepEqual(ids(empty.routines), ['default-evening-study'])
  assert.equal(empty.routines.some(item => item.kind === 'class'), false)
  assert.deepEqual(ids(routinesForDay(f.state(), '2026-10-06')), ['default-evening-study'])
  assert.equal(dayCapacity(f.state(), f.tasks(), '2026-10-06', now).totalMin, 120)
})

test('a restored day returns to the weekly timetable and re-arms placement conflicts', t => {
  const f = fixture(t)
  f.seed()
  const before = f.state()
  const task = f.db.createTask({ title: '周日任务' })
  f.edit(exception(sunday, 'holiday'))
  assert.deepEqual(ids(routinesForDay(f.state(), sunday)), ['default-weekend-availability'])
  const placed = f.block(task.id, { start: '11:00', end: '11:30' })
  f.edit({ type: 'save-block', block: placed })
  assert.deepEqual(dayCapacity(f.state(), f.tasks(), sunday, now).conflicts, [])
  f.edit(exception(sunday, 'restored'))
  const restored = f.state()
  assert.deepEqual(restored.dayExceptions[sunday], { date: sunday, kind: 'restored' })
  assert.deepEqual(routinesForDay(restored, sunday), routinesForDay(before, sunday))
  assert.deepEqual(dayCapacity(restored, f.tasks(), sunday, now).conflicts, [placed.id])
  assert.throws(() => f.edit({ type: 'save-block', block: f.block(task.id, { start: '11:10', end: '11:40' }) }), conflict)
  // Switching back to the legacy template drops the restored marker again.
  f.edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  const templated = f.state()
  assert.equal(Object.hasOwn(templated.dayExceptions, sunday), false)
  assert.deepEqual(routinesForDay(templated, sunday), routinesForDay(before, thursday))
  // A fresh restored marker switches back to the weekly row and clears that template.
  f.edit(exception(sunday, 'restored'))
  const switched = f.state()
  assert.equal(Object.hasOwn(switched.dayOverrides, sunday), false)
  assert.deepEqual(switched.dayExceptions[sunday], { date: sunday, kind: 'restored' })
  assert.deepEqual(routinesForDay(switched, sunday), routinesForDay(before, sunday))
})

test('legacy day templates and new exceptions switch in both directions', t => {
  const f = fixture(t)
  f.seed()
  const before = f.state()
  // Legacy template first: the date borrows Thursday.
  f.edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  const templated = f.state()
  assert.equal(templated.revision, before.revision + 1)
  assert.deepEqual(routinesForDay(templated, sunday), routinesForDay(before, thursday))
  assert.deepEqual(templated.dayExceptions, {})
  // Re-applying the identical legacy template is a no-op, exactly like an exception.
  f.edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  assert.deepEqual(f.state(), templated)
  // An exception replaces the legacy snapshot on the same date.
  f.edit(exception(sunday, 'holiday'))
  const holiday = f.state()
  assert.equal(holiday.revision, templated.revision + 1)
  assert.equal(Object.hasOwn(holiday.dayOverrides, sunday), false)
  assert.equal(holiday.dayExceptions[sunday].kind, 'holiday')
  assert.deepEqual(ids(routinesForDay(holiday, sunday)), ['default-weekend-availability'])
  // Weekly corrections still only synchronize legacy templates, never exceptions.
  const weeklyEdit = { type: 'edit-weekday', weekday: 4, replacements: [{ routineId: 'thursday-class', title: '物理实验', kind: 'class' }], syncDates: [sunday] }
  assert.throws(() => f.edit(weeklyEdit), conflict)
  assert.deepEqual(f.state(), holiday)
  // The legacy action switches the same date back and drops the exception.
  f.edit({ type: 'set-day-template', date: sunday, sourceWeekday: 4 })
  const switchedBack = f.state()
  assert.equal(Object.hasOwn(switchedBack.dayExceptions, sunday), false)
  assert.deepEqual(routinesForDay(switchedBack, sunday), routinesForDay(before, thursday))
  // ... and a new exception switches the date away from that template again.
  f.edit(exception(sunday, 'cancelled'))
  const cancelled = f.state()
  assert.equal(Object.hasOwn(cancelled.dayOverrides, sunday), false)
  assert.deepEqual(routinesForDay(cancelled, sunday), [])
  assert.throws(() => f.edit({ type: 'remove-day-template', date: sunday }), missing)
  // Clearing the exception returns the plain weekly row.
  f.edit({ type: 'clear-day-exception', date: sunday })
  const cleared = f.state()
  assert.deepEqual(cleared.dayExceptions, {})
  assert.deepEqual(cleared.dayOverrides, {})
  assert.deepEqual(routinesForDay(cleared, sunday), routinesForDay(before, sunday))
  assert.throws(() => f.edit({ type: 'clear-day-exception', date: sunday }), missing)
  assert.throws(() => f.edit({ type: 'remove-day-template', date: sunday }), missing)
  assert.deepEqual(f.state(), cleared)
  // Restored behaves like any exception and is dropped by a later legacy template.
  f.edit(exception(nextSunday, 'restored'))
  assert.deepEqual(f.state().dayExceptions[nextSunday], { date: nextSunday, kind: 'restored' })
  assert.deepEqual(routinesForDay(f.state(), nextSunday), routinesForDay(before, nextSunday))
  f.edit({ type: 'set-day-template', date: nextSunday, sourceWeekday: 4 })
  const relaid = f.state()
  assert.equal(Object.hasOwn(relaid.dayExceptions, nextSunday), false)
  assert.deepEqual(routinesForDay(relaid, nextSunday), routinesForDay(before, thursday))
  // Clearing also removes a legacy-only template, so one action resets either mechanism.
  f.edit({ type: 'set-day-template', date: '2026-09-29', sourceWeekday: 4 })
  assert.ok(f.state().dayOverrides['2026-09-29'])
  f.edit({ type: 'clear-day-exception', date: '2026-09-29' })
  assert.equal(Object.hasOwn(f.state().dayOverrides, '2026-09-29'), false)
  assert.deepEqual(routinesForDay(f.state(), '2026-09-29'), routinesForDay(before, '2026-09-29'))
})

test('repeating the same exception adds no revision and no duplicate record', t => {
  const f = fixture(t, { persistent: true })
  f.seed()
  f.edit(exception(sunday, 'holiday'))
  const created = f.state()
  for (let attempt = 0; attempt < 3; attempt++) {
    f.edit(exception(sunday, 'holiday'))
    assert.deepEqual(f.state(), created)
  }
  f.edit(exception(holidayStart, 'holiday', { endDate: holidayEnd }))
  const ranged = f.state()
  f.edit(exception(holidayStart, 'holiday', { endDate: holidayEnd }))
  assert.deepEqual(f.state(), ranged)
  // Overlapping spans only write the days that are actually missing.
  f.edit(exception('2026-10-05', 'holiday', { endDate: '2026-10-09' }))
  const extended = f.state()
  assert.equal(extended.revision, ranged.revision + 1)
  assert.deepEqual(Object.keys(extended.dayExceptions).sort(), [sunday, ...holidayDates, '2026-10-08', '2026-10-09'].sort())
  f.edit(exception('2026-10-05', 'holiday', { endDate: '2026-10-09' }))
  assert.deepEqual(f.state(), extended)
  // Replaying from a stale revision cannot rewrite the newer calendar.
  assert.throws(() => f.db.updatePlanner(exception(sunday, 'holiday'), created.revision), conflict)
  assert.deepEqual(f.state(), extended)
  f.edit(exception(nextSunday, 'rescheduled', { sourceWeekday: 4 }))
  const rescheduled = f.state()
  f.edit(exception(nextSunday, 'rescheduled', { sourceWeekday: 4 }))
  assert.deepEqual(f.state(), rescheduled)
  // Clearing twice cannot create a second revision or a hidden record.
  f.edit({ type: 'clear-day-exception', date: nextSunday })
  const cleared = f.state()
  assert.throws(() => f.edit({ type: 'clear-day-exception', date: nextSunday }), missing)
  assert.deepEqual(f.state(), cleared)
  // Replaying the identical durable receipt neither re-applies nor duplicates it.
  const action = { type: 'set-day-template', date: '2026-09-29', sourceWeekday: 4 }
  const input = f.operation([action])
  const receipt = f.db.applyPlannerOperation(input)
  const applied = f.state()
  assert.equal(applied.revision, cleared.revision + 1)
  assert.deepEqual(f.db.applyPlannerOperation(input), receipt)
  assert.deepEqual(f.state(), applied)
  assert.deepEqual(f.db.listOperations().map(item => item.id), [receipt.id])
  assert.throws(() => f.db.applyPlannerOperation({ ...input, summary: '不同内容' }), conflict)
  assert.deepEqual(f.state(), applied)
  assert.deepEqual(f.db.listOperations().map(item => item.id), [receipt.id])
})

test('malformed or oversized exception actions leave the stored day untouched', t => {
  const f = fixture(t)
  f.seed()
  const before = f.state()
  const actions = [
    { type: 'set-day-exception', date: sunday, kind: 'vacation' },
    { type: 'set-day-exception', date: sunday },
    { type: 'set-day-exception', kind: 'holiday' },
    { type: 'set-day-exception', date: '2026-02-30', kind: 'holiday' },
    { type: 'set-day-exception', date: '__proto__', kind: 'holiday' },
    { type: 'set-day-exception', date: nextSunday, kind: 'holiday', endDate: sunday },
    { type: 'set-day-exception', date: '2026-10-01', endDate: '2026-11-01', kind: 'holiday' },
    { type: 'set-day-exception', date: sunday, kind: 'holiday', sourceWeekday: 4 },
    { type: 'set-day-exception', date: sunday, kind: 'cancelled', sourceWeekday: 0 },
    { type: 'set-day-exception', date: sunday, kind: 'restored', routines: [routine()] },
    { type: 'set-day-exception', date: sunday, kind: 'rescheduled' },
    { type: 'set-day-exception', date: sunday, kind: 'rescheduled', sourceWeekday: -1 },
    { type: 'set-day-exception', date: sunday, kind: 'rescheduled', sourceWeekday: 7 },
    { type: 'set-day-exception', date: sunday, kind: 'rescheduled', sourceWeekday: '4' },
    { type: 'set-day-exception', date: sunday, kind: 'rescheduled', sourceWeekday: 4.5 },
    { type: 'set-day-exception', date: sunday, kind: 'holiday', extra: true },
    { type: 'set-day-exception', date: sunday, kind: 'holiday', endDate: '2026-02-30' },
    { type: 'clear-day-exception' },
    { type: 'clear-day-exception', date: 'tomorrow' },
    { type: 'clear-day-exception', date: sunday, kind: 'holiday' },
  ]
  for (const action of actions) {
    assert.throws(() => f.db.updatePlanner(action, f.state().revision), invalid)
    assert.deepEqual(f.state(), before)
  }
  // The documented boundary is 31 consecutive days: 31 works, 32 is refused.
  f.edit(exception('2026-10-01', 'holiday', { endDate: '2026-10-31' }))
  const bounded = f.state()
  assert.equal(bounded.revision, before.revision + 1)
  assert.equal(Object.keys(bounded.dayExceptions).length, 31)
  assert.equal(bounded.dayExceptions['2026-10-31'].kind, 'holiday')
})

test('backups round-trip exceptions and legacy backups without the field still work', t => {
  const f = fixture(t)
  f.seed()
  f.edit(exception(holidayStart, 'holiday', { endDate: holidayEnd }))
  f.edit(exception(sunday, 'rescheduled', { sourceWeekday: 4 }))
  f.edit(exception(saturday, 'cancelled'))
  const full = f.state()
  const backup = f.db.exportData()
  f.edit({ type: 'clear-day-exception', date: sunday })
  f.edit({ type: 'clear-day-exception', date: saturday })
  f.edit({ type: 'clear-day-exception', date: '2026-10-03' })
  const cleared = f.state()
  assert.deepEqual(Object.keys(cleared.dayExceptions).sort(), holidayDates.filter(date => date !== '2026-10-03'))
  assert.equal(f.db.importData(backup).restored, true)
  const restored = f.state()
  assert.deepEqual(restored.dayExceptions, full.dayExceptions)
  assert.deepEqual(routinesForDay(restored, sunday), routinesForDay(full, sunday))
  assert.equal(restored.revision, Math.max(cleared.revision, full.revision) + 1)
  // A tampered tables payload is rejected before anything is written.
  const tampered = f.db.exportData()
  tampered.tables.state.find(row => row.key === 'planner-v1').value = '{}'
  assert.throws(() => f.db.importData(tampered), invalid)
  assert.deepEqual(f.state(), restored)
  // Older backups have no dayExceptions field and must stay byte-compatible.
  const legacy = f.db.exportData(), row = legacy.tables.state.find(item => item.key === 'planner-v1')
  const stripped = JSON.parse(row.value)
  delete stripped.dayExceptions
  row.value = JSON.stringify(stripped)
  f.db.importData(sign(legacy))
  const legacyState = f.state()
  assert.equal(Object.hasOwn(legacyState, 'dayExceptions'), false)
  assert.deepEqual(ids(routinesForDay(legacyState, sunday)), ['default-weekend-availability', 'sunday-class'])
  // Undoing a receipt created on that legacy state must not invent the field.
  const receipt = f.db.applyPlannerOperation(f.operation([{ type: 'set-day-template', date: nextSunday, sourceWeekday: 4 }]))
  f.db.undoOperation(receipt.id)
  assert.equal(Object.hasOwn(f.state(), 'dayExceptions'), false)
  assert.deepEqual(ids(routinesForDay(f.state(), nextSunday)), ['default-weekend-availability', 'sunday-class'])
  // The first real exception upgrades the legacy record in place.
  f.edit(exception(sunday, 'holiday'))
  assert.equal(f.state().dayExceptions[sunday].kind, 'holiday')
  assert.deepEqual(ids(f.state().dayExceptions[sunday].routines), ['default-weekend-availability'])
  assert.deepEqual(Object.keys(f.state().dayExceptions), [sunday])
  // A crafted but valid backup can hold both mechanisms on one date. The
  // exception wins for reads, and repeating it replaces the stale legacy layer.
  const mixed = f.db.exportData(), mixedRow = mixed.tables.state.find(item => item.key === 'planner-v1')
  const mixedState = JSON.parse(mixedRow.value)
  mixedState.dayOverrides = { [nextSunday]: { date: nextSunday, sourceWeekday: 4, routines: routinesForDay(mixedState, thursday) } }
  mixedState.dayExceptions = { [nextSunday]: { date: nextSunday, kind: 'holiday' } }
  mixedRow.value = JSON.stringify(mixedState)
  f.db.importData(sign(mixed))
  const both = f.state()
  assert.deepEqual(ids(routinesForDay(both, nextSunday)), ['default-weekend-availability'])
  assert.equal(dayCapacity(both, f.tasks(), nextSunday, now).totalMin, 780)
  f.edit(exception(nextSunday, 'holiday'))
  const pruned = f.state()
  assert.equal(pruned.revision, both.revision + 1)
  assert.equal(Object.hasOwn(pruned.dayOverrides, nextSunday), false)
  assert.equal(pruned.dayExceptions[nextSunday].kind, 'holiday')
  assert.deepEqual(ids(pruned.dayExceptions[nextSunday].routines), ['default-weekend-availability'])
  f.edit(exception(nextSunday, 'holiday'))
  assert.deepEqual(f.state(), pruned)
})

test('malformed exception records in a backup are rejected transactionally', t => {
  const f = fixture(t)
  f.seed()
  f.edit(exception(sunday, 'holiday'))
  f.edit(exception(nextSunday, 'rescheduled', { sourceWeekday: 4 }))
  const before = f.state(), original = f.db.exportData()
  const mutations = [
    state => { state.dayExceptions = null },
    state => { state.dayExceptions = [] },
    state => { state.dayExceptions = 'holiday' },
    state => { state.dayExceptions = { holiday: { date: sunday, kind: 'holiday' } } },
    state => { state.dayExceptions = { '2026-02-30': { date: '2026-02-30', kind: 'holiday' } } },
    state => { state.dayExceptions = { [sunday]: 'holiday' } },
    state => { state.dayExceptions = { [sunday]: { date: nextSunday, kind: 'holiday' } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'vacation' } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'holiday', extra: true } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'holiday', sourceWeekday: 4 } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'holiday', routines: [routine()] } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'restored', sourceWeekday: 4 } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'cancelled', routines: [routine()] } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', routines: [routine()] } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 4 } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 9, routines: [routine()] } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 4, routines: 'none' } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 4, routines: [routine(), routine()] } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 4, routines: [routine({ enabled: 'yes' })] } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 4, routines: [routine({ start: '25:00' })] } } },
    state => { state.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 4, routines: Array.from({ length: 301 }, (_, index) => routine({ id: `course-${index}` })) } } },
    state => {
      state.dayExceptions = Object.fromEntries(Array.from({ length: 3661 }, (_, index) => {
        const date = new Date(Date.UTC(2026, 0, 1 + index)).toISOString().slice(0, 10)
        return [date, { date, kind: 'holiday' }]
      }))
    },
  ]
  for (const mutate of mutations) {
    const backup = structuredClone(original), row = backup.tables.state.find(item => item.key === 'planner-v1'), state = JSON.parse(row.value)
    mutate(state)
    row.value = JSON.stringify(state)
    assert.throws(() => f.db.importData(sign(backup)), invalid)
    assert.deepEqual(f.state(), before)
  }
  // Positive control: a reschedule from a class-free weekday stores an empty
  // snapshot, which is valid even though a legacy template would need a class.
  const empty = structuredClone(original), emptyRow = empty.tables.state.find(item => item.key === 'planner-v1')
  const emptyState = JSON.parse(emptyRow.value)
  emptyState.dayExceptions = { [sunday]: { date: sunday, kind: 'rescheduled', sourceWeekday: 4, routines: [] } }
  emptyRow.value = JSON.stringify(emptyState)
  assert.equal(f.db.importData(sign(empty)).restored, true)
  assert.deepEqual(f.state().dayExceptions[sunday], { date: sunday, kind: 'rescheduled', sourceWeekday: 4, routines: [] })
  assert.deepEqual(routinesForDay(f.state(), sunday), [])
  assert.equal(dayCapacity(f.state(), f.tasks(), sunday, now).totalMin, 0)
})

test('undo restores the exception snapshot and refuses to overwrite later exception edits', t => {
  const f = fixture(t)
  f.seed()
  const weekly = f.state()
  f.edit(exception(sunday, 'holiday'))
  const before = f.state()
  const action = { type: 'set-day-template', date: nextSunday, sourceWeekday: 4 }
  const receipt = f.db.applyPlannerOperation(f.operation([action]))
  assert.equal(receipt.undoable, true)
  assert.deepEqual(receipt.requestedActions, [action])
  assert.equal(f.state().revision, before.revision + 1)
  assert.deepEqual(f.state().dayExceptions, before.dayExceptions)
  const undone = f.db.undoOperation(receipt.id)
  const undoneRow = f.db.listOperations().find(item => item.id === receipt.id)
  assert.ok(undone.undoneAt)
  assert.equal(undoneRow.undoneAt, undone.undoneAt)
  assert.equal(undoneRow.undoable, true)
  const restored = f.state()
  assert.deepEqual(restored, { ...before, revision: before.revision + 2 })
  assert.deepEqual(restored.dayOverrides, {})
  assert.equal(restored.dayExceptions[sunday].kind, 'holiday')
  assert.deepEqual(ids(routinesForDay(restored, sunday)), ['default-weekend-availability'])
  // A second undo is idempotent: the durable row and revision both stay put.
  const rowsBefore = f.db.listOperations()
  const again = f.db.undoOperation(receipt.id)
  assert.equal(again.undoneAt, rowsBefore.find(item => item.id === receipt.id).undoneAt)
  assert.deepEqual(f.db.listOperations(), rowsBefore)
  assert.deepEqual(f.state(), restored)
  // A later manual exception edit makes that old receipt unsafe to replay.
  const live = f.db.applyPlannerOperation(f.operation([action]))
  assert.equal(f.state().revision, restored.revision + 1)
  assert.equal(f.state().dayOverrides[nextSunday].sourceWeekday, 4)
  f.edit(exception(sunday, 'cancelled'))
  const latest = f.state()
  assert.throws(() => f.db.undoOperation(live.id), conflict)
  assert.deepEqual(f.state(), latest)
  assert.equal(f.state().dayExceptions[sunday].kind, 'cancelled')
  assert.deepEqual(routinesForDay(f.state(), sunday), [])
  // A receipt that was already undone stays idempotent even after later edits.
  const historyBefore = f.db.listOperations()
  assert.equal(f.db.undoOperation(receipt.id).undoneAt, undone.undoneAt)
  assert.deepEqual(f.db.listOperations(), historyBefore)
  assert.deepEqual(f.state(), latest)
  // The cleared day is still reachable by restoring the backup that holds it.
  const backup = f.db.exportData()
  f.edit({ type: 'clear-day-exception', date: sunday })
  assert.deepEqual(routinesForDay(f.state(), sunday), routinesForDay(weekly, sunday))
  f.db.importData(backup)
  assert.equal(f.state().dayExceptions[sunday].kind, 'cancelled')
  assert.deepEqual(routinesForDay(f.state(), sunday), [])
})

test('assistant receipts apply, replay and undo whole exception batches', t => {
  const f = fixture(t)
  f.seed()
  // This is the receipt path the assistant's set_calendar_exception tool uses.
  const manual = exception(sunday, 'rescheduled', { sourceWeekday: 4 })
  f.edit(manual)
  const scheduled = f.state()
  const record = scheduled.dayExceptions[sunday]
  const holiday = exception(holidayStart, 'holiday', { endDate: holidayEnd })
  const input = f.operation([holiday])
  const receipt = f.db.applyPlannerOperation(input)
  const applied = f.state()
  assert.equal(receipt.kind, 'planner')
  assert.equal(receipt.undoable, true)
  assert.deepEqual(receipt.requestedActions, [holiday])
  assert.equal(applied.revision, scheduled.revision + 1)
  assert.deepEqual(Object.keys(applied.dayExceptions).sort(), [sunday, ...holidayDates].sort())
  assert.deepEqual(f.db.listOperations().map(item => item.id), [receipt.id])
  // An identical replay returns the stored receipt: no second revision or row.
  assert.deepEqual(f.db.applyPlannerOperation(input), receipt)
  assert.deepEqual(f.state(), applied)
  assert.deepEqual(f.db.listOperations().map(item => item.id), [receipt.id])
  assert.throws(() => f.db.applyPlannerOperation({ ...input, summary: '不同内容' }), conflict)
  assert.deepEqual(f.state(), applied)
  // Undo restores the rescheduled snapshot exactly, routines payload included.
  f.db.undoOperation(receipt.id)
  const undone = f.state()
  assert.deepEqual(undone, { ...scheduled, revision: scheduled.revision + 2 })
  assert.deepEqual(undone.dayExceptions[sunday], record)
  assert.deepEqual(routinesForDay(undone, sunday), routinesForDay(scheduled, thursday))
  // A mixed batch applies both actions, each costing its own revision, in one receipt.
  const batch = f.operation([exception(nextSunday, 'rescheduled', { sourceWeekday: 4 }), exception(saturday, 'cancelled')])
  const batchReceipt = f.db.applyPlannerOperation(batch)
  const batched = f.state()
  assert.equal(batched.revision, undone.revision + 2)
  assert.equal(batched.dayExceptions[nextSunday].sourceWeekday, 4)
  assert.deepEqual(batched.dayExceptions[saturday], { date: saturday, kind: 'cancelled' })
  assert.deepEqual(routinesForDay(batched, nextSunday), routinesForDay(scheduled, thursday))
  // A later receipt may clear what an earlier one set; stale receipts cannot replay.
  f.db.applyPlannerOperation(f.operation([{ type: 'clear-day-exception', date: saturday }]))
  assert.equal(Object.hasOwn(f.state().dayExceptions, saturday), false)
  const latest = f.state()
  assert.throws(() => f.db.applyPlannerOperation({ ...f.operation([holiday]), expectedRevision: scheduled.revision }), conflict)
  assert.deepEqual(f.state(), latest)
  // Retraction blocks new exception receipts from that request but keeps the old one undoable.
  const request = { requestId: randomUUID(), conversationId: 'main', text: '国庆放假', context: { timezone: 'Asia/Shanghai' } }
  f.db.beginTurn(request)
  const turnReceipt = f.db.applyPlannerOperation(f.operation([exception('2026-10-10', 'holiday')], { requestId: request.requestId }))
  f.db.retractRequest(request)
  assert.throws(() => f.db.applyPlannerOperation(f.operation([exception('2026-10-11', 'holiday')], { requestId: request.requestId })),
    error => error.status === 409)
  assert.equal(Object.hasOwn(f.state().dayExceptions, '2026-10-11'), false)
  f.db.undoOperation(turnReceipt.id)
  assert.equal(Object.hasOwn(f.state().dayExceptions, '2026-10-10'), false)
  // Backups validate those stored receipt actions and turn them into read-only history.
  const saved = f.state()
  const backup = f.db.exportData()
  f.edit({ type: 'clear-day-exception', date: nextSunday })
  assert.equal(Object.hasOwn(f.state().dayExceptions, nextSunday), false)
  assert.equal(f.db.importData(backup).restored, true)
  assert.deepEqual(f.state().dayExceptions, saved.dayExceptions)
  assert.equal(Object.hasOwn(f.state().dayExceptions, nextSunday), true)
  const history = f.db.listOperations().find(item => item.id === batchReceipt.id)
  assert.equal(history.kind, 'restored')
  assert.equal(history.undoable, false)
  assert.throws(() => f.db.undoOperation(batchReceipt.id), conflict)
})
