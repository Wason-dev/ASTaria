/** A scrubbed camera journey shared by the string workspace and the existing GPU. */
export const STRING_FLIGHT_EVENT = 'astaria:string-flight'
export const STRING_FLIGHT_START_RADIUS = 30
export const STRING_FLIGHT_END_RADIUS = 1.6
/** Horizon-radius units: remain outside both the horizon (1) and photon sphere (1.5). */
export const STRING_FLIGHT_EDGE_RADIUS = 4.5
/** Bottom-up shader coordinates; the upper limb rests 62% down the viewport. */
export const STRING_FLIGHT_EDGE_LIMB = .38

export type StringFlightMode = 'center' | 'edge'
export type StringFlightEdgeFrame = { height: number; curvature: number }
/** Angle is measured from the upper limb; displacement is in viewport heights. */
export type StringFlightEdgePull = { angle: number; displacement: number; spread: number }
export type StringFlightProjection = {
  width: number; height: number; cx: number; cy: number; radius: number; apexY: number
}
const DEFAULT_EDGE_FRAME: StringFlightEdgeFrame = { height: .62, curvature: .16 }
const EMPTY_EDGE_PULL: StringFlightEdgePull = { angle: 0, displacement: 0, spread: .1 }

let currentProgress = 0
let currentMode: StringFlightMode = 'center'
let currentEdgeFrame = { ...DEFAULT_EDGE_FRAME }
let currentEdgePull = { ...EMPTY_EDGE_PULL }
let renderedProjection: StringFlightProjection | null = null

const finiteClamp = (value: number, fallback: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
const wrapAngle = (angle: number) => ((angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
const normalizeEdgePull = (pull: StringFlightEdgePull): StringFlightEdgePull => ({
  angle: Number.isFinite(pull.angle) ? wrapAngle(pull.angle) : 0,
  displacement: finiteClamp(pull.displacement, 0, -.08, .08),
  spread: finiteClamp(pull.spread, EMPTY_EDGE_PULL.spread, .015, Math.PI),
})
const normalizeEdgeFrame = (frame: StringFlightEdgeFrame): StringFlightEdgeFrame => ({
  height: finiteClamp(frame.height, DEFAULT_EDGE_FRAME.height, .25, .86),
  curvature: finiteClamp(frame.curvature, DEFAULT_EDGE_FRAME.curvature, .025, .45),
})
const emitFlight = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent<number>(STRING_FLIGHT_EVENT, { detail: currentProgress }))
}

/** Adjusts only the temporary edge view, never the homepage camera or springs. */
export function setStringFlightEdgeFrame(frame: StringFlightEdgeFrame): void {
  const next = normalizeEdgeFrame(frame)
  if (next.height === currentEdgeFrame.height && next.curvature === currentEdgeFrame.curvature) return
  currentEdgeFrame = next
  // The camera must redraw when tuning changes after the flight has settled.
  if (currentMode === 'edge' && currentProgress > 0) emitFlight()
}

export function getStringFlightEdgeFrame(): StringFlightEdgeFrame {
  return { ...currentEdgeFrame }
}

/** A single field moves both the drawn strands and the existing GPU surface. */
export function stringFlightEdgeDisplacement(angle: number, pull: StringFlightEdgePull): number {
  if (!Number.isFinite(angle)) return 0
  const normalized = normalizeEdgePull(pull)
  const distance = wrapAngle(angle - normalized.angle) / normalized.spread
  return normalized.displacement * Math.exp(-.5 * distance * distance)
}

export function setStringFlightEdgePull(pull: StringFlightEdgePull): void {
  const next = currentMode === 'edge' && currentProgress > 0 ? normalizeEdgePull(pull) : { ...EMPTY_EDGE_PULL }
  if (next.angle === currentEdgePull.angle && next.displacement === currentEdgePull.displacement
    && next.spread === currentEdgePull.spread) return
  currentEdgePull = next
  if (currentMode === 'edge' && currentProgress > 0) emitFlight()
}

export function getStringFlightEdgePull(): StringFlightEdgePull {
  return { ...currentEdgePull }
}

export function normalizeStringFlight(progress: number): number {
  return Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
}

/** Retained across component/renderer mount ordering; no animation clock or storage. */
export function setStringFlight(progress: number, mode: StringFlightMode = 'center'): void {
  const next = normalizeStringFlight(progress)
  if (next === currentProgress && mode === currentMode) return
  currentProgress = next
  currentMode = mode
  if (next === 0 || mode !== 'edge') {
    renderedProjection = null
    currentEdgePull = { ...EMPTY_EDGE_PULL }
  }
  emitFlight()
}

export function getStringFlight(): number {
  return currentProgress
}

export function getStringFlightMode(): StringFlightMode {
  return currentMode
}

function smoothRange(start: number, end: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - start) / (end - start)))
  return t * t * t * (t * (t * 6 - 15) + 10)
}

export type StringFlightCamera = {
  zoom: number
  /** Camera angles in degrees, matching the existing camera controls. */
  roll: number
  inclination: number
  centerX: number
  centerY: number
}

/** Critical impact projected through the shader's fixed 30-unit focal plane. */
function shadowImageRadius(distance: number): number {
  const sine = Math.sqrt(27) / 2 * Math.sqrt(1 - 1 / distance) / distance
  return 30 * sine / Math.sqrt(1 - sine * sine)
}

