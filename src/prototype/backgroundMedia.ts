import type { SceneCamera } from '../spatial/scene'
import { portraitCameraOffset } from './portraitComposition.ts'
import { resolveStringFlightCamera, STRING_FLIGHT_START_RADIUS } from './stringFlight.ts'
import type { StringFlightMode, StringFlightEdgeFrame } from './stringFlight.ts'

export type BackgroundMode = 'realtime' | 'video' | 'image'
export type MediaResolution = '4k' | '1080p' | '720p'
export type MediaQuality = 'high' | 'standard'
export const MEDIA_DIMENSIONS = { '4k': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720] } as const
export const MEDIA_BITRATES = { '4k': { high: 45, standard: 30 }, '1080p': { high: 20, standard: 12 }, '720p': { high: 10, standard: 6 } } as const

export type MediaView = 'panorama' | 'horizon'
export function backgroundAsset(shape: 'portrait' | 'landscape', night: boolean, resolution: MediaResolution, quality: MediaQuality, kind: 'image' | 'video', view: MediaView = 'panorama') {
  // Legacy 720p/standard preferences still load, but redundant encodes are no
  // longer shipped. Optional 4K video is resolved from verified local storage.
  void quality
  const actualResolution = kind === 'image' ? '4k' : resolution === '4k' ? '4k' : '1080p'
  return `/backgrounds/${view === 'horizon' ? 'horizon-' : ''}${shape}-${night ? 'dark' : 'light'}-${actualResolution}-high.${kind === 'video' ? 'mp4' : 'webp'}${view === 'horizon' ? '?framing=overscan-2' : ''}`
}

export const MEDIA_LAYOUT_EVENT = 'astaria-media-layout'
/** Native close-up includes an extra half viewport on all four sides. */
export const HORIZON_MEDIA_OVERSCAN = 2
export function horizonMediaBlend(progress: number) {
  if (!Number.isFinite(progress) || progress <= .66) return 0
  if (progress >= 1) return 1
  const t = Math.max(0, Math.min(1, (progress - .66) / .34))
  return Math.max(0, Math.min(1, t * t * t * (t * (t * 6 - 15) + 10)))
}

type MediaMatrix = { a: number; b: number; c: number; d: number; e: number; f: number }

/** Inverse-map all viewport corners: a rotated rectangle's bounding box alone
 * cannot prove coverage. Leave a soft 24 CSS-pixel margin before revealing it. */
export function mediaViewportCoverage(matrix: MediaMatrix, sourceWidth: number, sourceHeight: number, width: number, height: number) {
  const { a, b, c, d, e, f } = matrix, determinant = a * d - b * c
  if (!Number.isFinite(determinant) || determinant <= 0) return 0
  let margin = Infinity
  for (const [x, y] of [[0, 0], [width, 0], [width, height], [0, height]]) {
    const sx = (d * (x - e) - c * (y - f)) / determinant
    const sy = (-b * (x - e) + a * (y - f)) / determinant
    margin = Math.min(margin, sx, sy, sourceWidth - sx, sourceHeight - sy)
  }
  const t = Math.max(0, Math.min(1, margin * Math.hypot(a, b) / 24))
  return t * t * (3 - 2 * t)
}

export const MEDIA_CAMERA_VIEWS = {
  panorama: { zoom: .7, roll: 18, inclination: 83, centerX: .65, centerY: .51 },
  interstellar: { zoom: 2.05, roll: 7, inclination: 84, centerX: .98, centerY: .51 },
} as const

export function shadowImageRadius(distance = STRING_FLIGHT_START_RADIUS) {
  const sine = Math.sqrt(27) / 2 * Math.sqrt(1 - 1 / distance) / distance
  return 30 * sine / Math.sqrt(1 - sine * sine)
}

/** One affine map for the decoded master, entry hit target, digits and horizon.
 * Preserve the camera zoom used by chat UI; media crop belongs to presentation. */
