import { MediaSceneCamera, mediaSceneLayout, MEDIA_LAYOUT_EVENT } from './backgroundMedia'
import type { SceneCamera } from '../spatial/scene'
import { ResponseEffectController } from './responseEffects'
import type { ResponseEffectSettings, ResponsePhase } from './responseEffects'
import { DecisionEffectController, DECISION_EFFECT_EVENT, DECISION_EXIT_EVENT, getDecisionEffect } from './decisionEffect'
import type { DecisionEffectDetail } from './decisionEffect'
import { getStringFlight, getStringFlightMode, getStringFlightEdgeFrame, publishMediaStringFlightProjection, STRING_FLIGHT_EVENT } from './stringFlight'
import { observePageActivity, pageIsHidden } from '../stores/pageActivity'
import { publishSceneFrame } from '../stores/sceneFrames'
import { nextRenderDeadline, renderFrameIsDue, resolveRenderProfile } from './renderProfile'
import type { RenderProfile, RenderScene } from './renderProfile'

/** Affine media camera and transparent Canvas2D light. Never creates a WebGL
 * context, computes a LUT, replaces the video, or reads user conversation text. */
export class MediaSceneRenderer {
  private camera = new MediaSceneCamera()
  private response = new ResponseEffectController()
  private decision = new DecisionEffectController()
  private motion = matchMedia('(prefers-reduced-motion: reduce)')
  private reduced = this.motion.matches
  private observer: ResizeObserver
  private detachActivity: () => void
  private context: CanvasRenderingContext2D
  private width = 1
  private height = 1
  private ratio = 1
  private frameId = 0
  private last = 0
  private deadline = 0
  private disposed = false
  private night = true
  private profile: RenderProfile = 'full'
  private scene: RenderScene = 'home'
  private snapshot: SceneCamera = this.camera.snapshot()
  private projection = mediaSceneLayout(this.snapshot, 1, 1, false).projection

  private host: HTMLElement
  private stage: HTMLElement
  private closeStage: HTMLElement
  private canvas: HTMLCanvasElement

  constructor(host: HTMLElement, stage: HTMLElement, closeStage: HTMLElement, canvas: HTMLCanvasElement, pose?: SceneCamera) {
    this.host = host; this.stage = stage; this.closeStage = closeStage; this.canvas = canvas
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('无法准备背景光效')
    this.context = context
    if (pose) this.camera.setPose(pose)
    this.decision.setDetail(getDecisionEffect())
    this.observer = new ResizeObserver(this.resize)
    this.observer.observe(host)
    this.detachActivity = observePageActivity(this.activity)
    this.motion.addEventListener('change', this.motionChanged)
    window.addEventListener(STRING_FLIGHT_EVENT, this.flightChanged)
    window.addEventListener(DECISION_EFFECT_EVENT, this.decisionChanged)
    window.addEventListener(DECISION_EXIT_EVENT, this.decisionExit)
    this.resize()
  }

  setView(view: 'panorama' | 'interstellar') { this.camera.setView(view); this.publishGeometry(); this.requestFrame() }
  setNight(value: number) { this.night = value >= .5; this.requestFrame() }
  setResponseEffect(settings: ResponseEffectSettings) { this.response.setSettings(settings); this.requestFrame() }
  setResponsePhase(phase: ResponsePhase) { this.response.setPhase(phase); this.requestFrame() }
  setRenderProfile(profile: RenderProfile, scene: RenderScene) { this.profile = profile; this.scene = scene; this.requestFrame() }
  getCameraSnapshot() { return this.snapshot }

