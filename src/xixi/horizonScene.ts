import type { OrbitDay, OrbitGroup } from './orbitGroups'
import { moveOrbitGroup } from './orbitGroups'
import { springStep } from './orbitMotion'
import type { Spring } from './orbitMotion'
import type { HorizonTuning } from './horizonTuning'
import { getStringFlightProjection, getStringFlightEdgePull, setStringFlightEdgePull, stringFlightEdgeDisplacement } from '../prototype/stringFlight'

export type HorizonPoint = { x: number; y: number }
export type HorizonProjection = {
  width: number; height: number; apexY: number; radius: number; cx: number; cy: number
}
export type HorizonPosition = HorizonPoint & { t: number; index: number; day: OrbitDay; angle: number }
export type HorizonVisual = {
  groups: readonly OrbitGroup[]; day: OrbitDay; tuning: HorizonTuning; reduced: boolean; reveal: number
  pointer: HorizonPoint | null; dragging: { id: string; x: number; y: number } | null
  dropTarget: { day: OrbitDay; index: number } | null; expanded: string | null
}

const clamp = (n: number, low = 0, high = 1) => Math.min(high, Math.max(low, n))
const finite = (n: number, fallback: number) => Number.isFinite(n) ? n : fallback
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const spring = (value: number): Spring => ({ value, velocity: 0 })
const wrap = (n: number) => (n % 1 + 1) % 1
const SAMPLE_COUNT = 224

/** One planetary horizon. The circle's center remains below the viewport even
 * on portrait screens; curvature specifies the preferred edge sag / width. */
export function horizonProjection(width: number, height: number, tuning: HorizonTuning): HorizonProjection {
  const w = Math.max(1, finite(width, 1)), h = Math.max(1, finite(height, 1))
  const apexY = h * clamp(finite(tuning.height, .62), .25, .86)
  const sag = w * clamp(finite(tuning.curvature, .16), .025, .45)
  const radius = Math.max((w * w / 4 + sag * sag) / (2 * sag), h - apexY + h * .08)
  return { width: w, height: h, apexY, radius, cx: w / 2, cy: apexY + radius }
}

/** The overlay follows the same camera as the homepage, including mid-flight. */
export function renderedHorizonProjection(width: number, height: number, tuning: HorizonTuning): HorizonProjection {
  return getStringFlightProjection(width, height) ?? horizonProjection(width, height, tuning)
}

export function horizonPoint(projection: HorizonProjection, t: number): HorizonPoint {
  const x = projection.width * clamp(finite(t, .5)), dx = x - projection.cx
  return { x, y: projection.cy - Math.sqrt(Math.max(0, projection.radius ** 2 - dx * dx)) }
}

/** Detail strands follow the same deformed limb as the scene and main band. */
export function interactiveHorizonPoint(projection: HorizonProjection, t: number): HorizonPoint {
  const point = horizonPoint(projection, t)
  const angle = Math.atan2(point.x - projection.cx, projection.cy - point.y)
  const displacement = stringFlightEdgeDisplacement(angle, getStringFlightEdgePull()) * projection.height
  return { x: point.x + Math.sin(angle) * displacement, y: point.y - Math.cos(angle) * displacement }
}

export function horizonGroupPositions(groups: readonly OrbitGroup[], day: OrbitDay, projection: HorizonProjection) {
  const result = new Map<string, HorizonPosition>(), items = groups.filter(group => group.day === day)
  items.forEach((group, index) => {
    const t = .16 + .68 * (index + .5) / items.length, p = horizonPoint(projection, t)
    result.set(group.id, { ...p, t, index, day, angle: Math.asin((p.x - projection.cx) / projection.radius) })
  })
  return result
}

/** Insertion uses the unchanged original anchors, so a preview cannot move its
 * own hit thresholds. Dropping on a group's own anchor preserves its index. */
