import type { SceneCamera } from './scene'

/** UI geometry follows camera changes, not the ambient simulation clock. */
export function sameCameraSample(a: SceneCamera | undefined, b: SceneCamera): boolean {
  return !!a && a.zoom === b.zoom && a.roll === b.roll && a.inclination === b.inclination
    && a.centerX === b.centerX && a.centerY === b.centerY
    && a.cameraTransition === b.cameraTransition && a.reducedMotion === b.reducedMotion && a.paused === b.paused
}
