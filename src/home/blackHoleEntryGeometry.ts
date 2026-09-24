import type { SceneCamera } from '../spatial/scene'
import { sceneProjection } from '../spatial/scene'

/** The Schwarzschild shadow through the homepage shader's 30-unit focal plane. */
export function blackHoleEntryGeometry(camera: SceneCamera, width: number, height: number) {
  const projection = sceneProjection(camera, Math.max(1, width), Math.max(1, height))
  const distance = 30
  const sine = Math.sqrt(27) / 2 * Math.sqrt(1 - 1 / distance) / distance
  const shadowRadius = projection.unit * 30 * sine / Math.sqrt(1 - sine * sine)
  // Include the thin luminous rim while keeping the empty rectangle corners inert.
  const radius = Math.max(22, shadowRadius * 1.025)
  return { cx: projection.cx, cy: projection.cy, radius, shadowRadius }
}
