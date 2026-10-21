import test from 'node:test'
import assert from 'node:assert/strict'
import { createDatabase } from '../server/database.mjs'

process.env.TZ = 'Asia/Shanghai'

const routine = (patch = {}) => ({
  id: 'evening-break', title: '洗漱', kind: 'break', weekdays: [1, 2, 3, 4, 5],
  start: '20:30', end: '21:30', location: '', items: [], enabled: true, ...patch,
})

function fixture(t, instant = '2026-10-12T10:32:00') {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(instant).getTime() })
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  const occupy = (date, start, end, { status = 'todo', locked = false } = {}) => {
    const task = db.createTask({ title: '回归测试事项' })
    edit({ type: 'save-block', block: { id: `block-${task.id}`, taskId: task.id, date, start, end, locked } })
    if (status !== 'todo') db.updateTask(task.id, { status })
    return task.id
  }
  return { db, edit, occupy }
}

function rejectConflict(f, action, taskId, date, start, end) {
  const state = f.db.getPlanner(), tasks = f.db.listTasks()
  assert.throws(() => f.edit(action), error => {
    assert.equal(error.status, 409)
    assert.match(error.message, /固定安排与已有任务时间重叠/u)
    for (const detail of [date, `${start}–${end}`, f.db.getTask(taskId).title]) {
      assert.ok(error.message.includes(detail), `conflict identifies ${detail}`)
    }
    return true
  })
  assert.deepEqual(f.db.getPlanner(), state, 'rejected changes preserve the planner and revision')
  assert.deepEqual(f.db.listTasks(), tasks, 'rejected changes preserve all tasks')
}

for (const type of ['save-routine', 'import-routines']) {
  test(`${type} ignores historical occupancy without deleting done, active or locked records`, t => {
    const f = fixture(t)
    f.occupy('2026-09-21', '20:45', '21:15', { status: 'done', locked: true })
    f.occupy('2026-10-08', '21:00', '21:30', { status: 'doing' })
    f.occupy('2026-10-09', '20:30', '21:00', { locked: true })
    const before = f.db.getPlanner(), tasks = f.db.listTasks()
    const action = type === 'save-routine' ? { type, routine: routine() } : { type, routines: [routine()] }
    const saved = f.edit(action)
    assert.equal(saved.revision, before.revision + 1)
    assert.deepEqual(saved.routines.find(item => item.id === 'evening-break'), routine())
    assert.deepEqual(saved.blocks, before.blocks)
    assert.deepEqual(f.db.listTasks(), tasks)
  })
}

test('editing an existing weekly routine also ignores historical overlaps', t => {
  const f = fixture(t)
  f.occupy('2026-10-09', '20:30', '21:30', { locked: true })
  f.edit({ type: 'save-routine', routine: routine({ start: '22:00', end: '23:00' }) })
  const before = f.db.getPlanner()
  const saved = f.edit({ type: 'save-routine', routine: routine() })
  assert.equal(saved.routines.filter(item => item.id === 'evening-break').length, 1)
  assert.equal(saved.routines.find(item => item.id === 'evening-break').start, '20:30')
  assert.deepEqual(saved.blocks, before.blocks)
})

for (const timing of [
  { label: 'the overlap ended while the task is still running', blockEnd: '11:30', routineEnd: '10:00' },
  { label: 'the overlap ends exactly now', blockEnd: '11:30', routineEnd: '10:32' },
  { label: 'the task ended while the routine continues', blockEnd: '10:00', routineEnd: '11:30' },
]) {
  test(`today permits a weekly routine when ${timing.label}`, t => {
    const f = fixture(t)
    f.occupy('2026-10-12', '09:00', timing.blockEnd, { locked: true })
    const before = f.db.getPlanner()
    const saved = f.edit({ type: 'save-routine', routine: routine({ start: '09:00', end: timing.routineEnd }) })
    assert.deepEqual(saved.blocks, before.blocks)
    assert.equal(saved.revision, before.revision + 1)
  })
}

test('an overlap that continues today still rejects with its date, task and time', t => {
  const f = fixture(t)
  const taskId = f.occupy('2026-10-12', '09:00', '11:30')
  rejectConflict(f, { type: 'save-routine', routine: routine({ start: '10:00', end: '11:00' }) }, taskId, '2026-10-12', '09:00', '11:30')
})

for (const status of ['todo', 'done']) {
  test(`future ${status} occupancy keeps its conflict protection`, t => {
    const f = fixture(t)
    const taskId = f.occupy('2026-10-13', '20:45', '21:15', { status, locked: true })
    rejectConflict(f, { type: 'save-routine', routine: routine() }, taskId, '2026-10-13', '20:45', '21:15')
  })
}

