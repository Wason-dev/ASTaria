import type { StringItem } from './stringOrder'
import { stringGeometry } from './stringOrder'
import { stringRowY, type StringStyle } from './stringStyles'

export type StringPoint = { x: number; y: number }
export type StringVisualState = {
  upper: readonly StringItem[]; lower: readonly StringItem[]; scroll: number; reveal: number
  pointer: StringPoint | null; hover: string | null; grabbed: { id: string; x: number; y: number } | null
  reduced: boolean; busy: boolean; style: StringStyle
}
type Spark = { x: number; row: number; born: number; strength: number }
type LightSegment = { x: number; half: number; strength: number; active: boolean }
type StyleWeights = Record<StringStyle, number>
type Curve = (x: number) => number
const STYLES: readonly StringStyle[] = ['ribbon', 'filament', 'current', 'orbit']
const TAU = Math.PI * 2
const clamp = (value: number, a: number, b: number) => Math.max(a, Math.min(b, value))
const smooth = (t: number) => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x) }
const emptyWeights = (): StyleWeights => ({ ribbon: 0, filament: 0, current: 0, orbit: 0 })

/** A small, original 2D renderer: projected surfaces and depth-sorted filaments
 * give the strings volume without a second WebGL renderer. Task lengths are
 * highlights on the surface itself, rather than beads laid on top of a line. */
export class StringCanvas {
  private frame = 0
  private width = 1
  private height = 1
  private previous = 0
  private entered = 0
  private phase = 0
  private pointer = { x: -1000, y: -1000, strength: 0 }
  private positions = new Map<string, StringPoint>()
  private sparks: Spark[] = []
  private observer: ResizeObserver
  private context: CanvasRenderingContext2D
  private background: HTMLCanvasElement | null = null
  private disposed = false
  private style: StringStyle | null = null
  private weights = emptyWeights()
  private fromWeights = emptyWeights()
  private styleChanged = 0

  constructor(private canvas: HTMLCanvasElement, private read: () => StringVisualState,
    private place: (positions: Map<string, StringPoint>, width: number, height: number) => void) {
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('暂时无法绘制光弦')
    this.context = context
    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(canvas)
    this.resize()
    document.addEventListener('visibilitychange', this.visibility)
    this.frame = requestAnimationFrame(this.draw)
  }

