import { deadlineParts } from './deadlineShortcuts.ts'
import { horizonDate } from './horizonOrder.ts'
import type { HorizonSnapshot } from './horizonOrder'
import type { OrbitGroup } from './orbitGroups'

/** Resolve IDs from the actual snapshot, never from an error's task title. */
export function horizonDeadlineConflicts(snapshot: HorizonSnapshot | null, groups: readonly OrbitGroup[]) {
  const conflicts = new Map<string, { taskId: string; title: string; due: string; targetDate: string }>()
  if (!snapshot) return []
  const items = new Map(snapshot.items.map(item => [item.id, item]))
  for (const group of groups) for (const task of group.tasks) {
    const item = items.get(task.id)
    if (!item?.movable || !item.due) continue
    const targetDate = horizonDate(snapshot.date, group.day)
    if (targetDate <= deadlineParts(item.due).date) continue
    const previous = conflicts.get(item.taskId)
    if (!previous || previous.targetDate < targetDate) conflicts.set(item.taskId, { taskId: item.taskId, title: item.title, due: item.due, targetDate })
  }
  return [...conflicts.values()]
}

/** A deadline write changes the snapshot key. Keep the user's order only if
 * every draft block still exists and remains movable in the latest snapshot.
 * All item metadata is refreshed; subsequent completion validates it again. */
export function rebaseHorizonDraft(previous: HorizonSnapshot, next: HorizonSnapshot, groups: readonly OrbitGroup[]): OrbitGroup[] | null {
  if (previous.date !== next.date) return null
  const latest = new Map(next.groups.flatMap(group => group.tasks.map(task => [task.id, task] as const)))
  const ids = groups.flatMap(group => group.tasks.map(task => task.id))
  if (ids.length !== latest.size || new Set(ids).size !== ids.length || ids.some(id => !latest.has(id))) return null
  return groups.map(group => ({ ...group, tasks: group.tasks.map(task => ({ ...latest.get(task.id)! })) }))
}
