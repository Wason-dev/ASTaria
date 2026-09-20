import type { Task } from '../domain/task.ts'
import { agendaDate, localDay } from '../home/agenda.ts'
import type { CarryItem, DayCapacity, MinuteRange, PlanBlock, PlannerState, Routine } from './types.ts'

const MINUTE = 60_000
const DAY_MINUTES = 1440

/** 24:00 is an end-of-day boundary; invalid input stays invalid. */
export function minuteOf(time: string): number {
  if (time === '24:00') return DAY_MINUTES
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time)) return Number.NaN
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

export function timeOf(minutes: number): string {
  if (!Number.isFinite(minutes)) return ''
  const value = Math.min(DAY_MINUTES, Math.max(0, Math.round(minutes)))
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`
}

function minutesParts(n: number) {
  const value = Number.isFinite(n) ? Math.max(0, Math.ceil(n)) : 0
  return { hours: Math.floor(value / 60), minutes: value % 60 }
}

export function minutesLabel(n: number): string {
  const { hours, minutes } = minutesParts(n)
  return hours ? `${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}` : `${minutes} 分钟`
}

/** A compact display only: capacity calculations keep their second-level precision. */
export function compactMinutesLabel(n: number): string {
  const { hours, minutes } = minutesParts(n)
  return hours ? `${hours}h${minutes ? ` ${minutes}m` : ''}` : `${minutes}m`
}

function dayBounds(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return null
  const start = agendaDate(date)
  if (!start) return null
  const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1)
  return { start, end }
}

function timeOn(date: Date, minutes: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minutes)
}

function explicitInterval(date: string, start: string, end: string) {
  const bounds = dayBounds(date), from = minuteOf(start), to = minuteOf(end)
  if (!bounds || !Number.isFinite(from) || !Number.isFinite(to) || from >= DAY_MINUTES || from >= to) return null
  return { start: timeOn(bounds.start, from), end: timeOn(bounds.start, to) }
}

function clipRange(interval: { start: Date; end: Date }, date: string): MinuteRange | null {
  const bounds = dayBounds(date)
  if (!bounds || interval.end <= bounds.start || interval.start >= bounds.end || interval.end <= interval.start) return null
  const minute = (value: Date) => value.getHours() * 60 + value.getMinutes() + value.getSeconds() / 60 + value.getMilliseconds() / MINUTE
  const start = interval.start <= bounds.start ? 0 : minute(interval.start)
  const end = interval.end >= bounds.end ? DAY_MINUTES : minute(interval.end)
  return end > start ? { start, end } : null
}

function mergeRanges(ranges: readonly MinuteRange[]): MinuteRange[] {
  const sorted = ranges.filter(range => Number.isFinite(range.start) && Number.isFinite(range.end) && range.end > range.start)
    .map(range => ({ ...range })).sort((a, b) => a.start - b.start || a.end - b.end)
  const merged: MinuteRange[] = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
    else merged.push(range)
  }
  return merged
}

function subtractRanges(base: readonly MinuteRange[], occupied: readonly MinuteRange[]): MinuteRange[] {
  const cuts = mergeRanges(occupied)
  return mergeRanges(base).flatMap(range => {
    const result: MinuteRange[] = []
    let cursor = range.start
    for (const cut of cuts) {
      if (cut.end <= cursor) continue
      if (cut.start >= range.end) break
      if (cut.start > cursor) result.push({ start: cursor, end: Math.min(cut.start, range.end) })
      cursor = Math.max(cursor, cut.end)
      if (cursor >= range.end) break
    }
    if (cursor < range.end) result.push({ start: cursor, end: range.end })
    return result
  })
}

const duration = (ranges: readonly MinuteRange[]) => ranges.reduce((sum, range) => sum + range.end - range.start, 0)
const overlap = (a: MinuteRange, b: MinuteRange) => a.start < b.end && b.start < a.end
const knownTask = (task: Task) => !task.deletedAt && task.status !== 'dropped'

/** Weekdays follow Date.getDay(): Sunday is 0. Explicit routines stay within a day. */
export function routinesForDay(state: PlannerState, date: string): Routine[] {
  const bounds = dayBounds(date)
  if (!bounds) return []
  const override = state.dayOverrides?.[date]
  const result: Routine[] = []
  for (const routine of override?.routines ?? state.routines) {
    if (!routine.enabled || (!override && !routine.weekdays.includes(bounds.start.getDay()))) continue
    const interval = explicitInterval(date, routine.start, routine.end)
    const range = interval && clipRange(interval, date)
    if (range) result.push({ ...routine, weekdays: [...routine.weekdays], items: [...routine.items], start: timeOf(range.start), end: timeOf(range.end) })
  }
  return result.sort((a, b) => minuteOf(a.start) - minuteOf(b.start) || minuteOf(a.end) - minuteOf(b.end) || a.id.localeCompare(b.id))
}

/** A lesson replaces the visible free-time frame, without deleting its weekly source. */
export function visibleTimetableRoutines(routines: readonly Routine[]): Routine[] {
  const fixed = routines.filter(routine => routine.kind !== 'available')
    .map(routine => ({ start: minuteOf(routine.start), end: minuteOf(routine.end) }))
  return routines.flatMap(routine => routine.kind !== 'available' ? [routine]
    : subtractRanges([{ start: minuteOf(routine.start), end: minuteOf(routine.end) }], fixed)
      .map(range => ({ ...routine, start: timeOf(range.start), end: timeOf(range.end) })))
}

/** Shared by all seven columns, the ruler and now marker: short events gain room
 * by expanding the same time interval everywhere, never by overlapping a neighbor. */
export function timetableTimeScale(start: number, end: number, intervals: readonly MinuteRange[]) {
  const pixels = Array.from({ length: end - start }, () => 96 / 60)
  for (const interval of intervals) {
    const from = Math.max(start, interval.start), to = Math.min(end, interval.end), duration = to - from
    if (duration <= 0) continue
    const minimumHeight = duration < 20 ? 28 : duration < 40 ? 42 : 64
    const density = minimumHeight / duration
    for (let minute = Math.floor(from); minute < to; minute++) {
      pixels[minute - start] = Math.max(pixels[minute - start], density)
    }
  }
  const offsets = [0]
  for (const pixel of pixels) offsets.push(offsets.at(-1)! + pixel)
  return {
    height: offsets.at(-1)!,
    position(minute: number) {
      const offset = Math.min(end - start, Math.max(0, minute - start)), index = Math.floor(offset)
      return offsets[index] + (offset - index) * (pixels[index] ?? 0)
    },
  }
}

type PlannedInterval = { block: PlanBlock; range: MinuteRange; originalEnd: Date }

function plannedIntervals(state: PlannerState, tasks: readonly Task[], date: string): PlannedInterval[] {
  if (!dayBounds(date)) return []
  const taskMap = new Map(tasks.filter(knownTask).map(task => [task.id, task]))
  const explicitTasks = new Set<string>(), result: PlannedInterval[] = []
  for (const block of state.blocks) {
    if (!taskMap.has(block.taskId)) continue
    const interval = explicitInterval(block.date, block.start, block.end)
    if (!interval) continue
    explicitTasks.add(block.taskId)
    const range = clipRange(interval, date)
    if (range) result.push({ block: { ...block, date, start: timeOf(range.start), end: timeOf(range.end) }, range, originalEnd: interval.end })
  }
  for (const task of taskMap.values()) {
    if (explicitTasks.has(task.id) || !task.startAt?.includes('T') || !task.estimateMin || !Number.isFinite(task.estimateMin) || task.estimateMin <= 0) continue
    const start = agendaDate(task.startAt)
    if (!start) continue
    const end = new Date(start.getTime() + task.estimateMin * MINUTE)
    if (!Number.isFinite(end.getTime())) continue
    const range = clipRange({ start, end }, date)
    if (range) result.push({ block: { id: `task:${task.id}`, taskId: task.id, date, start: timeOf(range.start), end: timeOf(range.end), locked: false }, range, originalEnd: end })
  }
  return result.sort((a, b) => a.range.start - b.range.start || a.range.end - b.range.end || a.block.id.localeCompare(b.block.id))
}

export function blocksForDay(state: PlannerState, tasks: readonly Task[], date: string): PlanBlock[] {
  return plannedIntervals(state, tasks, date).map(item => item.block)
}

export function dayCapacity(state: PlannerState, tasks: readonly Task[], date: string, now: Date): DayCapacity {
  const routines = routinesForDay(state, date)
  const ranges = (kind: 'available' | 'fixed') => routines.filter(item => kind === 'available' ? item.kind === 'available' : item.kind !== 'available')
    .map(item => ({ start: minuteOf(item.start), end: minuteOf(item.end) }))
  const fixed = mergeRanges(ranges('fixed'))
  const available = subtractRanges(ranges('available'), fixed)
  const planned = plannedIntervals(state, tasks, date)
  const free = subtractRanges(available, planned.map(item => item.range))
  const today = localDay(now)
  const currentMinute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / MINUTE
  const remaining = date < today ? [] : date > today ? free.map(range => ({ ...range }))
    : free.map(range => ({ start: Math.max(range.start, currentMinute), end: range.end })).filter(range => range.start < range.end)
  const taskMap = new Map(tasks.filter(knownTask).map(task => [task.id, task]))
  const conflicts = new Set<string>()
  for (const item of planned) {
    if (fixed.some(range => overlap(range, item.range))) conflicts.add(item.block.id)
    const due = taskMap.get(item.block.taskId)?.due
    const deadline = due?.length === 10 ? dayBounds(due)?.end : agendaDate(due)
    if (deadline && item.originalEnd > deadline) conflicts.add(item.block.id)
  }
  for (let index = 0; index < planned.length; index++) {
    for (let other = index + 1; other < planned.length && planned[other].range.start < planned[index].range.end; other++) {
      if (overlap(planned[index].range, planned[other].range)) {
        conflicts.add(planned[index].block.id)
        conflicts.add(planned[other].block.id)
      }
    }
  }
  const explicitTasks = new Set(state.blocks.filter(block => taskMap.has(block.taskId) && explicitInterval(block.date, block.start, block.end)).map(block => block.taskId))
  const unestimatedCount = tasks.filter(task => {
    if (!knownTask(task) || task.status === 'done' || explicitTasks.has(task.id) || (task.estimateMin !== undefined && Number.isFinite(task.estimateMin) && task.estimateMin > 0)) return false
    const start = agendaDate(task.startAt)
    return start && localDay(start) === date
  }).length
  const totalMin = duration(available), freeMin = duration(free)
  return { available, free, remaining, totalMin, scheduledMin: totalMin - freeMin, freeMin, remainingMin: duration(remaining),
    longestMin: Math.max(0, ...remaining.map(range => range.end - range.start)), unestimatedCount, conflicts: [...conflicts] }
}

export function carryItems(state: PlannerState, tasks: readonly Task[], date: string): CarryItem[] {
  if (!dayBounds(date)) return []
  const result = new Map<string, CarryItem>()
  const checked = new Set(state.checked[date] ?? [])
  const add = (label: string, source: string, suggested = false) => {
    const key = label.trim()
    if (!key) return
    const current = result.get(key)
    if (current) {
      if (!current.sources.includes(source)) current.sources.push(source)
      current.suggested = current.suggested && suggested
    } else result.set(key, { key, label: key, sources: [source], suggested, checked: checked.has(key) })
  }
  for (const routine of routinesForDay(state, date)) for (const item of routine.items) add(item, routine.title)
  const plannedTasks = new Set(blocksForDay(state, tasks, date).map(block => block.taskId))
  const explicitTasks = new Set(state.blocks.filter(block => explicitInterval(block.date, block.start, block.end)).map(block => block.taskId))
  // A date-only start is an explicit plan for the day even before its clock
  // time or estimate is supplied; a due date by itself is not such a plan.
  for (const task of tasks.filter(knownTask)) {
    const start = agendaDate(task.startAt)
    if (!explicitTasks.has(task.id) && start && localDay(start) === date) plannedTasks.add(task.id)
    const details = state.details[task.id]
    const due = agendaDate(task.due)
    const submissionToday = details?.needsSubmission && !details.submittedAt && due && localDay(due) === date
    if (plannedTasks.has(task.id) || submissionToday) {
      for (const item of details?.items ?? []) add(item, task.title)
    }
    if (plannedTasks.has(task.id) && task.context?.includes('desk-mac')) add('电脑', task.title, true)
  }
  return [...result.values()]
}
