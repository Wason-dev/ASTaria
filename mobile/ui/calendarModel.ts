import type { Task } from '../../src/domain/task.ts'
import { agendaDate, agendaItems, agendaPlanIndex, localDay, shiftDay } from '../../src/home/agenda.ts'
import { planBlockCompleted } from '../../src/planner/completion.ts'
import { blocksForDay, dayCapacity, minuteOf, routinesForDay } from '../../src/planner/model.ts'
import type { PlanBlock, PlannerState, Routine } from '../../src/planner/types.ts'

export type CalendarEntry =
  | { key: string; kind: 'routine'; start: number; end: number; routine: Routine; conflict: boolean }
  | { key: string; kind: 'task'; start: number; end: number; task: Task; block: PlanBlock; done: boolean; conflict: boolean }
  | { key: string; kind: 'free'; start: number; end: number }

/** Calendar days stay local; adding a week must also work across DST and years. */
export function calendarWeek(day: string): string[] {
  const date = agendaDate(day)
  if (!date) return []
  const monday = shiftDay(date, -((date.getDay() + 6) % 7))
  return Array.from({ length: 7 }, (_, index) => localDay(shiftDay(monday, index)))
}

/** A mobile presentation of the shared projections, never a second scheduler. */
export function calendarDay(state: PlannerState, tasks: readonly Task[], day: string, now: Date) {
  const routines = routinesForDay(state, day)
  const blocks = blocksForDay(state, tasks, day)
  const capacity = dayCapacity(state, tasks, day, now)
  const conflicts = new Set(capacity.conflicts)
  const taskMap = new Map(tasks.map(task => [task.id, task]))
  const planned = new Set(blocks.map(block => block.taskId))
  const entries: CalendarEntry[] = routines.filter(routine => routine.kind !== 'available').map(routine => ({
    key: `routine:${routine.sourceDate ?? 'weekly'}:${routine.id}`, kind: 'routine', routine,
    start: minuteOf(routine.start), end: minuteOf(routine.end), conflict: conflicts.has(routine.id),
  }))
  for (const block of blocks) {
    const task = taskMap.get(block.taskId)
    if (task) entries.push({ key: `block:${block.id}`, kind: 'task', task, block,
      start: minuteOf(block.start), end: minuteOf(block.end), done: planBlockCompleted(task, state, block),
      conflict: conflicts.has(block.id) })
  }
  // Only explicit, known availability becomes a free slot. Unknown hours stay unknown.
  for (const range of capacity.free) entries.push({ key: `free:${range.start}:${range.end}`, kind: 'free', ...range })
  entries.sort((a, b) => a.start - b.start || a.end - b.end || a.key.localeCompare(b.key))
  const reminders = agendaItems(tasks, day, localDay(now), agendaPlanIndex(state.blocks))
    .filter(task => !planned.has(task.id))
  return { entries, reminders, capacity, availabilityKnown: routines.some(routine => routine.kind === 'available') }
}
