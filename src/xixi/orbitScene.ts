import type { OrbitDay, OrbitGroup } from './orbitGroups'
import { moveOrbitGroup } from './orbitGroups'
import { orbitWave, springStep } from './orbitMotion'
import type { Spring, WavePulse } from './orbitMotion'
import type { OrbitTuning } from './orbitTuning'

export const ORBIT_LOOKS = [
  { id: 'minimal', name: '极简', number: '00', description: '留白与细弦', note: '只留下这三天，和想推进的事' },
  { id: 'engraved', name: '星环', number: '01', description: '细金轨道 · 正面展开', note: '最清楚的三天，像刻在夜空里的年轮' },
  { id: 'accretion', name: '吸积', number: '02', description: '倾斜光盘 · 流动金箔', note: '靠近吸积盘，事情沿着引力缓缓流动' },
  { id: 'horizon', name: '临界', number: '03', description: '低位视角 · 明亮盘缘', note: '贴近光的边缘，让轨道有远近和厚度' },
  { id: 'dust', name: '星尘', number: '04', description: '粒子尘带 · 柔和悬浮', note: '在细碎的星尘里，给每一组事留出位置' },
] as const
export type OrbitLook = typeof ORBIT_LOOKS[number]['id']
export type OrbitPoint = { x: number; y: number }
export type OrbitProjection = { cx: number; cy: number; rx: number; ry: number; tilt: number; start: number; end: number
  rotation: number; innerRadius: number; middleRadius: number; configured: number }
export type OrbitPosition = OrbitPoint & { t: number; day: OrbitDay; index: number; angle: number }
export type OrbitVisual = {
  look: OrbitLook; groups: readonly OrbitGroup[]; reduced: boolean; reveal: number
  pointer: OrbitPoint | null; dragging: { id: string; x: number; y: number } | null; expanded: string | null
  dropTarget: { day: OrbitDay; index: number } | null
  tuning?: OrbitTuning
}
const clamp = (n: number, a = 0, b = 1) => Math.min(b, Math.max(a, n))
const TAU = Math.PI * 2
const closedOrbit = (projection: OrbitProjection) => projection.end - projection.start >= TAU - .0001
const orbitRadius = (projection: OrbitProjection, day: number) => day <= 1
  ? (projection.innerRadius ?? .55) + day * ((projection.middleRadius ?? .77) - (projection.innerRadius ?? .55))
  : (projection.middleRadius ?? .77) + (day - 1) * (1 - (projection.middleRadius ?? .77))
export function orbitProjection(width: number, height: number, look: OrbitLook, tuning?: OrbitTuning): OrbitProjection {
  if (tuning) {
    const span = tuning.arcDegrees * Math.PI / 180, phase = tuning.rotationDegrees * Math.PI / 180
    const rx = Math.min(width * .46, height * .9) * tuning.scale
    return { cx: width * tuning.centerX, cy: height * tuning.centerY, rx, ry: rx * tuning.flatten, tilt: 0,
      rotation: tuning.tiltDegrees * Math.PI / 180, start: phase - span / 2, end: phase + span / 2,
      innerRadius: 1 - 2 * tuning.gap, middleRadius: 1 - tuning.gap, configured: 1 }
  }
  const narrow = width < 650
  const presets = {
    minimal: { cy: .53, ry: .37, tilt: -.065, start: -1.36, end: 1.36 },
    engraved: { cy: .52, ry: .40, tilt: 0, start: -1.32, end: 1.32 },
    accretion: { cy: .60, ry: .34, tilt: -.16, start: -1.45, end: 1.45 },
    horizon: { cy: .53, ry: .22, tilt: .075, start: -1.52, end: 1.52 },
    dust: { cy: .56, ry: .38, tilt: -.055, start: -1.38, end: 1.38 },
  }[look]
  return { cx: width * (narrow ? -.08 : .065), cy: height * presets.cy,
    rx: width * (narrow ? 1.02 : .84), ry: height * presets.ry, tilt: height * presets.tilt,
    start: presets.start, end: presets.end, rotation: 0, innerRadius: .55, middleRadius: .77, configured: 0 }
}
/** One affine basis for positions, radial offsets and tangents. Rotation is a
 * real screen-space rotation; legacy tilt remains a shear only for old presets. */
