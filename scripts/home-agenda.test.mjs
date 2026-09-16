import test from 'node:test'
import assert from 'node:assert/strict'
import { agendaDate, agendaItems, dayTaskLabel, deadlineItems, deadlineLabel, isOverdue, localDay, monthDays, shiftMonth } from '../src/home/agenda.ts'

const now = new Date(2026, 8, 16, 12)
const today = '2026-09-16'
const task = (id, patch = {}) => ({ id, title: id, status: 'todo', deletedAt: null, createdAt: '2026-09-01T00:00:00Z', ...patch })

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
