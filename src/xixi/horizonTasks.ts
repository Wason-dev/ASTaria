/** Stable arc slots keep drag targets independent of animated neighbors. */
export const horizonTaskSlot = (index: number, count: number) => .1 + .8 * (index + .5) / Math.max(1, count)

export function horizonTaskDropIndex(x: number, width: number, ids: readonly string[], draggedId: string): number {
  const t = Math.max(0, Math.min(1, Number.isFinite(x) && width > 0 ? x / width : .5))
  return ids.filter((id, index) => id !== draggedId && horizonTaskSlot(index, ids.length) < t - 1e-9).length
}

export function previewHorizonTasks(ids: readonly string[], id: string, index: number): string[] {
  if (!ids.includes(id)) return [...ids]
  const result = ids.filter(value => value !== id)
  result.splice(Math.max(0, Math.min(result.length, index)), 0, id)
  return result
}