export function horizonDropIndex(
  point: HorizonPoint, projection: HorizonProjection, groups: readonly OrbitGroup[], day: OrbitDay, dragId: string,
): number {
  const t = clamp(finite(point.x, projection.cx) / projection.width)
  const positions = horizonGroupPositions(groups, day, projection)
  return [...positions].filter(([id, anchor]) => id !== dragId && anchor.t < t - 1e-9).length
}

type RibbonPoint = HorizonPoint & { nx: number; ny: number }
type GroupMotion = {
  t: Spring; lift: Spring; angle: Spring; x: Spring; y: Spring; offsetX: Spring; offsetY: Spring
  center: HorizonPoint; dragging: boolean
}

/** Material flows along a stable, shared curve. No particles stand in for the
 * band: its thickness is a warm body containing continuous fine filaments. */
export class HorizonCanvas {
  private canvas: HTMLCanvasElement
  private context: CanvasRenderingContext2D
  private getState: () => HorizonVisual
  private onPositions: (positions: Map<string, HorizonPosition>, projection: HorizonProjection) => void
  private observer: ResizeObserver
  private frame = 0
  private disposed = false
  private width = 1
  private height = 1
  private ratio = 1
  private last = 0
  private flowTime = 0
  private atmosphere: { image: HTMLCanvasElement; top: number; key: string } | null = null
  private samples: RibbonPoint[] = []
  private motions = new Map<string, GroupMotion>()
  private pointerAngle = spring(0)
  private pointerDisplacement = spring(0)
  private previousDay: OrbitDay
  private dayProgress = 1
  private dayDirection = 1
  private materialDrift = spring(0)
  private materialDestination = 0
  private groupVisibility = 1

  constructor(
    canvas: HTMLCanvasElement, getState: () => HorizonVisual,
    onPositions: (positions: Map<string, HorizonPosition>, projection: HorizonProjection) => void,
  ) {
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('HorizonCanvas requires a 2D canvas context')
    this.canvas = canvas; this.context = context; this.getState = getState; this.onPositions = onPositions
    this.previousDay = getState().day
    this.resize()
    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(canvas)
    document.addEventListener('visibilitychange', this.visibility)
    if (!document.hidden) this.frame = requestAnimationFrame(this.render)
  }

  destroy() {
    if (this.disposed) return
    this.disposed = true
    cancelAnimationFrame(this.frame); this.frame = 0
    this.observer.disconnect()
    document.removeEventListener('visibilitychange', this.visibility)
    this.releaseAtmosphere(); this.samples = []; this.motions.clear()
    setStringFlightEdgePull({ angle: 0, displacement: 0, spread: .1 })
  }