export function orbitBasis(projection: OrbitProjection, t: number) {
  const angle = projection.start + (projection.end - projection.start) * t
  const cos = Math.cos(projection.rotation ?? 0), sin = Math.sin(projection.rotation ?? 0)
  const x = Math.cos(angle) * projection.rx, y = Math.sin(angle) * projection.ry + Math.cos(angle) * projection.tilt
  const tx = -Math.sin(angle) * projection.rx, ty = Math.cos(angle) * projection.ry - Math.sin(angle) * projection.tilt
  return { radialX: x * cos - y * sin, radialY: x * sin + y * cos,
    tangentX: tx * cos - ty * sin, tangentY: tx * sin + ty * cos }
}
export function orbitPoint(projection: OrbitProjection, day: OrbitDay, t: number, radialOffset = 0): OrbitPoint {
  const radius = orbitRadius(projection, day) + radialOffset, basis = orbitBasis(projection, t)
  return { x: projection.cx + basis.radialX * radius, y: projection.cy + basis.radialY * radius }
}
export function orbitGroupPositions(groups: readonly OrbitGroup[], projection: OrbitProjection) {
  const result = new Map<string, OrbitPosition>()
  for (const day of [0, 1, 2] as const) {
    const items = groups.filter(group => group.day === day)
    items.forEach((group, index) => {
      const fraction = (index + .5) / Math.max(1, items.length)
      const inset = .1 * clamp((TAU - (projection.end - projection.start)) / (Math.PI / 2))
      const t = projection.configured ? inset + (1 - 2 * inset) * fraction : .22 + .58 * fraction
      const p = orbitPoint(projection, day, t), p2 = orbitPoint(projection, day, t + .001)
      result.set(group.id, { ...p, day, t, index, angle: Math.atan2(p2.y - p.y, p2.x - p.x) })
    })
  }
  return result
}
export function orbitDropTarget(point: OrbitPoint, projection: OrbitProjection, groups: readonly OrbitGroup[], id: string) {
  let day: OrbitDay = 0, t = .5, distance = Infinity
  const rotation = projection.rotation ?? 0, cos = Math.cos(rotation), sin = Math.sin(rotation)
  const dx = point.x - projection.cx, dy = point.y - projection.cy
  const x = (dx * cos + dy * sin) / projection.rx
  const y = (-dx * sin + dy * cos - x * projection.tilt) / projection.ry
  const angle = Math.atan2(y, x), span = projection.end - projection.start
  const phase = ((angle - projection.start) % TAU + TAU) % TAU
  const seed = phase <= span ? phase / span : clamp((phase - TAU) / span)
  for (const candidate of [0, 1, 2] as const) {
    let nearestT = seed, nearestDistance = Infinity
    const distanceAt = (at: number) => { const p = orbitPoint(projection, candidate, at); return Math.hypot(point.x - p.x, point.y - p.y) }
    for (const at of [seed, ...Array.from({ length: 101 }, (_, step) => step / 100)]) {
      const d = distanceAt(at)
      if (d < nearestDistance) { nearestT = at; nearestDistance = d }
    }
    let low = Math.max(0, nearestT - .01), high = Math.min(1, nearestT + .01)
    for (let step = 0; step < 12; step++) {
      const a = low + (high - low) / 3, b = high - (high - low) / 3
      if (distanceAt(a) < distanceAt(b)) high = b; else low = a
    }
    const refinedT = (low + high) / 2, refinedDistance = distanceAt(refinedT)
    if (refinedDistance < nearestDistance) { nearestT = refinedT; nearestDistance = refinedDistance }
    if (nearestDistance < distance - 1e-7) { day = candidate; t = nearestT; distance = nearestDistance }
  }
  if (closedOrbit(projection) && t > 1 - 1e-8) t = 0
  const positions = orbitGroupPositions(groups, projection)
  const index = groups.filter(group => group.day === day && group.id !== id && (positions.get(group.id)?.t ?? 0) < t).length
  return { day, index, distance, t }
}

type RibbonSample = OrbitPoint & { radialX: number; radialY: number }
type GroupMotion = {
  t: Spring; day: Spring; lift: Spring; angle: Spring
  x: Spring; y: Spring; offsetX: Spring; offsetY: Spring
  dragging: boolean; center: OrbitPoint
}
const spring = (value: number): Spring => ({ value, velocity: 0 })
const mix = (a: number, b: number, t: number) => a + (b - a) * t
const SAMPLE_COUNT = 160
const wrappedDistance = (value: number) => ((value + .5) % 1 + 1) % 1 - .5
const wrap = (value: number) => ((value % 1) + 1) % 1

function closedWave(day: number, t: number, time: number, pulses: readonly WavePulse[], pointer: { day: number; t: number; strength: number }, reduced: boolean) {
  if (reduced) return 0
  let value = .55 * Math.sin(t * TAU * 2 - time * .6 + day * .8) + .25 * Math.sin(t * TAU * 3 + time * .36 - day * .55)
  const distance = wrappedDistance(t - pointer.t)
  value += pointer.strength * Math.exp(-.5 * ((distance / .13) ** 2 + ((day - pointer.day) / .65) ** 2))
    * (3.1 + .4 * Math.sin(distance * 26 - time * 1.5))
  for (const pulse of pulses) {
    const age = time - pulse.started
    if (age <= 0) continue
    const front = Math.abs(wrappedDistance(t - pulse.t)) - .3 * age
    value += 1.5 * pulse.strength * Math.exp(-.5 * ((front / .065) ** 2 + ((day - pulse.day) / .7) ** 2))
      * Math.cos(front * 30) * Math.exp(-age / .8) * (1 - Math.exp(-age * 16))
  }
  return 5 * Math.tanh(value / 5)
}

/** The same moving ribbon supplies rendering, task anchors and pointer hitboxes.
 * Dust is cheap deterministic material flow; wave geometry is sampled once/frame. */
