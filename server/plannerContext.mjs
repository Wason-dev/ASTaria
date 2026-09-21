import { dayCapacity, blocksForDay, routinesForDay, minuteOf } from '../src/planner/model.ts'
import { localDay } from '../src/home/agenda.ts'

// Keep this estimate aligned with xixi's input budget without importing xixi.
function units(value) {
  const text = JSON.stringify(value)
  const cjk = (text.match(/[\u3000-\u9fff\uff00-\uffef]/gu) ?? []).length
  return Math.ceil(cjk * 1.2 + (text.length - cjk) / 3)
}
const budgetOf = (budget, fallback) => Math.max(64, Number.isFinite(budget) ? Math.floor(budget) : fallback)
const clipped = (text, length) => String(text ?? '').length > length ? `${String(text).slice(0, length - 1)}…` : String(text ?? '')
const overlaps = (a, b) => minuteOf(a.start) < minuteOf(b.end) && minuteOf(b.start) < minuteOf(a.end)
const duration = ranges => ranges.reduce((sum, range) => sum + range.end - range.start, 0)
const within = (ranges, window) => ranges.map(range => ({ start: Math.max(range.start, minuteOf(window.start)), end: Math.min(range.end, minuteOf(window.end)) }))
  .filter(range => range.end > range.start)

function scheduleRows(state, tasks, date) {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const rows = [
    ...routinesForDay(state, date).filter(item => item.kind !== 'available').map(({ id, title, kind, start, end, location }) => ({ id, title, kind, start, end, location })),
    ...blocksForDay(state, tasks, date).map(item => ({ id: item.id, taskId: item.taskId, title: byId.get(item.taskId)?.title ?? '任务',
      kind: 'plan', start: item.start, end: item.end, location: '' })),
  ]
  // Tasks have no structured location field. Do not inherit the free window's
  // location (an off-site activity can occupy a school study window).
  return rows.sort((a, b) => minuteOf(a.start) - minuteOf(b.start) || minuteOf(a.end) - minuteOf(b.end) || a.id.localeCompare(b.id))
}

function compactRow(row) {
  const title = clipped(row.title, 70), location = clipped(row.location, 40)
  return { ...row, title, location, ...(title !== row.title || location !== row.location ? { truncated: true } : {}) }
}
function collection(items, total, extra = {}) {
  const truncated = items.length < total || items.some(item => item.truncated)
  return { ...extra, items, total, truncated, ...(truncated ? { readMore: 'read_planner' } : {}) }
}
function refreshWindow(item, original) {
  item.occupied.truncated = item.occupied.items.length < item.occupied.total || item.occupied.items.some(row => row.truncated)
  item.remainingTruncated = item.remaining.length < original.remaining.length
  item.truncated = original.textTruncated || item.occupied.truncated || item.remainingTruncated
}

/**
 * Declared windows after subtracting ALL fixed routines and task blocks.
 * freeMinutes describes the whole day; remainingMinutes/remaining describe
 * time after `at`. Remaining ranges use the model's exact minutes since 00:00.
 * Counts and minute totals are computed before any context-budget truncation.
 * A missing item or a truncated empty array is never evidence of free time.
 * Budgets below 64 units use the minimum truthful collection envelope.
 */
export function availabilityWindows(state, tasks, date, at, budget = 900) {
  const limit = budgetOf(budget, 900), capacity = dayCapacity(state, tasks, date, at)
  const schedule = scheduleRows(state, tasks, date)
  const windows = routinesForDay(state, date).filter(row => row.kind === 'available')
  const nowMinute = date === localDay(at) ? at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60 : -1
  // A long school day must not crowd upcoming evening windows out of context.
  windows.sort((a, b) => Number(minuteOf(a.end) <= nowMinute) - Number(minuteOf(b.end) <= nowMinute) || minuteOf(a.start) - minuteOf(b.start))
  const originals = windows.map(window => {
    const title = clipped(window.title, 70), location = clipped(window.location, 40)
    const freeMinutes = duration(within(capacity.free, window)), remaining = within(capacity.remaining, window)
    return { ...window, title, location, textTruncated: title !== window.title || location !== window.location,
      status: freeMinutes === 0 ? 'occupied' : freeMinutes < minuteOf(window.end) - minuteOf(window.start) ? 'partial' : 'free',
      freeMinutes, remainingMinutes: duration(remaining), remaining, occupied: schedule.filter(row => overlaps(row, window)).map(compactRow) }
  })
  const items = [], included = []
  const result = () => collection(items, originals.length)
  // Reserve the name and definitive occupancy of each visible window before
  // spending space on detailed blockers. A busy first window cannot hide a
  // later named window merely by having a large list of appointments.
  for (const original of originals.slice(0, 24)) {
    const { id, title, start, end, location, status, freeMinutes, remainingMinutes } = original
    const item = { id, title, start, end, location, status, freeMinutes, remainingMinutes, remaining: [], remainingTruncated: false,
      occupied: { items: [], total: original.occupied.length, truncated: false }, truncated: false }
    refreshWindow(item, original)
    items.push(item)
    if (units(result()) > limit) { items.pop(); continue }
    included.push(original)
  }
  // Round-robin detail keeps at least the first blocking event visible for
  // each window when possible; remaining totals stay exact even if spans or
  // later blocker names do not fit.
  const longest = Math.max(0, ...included.map(row => Math.max(row.occupied.length, row.remaining.length)))
  for (let index = 0; index < longest; index++) {
    for (let position = 0; position < items.length; position++) {
      const item = items[position], original = included[position]
      for (const kind of ['occupied', 'remaining']) {
        const source = original[kind], target = kind === 'occupied' ? item.occupied.items : item.remaining
        if (index >= source.length || target.length !== index) continue
        target.push(source[index]); refreshWindow(item, original)
        if (units(result()) > limit) { target.pop(); refreshWindow(item, original) }
      }
    }
  }
  return result()
}

function clockParts(current) {
  if (current instanceof Date) return { date: localDay(current), minute: current.getHours() * 60 + current.getMinutes() + current.getSeconds() / 60 + current.getMilliseconds() / 60000 }
  return { date: current.localDate, minute: minuteOf(current.localMinute) }
}

/** A bounded chronological preview; `total` always counts ALL matching rows. */
export function nextSchedule(state, tasks, date, current, budget = 550) {
  const limit = budgetOf(budget, 550), now = clockParts(current)
  const today = date === now.date
  const rows = scheduleRows(state, tasks, date).filter(row => !today || minuteOf(row.end) > now.minute)
  const items = []
  const result = () => collection(items, rows.length, { date, ...(today ? { nowMinute: Math.floor(now.minute) } : {}) })
  for (const row of rows.slice(0, 6)) {
    const status = date < now.date ? '已结束' : today && minuteOf(row.start) <= now.minute ? '进行中' : '接下来'
    items.push({ ...compactRow(row), status })
    if (units(result()) > limit) { items.pop(); break }
  }
  return result()
}
