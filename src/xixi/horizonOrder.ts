import type { OrbitDay, OrbitGroup } from './orbitGroups'
import type { StringSnapshot } from './stringOrder'

export type HorizonSnapshot = StringSnapshot & { days: 3; groups: OrbitGroup[]; groupingSaved?: boolean }
export type HorizonResult = HorizonSnapshot & { summary: string; operation: { id: string } | null; replayed?: boolean }

/** Keep block identities: one task may have several independently scheduled parts. */
export function horizonDraft(groups: readonly OrbitGroup[]) {
  return ([0, 1, 2] as const).flatMap(day => groups.filter(group => group.day === day)
    .map(group => ({ id: group.id, title: group.title, day: group.day, itemIds: group.tasks.map(task => task.id) })))
}

export function horizonPage(groups: readonly OrbitGroup[], day: OrbitDay, requested: number, size: number) {
  const all = groups.filter(group => group.day === day)
  const count = Math.max(1, Math.ceil(all.length / size))
  const page = Math.max(0, Math.min(count - 1, requested))
  return { all, page, count, offset: page * size, visible: all.slice(page * size, (page + 1) * size) }
}

export function horizonDate(date: string, day: number) {
  const value = new Date(`${date}T12:00:00`)
  value.setDate(value.getDate() + day)
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}
