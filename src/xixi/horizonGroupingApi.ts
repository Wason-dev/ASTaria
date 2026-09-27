import type { HorizonSnapshot } from './horizonOrder'
import type { OrbitGroup } from './orbitGroups'
import { requestHorizonEvents } from './horizonProgress'
import type { HorizonActivity, HorizonPhase } from './horizonProgress'

export type HorizonGroupingResult = { snapshotKey: string; groups: OrbitGroup[] }

/** Suggestions cannot invent work, change its day, or drop a scheduled part. */
export function isHorizonGroupingResult(value: unknown, snapshot: HorizonSnapshot): value is HorizonGroupingResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const result = value as Partial<HorizonGroupingResult>
  if (result.snapshotKey !== snapshot.snapshotKey || !Array.isArray(result.groups)) return false
  const original = new Map(snapshot.groups.flatMap(group => group.tasks.map(task => [task.id, { task, day: group.day }] as const)))
  const groupIds = new Set<string>(), taskIds = new Set<string>()
  for (const group of result.groups) {
    if (!group || typeof group !== 'object' || typeof group.id !== 'string' || !group.id || group.id.length > 160 || groupIds.has(group.id)
      || typeof group.title !== 'string' || !group.title.trim() || group.title.length > 160
      || ![0, 1, 2].includes(group.day) || !Array.isArray(group.tasks) || !group.tasks.length || group.tasks.length > 6
      || !(group.project === undefined || typeof group.project === 'string')) return false
    groupIds.add(group.id)
    for (const task of group.tasks) {
      const reference = task && original.get(task.id)
      if (!reference || taskIds.has(task.id) || reference.day !== group.day || task.title !== reference.task.title
        || task.minutes !== reference.task.minutes || task.needsReschedule !== reference.task.needsReschedule) return false
      taskIds.add(task.id)
    }
  }
  return taskIds.size === original.size
}

export function horizonGroupingApi(snapshot: HorizonSnapshot, requestId: string, onPhase: (phase: HorizonPhase) => void,
  signal?: AbortSignal, onActivity?: (activity: HorizonActivity) => void) {
  return requestHorizonEvents('/api/companion/horizon-groups', {
    date: snapshot.date, expectedRevision: snapshot.revision, snapshotKey: snapshot.snapshotKey, requestId,
  }, (value): value is HorizonGroupingResult => isHorizonGroupingResult(value, snapshot), onPhase, signal, onActivity)
}