  private resize = () => {
    if (this.disposed) return
    const rect = this.canvas.getBoundingClientRect()
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height)
    this.ratio = clamp(finite(globalThis.devicePixelRatio, 1), 1, 1.6)
    this.canvas.width = Math.round(this.width * this.ratio)
    this.canvas.height = Math.round(this.height * this.ratio)
    this.releaseAtmosphere()
  }

  private visibility = () => {
    if (this.disposed) return
    cancelAnimationFrame(this.frame); this.frame = 0; this.last = 0
    if (!document.hidden) this.frame = requestAnimationFrame(this.render)
  }

  private sampleCurve(projection: HorizonProjection, state: HorizonVisual, dt: number) {
    const pointer = state.pointer
    const angle = pointer ? Math.atan2(pointer.x - projection.cx, projection.cy - pointer.y) : this.pointerAngle.value
    const distance = pointer ? Math.hypot(pointer.x - projection.cx, pointer.y - projection.cy) - projection.radius : 0
    const amplitude = Math.min(16 * clamp(state.tuning.wave, 0, 3), this.height * .075)
    const displacement = pointer && !state.reduced && !state.dragging
      ? amplitude * Math.tanh(distance / 44) * Math.exp(-((distance / 180) ** 2)) * clamp(state.reveal) : 0
    this.pointerAngle = state.reduced ? spring(angle) : springStep(this.pointerAngle, angle, dt, 13, 1)
    this.pointerDisplacement = state.reduced ? spring(0) : springStep(this.pointerDisplacement, displacement, dt, 13, 1)
    const pull = { angle: this.pointerAngle.value, displacement: this.pointerDisplacement.value / this.height,
      spread: clamp(this.width * .11 / projection.radius, .015, .65) }
    setStringFlightEdgePull(pull)
    this.samples = Array.from({ length: SAMPLE_COUNT + 1 }, (_, index) => {
      const at = index / SAMPLE_COUNT, point = horizonPoint(projection, at)
      const nx = (point.x - projection.cx) / projection.radius, ny = (point.y - projection.cy) / projection.radius
      const response = stringFlightEdgeDisplacement(Math.atan2(nx, -ny), pull) * this.height
      return { x: point.x + nx * response, y: point.y + ny * response, nx, ny }
    })
  }

  private point(t: number, offset = 0): HorizonPoint {
    const at = clamp(t) * SAMPLE_COUNT, index = Math.min(SAMPLE_COUNT - 1, Math.floor(at)), fraction = at - index
    const a = this.samples[index], b = this.samples[index + 1]
    return { x: mix(a.x, b.x, fraction) + mix(a.nx, b.nx, fraction) * offset,
      y: mix(a.y, b.y, fraction) + mix(a.ny, b.ny, fraction) * offset }
  }

  private path(from = 0, to = 1, offset = 0, warp = 0, phase = 0) {
    const c = this.context, count = Math.max(8, Math.ceil((to - from) * SAMPLE_COUNT))
    c.beginPath()
    for (let step = 0; step <= count; step++) {
      const t = mix(from, to, step / count)
      const texture = warp * (Math.sin(t * 13 + phase) * .7 + Math.sin(t * 29 - phase * .4) * .3)
      const p = this.point(t, offset + texture)
      if (step === 0) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y)
    }
  }

  private releaseAtmosphere() {
    if (this.atmosphere) { this.atmosphere.image.width = 0; this.atmosphere.image.height = 0 }
    this.atmosphere = null
  }

  private glowImage(projection: HorizonProjection, thickness: number) {
    const key = `${this.width}:${this.height}:${projection.apexY}:${projection.radius}:${thickness}`
    if (this.atmosphere?.key === key) return this.atmosphere
    this.releaseAtmosphere()
    const extent = thickness * 6
    const top = Math.max(0, Math.floor(projection.apexY - extent))
    const bottom = Math.min(this.height, Math.ceil(horizonPoint(projection, 0).y + extent))
    const image = document.createElement('canvas')
    image.width = Math.ceil(this.width); image.height = Math.max(1, bottom - top)
    const c = image.getContext('2d')!
    const inner = Math.max(0, projection.radius - extent), outer = projection.radius + extent
    const glow = c.createRadialGradient(projection.cx, projection.cy - top, inner, projection.cx, projection.cy - top, outer)
    // A continuous radial falloff follows the stable circular horizon. Cache it
    // in a cropped strip for the still scene. The pulled scene uses the same
    // falloff along its deformed path so no glow remains on the old circle.
    for (let index = 0; index <= 64; index++) {
      const at = index / 64, distance = mix(inner, outer, at) - projection.radius
      const alpha = index === 0 || index === 64 ? 0
        : .22 * Math.exp(-.5 * (distance / (thickness * .72)) ** 2)
          + .055 * Math.exp(-.5 * (distance / (thickness * 1.9)) ** 2)
      glow.addColorStop(at, `rgba(237,158,69,${alpha.toFixed(5)})`)
    }
    c.fillStyle = glow; c.fillRect(0, 0, image.width, image.height)
    this.atmosphere = { image, top, key }
    return this.atmosphere
  }

  private pulledGlow(thickness: number, energy: number) {
    const c = this.context
    this.path()
    c.strokeStyle = '#ed9e45'
    // Layered Gaussian falloff, widest first. Only used while a pointer pulls
    // the curve; the stationary texture remains cached for the idle scene.
    for (const [sigma, peak] of [[thickness * .72, .22], [thickness * 1.9, .055]]) {
      let previous = 0
      for (let step = 24; step >= 0; step--) {
        const distance = (step + .5) / 25 * sigma * 3.2
        const alpha = peak * Math.exp(-.5 * (distance / sigma) ** 2)
        c.lineWidth = distance * 2
        c.globalAlpha = clamp((alpha - previous) * energy); c.stroke(); previous = alpha
      }
    }
  }

  private ribbon(state: HorizonVisual, projection: HorizonProjection) {
    const c = this.context, tuning = state.tuning
    const thickness = clamp(finite(tuning.thickness, 22), 4, 80)
    const light = clamp(state.reveal) * clamp(finite(tuning.brightness, 1), 0, 2.5)
    const glow = clamp(finite(tuning.glow, .8), 0, 2)
    c.save(); c.globalCompositeOperation = 'screen'; c.lineCap = 'round'; c.lineJoin = 'round'

    if (light * glow > 0) {
      const movement = clamp(Math.abs(this.pointerDisplacement.value) / 2)
      const atmosphere = movement < 1 ? this.glowImage(projection, thickness) : null
      // Keep both controls responsive above 1 without rebuilding the texture.
      // Normal settings use one pass; the strongest allowed appearance uses 3.
      for (let energy = light * glow * (1 - movement); atmosphere && energy > 0; energy -= 1) {
        c.globalAlpha = clamp(energy); c.drawImage(atmosphere.image, 0, atmosphere.top)
      }
      if (movement > 0) this.pulledGlow(thickness, light * glow * movement)
    }
    const body = c.createLinearGradient(0, 0, this.width, 0)
    body.addColorStop(0, '#85552b'); body.addColorStop(.18, '#c78638')
    body.addColorStop(.5, '#e7ad62'); body.addColorStop(.82, '#bb792f'); body.addColorStop(1, '#81522b')
    this.path(); c.strokeStyle = body; c.lineWidth = thickness; c.globalAlpha = clamp(light * .24); c.stroke()
    this.path(); c.strokeStyle = '#e8af62'; c.lineWidth = thickness * .66
    c.globalAlpha = clamp(light * .25); c.stroke()
    this.path(); c.strokeStyle = '#ffdca0'; c.lineWidth = thickness * .30
    c.globalAlpha = clamp(light * .37); c.stroke()

    // Unequal, coherent filaments give the band depth at rest. Their shape
    // advects slowly while the underlying horizon remains completely stable.
    for (let lane = 0; lane < 25; lane++) {
      const fraction = lane / 24, envelope = Math.sin(fraction * Math.PI) ** .65
      const offset = (fraction - .5) * thickness * .98
      const phase = lane * 2.399 - this.flowTime * (.17 + lane % 4 * .045) - this.materialDrift.value * 15
      this.path(0, 1, offset, thickness * .035 * envelope, phase)
      c.strokeStyle = lane % 4 === 0 ? '#fff0ca' : lane % 3 === 0 ? '#dd9c4a' : '#f2c47e'
      c.lineWidth = lane % 5 === 0 ? 1.05 : .40 + envelope * .22
      c.globalAlpha = clamp(light * envelope * (.085 + (lane % 5) * .034)); c.stroke()
    }

    // Long streaks run at different speeds inside the same luminous band.
    // Copies on both sides of the wrap avoid a visible material seam.
    for (let lane = 0; lane < 28; lane++) {
      const length = .13 + (lane % 7) * .027
      const speed = .018 + (lane % 6) * .006
      const head = wrap(lane * .381966 + this.flowTime * speed + this.materialDrift.value)
      const offset = Math.sin(lane * 2.17) * thickness * .44
      for (const copy of [-1, 0, 1]) {
        const start = head + copy - length, end = head + copy
        if (end <= 0 || start >= 1) continue
        const a = this.point(clamp(start), offset), b = this.point(clamp(end), offset)
        if (Math.hypot(b.x - a.x, b.y - a.y) < 1) continue
        const streak = c.createLinearGradient(a.x, a.y, b.x, b.y)
        streak.addColorStop(0, '#f4bd7600'); streak.addColorStop(.28, '#efbb70a0')
        streak.addColorStop(.72, lane % 3 === 0 ? '#fff4d9ee' : '#f8d59ac0'); streak.addColorStop(1, '#ffdfa100')
        this.path(clamp(start), clamp(end), offset, thickness * .025, lane * .87 - this.flowTime * speed * 9)
        c.strokeStyle = streak; c.lineWidth = lane % 4 === 0 ? 1.3 : .65
        c.globalAlpha = clamp(light * (.45 + (lane % 3) * .12)); c.stroke()
      }
    }
    this.path()
    c.strokeStyle = '#fff1ce'; c.lineWidth = Math.max(.8, thickness * .063); c.globalAlpha = clamp(light * .69); c.stroke()
    this.path()
    c.strokeStyle = '#fffbee'; c.lineWidth = .65; c.globalAlpha = clamp(light * .71); c.stroke()
    c.restore()
  }

  private groups(state: HorizonVisual, projection: HorizonProjection, dt: number) {
    const sameDayPreview = state.dragging && state.dropTarget?.day === state.day
    const preview = sameDayPreview
      ? moveOrbitGroup(state.groups, state.dragging!.id, state.day, state.dropTarget!.index) : state.groups
    const targets = horizonGroupPositions(preview, state.day, projection)
    const positions = new Map<string, HorizonPosition>()
    const advance = (value: Spring, target: number, frequency = 15, damping = .9) => state.reduced
      ? spring(target) : springStep(value, target, dt, frequency, damping)
    const dayEase = 1 - (1 - this.dayProgress) ** 3
    const drift = state.reduced ? 0 : this.dayDirection * .025 * (1 - dayEase)
    const rendered = state.groups.filter(group => group.day === state.day || group.id === state.dragging?.id)

    for (const group of rendered) {
      const target = targets.get(group.id) ?? { ...horizonPoint(projection, .5), t: .5, angle: 0, index: 0, day: group.day }
      const dragging = state.dragging?.id === group.id
      let motion = this.motions.get(group.id)
      if (!motion) {
        const p = this.point(target.t + drift)
        const left = this.point(target.t + drift - .0001), right = this.point(target.t + drift + .0001)
        motion = { t: spring(target.t), lift: spring(0), angle: spring(Math.atan2(right.y - left.y, right.x - left.x)), x: spring(p.x), y: spring(p.y),
          offsetX: spring(0), offsetY: spring(0), center: p, dragging: false }
        this.motions.set(group.id, motion)
      }
      motion.t = advance(motion.t, target.t)
      const visibleT = clamp(motion.t.value + drift), anchor = this.point(visibleT)
      const before = this.point(visibleT - .0001), after = this.point(visibleT + .0001)
      const angle = Math.atan2(after.y - before.y, after.x - before.x)
      if (dragging && !motion.dragging) { motion.x = spring(motion.center.x); motion.y = spring(motion.center.y) }
      if (!dragging && motion.dragging) {
        motion.offsetX = spring(motion.center.x - anchor.x); motion.offsetY = spring(motion.center.y - anchor.y)
      }
      motion.lift = advance(motion.lift, dragging ? 1 : 0, 17, 1)
      motion.angle = advance(motion.angle, dragging ? -.045 : angle, 12, 1)
      if (dragging) {
        motion.x = advance(motion.x, state.dragging!.x, 42, 1); motion.y = advance(motion.y, state.dragging!.y, 42, 1)
        motion.center = { x: motion.x.value, y: motion.y.value }
      } else {
        motion.offsetX = advance(motion.offsetX, 0, 16, 1); motion.offsetY = advance(motion.offsetY, 0, 16, 1)
        motion.center = { x: anchor.x + motion.offsetX.value, y: anchor.y + motion.offsetY.value }
      }
      motion.dragging = dragging
      positions.set(group.id, { ...motion.center, t: visibleT, day: target.day, index: target.index, angle: motion.angle.value })
      const visibility = this.groupVisibility ** 2 * (3 - 2 * this.groupVisibility)
      this.groupStrand(motion, anchor, visibleT, state, (dragging ? 1 : dayEase) * visibility)
    }
    const live = new Set(rendered.map(group => group.id))
    for (const id of this.motions.keys()) if (!live.has(id)) this.motions.delete(id)
    this.onPositions(positions, projection)
  }

  private groupStrand(motion: GroupMotion, anchor: HorizonPoint, t: number, state: HorizonVisual, fade: number) {
    if (fade <= 0) return
    const c = this.context, lift = clamp(motion.lift.value)
    const halfWidth = clamp(this.width * .046, 30, 76), span = halfWidth / this.width
    const cos = Math.cos(motion.angle.value), sin = Math.sin(motion.angle.value)
    const strand: HorizonPoint[] = []
    for (let step = 0; step <= 40; step++) {
      const q = step / 20 - 1, curve = this.point(t + q * span)
      const along = q * halfWidth * (1 - .10 * lift)
      strand.push({ x: motion.center.x + mix(curve.x - anchor.x, cos * along, lift),
        y: motion.center.y + mix(curve.y - anchor.y, sin * along, lift) })
    }
    const from = strand[0], to = strand[strand.length - 1]
    const gradient = (middle: string) => {
      const result = c.createLinearGradient(from.x, from.y, to.x, to.y)
      result.addColorStop(0, '#f9c47800'); result.addColorStop(.22, middle)
      result.addColorStop(.78, middle); result.addColorStop(1, '#f9c47800')
      return result
    }
    const energy = clamp(state.reveal) * clamp(state.tuning.brightness, 0, 2.5) * fade
    c.save(); c.globalCompositeOperation = 'screen'; c.lineCap = 'round'; c.lineJoin = 'round'
    const thickness = clamp(state.tuning.thickness, 4, 80)
    for (const [width, alpha, color] of [
      [thickness * 1.9, .16 * state.tuning.glow, '#ffc574'],
      [thickness * .72, .34, '#ffd393'],
      [thickness * .28, .68, '#ffeac0'],
      [2.2, .96, '#fff9e8'],
    ] as const) {
      c.beginPath()
      strand.forEach((point, index) => { if (index === 0) c.moveTo(point.x, point.y); else c.lineTo(point.x, point.y) })
      c.strokeStyle = gradient(color); c.lineWidth = width * (1 - lift * .5)
      c.globalAlpha = clamp(energy * alpha); c.stroke()
    }
    c.restore()
  }

  private render = (stamp: number) => {
    this.frame = 0
    if (this.disposed || document.hidden) return
    const state = this.getState(), dt = this.last ? clamp((stamp - this.last) / 1000, 0, .05) : 1 / 60
    this.last = stamp
    if (state.day !== this.previousDay) {
      this.dayDirection = state.day > this.previousDay ? 1 : -1
      this.previousDay = state.day; this.dayProgress = state.reduced ? 1 : 0
      this.materialDestination += this.dayDirection * .12
    }
    this.dayProgress = state.reduced ? 1 : Math.min(1, this.dayProgress + dt / .7)
    this.groupVisibility = state.reduced ? (state.expanded ? 0 : 1)
      : clamp(this.groupVisibility + (state.expanded ? -1 : 1) * dt / .4)
    this.materialDrift = state.reduced ? spring(this.materialDestination) : springStep(this.materialDrift, this.materialDestination, dt, 5, 1)
    if (!state.reduced) this.flowTime += dt * clamp(state.tuning.flow, 0, 2)
    const projection = renderedHorizonProjection(this.width, this.height, state.tuning)
    this.sampleCurve(projection, state, dt)
    const c = this.context
    c.setTransform(this.ratio, 0, 0, this.ratio, 0, 0)
    c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'
    c.clearRect(0, 0, this.width, this.height)
    this.ribbon(state, projection); this.groups(state, projection, dt)
    if (!this.disposed && !document.hidden) this.frame = requestAnimationFrame(this.render)
  }
}