export function mediaSceneLayout(camera: SceneCamera, width: number, height: number, mobile: boolean,
  flight: { progress: number; mode: StringFlightMode; edgeFrame: StringFlightEdgeFrame } = { progress: 0, mode: 'edge', edgeFrame: { height: .62, curvature: .16 } }) {
  const w = Math.max(1, width), h = Math.max(1, height), narrow = w / h < .8
  const shape = narrow ? 'portrait' : 'landscape'
  const sourceWidth = narrow ? 2160 : 3840, sourceHeight = narrow ? 3840 : 2160
  const base = MEDIA_CAMERA_VIEWS.panorama
  const sourceX = narrow ? .5 + (base.centerX + portraitCameraOffset(sourceWidth, sourceHeight, base.zoom) - .5) * .34 : base.centerX
  const sourceY = 1 - (narrow ? .5 + (base.centerY - .5) * 6 : base.centerY)
  const baseX = narrow ? .5 + (base.centerX + (mobile ? portraitCameraOffset(w, h, base.zoom) : 0) - .5) * .34 : base.centerX
  // Anchor the image to the same center as the live view. Unlike centered
  // object-fit:cover this remains correct when the viewport aspect changes.
  const fit = Math.max(w * baseX / (sourceWidth * sourceX), w * (1 - baseX) / (sourceWidth * (1 - sourceX)), h / sourceHeight)
  const lens = narrow ? 13.8 : 10.2
  const pose = { ...camera, zoom: camera.zoom * sourceHeight * fit / h,
    centerX: camera.centerX + (mobile ? portraitCameraOffset(w, h, camera.zoom) : 0) }
  const effective = resolveStringFlightCamera(pose, flight.progress, flight.mode, w / h, flight.edgeFrame)
  const cx = w * (narrow ? .5 + (effective.centerX - .5) * .34 : effective.centerX)
  const cy = h * (1 - (narrow ? .5 + (effective.centerY - .5) * 6 : effective.centerY))
  const radius = h * effective.zoom / lens * shadowImageRadius(effective.radius)
  const sourceRadius = sourceHeight * base.zoom / lens * shadowImageRadius()
  const scale = radius / sourceRadius, angle = (base.roll - effective.roll) * Math.PI / 180
  const a = scale * Math.cos(angle), b = scale * Math.sin(angle), c = -b, d = a
  const e = cx - a * sourceWidth * sourceX - c * sourceHeight * sourceY
  const f = cy - b * sourceWidth * sourceX - d * sourceHeight * sourceY
  // The second master was rendered at the final horizon view (not enlarged
  // from home). Match the same circle throughout the handover. Its axis and
  // opacity depend on flight progress only, so interrupted exits reverse cleanly.
  // The final close-up is centered, so choose its master by orientation rather
  // than the homepage's portrait lens threshold. A tall desktop window must
  // not try to cover its height with the landscape close-up.
  const closeShape = w < h ? 'portrait' : 'landscape'
  const closeSourceWidth = closeShape === 'portrait' ? 2160 : 3840
  const closeSourceHeight = closeShape === 'portrait' ? 3840 : 2160
  const aspect = closeSourceWidth / closeSourceHeight, sag = aspect * .16
  const frameRadius = closeSourceHeight * Math.max((aspect * aspect / 4 + sag * sag) / (2 * sag), 1 - .62 + .08)
  const closeRadius = frameRadius / HORIZON_MEDIA_OVERSCAN
  const closeX = closeSourceWidth / 2, closeY = closeSourceHeight / 2 + (closeSourceHeight * .12 + frameRadius) / HORIZON_MEDIA_OVERSCAN
  const closeScale = radius / closeRadius, closeAngle = (base.roll - 3 - effective.roll) * Math.PI / 180
  const ca = closeScale * Math.cos(closeAngle), cb = closeScale * Math.sin(closeAngle), cc = -cb, cd = ca
  const closeMatrix = { a: ca, b: cb, c: cc, d: cd, e: cx - ca * closeX - cc * closeY, f: cy - cb * closeX - cd * closeY }
  const closeCoverage = mediaViewportCoverage(closeMatrix, closeSourceWidth, closeSourceHeight, w, h)
  return { shape, sourceWidth, sourceHeight, matrix: { a, b, c, d, e, f },
    closeMatrix, closeCoverage, closeShape, closeSourceWidth, closeSourceHeight,
    closeSourceCenter: { x: closeX, y: closeY, radius: closeRadius },
    blend: flight.mode === 'edge' ? horizonMediaBlend(flight.progress) * closeCoverage : 0,
    sourceCenter: { x: sourceWidth * sourceX, y: sourceHeight * sourceY, radius: sourceRadius },
    projection: { width: w, height: h, cx, cy, radius, apexY: cy - radius, unit: radius / shadowImageRadius() } }
}

/** Same critically damped camera as the live scene, without a WebGL context or
 * a permanent RAF. The caller schedules frames only while these springs move. */
export class MediaSceneCamera {
  private value = { ...MEDIA_CAMERA_VIEWS.panorama } as { -readonly [K in keyof typeof MEDIA_CAMERA_VIEWS.panorama]: number }
  private velocity = { zoom: 0, roll: 0, inclination: 0, centerX: 0, centerY: 0 }
  private target = { ...this.value }
  private moving = false

  setView(view: keyof typeof MEDIA_CAMERA_VIEWS) {
    this.target = { ...MEDIA_CAMERA_VIEWS[view] }
    this.moving = true
  }

  setPose(pose: Pick<SceneCamera, 'zoom' | 'roll' | 'inclination' | 'centerX' | 'centerY'>) {
    for (const key of Object.keys(this.value) as (keyof typeof this.value)[]) {
      this.value[key] = pose[key]; this.target[key] = pose[key]; this.velocity[key] = 0
    }
    this.moving = false
  }

  advance(seconds: number, reduced = false) {
    if (!this.moving) return
    const omega = 3.5, dt = Math.max(0, seconds), decay = Math.exp(-omega * dt)
    this.moving = false
    for (const key of Object.keys(this.value) as (keyof typeof this.value)[]) {
      const tolerance = key === 'zoom' ? .0005 : key === 'centerX' || key === 'centerY' ? .0001 : .01
      const displacement = this.value[key] - this.target[key]
      const term = this.velocity[key] + omega * displacement
      this.value[key] = reduced ? this.target[key] : this.target[key] + (displacement + term * dt) * decay
      this.velocity[key] = reduced ? 0 : (this.velocity[key] - omega * term * dt) * decay
      if (Math.abs(this.value[key] - this.target[key]) <= tolerance && Math.abs(this.velocity[key]) <= tolerance * 4) {
        this.value[key] = this.target[key]; this.velocity[key] = 0
      } else this.moving = true
    }
  }

  snapshot(reducedMotion = false): SceneCamera {
    return { ...this.value, cameraTransition: this.moving, reducedMotion, paused: false, simulationTime: 0 }
  }
}
