export type StringItem = {
  id: string; taskId: string; title: string; date: string; start: string; end: string
  durationMin: number; due?: string; movable: boolean; reason?: string
  needsReschedule?: boolean
}
export type StringSnapshot = {
  date: string; days: number; revision: number; snapshotKey: string; asOf: string; items: StringItem[]
}
export type StringResult = StringSnapshot & { operation: { id: string } | null; summary: string; replayed?: boolean }

/** Fixed appointments keep their reference positions; only task occurrences move. */
export function arrangeStringItems(items: readonly StringItem[], orderedIds: readonly string[]): StringItem[] {
  const byId = new Map(items.map(item => [item.id, item]))
  const ordered = orderedIds.map(id => byId.get(id)).filter((item): item is StringItem => Boolean(item?.movable))
  let index = 0
  return items.map(item => item.movable ? ordered[index++] ?? item : item)
}

export function moveStringItem(ids: readonly string[], id: string, target: number): string[] {
  const from = ids.indexOf(id)
  if (from < 0) return [...ids]
  const next = [...ids]
  next.splice(from, 1)
  next.splice(Math.max(0, Math.min(next.length, target)), 0, id)
  return next
}

export function stringGeometry(width: number, count: number) {
  const padding = width < 600 ? 100 : Math.max(116, width * .095)
  // Every task has a persistent, readable name; never squeeze it into a dot.
  const contentWidth = Math.max(width, padding * 2 + Math.max(0, count - 1) * 192)
  const spacing = count > 1 ? (contentWidth - padding * 2) / (count - 1) : 0
  return { contentWidth, padding, spacing, x: (index: number) => count === 1 ? width / 2 : padding + spacing * index }
}
