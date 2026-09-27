import type { OrbitDay, OrbitGroup } from './orbitGroups'
import { orbitDropTarget, orbitGroupPositions, orbitPoint } from './orbitScene'
import type { OrbitPoint, OrbitProjection } from './orbitScene'

type DropTarget = { day: OrbitDay; index: number }

/** Overlapping transparent hitboxes must select the light nearest the pointer. */
export function nearestOrbitAnchor(point: OrbitPoint, anchors: Iterable<readonly [string, OrbitPoint]>, fallbackId: string, radius = 48): string | null {
  let selected: string | null = null, closest = radius
  for (const [id, anchor] of anchors) {
    const distance = Math.hypot(anchor.x - point.x, anchor.y - point.y)
    if (distance < closest || (distance === closest && (selected === null || id === fallbackId))) {
      selected = id; closest = distance
    }
  }
  return selected
}

/** Keep an insertion slot steady at its boundary without waiting for a timer.
 * Hit testing uses the committed order, so moving neighbors cannot chase the pointer. */
export function stableOrbitDropTarget(point: OrbitPoint, geometry: OrbitProjection, groups: readonly OrbitGroup[], id: string,
  previous: DropTarget | null, margin = 7): DropTarget {
  let candidate = orbitDropTarget(point, geometry, groups, id)
  const anchors = orbitGroupPositions(groups, geometry)
  const refine = (day: OrbitDay, seed: number) => {
    const distanceAt = (t: number) => { const p = orbitPoint(geometry, day, t); return Math.hypot(point.x - p.x, point.y - p.y) }
    let low = Math.max(0, seed - .012), high = Math.min(1, seed + .012)
    for (let step = 0; step < 10; step++) {
      const a = low + (high - low) / 3, b = high - (high - low) / 3
      if (distanceAt(a) < distanceAt(b)) high = b; else low = a
    }
    const t = (low + high) / 2
    return { day, t, distance: distanceAt(t), index: groups.filter(group => group.day === day && group.id !== id && (anchors.get(group.id)?.t ?? 0) < t).length }
  }
  candidate = refine(candidate.day, candidate.t)
  if (!previous) return { day: candidate.day, index: candidate.index }
  if (candidate.day !== previous.day) {
    let distance = Infinity, t = .5
    for (let step = 0; step <= 100; step++) {
      const position = orbitPoint(geometry, previous.day, step / 100)
      const d = Math.hypot(point.x - position.x, point.y - position.y)
      if (d < distance) { distance = d; t = step / 100 }
    }
    const priorDay = refine(previous.day, t)
    if (candidate.distance + margin >= priorDay.distance) candidate = priorDay
  }
  if (candidate.day === previous.day && candidate.index !== previous.index) {
    const remaining = groups.filter(group => group.day === candidate.day && group.id !== id)
    const boundary = remaining[candidate.index > previous.index ? previous.index : previous.index - 1]
    const boundaryT = boundary ? anchors.get(boundary.id)?.t : undefined
    if (boundaryT !== undefined) {
      const at = orbitPoint(geometry, candidate.day, candidate.t), edge = orbitPoint(geometry, candidate.day, boundaryT)
      const spacing = Math.min(...[...anchors].filter(([anchorId, anchor]) => anchor.day === candidate.day && anchorId !== boundary.id)
        .map(([, anchor]) => Math.hypot(anchor.x - edge.x, anchor.y - edge.y)))
      const slotMargin = Math.min(margin, Math.max(.01, spacing * .24))
      if (Math.hypot(at.x - edge.x, at.y - edge.y) < slotMargin) return previous
    }
  }
  return { day: candidate.day, index: candidate.index }
}

export { HorizonStudio as OrbitStudio } from './HorizonStudio'
