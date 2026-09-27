import test from 'node:test'
import assert from 'node:assert/strict'
import { agendaDate, agendaItems, agendaPlanIndex, dayTaskLabel, deadlineItems, deadlineLabel, isOverdue, isUndatedTask, localDay, monthDays, shiftMonth, taskOnDay } from '../src/home/agenda.ts'

const now = new Date(2026, 8, 16, 12)
const today = '2026-09-16'
const task = (id, patch = {}) => ({ id, title: id, status: 'todo', deletedAt: null, createdAt: '2026-09-01T00:00:00Z', ...patch })
const block = (id, taskId, date = today, start = '18:00', end = '18:30') => ({ id, taskId, date, start, end, locked: false })

test('date-only values retain their local day and invalid persisted dates do not roll forward', () => {
  assert.equal(localDay(agendaDate(today)), today)
  assert.equal(localDay(agendaDate(new Date(2026, 8, 16, 23, 30).toISOString())), today)
  for (const value of [undefined, '', 'wrong', '2026-02-29', '2026-02-31T10:00:00Z', '2026-99-01']) assert.equal(agendaDate(value), undefined)
  assert.equal(localDay(agendaDate('2028-02-29')), '2028-02-29')
})

test('calendar uses full local dates and keeps start and deadline distinct with same-day deduplication', () => {
  const rows = [task('start-and-due', { startAt: today, due: today }), task('future-due', { startAt: today, due: '2026-09-18' }), task('other-year', { due: '2027-09-16' })]
  assert.deepEqual(agendaItems(rows, today, today).map(item => item.id).sort(), ['future-due', 'start-and-due'])
  assert.deepEqual(agendaItems(rows, '2026-09-18', today).map(item => item.id), ['future-due'])
  assert.deepEqual(agendaItems(rows, '2026-09-17', today), [])
  assert.equal(dayTaskLabel(rows[0], today), '安排 · 截止')
  assert.equal(dayTaskLabel(rows[1], today), '安排')
  assert.equal(dayTaskLabel(rows[1], '2026-09-18'), '截止')
})

test('today-only intentions do not populate history or invent dates for inbox tasks', () => {
  const rows = [task('inbox', { inbox: true }), task('doing', { status: 'doing' }), task('fuzzy', { fuzzyWindow: 'today' }), task('future-plan', { fuzzyWindow: 'today', startAt: '2026-09-18' })]
  assert.deepEqual(agendaItems(rows, today, today).map(item => item.id), ['doing', 'fuzzy'])
  assert.deepEqual(agendaItems(rows, '2026-09-15', today), [])
  assert.deepEqual(agendaItems(rows, '2026-09-18', today).map(item => item.id), ['future-plan'])
})

test('completed, dropped, and deleted tasks leave both active calendar and deadline lists', () => {
  const rows = [task('done', { status: 'done', due: today }), task('dropped', { status: 'dropped', due: today }), task('deleted', { deletedAt: now.toISOString(), due: today }), task('open', { due: today })]
  assert.deepEqual(agendaItems(rows, today, today).map(item => item.id), ['open'])
  assert.deepEqual(deadlineItems(rows).map(item => item.id), ['open'])
})

test('overdue deadlines remain visible; all-day deadlines expire after their local date', () => {
  const rows = [task('future', { due: '2026-09-17' }), task('past', { due: '2026-09-15' }), task('today', { due: today }), task('invalid', { due: 'invalid' })]
  const before = structuredClone(rows)
  assert.deepEqual(deadlineItems(rows).map(item => item.id), ['past', 'today', 'future', 'invalid'])
  assert.equal(isOverdue(rows[1], now), true)
  assert.equal(isOverdue(rows[2], new Date(2026, 8, 16, 23, 59)), false)
  assert.equal(isOverdue(rows[2], new Date(2026, 8, 17, 0, 0)), true)
  assert.equal(isOverdue(task('earlier', { due: new Date(2026, 8, 16, 11).toISOString() }), now), true)
  assert.equal(deadlineLabel(rows[3], now), '日期待确认')
  assert.match(deadlineLabel(task('year', { due: '2027-09-16' }), now), /2027年/)
  assert.deepEqual(rows, before)
})

test('month grids start on Monday, include leap days and navigate year/month ends safely', () => {
  const days = monthDays(new Date(2028, 1, 1))
  assert.equal(days.length, 42)
  assert.equal(days[0].getDay(), 1)
  assert.equal(new Set(days.map(localDay)).size, 42)
  assert.ok(days.some(date => localDay(date) === '2028-02-29'))
  assert.equal(localDay(shiftMonth(new Date(2026, 0, 31), 1)), '2026-02-28')
  assert.equal(localDay(shiftMonth(new Date(2026, 11, 31), 1)), '2027-01-31')
})