test('future adjacent slots do not conflict with a weekly routine', t => {
  const f = fixture(t)
  f.occupy('2026-10-13', '19:30', '20:30')
  f.occupy('2026-10-13', '21:30', '22:00')
  const before = f.db.getPlanner()
  assert.deepEqual(f.edit({ type: 'save-routine', routine: routine() }).blocks, before.blocks)
})

test('weekday, alternating week, disabled and availability rules still exclude unrelated slots', t => {
  const f = fixture(t)
  f.occupy('2026-10-13', '20:45', '21:15')
  f.occupy('2026-10-19', '20:45', '21:15')
  const before = f.db.getPlanner()
  for (const entry of [
    routine({ id: 'other-weekday', weekdays: [3] }),
    routine({ id: 'odd-monday', weekdays: [1], weekCycle: 'odd', weekAnchor: '2026-10-12' }),
    routine({ id: 'disabled', enabled: false }),
    routine({ id: 'availability', kind: 'available' }),
  ]) f.edit({ type: 'save-routine', routine: entry })
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('a dropped task releases future occupancy', t => {
  const f = fixture(t)
  f.occupy('2026-10-13', '20:45', '21:15', { status: 'dropped' })
  assert.doesNotThrow(() => f.edit({ type: 'save-routine', routine: routine() }))
})

test('a restored date uses the weekly routine and checks its future conflict', t => {
  const f = fixture(t)
  f.edit({ type: 'set-day-exception', date: '2026-10-13', kind: 'restored' })
  const taskId = f.occupy('2026-10-13', '20:45', '21:15')
  rejectConflict(f, { type: 'save-routine', routine: routine() }, taskId, '2026-10-13', '20:45', '21:15')
})

for (const kind of ['holiday', 'cancelled', 'rescheduled', 'legacy-template']) {
  test(`${kind} keeps its separate timetable when the weekly routine is saved`, t => {
    const f = fixture(t)
    f.edit({ type: 'save-routine', routine: routine({ id: 'source-class', kind: 'class', weekdays: [4], start: '09:00', end: '10:00' }) })
    f.edit(kind === 'legacy-template'
      ? { type: 'set-day-template', date: '2026-10-13', sourceWeekday: 4 }
      : { type: 'set-day-exception', date: '2026-10-13', kind, ...(kind === 'rescheduled' ? { sourceWeekday: 4 } : {}) })
    f.occupy('2026-10-13', '20:45', '21:15')
    const before = f.db.getPlanner()
    const saved = f.edit({ type: 'save-routine', routine: routine({ weekdays: [2] }) })
    assert.deepEqual(saved.blocks, before.blocks)
    assert.deepEqual(saved.dayOverrides, before.dayOverrides)
    assert.deepEqual(saved.dayExceptions, before.dayExceptions)
  })
}

test('changing the alternating-week anchor ignores only past conflicts', t => {
  const f = fixture(t)
  f.occupy('2026-09-28', '20:45', '21:15', { locked: true })
  f.edit({ type: 'set-first-week-monday', date: '2026-10-05' })
  f.edit({ type: 'save-routine', routine: routine({ weekdays: [1], weekCycle: 'odd' }) })
  const before = f.db.getPlanner()
  const saved = f.edit({ type: 'set-first-week-monday', date: '2026-10-12' })
  assert.equal(saved.firstWeekMonday, '2026-10-12')
  assert.equal(saved.routines.find(item => item.id === 'evening-break').weekAnchor, '2026-10-12')
  assert.deepEqual(saved.blocks, before.blocks)
})

test('changing the alternating-week anchor still rejects a new future conflict atomically', t => {
  const f = fixture(t)
  const taskId = f.occupy('2026-10-19', '20:45', '21:15')
  f.edit({ type: 'set-first-week-monday', date: '2026-10-12' })
  f.edit({ type: 'save-routine', routine: routine({ weekdays: [1], weekCycle: 'odd' }) })
  rejectConflict(f, { type: 'set-first-week-monday', date: '2026-10-19' }, taskId, '2026-10-19', '20:45', '21:15')
})

test('a batch import with a future conflict rolls back all routines and timetable confirmation', t => {
  const f = fixture(t)
  const taskId = f.occupy('2026-10-13', '20:45', '21:15')
  rejectConflict(f, { type: 'import-routines', routines: [routine({ id: 'non-conflicting', start: '22:00', end: '23:00' }), routine()] }, taskId, '2026-10-13', '20:45', '21:15')
})

test('local midnight does not mistake today for the previous UTC date', t => {
  const f = fixture(t, '2026-10-12T00:05:00')
  f.occupy('2026-10-11', '23:00', '23:59')
  f.edit({ type: 'save-routine', routine: routine({ id: 'past-night', weekdays: [0], start: '23:00', end: '23:59' }) })
  const taskId = f.occupy('2026-10-12', '00:10', '00:30')
  rejectConflict(f, { type: 'save-routine', routine: routine({ start: '00:10', end: '00:30' }) }, taskId, '2026-10-12', '00:10', '00:30')
})