export class OrbitCanvas {
  private context: CanvasRenderingContext2D
  private frame = 0
  private width = 1
  private height = 1
  private last = 0
  private observer: ResizeObserver
  private background: HTMLCanvasElement | null = null
  private previousLook: OrbitLook | null = null
  private disposed = false
  private time = 0
  private flowTime = 0
  private priorBackground: HTMLCanvasElement | null = null
  private lookChangedAt = 0
  private projection: OrbitProjection | null = null
  private ribbons: RibbonSample[][] = []
  private motions = new Map<string, GroupMotion>()
  private pulses: WavePulse[] = []
  private pointerDay = spring(1)
  private pointerT = spring(.5)
  private pointerStrength = spring(0)
  private previousPointer: OrbitPoint | null = null
  private lastPulse = -1
  private diskTextures: HTMLCanvasElement[] = []
  private diskTextureKey = ''
  private diskTextureRadii = [.56, .78, 1]
  private dust = Array.from({ length: 330 }, (_, index) => ({
    t: ((index * 0.61803398875) % 1), offset: Math.sin(index * 71.13) * Math.cos(index * 21.17) * .031,
    size: .35 + (Math.sin(index * 9.1) + 1) * .35, alpha: .08 + (Math.cos(index * 7.7) + 1) * .18,
  }))
  constructor(private canvas: HTMLCanvasElement, private read: () => OrbitVisual,
    private place: (positions: Map<string, OrbitPosition>, projection: OrbitProjection) => void) {
    const c = canvas.getContext('2d', { alpha: true })
    if (!c) throw new Error('暂时无法绘制轨道')
    this.context = c
    this.observer = new ResizeObserver(this.resize); this.observer.observe(canvas); this.resize()
    document.addEventListener('visibilitychange', this.visibility)
    this.frame = requestAnimationFrame(this.draw)
  }
  private resize = () => {
    const rect = this.canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 1.5)
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height)
    this.canvas.width = Math.round(this.width * ratio); this.canvas.height = Math.round(this.height * ratio)
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0)
    this.previousLook = null; this.projection = null
  }
  private visibility = () => {
    cancelAnimationFrame(this.frame); this.last = 0; this.previousPointer = null
    if (!document.hidden && !this.disposed) this.frame = requestAnimationFrame(this.draw)
  }
  private sampleRibbons(projection: OrbitProjection, state: OrbitVisual, dt: number) {
    const nearest = state.pointer ? orbitDropTarget(state.pointer, projection, state.groups, '') : null
    const strength = nearest ? Math.exp(-Math.pow(nearest.distance / 115, 2)) : 0
    const speed = state.pointer && this.previousPointer ? Math.hypot(state.pointer.x - this.previousPointer.x, state.pointer.y - this.previousPointer.y) / dt : 0
    if (!state.reduced && nearest && strength > .15 && speed > 45 && this.time - this.lastPulse > .20) {
      this.pulses.push({ day: nearest.day, t: nearest.t, started: this.time, strength: Math.min(1, speed / 650) * strength })
      this.lastPulse = this.time
    }
    this.previousPointer = state.pointer ? { ...state.pointer } : null
    this.pulses = this.pulses.filter(pulse => this.time - pulse.started < 2.2).slice(-6)
    this.pointerDay = springStep(this.pointerDay, nearest?.day ?? this.pointerDay.value, dt, 17, 1)
    const closed = closedOrbit(projection)
    const pointerTarget = nearest ? closed ? this.pointerT.value + wrappedDistance(nearest.t - this.pointerT.value) : nearest.t : this.pointerT.value
    this.pointerT = springStep(this.pointerT, pointerTarget, dt, 20, 1)
    this.pointerStrength = springStep(this.pointerStrength, state.reduced ? 0 : strength, dt, 14, 1)
    const pointer = { day: this.pointerDay.value, t: this.pointerT.value, strength: this.pointerStrength.value }
    this.ribbons = ([0, 1, 2] as const).map(day => Array.from({ length: SAMPLE_COUNT + 1 }, (_, index) => {
      const t = index / SAMPLE_COUNT
      const { radialX, radialY, tangentX, tangentY } = orbitBasis(projection, t)
      const length = Math.max(1, Math.hypot(tangentX, tangentY))
      const periodic = projection.configured ? clamp(1 - (TAU - (projection.end - projection.start)) / (Math.PI / 4)) : 0
      const wave = (periodic > 0 ? mix(orbitWave(day, t, this.time, this.pulses, pointer, state.reduced),
        closedWave(day, t, this.time, this.pulses, pointer, state.reduced), periodic)
        : orbitWave(day, t, this.time, this.pulses, pointer, state.reduced)) * (state.tuning?.wave ?? 1) * (state.look === 'minimal' ? .34 : 1)
      const point = orbitPoint(projection, day, t)
      return { x: point.x + tangentY / length * wave, y: point.y - tangentX / length * wave, radialX, radialY }
    }))
  }
  private point(day: number, t: number, offset = 0): OrbitPoint {
    const at = (this.projection && closedOrbit(this.projection) ? wrap(t) : clamp(t)) * SAMPLE_COUNT
    const index = Math.min(SAMPLE_COUNT - 1, Math.floor(at)), fraction = at - index
    const low = Math.floor(clamp(day, 0, 2)), high = Math.min(2, low + 1), between = clamp(day - low)
    const sample = (row: number) => {
      const a = this.ribbons[row][index], b = this.ribbons[row][index + 1]
      return { x: mix(a.x, b.x, fraction) + mix(a.radialX, b.radialX, fraction) * offset,
        y: mix(a.y, b.y, fraction) + mix(a.radialY, b.radialY, fraction) * offset }
    }
    const a = sample(low), b = sample(high)
    return { x: mix(a.x, b.x, between), y: mix(a.y, b.y, between) }
  }
  private path(c: CanvasRenderingContext2D, day: number, offset = 0, from = 0, to = 1) {
    c.beginPath()
    const steps = Math.max(8, Math.round((to - from) * SAMPLE_COUNT))
    for (let i = 0; i <= steps; i++) {
      const p = this.point(day, from + (to - from) * i / steps, offset)
      if (!i) c.moveTo(p.x, p.y); else c.lineTo(p.x, p.y)
    }
  }
  private paintBackground(look: OrbitLook) {
    const image = document.createElement('canvas'); image.width = this.width; image.height = this.height
    const c = image.getContext('2d')!, w = this.width, h = this.height
    c.fillStyle = look === 'minimal' ? '#08090b' : '#040507'; c.fillRect(0, 0, w, h)
    if (look === 'minimal') return image
    const glow = (x: number, y: number, rx: number, ry: number, color: string, opacity: number) => {
      c.save(); c.translate(x, y); c.scale(rx, ry)
      const gradient = c.createRadialGradient(0, 0, 0, 0, 0, 1)
      gradient.addColorStop(0, `rgba(${color},${opacity})`); gradient.addColorStop(1, `rgba(${color},0)`)
      c.fillStyle = gradient; c.fillRect(-1, -1, 2, 2); c.restore()
    }
    glow(w * .45, h * .56, w * .65, h * .7, '83,57,24', look === 'accretion' ? .17 : .065)
    glow(w * .84, h * .31, w * .5, h * .7, '38,48,73', .09)
    let seed = 41761
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    for (let i = 0; i < 140; i++) {
      c.fillStyle = `rgba(209,208,205,${.025 + random() * .17})`
      c.beginPath(); c.arc(random() * w, random() * h, .2 + random() * .55, 0, Math.PI * 2); c.fill()
    }
    return image
  }
  private diskSurface(c: CanvasRenderingContext2D, projection: OrbitProjection, state: OrbitVisual) {
    const tuning = state.tuning
    if (state.look === 'minimal' || !tuning || tuning.diskWidth <= .001) return
    // Dense unequal streams are baked only when their radial profile changes.
    // Three independently advected textures supply differential orbital flow;
    // frame work remains three image draws, rather than per-pixel CPU noise.
    const size = this.width < 700 ? 768 : 1024
    const key = `${size}:${tuning.gap.toFixed(3)}:${tuning.diskWidth.toFixed(2)}`
    if (this.diskTextureKey !== key) {
      this.diskTextureKey = key
      this.diskTextureRadii = [1 - 2 * tuning.gap, 1 - tuning.gap, 1]
      this.diskTextures = this.diskTextureRadii.map((radius, day) => {
        const canvas = this.diskTextures[day] ?? document.createElement('canvas')
        if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size }
        const paint = canvas.getContext('2d')!, extent = 1.22, unit = size / (extent * 2)
        paint.setTransform(1, 0, 0, 1, 0, 0); paint.clearRect(0, 0, size, size)
        paint.translate(size / 2, size / 2)
        const halfWidth = tuning.gap * (.025 + .62 * tuning.diskWidth)
        const layers = 74, lower = radius - halfWidth, upper = radius + halfWidth
        for (let layer = 0; layer < layers; layer++) {
          const fraction = layer / (layers - 1)
          const uneven = Math.sin(layer * .71 + day) * .0021 + Math.sin(layer * 2.73) * .0011
          const r = lower + (upper - lower) * fraction + uneven
          const edge = Math.sin(fraction * Math.PI) ** .7
          const broad = (.5 + .5 * Math.sin(layer * .32 + Math.sin(layer * .087) * 2)) ** 2
          const fine = .5 + .5 * Math.sin(layer * 2.11 + day * .7)
          const heat = clamp(.82 - day * .20 + broad * .28 + fine * .16)
          const red = Math.round(174 + heat * 81), green = Math.round(99 + heat * 143), blue = Math.round(39 + heat * 170)
          paint.strokeStyle = `rgba(${red},${green},${blue},${edge * (.13 + broad * .28 + fine * .10)})`
          paint.lineWidth = .4 + broad * 1.85 + fine * .75
          paint.beginPath()
          for (let step = 0; step <= 192; step++) {
            const angle = step / 192 * TAU
            const warped = r + (.002 + broad * .0025) * Math.sin(angle * 3 + layer * .19)
              + .0015 * Math.sin(angle * 9 - layer * .73)
            const x = Math.cos(angle) * warped * unit, y = Math.sin(angle) * warped * unit
            if (!step) paint.moveTo(x, y); else paint.lineTo(x, y)
          }
          paint.stroke()
          // Angular inhomogeneity makes rotation visible even on a full ellipse.
          if (layer % 3 === 0) {
            const start = layer * 2.399 + day * .4, span = .45 + broad * 1.8
            const from = { x: Math.cos(start) * r * unit, y: Math.sin(start) * r * unit }
            const to = { x: Math.cos(start + span) * r * unit, y: Math.sin(start + span) * r * unit }
            const thread = paint.createLinearGradient(from.x, from.y, to.x, to.y)
            thread.addColorStop(0, '#efb86800'); thread.addColorStop(.5, `rgba(255,236,200,${edge * (.14 + heat * .30)})`); thread.addColorStop(1, '#efb86800')
            paint.strokeStyle = thread; paint.lineWidth = .45 + fine * 1.6; paint.beginPath()
            for (let step = 0; step <= 32; step++) {
              const angle = start + span * step / 32, rr = r + Math.sin(angle * 3 + layer) * .004
              const x = Math.cos(angle) * rr * unit, y = Math.sin(angle) * rr * unit
              if (!step) paint.moveTo(x, y); else paint.lineTo(x, y)
            }
            paint.stroke()
          }
        }
        return canvas
      })
    }
    c.save()
    if (!closedOrbit(projection)) {
      c.beginPath(); c.moveTo(projection.cx, projection.cy)
      for (let step = 0; step <= SAMPLE_COUNT; step++) {
        const point = orbitPoint(projection, 2, step / SAMPLE_COUNT, .23)
        c.lineTo(point.x, point.y)
      }
      c.closePath(); c.clip()
    }
    c.globalCompositeOperation = 'screen'
    for (const day of [2, 1, 0] as const) {
      const attention = state.expanded ? .45 : state.dragging ? state.dropTarget?.day === day ? 1.15 : .65 : 1
      const brightness = state.reveal * tuning.brightness * attention
      const radiusRatio = orbitRadius(projection, day) / this.diskTextureRadii[day]
      c.save(); c.translate(projection.cx, projection.cy); c.rotate(projection.rotation)
      c.transform(projection.rx * radiusRatio, projection.tilt * radiusRatio, 0, projection.ry * radiusRatio, 0, 0)
      c.rotate(projection.start + this.flowTime * .095 / Math.pow(this.diskTextureRadii[day], 1.5))
      c.globalAlpha = clamp(brightness * .85)
      c.drawImage(this.diskTextures[day], -1.22, -1.22, 2.44, 2.44)
      if (brightness > 1) { c.globalAlpha = clamp((brightness - 1) * .55); c.drawImage(this.diskTextures[day], -1.22, -1.22, 2.44, 2.44) }
      c.restore()
    }
    c.restore()
    // Quiet central shadow keeps the luminous material grounded in a dark well.
    const shadowRadius = Math.min(projection.rx, projection.ry * 2) * projection.innerRadius * .60
    const shadow = c.createRadialGradient(projection.cx, projection.cy, 0, projection.cx, projection.cy, Math.max(1, shadowRadius))
    shadow.addColorStop(0, '#020304'); shadow.addColorStop(.62, '#020304fa'); shadow.addColorStop(1, '#02030400')
    c.save(); c.globalAlpha = state.reveal; c.fillStyle = shadow
    c.fillRect(projection.cx - shadowRadius, projection.cy - shadowRadius, shadowRadius * 2, shadowRadius * 2); c.restore()
  }
  private material(c: CanvasRenderingContext2D, day: OrbitDay, look: OrbitLook, light: number, reveal: number, state: OrbitVisual) {
    // The ellipse stays legible as a day; its fine material circulates around it.
    const speed = .035 / (1 + day * .34), amount = look === 'engraved' ? 90 : look === 'dust' ? 330 : 230
    for (let i = 0; i < amount; i++) {
      const dust = this.dust[i], t = (dust.t + this.flowTime * speed * (1 + dust.offset * 7)) % 1
      const spread = state.tuning ? .08 + state.tuning.diskWidth * .92 : 1
      const p = this.point(day, t, dust.offset * (look === 'engraved' ? .25 : 1) * spread)
      c.globalAlpha = clamp(reveal * light * (this.projection && closedOrbit(this.projection) ? 1 : Math.sin(t * Math.PI) ** .8) * dust.alpha)
      c.fillStyle = i % 5 ? '#dfb778' : '#fff0c7'; c.fillRect(p.x, p.y, dust.size, dust.size)
    }
    for (let streak = 0; streak < 13; streak++) {
      const t = (streak * .077 + this.flowTime * speed * (1 + Math.sin(streak * 6) * .16)) % 1
      const length = .025 + (Math.sin(streak * 5.1) + 1) * .03
      const offset = Math.sin(streak * 8) * .011 * (state.tuning ? .08 + state.tuning.diskWidth * .92 : 1)
      const closed = this.projection && closedOrbit(this.projection), from = closed ? t - length : Math.max(0, t - length)
      const head = this.point(day, from, offset), tail = this.point(day, t, offset)
      if (Math.hypot(head.x - tail.x, head.y - tail.y) < 1) continue
      const flow = c.createLinearGradient(head.x, head.y, tail.x, tail.y)
      flow.addColorStop(0, '#f3ca8300'); flow.addColorStop(.73, '#f5d59e88'); flow.addColorStop(1, '#fff3ce00')
      this.path(c, day, offset, from, t)
      c.globalAlpha = clamp(reveal * light * (closed ? 1 : Math.sin(t * Math.PI)) * .75 * (state.tuning ? .65 : 1))
      c.strokeStyle = flow; c.lineWidth = streak % 3 ? .7 : 1.4; c.stroke()
    }
  }
  private minimalTracks(state: OrbitVisual) {
    const c = this.context, brightness = state.tuning?.brightness ?? 1
    c.save(); c.globalCompositeOperation = 'source-over'
    for (const day of [2, 1, 0] as const) {
      const target = state.dragging && state.dropTarget?.day === day
      const quiet = state.expanded ? .58 : state.dragging && !target ? .65 : 1
      const start = this.point(day, 0), middle = this.point(day, .5)
      const stroke = c.createLinearGradient(start.x, start.y, middle.x, middle.y)
      stroke.addColorStop(0, '#8d887b45'); stroke.addColorStop(.48, '#a59b856f'); stroke.addColorStop(1, target ? '#cfb98faa' : '#b4a68b8c')
      c.strokeStyle = stroke; c.lineWidth = target ? .9 : .65
      c.globalAlpha = clamp(state.reveal * quiet * (.72 + brightness * .28))
      this.path(c, day); c.stroke()
    }
    // A single dim passing highlight is enough to suggest flow without particles.
    if (!state.reduced && (state.tuning?.flow ?? 1) > 0) {
      const t = wrap(.24 + this.flowTime * .013), closed = this.projection && closedOrbit(this.projection)
      const from = closed ? t - .028 : Math.max(0, t - .028)
      const head = this.point(1, from), tail = this.point(1, t)
      if (Math.hypot(head.x - tail.x, head.y - tail.y) > .1) {
        const stroke = c.createLinearGradient(head.x, head.y, tail.x, tail.y)
        stroke.addColorStop(0, '#d5c8ab00'); stroke.addColorStop(.5, '#d5c8ab4d'); stroke.addColorStop(1, '#d5c8ab00')
        c.strokeStyle = stroke; c.lineWidth = .7; c.globalAlpha = clamp(state.reveal * .30 * brightness)
        this.path(c, 1, 0, from, t); c.stroke()
      }
    }
    c.restore()
  }
  private groups(state: OrbitVisual, projection: OrbitProjection, dt: number) {
    const preview = state.dragging && state.dropTarget ? moveOrbitGroup(state.groups, state.dragging.id, state.dropTarget.day, state.dropTarget.index) : state.groups
    const targets = orbitGroupPositions(preview, projection), positions = new Map<string, OrbitPosition>()
    const advance = (value: Spring, target: number, frequency = 16, damping = .88) => state.reduced ? spring(target) : springStep(value, target, dt, frequency, damping)
    for (const group of state.groups) {
      const destination = targets.get(group.id)!, dragging = state.dragging?.id === group.id
      let motion = this.motions.get(group.id)
      if (!motion) {
        motion = { t: spring(destination.t), day: spring(destination.day), lift: spring(0), angle: spring(-.12),
          x: spring(destination.x), y: spring(destination.y), offsetX: spring(0), offsetY: spring(0), dragging: false, center: destination }
        this.motions.set(group.id, motion)
      }
      const wasDragging = motion.dragging
      const targetT = closedOrbit(projection) ? motion.t.value + wrappedDistance(destination.t - motion.t.value) : destination.t
      motion.t = advance(motion.t, targetT); motion.day = advance(motion.day, destination.day)
      const anchor = this.point(motion.day.value, motion.t.value), tangent = this.point(motion.day.value, motion.t.value + .001)
      if (dragging && !wasDragging) { motion.x = spring(motion.center.x); motion.y = spring(motion.center.y) }
      if (!dragging && wasDragging) {
        // Preserve the exact last visible center when releasing, then settle onto
        // the new curved path. Never jump back to the old source anchor.
        motion.offsetX = spring(motion.center.x - anchor.x); motion.offsetY = spring(motion.center.y - anchor.y)
        if (!state.reduced) this.pulses.push({ day: destination.day, t: destination.t, started: this.time, strength: .85 })
      }
      motion.lift = advance(motion.lift, dragging ? 1 : 0, 18, 1)
      if (dragging) {
        motion.x = advance(motion.x, state.dragging!.x, 40, 1); motion.y = advance(motion.y, state.dragging!.y, 40, 1)
        motion.angle = advance(motion.angle, -.12 + clamp(motion.y.velocity / 1600, -.32, .32), 11, 1)
        motion.center = { x: motion.x.value, y: motion.y.value }
      } else {
        motion.offsetX = advance(motion.offsetX, 0, 18, 1); motion.offsetY = advance(motion.offsetY, 0, 18, 1)
        motion.center = { x: anchor.x + motion.offsetX.value, y: anchor.y + motion.offsetY.value }
      }
      motion.dragging = dragging
      positions.set(group.id, { ...destination, ...motion.center, t: closedOrbit(projection) ? wrap(motion.t.value) : motion.t.value, angle: Math.atan2(tangent.y - anchor.y, tangent.x - anchor.x) })
      this.paintGroup(group, motion, anchor, state)
    }
    this.place(positions, projection)
  }
  private paintGroup(group: OrbitGroup, motion: GroupMotion, anchor: OrbitPoint, state: OrbitVisual) {
    const c = this.context, center = motion.center, lift = clamp(motion.lift.value)
    const minimal = state.look === 'minimal'
    const expanded = state.expanded === group.id, hover = state.pointer && Math.hypot(center.x - state.pointer.x, center.y - state.pointer.y) < 55
    const tangent = this.point(motion.day.value, motion.t.value + .001)
    const angle = Math.atan2(tangent.y - anchor.y, tangent.x - anchor.x)
    const length = minimal ? clamp(14 + group.tasks.length * 2.5, 16, 23) : clamp(30 + group.tasks.length * 9, 35, 68)
    const freeLength = length * (minimal ? .92 : .77)
    const span = Math.min(.13, length / Math.max(1, Math.hypot(tangent.x - anchor.x, tangent.y - anchor.y) * 1000))
    const freeAngle = motion.angle.value, cos = Math.cos(freeAngle), sin = Math.sin(freeAngle)
    const ribbonPoint = (u: number, thread: number): OrbitPoint => {
      const along = (u * 2 - 1), envelope = Math.sin(u * Math.PI)
      const attached = this.point(motion.day.value, motion.t.value + along * span, thread * .0028 * envelope)
      const wave = state.reduced ? 0 : Math.sin(u * 7 - this.time * 2.2 + thread * .6) * 1.1 * envelope * (state.tuning?.wave ?? 1) * (minimal ? .25 : 1)
      const looseX = along * freeLength, looseY = thread * 3.1 * envelope + wave
      return { x: center.x + mix(attached.x - anchor.x, looseX * cos - looseY * sin, lift),
        y: center.y + mix(attached.y - anchor.y, looseX * sin + looseY * cos, lift) }
    }
    c.save(); c.globalAlpha = clamp(state.reveal * (state.expanded && !expanded ? .23 : 1) * (state.tuning?.brightness ?? 1))
    if (minimal) {
      const head = ribbonPoint(0, 0), tail = ribbonPoint(1, 0), gradient = c.createLinearGradient(head.x, head.y, tail.x, tail.y)
      const active = hover || expanded || lift > .05
      gradient.addColorStop(0, '#b4a18500'); gradient.addColorStop(.2, active ? '#d2bb94cc' : '#c4ad8999')
      gradient.addColorStop(.55, active ? '#ead7b4' : '#ceb997df'); gradient.addColorStop(1, '#b4a18500')
      c.strokeStyle = gradient; c.lineWidth = active ? 1.65 : 1.25; c.lineCap = 'round'
      c.beginPath()
      for (let step = 0; step <= 28; step++) {
        const point = ribbonPoint(step / 28, 0)
        if (step) c.lineTo(point.x, point.y); else c.moveTo(point.x, point.y)
      }
      c.stroke(); c.restore(); return
    }
    c.save(); c.translate(center.x, center.y)
    const auraAngle = Math.atan2(mix(Math.sin(angle), sin, lift), mix(Math.cos(angle), cos, lift))
    c.rotate(auraAngle); c.scale(mix(length * 1.3, freeLength * 1.55, lift), mix(hover ? 24 : 17, 28, lift))
    const aura = c.createRadialGradient(0, 0, 0, 0, 0, 1)
    const glow = state.tuning?.glow ?? 1
    aura.addColorStop(0, `rgba(244,206,138,${(lift > .1 || expanded ? .38 : .2) * glow})`); aura.addColorStop(.3, `rgba(218,160,76,${.09 * glow})`); aura.addColorStop(1, 'rgba(191,121,37,0)')
    c.fillStyle = aura; c.fillRect(-1, -1, 2, 2); c.restore()
    c.globalCompositeOperation = 'screen'
    const head = ribbonPoint(0, 0), tail = ribbonPoint(1, 0), gradient = c.createLinearGradient(head.x, head.y, tail.x, tail.y)
    gradient.addColorStop(0, '#c7934000'); gradient.addColorStop(.32, '#d9b276aa'); gradient.addColorStop(.6, '#fff0c9'); gradient.addColorStop(1, '#b2762200')
    for (let thread = 0; thread < group.tasks.length + 2; thread++) {
      c.strokeStyle = gradient; c.lineWidth = thread % 2 ? .65 : 1.1
      c.beginPath()
      for (let step = 0; step <= 28; step++) {
        const point = ribbonPoint(step / 28, thread - (group.tasks.length + 1) / 2)
        if (step) c.lineTo(point.x, point.y); else c.moveTo(point.x, point.y)
      }
      c.stroke()
    }
    c.restore()
  }
  private draw = (stamp: number) => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.draw)
    const state = this.read()
    // Render at display cadence (up to 60 fps), not the former 30 fps drag cap.
    // Reduced motion freezes ambient movement, not direct pointer manipulation.
    if (stamp - this.last < (state.reduced && !state.dragging ? 90 : 14)) return
    const dt = this.last ? Math.min(.05, (stamp - this.last) / 1000) : 1 / 60; this.last = stamp
    if (!state.reduced) { this.time += dt; this.flowTime += dt * (state.tuning?.flow ?? 1) }
    const c = this.context, w = this.width, h = this.height
    if (state.reveal <= .001) { c.clearRect(0, 0, w, h); return }
    const destinationProjection = orbitProjection(w, h, state.look, state.tuning)
    const projection = { ...destinationProjection }, blend = state.reduced ? 1 : 1 - Math.exp(-dt / .14)
    if (this.projection) for (const key of Object.keys(projection) as Array<keyof OrbitProjection>) projection[key] = mix(this.projection[key], destinationProjection[key], blend)
    this.projection = projection
    if (state.look !== this.previousLook) { this.priorBackground = state.look === 'minimal' ? null : this.background; this.background = this.paintBackground(state.look); this.previousLook = state.look; this.lookChangedAt = stamp }
    c.clearRect(0, 0, w, h); c.globalAlpha = state.reveal
    const crossfade = state.reduced ? 1 : Math.min(1, (stamp - this.lookChangedAt) / 450)
    if (this.priorBackground && crossfade < 1) c.drawImage(this.priorBackground, 0, 0)
    if (this.background) { c.globalAlpha = state.reveal * (this.priorBackground ? crossfade : 1); c.drawImage(this.background, 0, 0) }
    if (crossfade === 1) this.priorBackground = null
    this.sampleRibbons(projection, state, dt)
    if (state.look === 'minimal') {
      this.minimalTracks(state); this.groups(state, projection, dt); c.globalAlpha = 1; return
    }
    this.diskSurface(c, projection, state)
    const targetDay = state.dropTarget?.day
    for (const day of [2, 1, 0] as const) {
      const light = (state.dragging ? targetDay === day ? 1.3 : .68 : state.expanded ? .40 : 1) * (state.tuning?.brightness ?? 1)
      const start = this.point(day, 0), middle = this.point(day, .5)
      const gradient = c.createLinearGradient(start.x, start.y, middle.x, middle.y)
      gradient.addColorStop(0, state.tuning ? '#93602855' : '#9e703800'); gradient.addColorStop(.14, state.tuning ? '#b3813e55' : '#c3955512'); gradient.addColorStop(.5, '#d3a3636b'); gradient.addColorStop(.8, '#f9d39cc9'); gradient.addColorStop(1, '#fff0c1dd')
      c.save(); c.globalCompositeOperation = 'screen'
      const halos = state.look === 'engraved' ? [[8, .06], [3, .12]] : state.look === 'dust' ? [[36, .03], [14, .04]] : state.look === 'horizon' ? [[24, .04], [9, .12], [3, .2]] : [[46, .04], [18, .12], [5, .2]]
      for (const [width, alpha] of halos) {
        this.path(c, day); c.globalAlpha = clamp(state.reveal * light * alpha * (state.tuning?.glow ?? 1)); c.strokeStyle = gradient
        c.lineWidth = width * (state.tuning ? .55 + state.tuning.glow * .55 : 1); c.stroke()
      }
      const layers = state.tuning ? 3 : state.look === 'engraved' ? 3 : state.look === 'dust' ? 9 : 17
      for (let layer = 0; layer < layers; layer++) {
        const normal = (layer / Math.max(1, layers - 1) - .5)
        const width = state.tuning ? .002 + state.tuning.diskWidth * .010 : state.look === 'engraved' ? .005 : state.look === 'horizon' ? .021 : .028
        const breathing = state.reduced ? 0 : Math.sin(this.time * .7 + layer * .6 + day) * .0004 * (state.tuning?.wave ?? 1)
        this.path(c, day, normal * width + breathing)
        c.strokeStyle = gradient; c.lineWidth = layer === Math.floor(layers / 2) ? state.look === 'horizon' ? 1.45 : .95 : .36
        c.globalAlpha = clamp(state.reveal * light * (state.tuning ? .38 : state.look === 'dust' ? .12 : state.look === 'engraved' ? .6 : .4 + Math.cos(normal * Math.PI) * .4)); c.stroke()
      }
      this.material(c, day, state.look, light, state.reveal, state)
      c.restore()
    }
    this.groups(state, projection, dt)
    c.globalAlpha = 1
  }
  destroy() {
    this.disposed = true; cancelAnimationFrame(this.frame); this.observer.disconnect()
    document.removeEventListener('visibilitychange', this.visibility)
    this.background = null; this.priorBackground = null; this.diskTextures = []; this.motions.clear(); this.pulses = []
  }
}