test('planner blocks place tasks without startAt on the calendar and out of undated', () => {
  const rows = [task('math'), task('physics')]
  const plans = agendaPlanIndex([block('math-slot', 'math'), block('physics-slot', 'physics', today, '18:40', '19:20')])
  assert.deepEqual(agendaItems(rows, today, today, plans).map(item => item.id), ['math', 'physics'])
  assert.equal(rows.filter(item => taskOnDay(item, today, today, plans)).length, 2)
  assert.deepEqual(rows.filter(item => isUndatedTask(item, plans)), [])
  assert.equal(dayTaskLabel(rows[0], today, plans), '18:00–18:30')
  assert.equal(dayTaskLabel(rows[1], today, plans), '18:40–19:20')
})

test('one repeating task appears once per applicable day, with that day’s ordered block times', () => {
  const repeated = task('vocabulary')
  const blocks = [block('tomorrow', repeated.id, '2026-09-17', '19:40', '20:00'),
    block('late', repeated.id, today, '20:00', '20:10'), block('early', repeated.id, today, '18:00', '18:10'),
    block('duplicate-time', repeated.id, today, '18:00', '18:10')]
  const original = structuredClone(blocks)
  const plans = agendaPlanIndex(blocks)
  assert.deepEqual(agendaItems([repeated], today, today, plans), [repeated])
  assert.deepEqual(agendaItems([repeated], '2026-09-17', today, plans), [repeated])
  assert.deepEqual(agendaItems([repeated], '2026-09-18', today, plans), [])
  assert.equal(dayTaskLabel(repeated, today, plans), '18:00–18:10 · 20:00–20:10')
  assert.equal(dayTaskLabel(repeated, '2026-09-17', plans), '19:40–20:00')
  assert.deepEqual(blocks, original)
})

test('actual blocks override stale startAt while deadlines remain independently visible', () => {
  const item = task('moved', { startAt: `${today}T09:00:00`, due: '2026-09-18T20:00:00' })
  const plans = agendaPlanIndex([block('new-slot', item.id, '2026-09-17', '17:00', '18:00')])
  assert.deepEqual(agendaItems([item], today, today, plans), [])
  assert.deepEqual(agendaItems([item], '2026-09-17', today, plans), [item])
  assert.deepEqual(agendaItems([item], '2026-09-18', today, plans), [item])
  assert.equal(dayTaskLabel(item, '2026-09-17', plans), '17:00–18:00')
  assert.equal(dayTaskLabel(item, '2026-09-18', plans), '20:00 截止')
  assert.deepEqual(deadlineItems([item]), [item])
})

test('same-day block and deadline show one task with both its time and deadline', () => {
  const item = task('submission', { due: today })
  const plans = agendaPlanIndex([block('one', item.id), block('two', item.id, today, '19:00', '19:30')])
  assert.deepEqual(agendaItems([item], today, today, plans), [item])
  assert.equal(dayTaskLabel(item, today, plans), '18:00–18:30 · 19:00–19:30 · 截止')
})

test('startAt still supplies the schedule when that task has no planner blocks', () => {
  const fallback = task('legacy', { startAt: `${today}T16:00:00` })
  const loose = task('loose')
  const plans = agendaPlanIndex([block('other-slot', 'another-task', '2026-09-17')])
  assert.deepEqual(agendaItems([loose, fallback], today, today, plans), [fallback])
  assert.equal(dayTaskLabel(fallback, today, plans), '16:00 开始')
  assert.equal(isUndatedTask(fallback, plans), false)
  assert.equal(isUndatedTask(loose, plans), true)
  assert.equal(isUndatedTask(task('due-only', { due: '2026-09-18' }), plans), false)
})

test('explicit plans suppress stale fuzzy today intent but preserve doing and unscheduled fuzzy tasks', () => {
  const planned = task('planned', { fuzzyWindow: 'today' })
  const doing = task('doing', { status: 'doing' })
  const fuzzy = task('fuzzy', { fuzzyWindow: 'today' })
  const plans = agendaPlanIndex([block('later', planned.id, '2026-09-17'), block('doing-later', doing.id, '2026-09-17')])
  assert.deepEqual(agendaItems([planned, doing, fuzzy], today, today, plans).map(item => item.id), ['doing', 'fuzzy'])
  assert.equal(dayTaskLabel(doing, today, plans), '进行中')
  assert.equal(isUndatedTask(fuzzy, plans), false)
})

test('day ordering follows actual block times and excludes closed tasks even if blocks remain', () => {
  const rows = [task('late', { startAt: `${today}T08:00:00` }), task('early', { startAt: `${today}T22:00:00` }),
    task('done', { status: 'done' }), task('dropped', { status: 'dropped' }), task('deleted', { deletedAt: now.toISOString() })]
  const plans = agendaPlanIndex([block('late-slot', 'late', today, '20:00', '20:30'), block('early-slot', 'early', today, '16:00', '16:30'),
    block('done-slot', 'done'), block('dropped-slot', 'dropped'), block('deleted-slot', 'deleted')])
  assert.deepEqual(agendaItems(rows, today, today, plans).map(item => item.id), ['early', 'late'])
})
