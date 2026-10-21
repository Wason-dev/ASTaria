import type { Task } from '../domain/task.ts'
import { agendaItems, agendaPlanIndex, localDay } from '../home/agenda.ts'
import { planBlockCompleted } from './completion.ts'
import { blocksForDay, dayCapacity, minuteOf, routinesForDay } from './model.ts'
import type { PlanBlock, PlannerState, Routine } from './types.ts'

export type DesktopDayEntry = {
  key: string; title: string; start: number; end: number
  kind: 'course' | 'event' | 'break' | 'task' | 'free'
  routine?: Routine; task?: Task; block?: PlanBlock; availableSources?: Routine[]; done: boolean; conflict: boolean
}
export type DesktopDayTrack = { key: 'courses' | 'events' | 'tasks' | 'free'; title: string; entries: DesktopDayEntry[] }
/** Reminders have no duration. Only the shared occupancy projection draws bars. */
export function desktopDayModel(state: PlannerState, tasks: readonly Task[], date: string, now: Date) {
  const routines = routinesForDay(state, date), blocks = blocksForDay(state, tasks, date)
  const capacity = dayCapacity(state, tasks, date, now), conflicts = new Set(capacity.conflicts)
  const taskMap = new Map(tasks.map(task => [task.id, task]))
  const entries: DesktopDayEntry[] = routines.filter(row => row.kind !== 'available').map(row => ({
    key: `routine:${row.sourceDate ?? 'weekly'}:${row.id}`, title: row.title,
    start: minuteOf(row.start), end: minuteOf(row.end),
    kind: row.sourceDate ? 'event' : row.kind === 'break' ? 'break' : 'course',
    routine: row, done: false, conflict: conflicts.has(row.id),
  }))
  for (const block of blocks) {
    const task = taskMap.get(block.taskId)
    if (task) entries.push({ key: `block:${block.id}`, title: task.title, start: minuteOf(block.start), end: minuteOf(block.end),
      kind: 'task', task, block, done: planBlockCompleted(task, state, block), conflict: conflicts.has(block.id) })
  }
  for (const range of capacity.free) {
    const availableSources = routines.filter(row => row.kind === 'available' && minuteOf(row.start) < range.end && minuteOf(row.end) > range.start)
    entries.push({ key: `free:${range.start}:${range.end}`, title: '空档', ...range, kind: 'free',
      ...(availableSources.length === 1 ? { routine: availableSources[0] } : {}), availableSources, done: false, conflict: false })
  }
  entries.sort((a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key))
  const planned = new Set(blocks.map(block => block.taskId))
  const reminders = agendaItems(tasks, date, localDay(now), agendaPlanIndex(state.blocks)).filter(task => !planned.has(task.id))
  const tracks: DesktopDayTrack[] = [
    { key: 'courses', title: '课程', entries: entries.filter(entry => entry.kind === 'course') },
    { key: 'events', title: '活动与休息', entries: entries.filter(entry => entry.kind === 'event' || entry.kind === 'break') },
    { key: 'tasks', title: '任务', entries: entries.filter(entry => entry.kind === 'task') },
    { key: 'free', title: '空档', entries: entries.filter(entry => entry.kind === 'free') },
  ]
  const start = Math.max(0, Math.floor(Math.min(360, ...entries.map(entry => entry.start)) / 60) * 60)
  const end = Math.min(1440, Math.ceil(Math.max(1320, ...entries.map(entry => entry.end)) / 60) * 60)
  return { tracks, reminders, capacity, start, end, availabilityKnown: routines.some(row => row.kind === 'available') }
}

export type DayStripPlacement = { entry: DesktopDayEntry; left: number; width: number; lane: number; lanes: number }

/** One shared sequence of real time boundaries, like timetable period columns.
 * Short gaps compress; long empty spans do not consume most of the screen.
 * Only actual overlapping intervals share vertical space, never wide labels. */
export function dayStripLayout(entries: readonly DesktopDayEntry[], start: number, end: number) {
  const valid = entries.filter(entry => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end > entry.start && entry.end > start && entry.start < end)
    .slice().sort((a, b) => a.start - b.start || b.end - a.end || a.key.localeCompare(b.key))
  const boundaries = [...new Set([start, end, ...valid.flatMap(entry => [Math.max(start, entry.start), Math.min(end, entry.end)])])].sort((a, b) => a - b)
  const offsets = [0]
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index], to = boundaries[index + 1], duration = to - from
    const covering = valid.filter(entry => entry.start < to && entry.end > from)
    const weight = covering.some(entry => entry.kind !== 'free') ? Math.max(40, Math.min(110, duration * 1.4))
      : covering.length ? Math.max(18, Math.min(110, duration * .75)) : Math.max(12, Math.min(40, duration * .2))
    offsets.push(offsets.at(-1)! + weight)
  }
  const total = offsets.at(-1) || 1
  const position = (minute: number) => {
    const value = Math.min(end, Math.max(start, minute))
    let index = boundaries.findIndex((boundary, at) => at > 0 && boundary >= value) - 1
    if (index < 0) index = 0
    const fraction = (value - boundaries[index]) / Math.max(1, boundaries[index + 1] - boundaries[index])
    return (offsets[index] + fraction * (offsets[index + 1] - offsets[index])) / total * 100
  }
  const items: DayStripPlacement[] = []
  let group: DayStripPlacement[] = [], laneEnds: number[] = [], groupEnd = -1, maxLanes = 1
  const flush = () => {
    for (const item of group) item.lanes = laneEnds.length
    maxLanes = Math.max(maxLanes, laneEnds.length)
    items.push(...group); group = []; laneEnds = []; groupEnd = -1
  }
  for (const entry of valid) {
    if (entry.start >= groupEnd && group.length) flush()
    let lane = laneEnds.findIndex(to => to <= entry.start)
    if (lane < 0) lane = laneEnds.length
    laneEnds[lane] = entry.end
    group.push({ entry, left: position(entry.start), width: position(entry.end) - position(entry.start), lane, lanes: 1 })
    groupEnd = Math.max(groupEnd, entry.end)
  }
  flush()
  return { items, position, boundaries, maxLanes }
}