/** Called after the GPU uniforms have received the actual flight camera. */
export function publishStringFlightProjection(
  camera: StringFlightCamera & { radius: number }, width: number, height: number,
): void {
  if (![width, height, camera.centerX, camera.centerY, camera.zoom, camera.radius].every(Number.isFinite)
    || width <= 0 || height <= 0 || camera.zoom <= 0 || camera.radius <= 1.5) return
  const narrow = width / height < .8
  const cx = width * (narrow ? .5 + (camera.centerX - .5) * .2 : camera.centerX)
  const cy = height * (1 - (narrow ? .5 + (camera.centerY - .5) * 6 : camera.centerY))
  const radius = height * shadowImageRadius(camera.radius) * camera.zoom / (narrow ? 13.8 : 10.2)
  renderedProjection = { width, height, cx, cy, radius, apexY: cy - radius }
}

/** The overlay follows the last applied GPU frame, including entry and retreat.
 * CSS scaling is accounted for until the renderer receives the next resize. */
export function getStringFlightProjection(width: number, height: number): StringFlightProjection | null {
  if (!renderedProjection || currentMode !== 'edge' || currentProgress === 0
    || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null
  const xScale = width / renderedProjection.width, yScale = height / renderedProjection.height
  return { width, height, cx: renderedProjection.cx * xScale, cy: renderedProjection.cy * yScale,
    radius: renderedProjection.radius * yScale, apexY: renderedProjection.apexY * yScale }
}

/** Pure additive presentation: the caller's camera/springs are never mutated. */
export function resolveStringFlightCamera(
  camera: StringFlightCamera, progress: number, mode: StringFlightMode = 'center', viewportAspect = 1,
  edgeFrame: StringFlightEdgeFrame = DEFAULT_EDGE_FRAME,
): StringFlightCamera & { radius: number } {
  const p = normalizeStringFlight(progress)
  if (p === 0) return { ...camera, radius: STRING_FLIGHT_START_RADIUS }
  if (mode === 'edge') {
    const travel = smoothRange(.08, 1, p)
    const steer = smoothRange(0, .68, p)
    const radius = STRING_FLIGHT_START_RADIUS * Math.exp(
      Math.log(STRING_FLIGHT_EDGE_RADIUS / STRING_FLIGHT_START_RADIUS) * travel,
    )
    // Match shaders.ts: a fixed 30-unit focal length and critical impact
    // sqrt(27)/2 give the visible shadow's angular radius for this observer.
    // Following its upper limb, instead of aiming down the radial center,
    // keeps the shrinking observer radius visibly outside the black hole.
    const aspect = Number.isFinite(viewportAspect) && viewportAspect > 0 ? viewportAspect : 1
    const narrow = aspect < .8, lensScale = narrow ? 13.8 : 10.2
    const target = normalizeEdgeFrame(edgeFrame), sag = aspect * target.curvature
    // Same sag/radius relation as the horizon editor, in viewport-height units.
    const targetShadowRadius = Math.max((aspect * aspect / 4 + sag * sag) / (2 * sag), 1 - target.height + .08)
    const initialShadowRadius = shadowImageRadius(STRING_FLIGHT_START_RADIUS) * camera.zoom / lensScale
    // Follow a monotone apparent radius as the real observer approaches. This
    // prevents an interstellar/homepage preset from overshooting the final arc.
    const shadowRadius = initialShadowRadius + (targetShadowRadius - initialShadowRadius) * travel
    const zoom = shadowRadius * lensScale / shadowImageRadius(radius)
    // vUv is bottom-up. Account for the portrait shader's sixfold centerY
    // mapping before placing the growing shadow center below the viewport.
    const initialCenterY = narrow ? .5 + (camera.centerY - .5) * 6 : camera.centerY
    const initialLimb = initialCenterY + initialShadowRadius
    const limb = initialLimb + (1 - target.height - initialLimb) * steer
    const centerY = limb - shadowRadius
    return {
      ...camera,
      zoom,
      centerX: camera.centerX + (.5 - camera.centerX) * steer,
      centerY: narrow ? .5 + (centerY - .5) / 6 : centerY,
      roll: camera.roll - 3 * travel,
      inclination: Math.min(89, Math.max(5, camera.inclination - 3 * travel)),
      radius,
    }
  }
  const align = smoothRange(.025, .30, p)
  const travel = Math.pow(smoothRange(.08, .88, p), 1.6)
  const bank = smoothRange(.08, .72, p)
  // First skim closer to the equatorial disk, then look slightly down into
  // the growing shadow. The final static observer stays outside the photon
  // sphere; the workspace's black veil completes the passage after .86.
  const skim = Math.sin(Math.PI * smoothRange(.06, .72, p))
  return {
    ...camera,
    centerX: camera.centerX + (.5 - camera.centerX) * align,
    centerY: camera.centerY + (.5 - camera.centerY) * align,
    roll: camera.roll - 7 * bank,
    inclination: Math.min(89, Math.max(5, camera.inclination + 3 * skim - 9 * travel)),
    // A constant lens with an exponentially approaching observer gives the
    // disk real parallax, while avoiding a late linear-distance rush.
    radius: Math.max(STRING_FLIGHT_END_RADIUS, STRING_FLIGHT_START_RADIUS
      * Math.exp(Math.log(STRING_FLIGHT_END_RADIUS / STRING_FLIGHT_START_RADIUS) * travel)),
  }
}