  private resize = () => {
    this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight)
    this.ratio = Math.min(devicePixelRatio || 1, 2)
    const width = Math.round(this.width * this.ratio), height = Math.round(this.height * this.ratio)
    if (this.canvas.width !== width || this.canvas.height !== height) { this.canvas.width = width; this.canvas.height = height }
    this.publishGeometry(); this.requestFrame()
  }
  private flightChanged = () => { this.publishGeometry(); this.requestFrame() }
  private decisionChanged = (event: Event) => { this.decision.setDetail((event as CustomEvent<DecisionEffectDetail>).detail); this.requestFrame() }
  private decisionExit = () => { this.decision.beginExit(this.reduced); this.requestFrame() }
  private motionChanged = () => { this.reduced = this.motion.matches; this.camera.advance(0, this.reduced); this.publishGeometry(); this.requestFrame() }
  private activity = () => {
    cancelAnimationFrame(this.frameId); this.frameId = 0; this.last = 0; this.deadline = 0
    if (!pageIsHidden()) this.requestFrame()
  }

  private publishGeometry() {
    const camera = this.camera.snapshot(this.reduced)
    const layout = mediaSceneLayout(camera, this.width, this.height, Boolean(document.documentElement.dataset.mobile), {
      progress: getStringFlight(), mode: getStringFlightMode(), edgeFrame: getStringFlightEdgeFrame(),
    })
    const { a, b, c, d, e, f } = layout.matrix
    this.stage.style.width = `${layout.sourceWidth}px`; this.stage.style.height = `${layout.sourceHeight}px`
    this.stage.style.transformOrigin = '0 0'
    this.stage.style.transform = `matrix(${a},${b},${c},${d},${e},${f})`
    this.stage.dataset.shape = layout.shape
    const close = layout.closeMatrix
    this.closeStage.style.width = `${layout.closeSourceWidth}px`; this.closeStage.style.height = `${layout.closeSourceHeight}px`
    this.closeStage.style.transformOrigin = '0 0'
    this.closeStage.style.transform = `matrix(${close.a},${close.b},${close.c},${close.d},${close.e},${close.f})`
    this.closeStage.dataset.shape = layout.closeShape
    this.host.style.setProperty('--media-horizon-blend', String(layout.blend))
    const playback = layout.blend >= 1 ? 'horizon' : getStringFlight() > 0 ? 'transition' : 'panorama'
    if (this.host.dataset.mediaPlayback !== playback) {
      this.host.dataset.mediaPlayback = playback
      this.host.dispatchEvent(new Event(MEDIA_LAYOUT_EVENT, { bubbles: true }))
    }
    this.projection = layout.projection
    this.snapshot = { ...camera, presentation: layout.projection }
    this.host.dataset.mediaCameraMoving = String(camera.cameraTransition)
    if (getStringFlightMode() === 'edge' && getStringFlight() > 0) publishMediaStringFlightProjection(layout.projection)
  }

  private requestFrame() {
    if (!this.frameId && !this.disposed && !pageIsHidden()) this.frameId = requestAnimationFrame(this.frame)
  }
  private frame = (now: number) => {
    this.frameId = 0
    if (this.disposed || pageIsHidden()) return
    const moving = this.camera.snapshot().cameraTransition
    const fps = moving ? resolveRenderProfile(this.profile, this.scene, true).frameRate : 30
    if (!renderFrameIsDue(this.deadline, now)) { this.requestFrame(); return }
    const delta = this.last ? Math.min(.1, (now - this.last) / 1000) : 1 / 60
    this.last = now; this.deadline = nextRenderDeadline(this.deadline, now, fps)
    this.camera.advance(delta, this.reduced)
    this.response.advance(delta, this.reduced)
    const reducedEffects = this.response.getSnapshot(this.reduced).reducedMotion
    this.decision.advance(delta, reducedEffects)
    this.publishGeometry(); this.draw(); publishSceneFrame()
    if (this.snapshot.cameraTransition || this.response.needsFrame(this.reduced) || this.decision.needsFrame(reducedEffects)) this.requestFrame()
    else { this.last = 0; this.deadline = 0 }
  }

  private draw() {
    const ctx = this.context, { cx, cy, radius } = this.projection
    const response = this.response.getSnapshot(this.reduced), decision = this.decision.getSnapshot(this.reduced)
    ctx.setTransform(this.ratio, 0, 0, this.ratio, 0, 0)
    ctx.clearRect(0, 0, this.width, this.height)
    this.canvas.dataset.phase = response.phase
    this.canvas.dataset.binaryVisible = String(response.binaryAmount > .001)
    if (response.binaryAmount > .001) {
      const settings = response.settings.binary
      ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, radius * .94, 0, Math.PI * 2); ctx.clip()
      const cell = this.width < 600 ? 28 : 34, font = this.width < 600 ? 11 : 13
      const drift = response.reducedMotion ? 0 : response.time * settings.flowSpeed * 12
      ctx.font = `500 ${font}px ui-monospace, SFMono-Regular, Menlo, monospace`
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.fillStyle = '#efe6ce'
      const firstX = Math.floor(Math.max(-radius, -cx) / cell), lastX = Math.ceil(Math.min(radius, this.width - cx) / cell)
      const firstY = Math.floor(Math.max(-radius, -cy) / cell) - 1, lastY = Math.ceil(Math.min(radius, this.height - cy) / cell) + 1
      for (let x = firstX; x <= lastX; x++) for (let y = firstY; y <= lastY; y++) {
        const seed = Math.sin(x * 127.1 + y * 311.7) * 43758.5453, random = seed - Math.floor(seed)
        if (random > .16 + settings.density * .64) continue
        const px = cx + x * cell, py = cy + y * cell + drift % cell
        const edge = Math.max(0, 1 - Math.hypot(px - cx, py - cy) / (radius * .94))
        const pulse = response.reducedMotion ? .75 : .65 + .35 * Math.sin(response.time * .55 + random * 8)
        ctx.globalAlpha = Math.min(.85, response.binaryAmount * settings.brightness * (.24 + random * .48) * Math.min(1, edge * 5) * pulse)
        ctx.fillText(random > .5 ? '01' : '10', px, py)
      }
      ctx.restore()
    }
    const glow = response.strength
    if (glow > .001 || decision.strength > .001) {
      ctx.save(); ctx.translate(cx, cy)
      ctx.globalCompositeOperation = this.night ? 'screen' : 'source-over'
      const time = response.time
      for (let ring = 0; ring < 3; ring++) {
        const pulse = response.reducedMotion ? .5 : .5 + .5 * Math.sin(time * .8 - ring * .8)
        ctx.globalAlpha = Math.min(.55, glow * (.12 + .16 * pulse) + decision.strength * .12)
        ctx.strokeStyle = this.night ? '#e9c68c' : '#917046'
        ctx.lineWidth = 1 + ring * .6
        ctx.beginPath(); ctx.arc(0, 0, radius * (1 + ring * .012), -.9 + ring * .24, 3.8 + ring * .24); ctx.stroke()
      }
      if (response.settings.style === 'filaments') for (let line = 0; line < 4; line++) {
        ctx.globalAlpha = glow * .15; ctx.lineWidth = .7
        ctx.beginPath(); ctx.ellipse(0, 0, radius * (1.12 + line * .04), radius * .24, -.32, 0, Math.PI * 2); ctx.stroke()
      }
      if (response.settings.style === 'stardust') for (let index = 0; index < 40; index++) {
        const angle = index * 2.39996 + time * .08, distance = radius * (1.04 + .08 * Math.sin(index))
        ctx.globalAlpha = glow * (.18 + .18 * Math.sin(time + index) ** 2); ctx.fillStyle = '#ead2a4'
        ctx.beginPath(); ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, 1, 0, Math.PI * 2); ctx.fill()
      }
      ctx.restore()
    }
  }

  dispose() {
    this.disposed = true; cancelAnimationFrame(this.frameId); this.detachActivity(); this.observer.disconnect()
    this.motion.removeEventListener('change', this.motionChanged)
    window.removeEventListener(STRING_FLIGHT_EVENT, this.flightChanged)
    window.removeEventListener(DECISION_EFFECT_EVENT, this.decisionChanged)
    window.removeEventListener(DECISION_EXIT_EVENT, this.decisionExit)
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height)
  }
}