  private resize = () => {
    const rect = this.canvas.getBoundingClientRect()
    this.width = Math.max(1, rect.width); this.height = Math.max(1, rect.height)
    const ratio = Math.min(devicePixelRatio || 1, 1.75)
    this.canvas.width = Math.round(this.width * ratio)
    this.canvas.height = Math.round(this.height * ratio)
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0)
    this.background = this.makeBackground()
  }

  /** Cache the distant haze and fine dust once per resize, at CSS resolution.
   * Only its parallax changes per frame; no full-screen noise/filter passes. */
  private makeBackground() {
    const image = document.createElement('canvas')
    image.width = Math.ceil(this.width + 64); image.height = Math.ceil(this.height + 64)
    const c = image.getContext('2d')
    if (!c) return image
    const w = image.width, h = image.height
    const cloud = (x: number, y: number, rx: number, ry: number, color: string, opacity: number) => {
      c.save(); c.translate(x, y); c.scale(rx, ry)
      const glow = c.createRadialGradient(0, 0, 0, 0, 0, 1)
      glow.addColorStop(0, `rgba(${color},${opacity})`)
      glow.addColorStop(.34, `rgba(${color},${opacity * .53})`)
      glow.addColorStop(1, `rgba(${color},0)`)
      c.fillStyle = glow; c.fillRect(-1, -1, 2, 2); c.restore()
    }
    cloud(w * .51, h * .54, w * .62, h * .47, '89,66,39', .12)
    cloud(w * .24, h * .43, w * .48, h * .32, '42,57,69', .13)
    cloud(w * .77, h * .61, w * .43, h * .31, '89,60,31', .11)
    cloud(w * .58, h * .84, w * .56, h * .31, '35,45,62', .085)
    let seed = 10793
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
    for (let i = 0; i < Math.min(150, w * h / 11000); i++) {
      const x = random() * w, y = random() * h
      const radius = .22 + random() * .48
      c.fillStyle = `rgba(219,194,148,${.055 + random() * .15})`
      c.beginPath(); c.arc(x, y, radius, 0, TAU); c.fill()
      // A few distant streaks instead of a dense star-field wallpaper.
      if (i % 19 === 0) {
        c.fillStyle = 'rgba(199,179,142,.035)'; c.fillRect(x - 2.5, y, 5, .35)
      }
    }
    return image
  }

  private visibility = () => {
    cancelAnimationFrame(this.frame)
    this.previous = 0
    if (!document.hidden && !this.disposed) this.frame = requestAnimationFrame(this.draw)
  }

  pulse(x: number, row = 1, strength = 1) {
    this.sparks.push({ x, row, born: performance.now(), strength })
    this.sparks = this.sparks.slice(-8)
  }

  private transition(style: StringStyle, now: number, reduced: boolean) {
    if (this.style === null || reduced) {
      this.weights = emptyWeights(); this.weights[style] = 1
      this.fromWeights = { ...this.weights }; this.style = style; return
    }
    if (style !== this.style) {
      this.fromWeights = { ...this.weights }; this.style = style; this.styleChanged = now
    }
    const progress = smooth((now - this.styleChanged) / 600)
    for (const key of STYLES) this.weights[key] = this.fromWeights[key] * (1 - progress) + (key === style ? progress : 0)
  }

  private path(curve: Curve, start = -8, end = this.width + 8, step = 6) {
    const c = this.context
    c.beginPath(); c.moveTo(start, curve(start))
    for (let x = start + step; x < end; x += step) c.lineTo(x, curve(x))
    c.lineTo(end, curve(end))
  }

  private gold(alpha: number, warm = false) {
    const gradient = this.context.createLinearGradient(0, 0, this.width, 0)
    gradient.addColorStop(0, 'rgba(151,100,38,0)')
    gradient.addColorStop(.07, `rgba(177,127,57,${alpha * .52})`)
    gradient.addColorStop(.31, `rgba(${warm ? '213,162,81' : '237,205,149'},${alpha})`)
    gradient.addColorStop(.56, `rgba(${warm ? '242,193,113' : '252,229,181'},${alpha})`)
    gradient.addColorStop(.84, `rgba(189,142,69,${alpha * .73})`)
    gradient.addColorStop(1, 'rgba(151,100,38,0)')
    return gradient
  }

  private energy(x: number, segments: readonly LightSegment[]) {
    let energy = 0
    for (const segment of segments) {
      const distance = (x - segment.x) / (segment.half * .62)
      if (Math.abs(distance) < 3) energy += Math.exp(-distance * distance) * segment.strength
    }
    return Math.min(1.8, energy)
  }

  private bloom(curve: Curve, light: number, spread = 1) {
    const c = this.context
    c.globalCompositeOperation = 'screen'
    for (const [width, alpha] of [[42 * spread, .013], [22 * spread, .026], [8 * spread, .052]]) {
      this.path(curve); c.strokeStyle = this.gold(alpha * light, true); c.lineWidth = width; c.stroke()
    }
  }

  private drawRibbon(curve: Curve, segments: readonly LightSegment[], row: number, light: number) {
    const c = this.context, w = this.width, time = this.phase
    this.bloom(curve, light, .95)
    const turn = (x: number) => x * .0048 + time * .16 + row * .73
    const halfWidth = (x: number) => (2.5 + 8 * Math.abs(Math.sin(turn(x)))) * (1 + this.energy(x, segments) * .17)
    // Thin adjacent surfaces share exact vertices: a continuously twisting
    // metallic sheet, with a dark face, warm body and a narrow reflective edge.
    const bands = 12
    c.globalCompositeOperation = 'source-over'
    for (let band = 0; band < bands; band++) {
      const a = band / bands * 2 - 1, b = (band + 1) / bands * 2 - 1
      const gradient = c.createLinearGradient(0, 0, w, 0)
      for (let step = 0; step <= 20; step++) {
        const x = w * step / 20, normal = (a + b) / 2
        const face = .5 + .5 * Math.sin(turn(x) + normal * 1.35)
        const ridge = Math.exp(-Math.pow((normal - Math.cos(turn(x)) * .65) / .22, 2))
        const shine = clamp(.26 + face * .44 + ridge * .65 + this.energy(x, segments) * .14, 0, 1)
        const edge = Math.pow(Math.sin(Math.PI * step / 20), .45)
        const r = Math.round(116 + shine * 139), g = Math.round(70 + shine * 155), bl = Math.round(22 + shine * 142)
        gradient.addColorStop(step / 20, `rgba(${r},${g},${bl},${light * edge * (.44 + shine * .42)})`)
      }
      c.beginPath(); c.moveTo(-8, curve(-8) + a * halfWidth(-8))
      for (let x = -2; x <= w + 8; x += 6) c.lineTo(x, curve(x) + a * halfWidth(x))
      for (let x = w + 8; x >= -8; x -= 6) c.lineTo(x, curve(x) + b * halfWidth(x))
      c.closePath(); c.fillStyle = gradient; c.fill()
    }
    c.globalCompositeOperation = 'screen'
    for (const side of [-1, 1]) {
      this.path(x => curve(x) + side * halfWidth(x))
      c.strokeStyle = this.gold(light * (side === -1 ? .55 : .22)); c.lineWidth = .6; c.stroke()
    }
    this.path(x => curve(x) + halfWidth(x) * Math.cos(turn(x)) * .65)
    c.strokeStyle = this.gold(light * .43); c.lineWidth = .65; c.stroke()
  }

  private drawFilament(curve: Curve, segments: readonly LightSegment[], row: number, light: number) {
    const c = this.context, time = this.phase, w = this.width
    this.bloom(curve, light, 1.15)
    // Project a bundle of helices. Rear halves are thinner and softer; bright
    // front halves are drawn last, so crossing strands have real depth order.
    for (const front of [false, true]) {
      for (let strand = 0; strand < 9; strand++) {
        const radius = 6.5 + strand % 3 * 3.2
        const angle = (x: number) => x * .0105 - time * .17 + strand * TAU / 9 + row * .45
        const y = (x: number) => curve(x) + Math.sin(angle(x)) * radius
        c.beginPath()
        let drawing = false
        for (let x = -8; x <= w + 8; x += 4) {
          const visible = (Math.cos(angle(x)) >= 0) === front
          if (visible) {
            if (!drawing) c.moveTo(x - 4, y(x - 4))
            c.lineTo(x, y(x)); drawing = true
          } else { drawing = false }
        }
        c.strokeStyle = this.gold(light * (front ? .56 : .105), !front)
        c.lineWidth = front ? .78 + strand % 3 * .12 : .48
        c.globalCompositeOperation = front ? 'screen' : 'source-over'; c.stroke()
        if (front) for (const segment of segments) {
          const glow = c.createLinearGradient(segment.x - segment.half, 0, segment.x + segment.half, 0)
          glow.addColorStop(0, 'rgba(250,225,173,0)')
          glow.addColorStop(.5, `rgba(250,225,173,${Math.min(.92, segment.strength * .67) * light})`)
          glow.addColorStop(1, 'rgba(250,225,173,0)')
          this.path(y, segment.x - segment.half, segment.x + segment.half, 4)
          c.strokeStyle = glow; c.lineWidth = .85; c.stroke()
        }
      }
    }
    // A sparse rear echo gives the bundle airy depth rather than a flat rope.
    this.path(x => curve(x) + Math.sin(x * .0038 + time * .12 + row) * 21)
    c.strokeStyle = this.gold(light * .085, true); c.lineWidth = .45; c.stroke()
  }

  private drawCurrent(curve: Curve, segments: readonly LightSegment[], row: number, light: number) {
    const c = this.context, w = this.width, time = this.phase
    this.bloom(curve, light * 1.4, 1.7)
    c.globalCompositeOperation = 'screen'
    // Many translucent currents share one body. Their edges taper, giving a
    // volume of flowing light instead of a row of particle emitters.
    for (let strand = -10; strand <= 10; strand++) {
      const y = (x: number) => curve(x) + strand * 1.35
        + Math.sin(x * .013 - time * .56 + strand * .53) * (1 + Math.abs(strand) * .36)
        + Math.sin(x * .0031 + strand * .7 + time * .21) * Math.abs(strand) * .38
      this.path(y)
      const center = 1 - Math.abs(strand) / 11
      c.strokeStyle = this.gold(light * (.028 + center * .09), strand % 3 !== 0)
      c.lineWidth = 1 + center * 1.8; c.stroke()
    }
    const count = Math.min(210, Math.ceil(w / 7))
    for (let i = 0; i < count; i++) {
      const seed = ((i * 127.17 + row * 71.1) % 997) / 997
      const x = ((i * 173.73 + time * (15 + seed * 21)) % (w + 100)) - 50
      const layer = Math.sin(i * 7.31)
      const offset = layer * (9 + Math.sin(i * 5.3) * 4)
      const length = 2 + seed * 13, energy = this.energy(x, segments)
      const alpha = (.065 + seed * .21 + energy * .24) * light
      this.path(px => curve(px) + offset + Math.sin(px * .011 - time * .4 + i) * 2, x, x + length, 4)
      c.strokeStyle = `rgba(244,${Math.round(195 + seed * 40)},${Math.round(120 + seed * 75)},${alpha})`
      c.lineWidth = .35 + seed * .65; c.stroke()
    }
    this.path(curve); c.strokeStyle = this.gold(light * .37); c.lineWidth = 1.2; c.stroke()
  }

  private drawOrbit(curve: Curve, segments: readonly LightSegment[], row: number, light: number) {
    const c = this.context, w = this.width
    this.bloom(curve, light * .9, 1.12)
    const perspective = (x: number) => .42 + .58 * Math.pow(Math.sin(Math.PI * clamp(x / w, 0, 1)), 1.2)
    c.globalCompositeOperation = 'screen'
    // Nested projected arcs describe a shallow orbital surface. The near lip
    // is bright, the far lip thin; distant echoes retreat into the background.
    for (const offset of [-34, -19, 24]) {
      this.path(x => curve(x) + offset * perspective(x))
      c.strokeStyle = this.gold(light * (offset === -19 ? .072 : .028), true)
      c.lineWidth = .55; c.stroke()
    }
    for (let band = -5; band <= 5; band++) {
      this.path(x => curve(x) + band * perspective(x))
      const facing = (band + 5) / 10
      c.strokeStyle = this.gold(light * (.022 + Math.pow(facing, 3) * .22), band < 2)
      c.lineWidth = 1.2; c.stroke()
    }
    this.path(x => curve(x) - 5 * perspective(x))
    c.strokeStyle = this.gold(light * .29); c.lineWidth = .65; c.stroke()
    this.path(x => curve(x) + 5 * perspective(x))
    c.strokeStyle = this.gold(light * .86); c.lineWidth = .85; c.stroke()
    this.path(curve); c.strokeStyle = this.gold(light * .42); c.lineWidth = .8; c.stroke()
    // Travelling glints are long, tangent strokes and remain part of the rail.
    for (let index = 0; index < 4; index++) {
      const x = ((index * 331 + this.phase * (row ? 11 : 6)) % (w + 260)) - 130
      const gradient = c.createLinearGradient(x, 0, x + 100, 0)
      gradient.addColorStop(0, 'rgba(249,221,168,0)')
      gradient.addColorStop(.66, `rgba(249,221,168,${light * .27})`)
      gradient.addColorStop(1, 'rgba(249,221,168,0)')
      this.path(px => curve(px) + 5 * perspective(px), x, x + 100)
      c.strokeStyle = gradient; c.lineWidth = 1; c.stroke()
    }
    // Lift the occupied portion of the rail very subtly, keeping its surface.
    for (const segment of segments) {
      const gradient = c.createLinearGradient(segment.x - segment.half, 0, segment.x + segment.half, 0)
      gradient.addColorStop(0, 'rgba(255,232,185,0)')
      gradient.addColorStop(.5, `rgba(255,232,185,${Math.min(.85, segment.strength * .64) * light})`)
      gradient.addColorStop(1, 'rgba(255,232,185,0)')
      this.path(x => curve(x) + 5 * perspective(x), segment.x - segment.half, segment.x + segment.half)
      c.strokeStyle = gradient; c.lineWidth = 1.15; c.stroke()
    }
  }

  private drawSegments(curve: Curve, segments: readonly LightSegment[], light: number, style: StringStyle) {
    const c = this.context
    c.globalCompositeOperation = 'screen'
    const thickness = { ribbon: 5, filament: 3.5, current: 10, orbit: 2.5 }[style]
    for (const segment of segments) {
      // This is an elongated, feathered strip following the string's geometry.
      // No circles, rings or halo discs: even the grabbed task stays continuous.
      const half = segment.half * (segment.active ? 1.12 : 1)
      const gradient = c.createLinearGradient(segment.x - half, 0, segment.x + half, 0)
      gradient.addColorStop(0, 'rgba(249,216,156,0)')
      gradient.addColorStop(.24, `rgba(226,170,78,${segment.strength * .22 * light})`)
      gradient.addColorStop(.5, `rgba(255,237,195,${Math.min(1, segment.strength * .85) * light})`)
      gradient.addColorStop(.76, `rgba(240,187,104,${segment.strength * .3 * light})`)
      gradient.addColorStop(1, 'rgba(249,216,156,0)')
      this.path(curve, segment.x - half, segment.x + half, 3)
      c.strokeStyle = gradient; c.lineWidth = thickness; c.shadowColor = '#d7a353'
      c.shadowBlur = segment.active ? 17 : 9; c.stroke(); c.shadowBlur = 0
      // A shorter reflective seam gives a readable grab point without a bead.
      this.path(curve, segment.x - half * .72, segment.x + half * .72, 3)
      c.strokeStyle = gradient; c.lineWidth = segment.active ? 1.8 : .9; c.stroke()
    }
  }

  private draw = (now: number) => {
    if (this.disposed || document.hidden) return
    this.frame = requestAnimationFrame(this.draw)
    const state = this.read()
    const changingStyle = state.style !== this.style || now - this.styleChanged < 650
    const interval = state.pointer || state.grabbed || changingStyle ? 1000 / 60 : 1000 / 30
    if (this.previous && now - this.previous < interval - 1) return
    const dt = this.previous ? Math.min(.06, (now - this.previous) / 1000) : .016
    this.previous = now
    this.phase += state.reduced ? 0 : dt
    this.transition(state.style, now, state.reduced)
    if (state.reveal > .05 && !this.entered) this.entered = now
    const age = this.entered ? (now - this.entered) / 1000 : 0
    const intro = state.reduced ? 0 : Math.exp(-age * .95)
    const { width: w, height: h, context: c } = this
    const rows = [stringRowY(h, 0), stringRowY(h, 1)]
    const geometry = stringGeometry(w, state.upper.length)
    const targetStrength = state.pointer && !state.reduced ? 1 : 0
    this.pointer.strength += (targetStrength - this.pointer.strength) * (1 - Math.exp(-dt * 5))
    if (state.pointer) {
      this.pointer.x += (state.pointer.x - this.pointer.x) * (1 - Math.exp(-dt * 9))
      this.pointer.y += (state.pointer.y - this.pointer.y) * (1 - Math.exp(-dt * 9))
    }
    this.sparks = this.sparks.filter(spark => now - spark.born < 2300)
    c.clearRect(0, 0, w, h); c.globalAlpha = 1; c.globalCompositeOperation = 'source-over'
    if (this.background) {
      const parallaxX = clamp((this.pointer.x / w - .5) * 9, -5, 5) * this.pointer.strength
      const parallaxY = clamp((this.pointer.y / h - .5) * 7, -4, 4) * this.pointer.strength
      c.drawImage(this.background, -32 + parallaxX, -32 + parallaxY)
    }
    const base = (style: StringStyle, x: number, row: number) => {
      const time = this.phase, u = (x - w * .5) / (w * .57)
      switch (style) {
        case 'ribbon': return Math.sin(x * .0042 + time * .15 + row * .65) * 8.5 + Math.sin(x * .0017 - time * .09) * 3
        case 'filament': return Math.sin(x * .0044 + time * .19 + row * .7) * 4.5
        case 'current': return Math.sin(x * .005 - time * .14 + row * .8) * 7 + Math.sin(x * .012 + time * .21) * 1.3
        case 'orbit': return (u * u - .29) * Math.min(65, w * .055) + Math.sin(x * .002 + time * .07 + row) * 1.5
      }
    }
    const freeCenter = (x: number, row: number) => {
      let y = rows[row]
      for (const style of STYLES) if (this.weights[style] > .001) y += base(style, x, row) * this.weights[style]
      const envelope = Math.sin(Math.PI * clamp(x / w, 0, 1))
      y += (Math.sin(x * .009 - this.phase * .7 + row) * 13 + Math.sin(x * .024 + this.phase) * 4) * intro * envelope
      const px = x - this.pointer.x
      const near = Math.exp(-Math.pow((this.pointer.y - rows[row]) / 85, 2)) * this.pointer.strength
      y += Math.exp(-px * px / 27000) * Math.sin(px * .018 - this.phase * 2) * near * 8
      if (!state.reduced) for (const spark of this.sparks) if (spark.row === row) {
        const time = (now - spark.born) / 1000
        const distance = Math.abs(x - spark.x + state.scroll)
        y += Math.sin(distance * .033 - time * 9) * Math.exp(-Math.pow((distance - time * 140) / 110, 2)) * Math.exp(-time * 1.7) * 10 * spark.strength
      }
      return y
    }
    const center = (x: number, row: number) => {
      const y = freeCenter(x, row)
      if (!state.grabbed || row !== 1) return y
      const delta = x - state.grabbed.x
      // Grab tension is relative to the actual curved surface. Referencing the
      // flat row anchor would double its bend on pointer-down and make it jump.
      const tension = clamp(state.grabbed.y - freeCenter(state.grabbed.x, row), -46, 46)
      return y + tension * Math.exp(-delta * delta / 14000)
    }
    const liveKeys = new Set<string>()
    for (let row = 0; row < 2; row++) {
      const items = row === 0 ? state.upper : state.lower
      const segments: LightSegment[] = []
      items.forEach((item, index) => {
        const key = `${row}:${item.id}`, target = geometry.x(index)
        liveKeys.add(key)
        const position = this.positions.get(key) ?? { x: target, y: rows[row] }
        const grabbed = row === 1 && state.grabbed?.id === item.id
        const targetX = grabbed ? state.grabbed!.x + state.scroll : target
        position.x += (targetX - position.x) * (state.reduced ? 1 : 1 - Math.exp(-dt * (grabbed ? 22 : 9)))
        const x = position.x - state.scroll
        // Always update every item, including offscreen items. DOM interaction
        // uses content x and the actual rendered screen y, even during a morph.
        position.y = center(x, row); this.positions.set(key, position)
        if (x < -120 || x > w + 120) return
        const active = state.hover === item.id || grabbed
        segments.push({ x, half: clamp(19 + Math.sqrt(item.durationMin) * 4.5, 33, 67),
          strength: (item.movable ? .84 : .43) * (active ? 1.55 : 1), active: Boolean(active) })
      })
      // Cache centerline samples. Layered surfaces reuse these rather than
      // evaluating pointer/ripple physics for each band, strand and highlight.
      const sampleStep = 4, sampleStart = -160, sampleEnd = w + 160
      const samples: number[] = []
      for (let x = sampleStart; x <= sampleEnd + sampleStep; x += sampleStep) samples.push(center(x, row))
      const curve: Curve = x => {
        const sample = (x - sampleStart) / sampleStep, left = Math.floor(sample)
        return left < 0 || left + 1 >= samples.length ? center(x, row) : samples[left] + (samples[left + 1] - samples[left]) * (sample - left)
      }
      for (const style of STYLES) {
        const light = this.weights[style] * (row === 0 ? .62 : 1)
        if (light < .001) continue
        if (style === 'ribbon') this.drawRibbon(curve, segments, row, light)
        else if (style === 'filament') this.drawFilament(curve, segments, row, light)
        else if (style === 'current') this.drawCurrent(curve, segments, row, light)
        else this.drawOrbit(curve, segments, row, light)
        this.drawSegments(curve, segments, light, style)
      }
      if (state.busy) {
        const x = (this.phase * 130) % (w + 200) - 100
        const beam = c.createLinearGradient(x - 100, 0, x + 100, 0)
        beam.addColorStop(0, 'rgba(251,227,180,0)'); beam.addColorStop(.5, 'rgba(251,227,180,.65)'); beam.addColorStop(1, 'rgba(251,227,180,0)')
        this.path(curve, x - 100, x + 100)
        c.strokeStyle = beam; c.lineWidth = 2; c.shadowColor = '#d9aa62'; c.shadowBlur = 12; c.stroke(); c.shadowBlur = 0
      }
    }
    for (const key of this.positions.keys()) if (!liveKeys.has(key)) this.positions.delete(key)
    c.globalCompositeOperation = 'source-over'; c.globalAlpha = 1
    this.place(this.positions, w, h)
  }

  destroy() {
    this.disposed = true; cancelAnimationFrame(this.frame)
    this.observer.disconnect(); document.removeEventListener('visibilitychange', this.visibility)
    this.positions.clear(); this.background = null
  }
}
