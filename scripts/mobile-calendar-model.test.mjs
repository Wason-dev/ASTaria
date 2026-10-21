import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { calendarDay, calendarWeek } from '../mobile/ui/calendarModel.ts'
import { desktopDayModel, dayStripLayout } from '../src/planner/desktopDayModel.ts'

process.env.TZ = 'Asia/Shanghai'
const date = '2026-10-15'
const now = new Date(`${date}T09:30:00+08:00`)
const state = patch => ({ revision: 1, timetableConfirmed: true, routines: [], blocks: [], details: {}, checked: {}, ...patch })
const routine = (id, kind, start, end, patch = {}) => ({ id, title: id, kind, weekdays: [4], start, end, location: '', items: [], enabled: true, ...patch })
const task = (id, patch = {}) => ({ id, title: id, area: null, source: 'manual', inbox: false, leadDays: 0, importance: 2,
  energy: 'light', context: ['anywhere'], status: 'todo', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', deletedAt: null, ...patch })
const block = (id, taskId, start, end, day = date) => ({ id, taskId, date: day, start, end, locked: false })

test('Monday-first weeks retain all seven days over year, month and leap-day boundaries', () => {
  assert.deepEqual(calendarWeek('2027-01-01'), ['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03'])
  assert.deepEqual(calendarWeek('2024-03-03'), ['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03'])
  assert.deepEqual(calendarWeek('2026-02-30'), [])
})

test('calendar navigation uses local days on both sides of real DST changes', () => {
  const url = new URL('../mobile/ui/calendarModel.ts', import.meta.url).href
  for (const zone of ['America/New_York', 'Europe/Berlin', 'Pacific/Auckland']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {calendarWeek} from ${JSON.stringify(url)}; console.log(JSON.stringify(['2026-03-08','2026-11-01'].map(calendarWeek)))`], { encoding: 'utf8', env: { ...process.env, TZ: zone } })
    assert.equal(result.status, 0, result.stderr)
    assert.deepEqual(JSON.parse(result.stdout), [
      ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08'],
      ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01'],
    ])
  }
})

test('classes, single-day events, tasks and actual free intervals form one ordered timeline', () => {
  const s = state({ routines: [routine('available', 'available', '08:00', '12:00'), routine('class', 'class', '08:00', '09:00')],
    dayEvents: [{ id: 'event', title: 'event', date, start: '10:00', end: '10:30', location: '', items: [] }],
    blocks: [block('planned', 'work', '09:00', '09:30')] })
  const result = calendarDay(s, [task('work')], date, now)
  assert.deepEqual(result.entries.map(row => [row.kind, row.start, row.end]), [
    ['routine', 480, 540], ['task', 540, 570], ['free', 570, 600], ['routine', 600, 630], ['free', 630, 720],
  ])
  assert.equal(result.entries.filter(row => row.kind === 'routine' && row.routine.sourceDate === date).length, 1)
  assert.equal(result.availabilityKnown, true)
  assert.equal(result.capacity.remainingMin, 120)
})

test('unknown hours and unestimated starts never become invented free slots or durations', () => {
  const result = calendarDay(state({ routines: [routine('class', 'class', '08:00', '09:00')] }), [task('unknown', { startAt: `${date}T11:00:00+08:00` })], date, now)
  assert.equal(result.availabilityKnown, false)
  assert.deepEqual(result.entries.map(row => row.kind), ['routine'])
  assert.equal(result.capacity.freeMin, 0)
  assert.equal(result.capacity.unestimatedCount, 1)
  assert.deepEqual(result.reminders.map(row => row.id), ['unknown'])
})

test('a scheduled task with a same-day deadline appears once; distinct deadline-only tasks stay visible', () => {
  const tasks = [task('scheduled', { due: date }), task('due', { due: date }), task('intent', { fuzzyWindow: 'today' })]
  const result = calendarDay(state({ blocks: [block('one', 'scheduled', '10:00', '11:00')] }), tasks, date, now)
  assert.deepEqual(result.entries.filter(row => row.kind === 'task').map(row => row.task.id), ['scheduled'])
  assert.deepEqual(new Set(result.reminders.map(row => row.id)), new Set(['due', 'intent']))
})

test('actual blocks suppress stale startAt and preserve multiple real sessions without duplicate reminders', () => {
  const tasks = [task('work', { startAt: `${date}T08:00:00+08:00`, estimateMin: 30 })]
  const s = state({ blocks: [block('first', 'work', '10:00', '10:30'), block('second', 'work', '15:00', '16:00')] })
  const result = calendarDay(s, tasks, date, now)
  assert.deepEqual(result.entries.map(row => row.key), ['block:first', 'block:second'])
  assert.deepEqual(result.reminders, [])
})

test('overnight startAt uses the shared clipped range and never invents an extra session', () => {
  const tasks = [task('overnight', { startAt: '2026-10-14T23:30:00+08:00', estimateMin: 90 })]
  const result = calendarDay(state(), tasks, date, now)
  assert.deepEqual(result.entries.map(row => [row.kind, row.start, row.end]), [['task', 0, 60]])
  assert.deepEqual(result.reminders, [])
})

test('completed real blocks remain occupied; a free-time goal completes only its actual session', () => {
  const s = state({ routines: [routine('available', 'available', '09:00', '12:00')],
    blocks: [block('ordinary', 'done', '09:00', '10:00'), block('session', 'goal', '10:00', '11:00'), block('later', 'goal', '11:00', '11:30')],
    completedFreeTimeSessions: { session: '2026-10-15T02:59:00Z' } })
  const result = calendarDay(s, [task('done', { status: 'done' }), task('goal', { freeTimeGoalId: 'goal-id' })], date, now)
  assert.deepEqual(result.entries.filter(row => row.kind === 'task').map(row => [row.block.id, row.done]), [['ordinary', true], ['session', true], ['later', false]])
  assert.deepEqual(result.entries.filter(row => row.kind === 'free').map(row => [row.start, row.end]), [[690, 720]])
})

test('rescheduled snapshot and single-date activity use the shared exception model without restoring weekly rows', () => {
  const source = routine('source', 'class', '10:00', '11:00', { weekdays: [1] })
  const s = state({ routines: [routine('usual', 'class', '08:00', '09:00')],
    dayExceptions: { [date]: { date, kind: 'rescheduled', sourceWeekday: 1, routines: [source] } },
    dayEvents: [{ id: 'event', title: 'event', date, start: '12:00', end: '13:00', location: '', items: [] }] })
  assert.deepEqual(calendarDay(s, [], date, now).entries.map(row => row.routine.id), ['source', 'event'])
  const cancelled = { ...s, dayExceptions: { [date]: { date, kind: 'cancelled' } } }
  assert.deepEqual(calendarDay(cancelled, [], date, now).entries.map(row => row.routine.id), ['event'])
})

test('conflicts are visible on real event and task rows; deleted and dropped tasks leave no slots', () => {
  const s = state({ blocks: [block('live', 'live', '09:00', '10:00'), block('deleted', 'deleted', '11:00', '12:00'), block('dropped', 'dropped', '13:00', '14:00')],
    dayEvents: [{ id: 'event', title: 'event', date, start: '09:30', end: '10:30', location: '', items: [] }] })
  const tasks = [task('live'), task('deleted', { deletedAt: date }), task('dropped', { status: 'dropped' })]
  const result = calendarDay(s, tasks, date, now)
  assert.equal(result.entries.length, 2)
  assert.ok(result.entries.every(row => row.conflict))
})

test('projection does not change shared state or user tasks', () => {
  const s = state({ routines: [routine('available', 'available', '09:00', '12:00')], blocks: [block('one', 'work', '10:00', '11:00')] })
  const tasks = [task('work', { due: date })]
  const before = JSON.stringify({ s, tasks })
  calendarDay(s, tasks, date, now)
  assert.equal(JSON.stringify({ s, tasks }), before)
})

test('desktop day keeps courses, activities, tasks and free time on separate tracks', () => {
  const s = state({ routines: [routine('class', 'class', '08:00', '09:00'), routine('break', 'break', '12:00', '13:00'), routine('available', 'available', '08:00', '14:00')],
    dayEvents: [{ id: 'event', title: 'event', date, start: '08:30', end: '09:30', location: '', items: [] }],
    blocks: [block('work', 'work', '09:30', '10:00')] })
  const model = desktopDayModel(s, [task('work')], date, now)
  assert.deepEqual(model.tracks.map(track => [track.key, track.entries.map(row => row.title)]), [
    ['courses', ['class']], ['events', ['event', 'break']], ['tasks', ['work']], ['free', ['空档', '空档']],
  ])
  assert.ok(model.tracks[0].entries[0].conflict)
  assert.ok(model.tracks[1].entries[0].conflict)
  assert.deepEqual(model.tracks[3].entries.map(row => [row.start, row.end]), [[600, 720], [780, 840]])
})

test('desktop reminders and date-only deadlines do not occupy axis time or create availability', () => {
  const tasks = [task('deadline', { due: date }), task('date-only', { startAt: date }), task('unknown', { startAt: `${date}T08:15:00+08:00` })]
  const model = desktopDayModel(state(), tasks, date, now)
  assert.ok(model.tracks.every(track => track.entries.length === 0))
  assert.deepEqual(new Set(model.reminders.map(row => row.id)), new Set(['deadline', 'date-only', 'unknown']))
  assert.equal(model.availabilityKnown, false)
  assert.equal(model.capacity.freeMin, 0)
})

test('desktop scheduled deadlines keep a single task card and retain exact block identity for editing', () => {
  const s = state({ blocks: [block('one', 'work', '10:00', '10:30'), block('two', 'work', '15:00', '16:00')] })
  const model = desktopDayModel(s, [task('work', { due: date, startAt: `${date}T07:00:00+08:00`, estimateMin: 30 })], date, now)
  assert.deepEqual(model.tracks.find(track => track.key === 'tasks').entries.map(row => row.block.id), ['one', 'two'])
  assert.deepEqual(model.reminders, [])
})

test('desktop axis includes real midnight boundaries and leaves adjacent intervals conflict-free', () => {
  const tasks = [task('early', { startAt: `${date}T00:00:00+08:00`, estimateMin: 30 }), task('late', { startAt: `${date}T23:30:00+08:00`, estimateMin: 90 }), task('adjacent')]
  const s = state({ blocks: [block('adjacent', 'adjacent', '00:30', '01:00')] })
  const model = desktopDayModel(s, tasks, date, now)
  assert.equal(model.start, 0)
  assert.equal(model.end, 1440)
  assert.deepEqual(model.tracks.find(track => track.key === 'tasks').entries.map(row => [row.start, row.end, row.conflict]), [[0, 30, false], [30, 60, false], [1410, 1440, false]])
})

test('desktop uses real rescheduled snapshots and does not mutate shared state while laying out labels', () => {
  const s = state({ routines: [routine('usual', 'class', '08:00', '09:00')],
    dayExceptions: { [date]: { date, kind: 'rescheduled', sourceWeekday: 1, routines: [routine('source', 'class', '11:00', '12:00', { weekdays: [1] })] } } })
  const before = JSON.stringify(s)
  const model = desktopDayModel(s, [], date, now)
  assert.deepEqual(model.tracks[0].entries.map(row => row.routine.id), ['source'])
  dayStripLayout(model.tracks[0].entries, model.start, model.end)
  assert.equal(JSON.stringify(s), before)
})

test('desktop free slots preserve full availability sources for editing, including merged frames', () => {
  const s = state({ routines: [routine('one', 'available', '09:00', '11:00'), routine('two', 'available', '11:00', '13:00')],
    blocks: [block('work', 'work', '09:30', '10:00')] })
  const model = desktopDayModel(s, [task('work')], date, now)
  const free = model.tracks.find(track => track.key === 'free').entries
  assert.deepEqual(free.map(row => [row.start, row.end]), [[540, 570], [600, 780]])
  assert.equal(free[0].routine.id, 'one')
  assert.equal(free[0].routine.end, '11:00')
  assert.equal(free[1].routine, undefined)
  assert.deepEqual(free[1].availableSources.map(row => row.id), ['one', 'two'])
})

const stripEntry = (key, start, end, extra = {}) => ({ key, title: key, kind: 'course', start, end, done: false, conflict: false, ...extra })
test('horizontal day keeps consecutive lessons on one row regardless of long titles', () => {
  const entries = Array.from({ length: 9 }, (_, index) => stripEntry(`一项需要完整阅读的长课程名称${index}`, 480 + index * 50, 525 + index * 50))
  const before = JSON.stringify(entries)
  const layout = dayStripLayout(entries, 360, 1320)
  assert.equal(layout.items.length, entries.length)
  assert.equal(layout.maxLanes, 1)
  for (const item of layout.items) {
    assert.equal(item.lanes, 1); assert.equal(item.lane, 0)
    assert(item.width > 0 && item.left >= 0 && item.left + item.width <= 100 + 1e-10)
  }
  assert.equal(JSON.stringify(entries), before)
})

test('only real time overlap splits a day column vertically, and adjacency returns to a full-height cell', () => {
  const entries = [stripEntry('first', 480, 530), stripEntry('overlap', 500, 540), stripEntry('adjacent', 540, 570)]
  const layout = dayStripLayout(entries, 420, 1320)
  assert.deepEqual(layout.items.map(item => [item.entry.key, item.lane, item.lanes]), [['first', 0, 2], ['overlap', 1, 2], ['adjacent', 0, 1]])
  assert.equal(layout.maxLanes, 2)
  const [one, two, next] = layout.items
  assert(one.left + one.width > two.left)
  assert.equal(two.left + two.width, next.left)
})

test('one shared horizontal scale keeps real boundaries, midnight and free-slot source identity', () => {
  const source = routine('source', 'available', '00:00', '01:00')
  const entries = [stripEntry('short', 0, 5), stripEntry('free', 5, 60, { kind: 'free', routine: source, availableSources: [source] }), stripEntry('late', 1439, 1440)]
  const layout = dayStripLayout(entries, 0, 1440)
  assert.equal(layout.position(-10), 0); assert.equal(layout.position(1500), 100)
  assert.equal(layout.items[0].left + layout.items[0].width, layout.items[1].left)
  assert.equal(layout.items[1].entry.availableSources[0], source)
  let previous = -1
  for (let minute = 0; minute <= 1440; minute++) { const at = layout.position(minute); assert(at >= previous); previous = at }
  assert.equal(layout.items.at(-1).left + layout.items.at(-1).width, 100)
  assert.deepEqual(dayStripLayout([], 360, 1320).items, [])
})
