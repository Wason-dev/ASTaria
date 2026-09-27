import { horizonTaskDropIndex } from './horizonTasks.ts'

/** Keep names readable instead of shrinking every item onto one arc. */
export function horizonTaskPageSize(width: number): number {
  const available = Number.isFinite(width) ? Math.max(1, width) : 320
  const labelWidth = available <= 520 ? 120 : available <= 800 ? 150 : 190
  return Math.max(1, Math.min(6, Math.floor(available * .8 / (labelWidth + 24))))
}

export function horizonTaskPage(count: number, size: number, requested: number) {
  const total = Math.max(1, Math.ceil(count / size))
  const page = Math.max(0, Math.min(total - 1, requested))
  return { page, total, start: page * size, end: Math.min(count, (page + 1) * size) }
}

/** Page-local anchors still produce an insertion index in the complete group. */
export function horizonPagedDropIndex(x: number, width: number, ids: readonly string[], draggedId: string, page: number, size: number): number {
  const { start, end } = horizonTaskPage(ids.length, size, page)
  const original = ids.indexOf(draggedId)
  const preceding = start - (original >= 0 && original < start ? 1 : 0)
  const local = horizonTaskDropIndex(x, width, ids.slice(start, end), draggedId)
  return Math.max(0, Math.min(ids.length - 1, preceding + local))
}
