import * as THREE from 'three'
import { vertexShader, fragmentShader } from './shaders'
import { createGeodesicLut } from './geodesics'
import { SelectiveBloom } from './postprocessing'
import { StarInfall } from './StarInfall'
import { AdaptiveQualityController } from './adaptiveQuality'
import type { AdaptiveQuality } from './adaptiveQuality'
import { ResponseEffectController } from './responseEffects'
import { DECISION_EFFECT_EVENT, DECISION_EXIT_EVENT, DECISION_EXIT_MS, DecisionEffectController, getDecisionEffect } from './decisionEffect'
import type { DecisionEffectDetail } from './decisionEffect'
import type { ResponseEffectSettings, ResponsePhase } from './responseEffects'
import { nextRenderDeadline, normalizeRenderProfile, renderFrameIsDue, resolveRenderProfile } from './renderProfile'
import type { RenderProfile, RenderScene } from './renderProfile'
import { STRING_FLIGHT_EVENT, STRING_FLIGHT_START_RADIUS, getStringFlight, getStringFlightMode, getStringFlightEdgeFrame, getStringFlightEdgePull, publishStringFlightProjection, resolveStringFlightCamera } from './stringFlight'
export type { ResponseEffectSettings, ResponsePhase } from './responseEffects'
export type { RenderProfile } from './renderProfile'
export type { DecisionEffectDetail } from './decisionEffect'
export { setDecisionEffect, beginDecisionExit, DECISION_EXIT_MS } from './decisionEffect'
export { setStringFlight, getStringFlight, getStringFlightMode } from './stringFlight'

export type Quality = AdaptiveQuality
export type QualityMode = Quality | 'auto'
export type CameraView = 'panorama' | 'interstellar'

export interface RenderStats {
  fps: number
  frameMs: number
  p95: number
  quality: Quality
  requestedQuality: QualityMode
  width: number
  height: number
  drawCalls: number
  stars: number
  paused: boolean
  reducedMotion: boolean
  renderedFrames: number
  simulationTime: number
  visibilityPaused: boolean
  zoom: number
  roll: number
  inclination: number
  centerX: number
  centerY: number
  view: CameraView | 'custom'
  cameraTransition: boolean
  pointerActive: boolean
  pointerStrength: number
  pointerX: number
  pointerY: number
  responseEffect: ReturnType<ResponseEffectController['getSnapshot']>
  renderProfile: RenderProfile
  renderScene: RenderScene
  targetFps: number
  decisionEffect: ReturnType<DecisionEffectController['getSnapshot']>
  stringFlightProgress: number
  cameraRadius: number
}

interface CameraSpring {
  value: number
  target: number
  velocity: number
  tolerance: number
}

function cameraSpring(value: number, tolerance: number): CameraSpring {
  return { value, target: value, velocity: 0, tolerance }
}

const CAMERA_VIEWS = {
  panorama: { zoom: 0.7, roll: 18, inclination: 83, centerX: 0.65, centerY: 0.51 },
  interstellar: { zoom: 2.05, roll: 7, inclination: 84, centerX: 0.98, centerY: 0.51 },
} as const

const TIERS: Record<Quality, { level: number; stars: number; maxDpr: number; pixels: number }> = {
  ultra: { level: 3, stars: 50_000, maxDpr: 2, pixels: 8_000_000 },
  high: { level: 2, stars: 20_000, maxDpr: 1.5, pixels: 4_000_000 },
  low: { level: 1, stars: 8_000, maxDpr: 1, pixels: 1_500_000 },
  safe: { level: 0, stars: 8_000, maxDpr: 0.65, pixels: 600_000 },
}

const STAR_COUNT = 50_000
const SAMPLE_COUNT = 180
const SESSION_SAMPLE_COUNT = 18_000
let cachedGeodesics: ReturnType<typeof createGeodesicLut> | undefined

function getGeodesics() {
  cachedGeodesics ??= createGeodesicLut({ cameraRadius: 30, maxImpact: 24, width: 2048, height: 1536 })
  return cachedGeodesics
}

function createDataTexture(data: Float32Array, width: number, height: number, format: THREE.PixelFormat, floatLinear: boolean) {
  const pixels = floatLinear ? data : Uint16Array.from(data, (value) => THREE.DataUtils.toHalfFloat(value))
  const texture = new THREE.DataTexture(pixels, width, height, format, floatLinear ? THREE.FloatType : THREE.HalfFloatType)
  texture.minFilter = THREE.LinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

// One deterministic catalogue is shared by every tier. Lower tiers draw a prefix.
function createStars() {
  let seed = 0x41535441
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const positions = new Float32Array(STAR_COUNT * 3)
  const colors = new Float32Array(STAR_COUNT * 3)
  const sizes = new Float32Array(STAR_COUNT)
  for (let i = 0; i < STAR_COUNT; i++) {
    positions[i * 3] = random() * 2 - 1
    positions[i * 3 + 1] = random() * 2 - 1
    positions[i * 3 + 2] = 0
    const magnitude = Math.pow(random(), 12)
    const warmth = random()
    const luminance = 0.028 + magnitude * 0.73
    colors[i * 3] = luminance * (0.76 + warmth * 0.24)
    colors[i * 3 + 1] = luminance * (0.82 + warmth * 0.11)
    colors[i * 3 + 2] = luminance * (1 - warmth * 0.19)
    sizes[i] = 0.55 + magnitude * 1.85
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  const material = new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uPixelRatio: { value: 1 } },
    vertexShader: `
      attribute vec3 color;
      attribute float aSize;
      uniform float uPixelRatio;
      varying vec3 vColor;
      void main() {
        vColor = color;
        gl_Position = vec4(position.xy, 0.0, 1.0);
        gl_PointSize = max(1.0, aSize * uPixelRatio);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec3 vColor;
      void main() {
        float radius = length(gl_PointCoord - 0.5) * 2.0;
        float alpha = exp(-radius * radius * 3.5);
        gl_FragColor = vec4(vColor, alpha);
      }
    `,
  })
  const points = new THREE.Points(geometry, material)
  points.frustumCulled = false
  return { geometry, material, points }
}

/** Owns the GPU, animation clock, adaptive resolution and its complete lifecycle. */
export class BlackHoleRenderer {
  private readonly host: HTMLElement
  private readonly onStats: (stats: RenderStats) => void
  private readonly onError: (message: string) => void
  private readonly renderer: THREE.WebGLRenderer
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private readonly scene = new THREE.Scene()
  private readonly starScene = new THREE.Scene()
  private readonly infall = new StarInfall()
  private readonly stars = createStars()
  private readonly target = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  private readonly geometry = new THREE.PlaneGeometry(2, 2)
  private readonly sceneTarget = new THREE.WebGLRenderTarget(1, 1, {
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
    generateMipmaps: false,
  })
  private readonly material: THREE.ShaderMaterial
  private readonly bloom: SelectiveBloom
  private readonly geodesicsTexture: THREE.DataTexture
  private readonly terminationTexture: THREE.DataTexture
  private readonly resizeObserver: ResizeObserver
  private readonly motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  private readonly resolution = new THREE.Vector2(1, 1)
  private readonly cameraCenter = new THREE.Vector2(0.65, 0.51)
  private readonly pointer = new THREE.Vector2(0.5, 0.5)
  private readonly pointerTarget = new THREE.Vector2(0.5, 0.5)
  private pointerActive = false
  private pointerStrength = 0
  private readonly cameraMotion = {
    zoom: cameraSpring(0.7, 0.0005),
    roll: cameraSpring(18, 0.01),
    inclination: cameraSpring(83, 0.01),
    centerX: cameraSpring(0.65, 0.0001),
    centerY: cameraSpring(0.51, 0.0001),
  }
  private readonly cameraSprings = Object.values(this.cameraMotion)
  private view: CameraView | 'custom' = 'panorama'
  private readonly samples: number[] = []
  private readonly sessionSamples: number[] = []
  private quality: Quality = 'ultra'
  private requestedQuality: QualityMode = 'auto'
  private paused = false
  private reducedMotion = false
  private visibilityPaused = document.hidden
  private contextLost = false
  private disposed = false
  private raf = 0
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private previousFrame: number | null = null
  private previousWasAmbient = false
  private nextFrameAt = 0
  private renderProfile: RenderProfile = 'full'
  private renderScene: RenderScene = 'home'
  private targetFps = 60
  private renderedFrames = 0
  private simulationTime = 0
  private night = 0
  private nightTarget = 0
  private nightVelocity = 0
  private readonly adaptiveQuality = new AdaptiveQualityController()
  private readonly responseEffect = new ResponseEffectController()
  private readonly decisionEffect = new DecisionEffectController()
  private stringFlightProgress = getStringFlight()
  private stringFlightMode = getStringFlightMode()
  private readonly responseWeights = new THREE.Vector3(1, 0, 0)
  private cssWidth = 0
  private cssHeight = 0
  private activeDpr = 0
  private starTextureDirty = true

  constructor(host: HTMLElement, onStats: (stats: RenderStats) => void, onError: (message: string) => void) {
    this.host = host
    this.onStats = onStats
    this.onError = onError
    this.reducedMotion = this.motionQuery.matches
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    })
    this.renderer.setClearColor(0x000000, 1)
    this.renderer.toneMapping = THREE.NoToneMapping
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.info.autoReset = false
    this.target.texture.wrapS = THREE.RepeatWrapping
    this.target.texture.wrapT = THREE.RepeatWrapping
    this.bloom = new SelectiveBloom(this.renderer)
    const canvas = this.renderer.domElement
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    canvas.style.display = 'block'
    canvas.setAttribute('aria-label', '实时渲染的黑洞、吸积盘与引力透镜')
    canvas.setAttribute('role', 'img')
    const geodesics = getGeodesics()
    // Float linear sampling is an extension even in WebGL 2; half-float linear
    // filtering is core and provides a portable fallback without black output.
    const floatLinear = this.renderer.extensions.has('OES_texture_float_linear')
    this.geodesicsTexture = createDataTexture(geodesics.inverseRadius, geodesics.width, geodesics.height, THREE.RedFormat, floatLinear)
    this.terminationTexture = createDataTexture(geodesics.termination, geodesics.width, 1, THREE.RGBAFormat, floatLinear)
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uResolution: { value: this.resolution },
        uTime: { value: 0 },
        uNight: { value: 0 },
        uInclination: { value: THREE.MathUtils.degToRad(83) },
        uZoom: { value: 0.7 },
        uRoll: { value: THREE.MathUtils.degToRad(18) },
        uCenter: { value: this.cameraCenter },
        uLens: { value: 1 },
        uDoppler: { value: 1 },
        uQuality: { value: TIERS.ultra.level },
        uStars: { value: this.target.texture },
        uBurst: { value: -100 },
        uPointer: { value: new THREE.Vector2(0, 0) },
        uGeodesics: { value: this.geodesicsTexture },
        uTermination: { value: this.terminationTexture },
        uLutSize: { value: new THREE.Vector2(geodesics.width, geodesics.height) },
        uMaxPhi: { value: geodesics.maxPhi },
        uCriticalImpact: { value: geodesics.criticalImpact },
        uMaxImpact: { value: geodesics.maxImpact },
        uCameraRadius: { value: geodesics.cameraRadius },
        uFlightCameraRadius: { value: STRING_FLIGHT_START_RADIUS },
        uFlightEdgeFocus: { value: 0 },
        uFlightEdgePull: { value: new THREE.Vector3(0, 0, .1) },
        uResponseStrength: { value: 0 },
        uResponseReply: { value: 0 },
        uResponseTime: { value: 0 },
        uResponseMotion: { value: 1 },
        uResponseWeights: { value: this.responseWeights },
        uDecisionActive: { value: 0 },
        uDecisionRadius: { value: 1 },
        uDecisionWarp: { value: 0 },
        uDecisionThickness: { value: 1 },
        uDecisionLens: { value: 0 },
        uDecisionFlow: { value: 1 },
        uDecisionTime: { value: 0 },
        uDecisionHorizon: { value: 0 },
        uDecisionBranch: { value: 0 },
        uDecisionComparing: { value: 0 },
        uDecisionEmphasis: { value: 0 },
      },
    })
    const quad = new THREE.Mesh(this.geometry, this.material)
    quad.frustumCulled = false
    this.scene.add(quad)
    this.scene.add(this.infall.object)
    this.starScene.add(this.stars.points)
    host.appendChild(canvas)
    canvas.addEventListener('webglcontextlost', this.handleContextLost)
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored)
    host.addEventListener('pointermove', this.handlePointer)
    host.addEventListener('pointerleave', this.handlePointerLeave)
    window.addEventListener(DECISION_EFFECT_EVENT, this.handleDecisionEffect)
    window.addEventListener(DECISION_EXIT_EVENT, this.handleDecisionExit)
    window.addEventListener(STRING_FLIGHT_EVENT, this.handleStringFlight)
    this.decisionEffect.setDetail(getDecisionEffect())
    document.addEventListener('visibilitychange', this.handleVisibility)
    this.motionQuery.addEventListener('change', this.handleMotion)
    this.resizeObserver = new ResizeObserver(this.handleResize)
    this.resizeObserver.observe(host)
    this.resize()
    this.syncStatsTimer()
    this.requestFrame()
  }

  setNight(value: number, immediate = false) {
    this.nightTarget = THREE.MathUtils.clamp(value, 0, 1)
    if (immediate || this.reducedMotion) {
      this.night = this.nightTarget
      this.nightVelocity = 0
      this.material.uniforms.uNight.value = this.night
    }
    this.requestFrame()
  }

  setQuality(mode: QualityMode) {
    this.requestedQuality = mode
    this.adaptiveQuality.reset()
    this.applyQuality(mode === 'auto' ? 'ultra' : mode)
    this.publishStats()
  }

  setRenderProfile(profile: RenderProfile, scene: RenderScene = 'home') {
    const next = normalizeRenderProfile(profile)
    this.renderProfile = next
    this.renderScene = scene
    const config = resolveRenderProfile(next, scene)
    this.targetFps = config.frameRate
    this.requestedQuality = config.quality
    this.adaptiveQuality.reset()
    this.applyQuality(config.quality)
    this.cancelFrame()
    this.requestFrame()
    this.publishStats()
  }

  setPaused(paused: boolean) {
    if (this.paused === paused) return
    this.paused = paused
    this.resetMeasurements()
    this.cancelFrame()
    this.syncStatsTimer()
    this.requestFrame()
    this.publishStats()
  }

  setLens(enabled: boolean) {
    this.material.uniforms.uLens.value = enabled ? 1 : 0
    this.requestFrame()
  }

  setDoppler(enabled: boolean) {
    this.material.uniforms.uDoppler.value = enabled ? 1 : 0
    this.requestFrame()
  }

  setResponseEffect(settings: ResponseEffectSettings) {
    this.responseEffect.setSettings(settings)
    this.syncResponseEffect(0)
    this.syncDecisionEffect(0)
    this.syncStatsTimer()
    this.requestFrame()
  }

  /** Apply the decision studio state without creating a second WebGL renderer. */
  setDecisionEffect(detail: Partial<DecisionEffectDetail>) {
    this.decisionEffect.setDetail(detail)
    this.syncDecisionEffect(0)
    this.syncStatsTimer()
    this.requestFrame()
    this.publishStats()
  }

  /** Shares the UI's finite retreat instead of leaving a delayed afterimage. */
  beginDecisionExit() {
    this.decisionEffect.beginExit(this.decisionMotionIsReduced() || this.visibilityPaused || this.contextLost, this.paused)
    this.syncDecisionEffect(0)
    this.syncStatsTimer()
    this.requestFrame()
    this.publishStats()
  }

  setResponsePhase(phase: ResponsePhase) {
    this.responseEffect.setPhase(phase)
    this.syncResponseEffect(0)
    this.syncDecisionEffect(0)
    this.syncStatsTimer()
    this.requestFrame()
  }

  setInclination(degrees: number) {
    this.setCameraParameter(this.cameraMotion.inclination, THREE.MathUtils.clamp(degrees, 5, 89))
  }

  setZoom(value: number) {
    this.setCameraParameter(this.cameraMotion.zoom, THREE.MathUtils.clamp(value, 0.55, 2.2))
  }

  setRoll(degrees: number) {
    this.setCameraParameter(this.cameraMotion.roll, THREE.MathUtils.clamp(degrees, -35, 35))
  }

  setView(view: CameraView) {
    this.view = view
    const preset = CAMERA_VIEWS[view]
    for (const key of Object.keys(this.cameraMotion) as (keyof typeof this.cameraMotion)[]) {
      // Keep position and velocity when interrupted, so reversing a move never
      // creates a discontinuity in the camera's path or speed.
      this.cameraMotion[key].target = preset[key]
    }
    if (this.reducedMotion) this.finishCameraTransition()
    this.requestFrame()
    this.publishStats()
  }

  /** Position is normalized viewport UV, with the origin at the bottom left. */
  setPointer(x: number, y: number, active = true) {
    this.pointerTarget.set(THREE.MathUtils.clamp(x, 0, 1), THREE.MathUtils.clamp(y, 0, 1))
    if (!this.pointerActive && this.pointerStrength === 0) this.pointer.copy(this.pointerTarget)
    this.pointerActive = active
    if (this.reducedMotion) this.finishPointerTransition()
    this.requestFrame()
  }

  emitParticles() {
    // A reduced-motion snapshot shows an already opened burst without animating it.
    this.material.uniforms.uBurst.value = this.simulationTime - (this.reducedMotion || this.paused ? 0.18 : 0)
    this.requestFrame()
  }

  getSnapshot(): RenderStats {
    const running = this.ambientIsRunning()
    const mean = this.samples.length ? this.samples.reduce((sum, duration) => sum + duration, 0) / this.samples.length : 0
    const sorted = [...this.samples].sort((a, b) => a - b)
    const p95 = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : 0
    return {
      fps: running && mean > 0 ? 1000 / mean : 0,
      frameMs: running ? mean : 0,
      p95: running ? p95 : 0,
      quality: this.quality,
      requestedQuality: this.requestedQuality,
      width: this.resolution.x,
      height: this.resolution.y,
      drawCalls: this.renderer.info.render.calls,
      stars: TIERS[this.quality].stars,
      paused: this.paused,
      reducedMotion: this.reducedMotion,
      renderedFrames: this.renderedFrames,
      simulationTime: this.simulationTime,
      visibilityPaused: this.visibilityPaused,
      zoom: this.material.uniforms.uZoom.value,
      roll: THREE.MathUtils.radToDeg(this.material.uniforms.uRoll.value),
      inclination: THREE.MathUtils.radToDeg(this.material.uniforms.uInclination.value),
      centerX: this.cameraCenter.x,
      centerY: this.cameraCenter.y,
      view: this.view,
      cameraTransition: this.cameraIsRunning(),
      pointerActive: this.pointerActive,
      pointerStrength: this.pointerStrength,
      pointerX: this.pointer.x,
      pointerY: this.pointer.y,
      responseEffect: this.responseEffect.getSnapshot(this.reducedMotion),
      renderProfile: this.renderProfile,
      renderScene: this.renderScene,
      targetFps: this.targetFps,
      decisionEffect: this.decisionEffect.getSnapshot(this.decisionMotionIsReduced()),
      stringFlightProgress: this.stringFlightProgress,
      cameraRadius: this.material.uniforms.uFlightCameraRadius.value,
    }
  }

  getFrameSamples() {
    return [...this.sessionSamples]
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.cancelFrame()
    this.stopStatsTimer()
    this.resizeObserver.disconnect()
    document.removeEventListener('visibilitychange', this.handleVisibility)
    this.motionQuery.removeEventListener('change', this.handleMotion)
    this.host.removeEventListener('pointermove', this.handlePointer)
    this.host.removeEventListener('pointerleave', this.handlePointerLeave)
    window.removeEventListener(DECISION_EFFECT_EVENT, this.handleDecisionEffect)
    window.removeEventListener(DECISION_EXIT_EVENT, this.handleDecisionExit)
    window.removeEventListener(STRING_FLIGHT_EVENT, this.handleStringFlight)
    this.renderer.domElement.removeEventListener('webglcontextlost', this.handleContextLost)
    this.renderer.domElement.removeEventListener('webglcontextrestored', this.handleContextRestored)
    this.geometry.dispose()
    this.material.dispose()
    this.stars.geometry.dispose()
    this.stars.material.dispose()
    this.target.dispose()
    this.sceneTarget.dispose()
    this.bloom.dispose()
    this.infall.dispose()
    this.geodesicsTexture.dispose()
    this.terminationTexture.dispose()
    this.scene.clear()
    this.starScene.clear()
    this.renderer.dispose()
    this.renderer.forceContextLoss()
    this.renderer.domElement.remove()
    this.samples.length = 0
    this.sessionSamples.length = 0
  }

  private ambientIsRunning() {
    return !this.disposed && !this.contextLost && !this.visibilityPaused && !this.paused && !this.reducedMotion
      && (this.stringFlightProgress < 1 || this.stringFlightMode === 'edge')
      && !(this.decisionEffect.getSnapshot().active && this.decisionMotionIsReduced())
  }

  private springIsRunning() {
    return Math.abs(this.night - this.nightTarget) > 0.0001 || Math.abs(this.nightVelocity) > 0.0001
  }

  private cameraIsRunning() {
    return this.cameraSprings.some((spring) => Math.abs(spring.value - spring.target) > spring.tolerance
      || Math.abs(spring.velocity) > spring.tolerance * 4)
  }

  private setCameraParameter(spring: CameraSpring, value: number) {
    spring.value = value
    spring.target = value
    spring.velocity = 0
    this.view = 'custom'
    this.syncCameraUniforms()
    this.requestFrame()
    this.publishStats()
  }

  private finishCameraTransition() {
    for (const spring of this.cameraSprings) {
      spring.value = spring.target
      spring.velocity = 0
    }
    this.syncCameraUniforms()
  }

  private syncCameraUniforms() {
    this.material.uniforms.uZoom.value = this.cameraMotion.zoom.value
    this.material.uniforms.uRoll.value = THREE.MathUtils.degToRad(this.cameraMotion.roll.value)
    this.material.uniforms.uInclination.value = THREE.MathUtils.degToRad(this.cameraMotion.inclination.value)
    this.cameraCenter.set(this.cameraMotion.centerX.value, this.cameraMotion.centerY.value)
  }

  private advanceCamera(delta: number) {
    if (delta <= 0 || !this.cameraIsRunning()) return
    const omega = 3.5
    const decay = Math.exp(-omega * delta)
    for (const spring of this.cameraSprings) {
      const displacement = spring.value - spring.target
      const velocityTerm = spring.velocity + omega * displacement
      spring.value = spring.target + (displacement + velocityTerm * delta) * decay
      spring.velocity = (spring.velocity - omega * velocityTerm * delta) * decay
      if (Math.abs(spring.value - spring.target) <= spring.tolerance
        && Math.abs(spring.velocity) <= spring.tolerance * 4) {
        spring.value = spring.target
        spring.velocity = 0
      }
    }
    this.syncCameraUniforms()
  }

  private pointerIsRunning() {
    return Math.abs(this.pointer.x - this.pointerTarget.x) > 0.00005
      || Math.abs(this.pointer.y - this.pointerTarget.y) > 0.00005
      || Math.abs(this.pointerStrength - (this.pointerActive ? 1 : 0)) > 0.002
  }

  private finishPointerTransition() {
    this.pointer.copy(this.pointerTarget)
    this.pointerStrength = this.pointerActive ? 1 : 0
  }

  private advancePointer(delta: number) {
    if (delta <= 0 || !this.pointerIsRunning()) return
    // Continuous exponential response remains interruptible without overshoot.
    // Strength reaches the 0.2% snap threshold in ~0.26s when the cursor leaves.
    const positionResponse = 1 - Math.exp(-22 * delta)
    const strengthResponse = 1 - Math.exp(-24 * delta)
    this.pointer.lerp(this.pointerTarget, positionResponse)
    this.pointerStrength += ((this.pointerActive ? 1 : 0) - this.pointerStrength) * strengthResponse
    if (!this.pointerIsRunning()) this.finishPointerTransition()
  }

  private requestFrame() {
    if (!this.raf && !this.disposed && !this.contextLost && !this.visibilityPaused && !this.stringFlightIsCovered()) {
      this.raf = requestAnimationFrame(this.frame)
    }
  }

  private stringFlightIsCovered() {
    return this.stringFlightProgress >= 1 && this.stringFlightMode === 'center'
  }

  private syncResponseEffect(delta: number) {
    this.responseEffect.advance(delta, this.reducedMotion, this.paused)
    const state = this.responseEffect.getSnapshot(this.reducedMotion)
    this.material.uniforms.uResponseStrength.value = state.strength
    this.material.uniforms.uResponseReply.value = state.reply
    this.material.uniforms.uResponseTime.value = state.time
    this.material.uniforms.uResponseMotion.value = state.reducedMotion ? 0 : 1
    this.responseWeights.set(...state.weights)
  }

  private decisionMotionIsReduced() {
    return this.reducedMotion || this.responseEffect.getSnapshot(this.reducedMotion).reducedMotion
  }

  private syncDecisionEffect(delta: number) {
    const reduced = this.decisionMotionIsReduced()
    this.decisionEffect.advance(delta, reduced, this.paused)
    const state = this.decisionEffect.getSnapshot(reduced)
    const uniforms = this.material.uniforms
    uniforms.uDecisionActive.value = state.strength
    uniforms.uDecisionHorizon.value = state.renderedHorizon
    uniforms.uDecisionBranch.value = state.renderedBranch
    uniforms.uDecisionComparing.value = state.comparison
    uniforms.uDecisionEmphasis.value = state.renderedEmphasis
    uniforms.uDecisionRadius.value = state.radiusScale
    uniforms.uDecisionWarp.value = state.warpHeight
    uniforms.uDecisionThickness.value = state.diskThickness
    uniforms.uDecisionLens.value = state.lensStrength
    uniforms.uDecisionFlow.value = state.flowSpeed
    uniforms.uDecisionTime.value = state.time
    // Presentation is an additive view over the current camera. It never
    // overwrites the homepage/chat camera springs, so leaving restores them.
    this.syncCameraUniforms()
    if (state.strength > 0) {
      const amount = state.strength
      const narrow = this.cssWidth < 760
      this.cameraCenter.x = THREE.MathUtils.lerp(this.cameraCenter.x, narrow ? .5 : .43, amount)
      this.cameraCenter.y = THREE.MathUtils.lerp(this.cameraCenter.y, .43, amount)
      uniforms.uZoom.value = THREE.MathUtils.lerp(this.cameraMotion.zoom.value, .40 - state.renderedHorizon * .08, amount)
      uniforms.uRoll.value = THREE.MathUtils.degToRad(THREE.MathUtils.lerp(this.cameraMotion.roll.value, 5, amount))
      uniforms.uInclination.value = THREE.MathUtils.degToRad(this.cameraMotion.inclination.value + state.inclinationOffset)
    }
    // Overlay the scrubbed flight after the ordinary/decision camera. Exact
    // zero restores that path without changing any camera spring or target.
    uniforms.uFlightCameraRadius.value = STRING_FLIGHT_START_RADIUS
    uniforms.uFlightEdgeFocus.value = this.stringFlightMode === 'edge'
      ? THREE.MathUtils.smoothstep(this.stringFlightProgress, .4, .96) : 0
    const pull = getStringFlightEdgePull()
    uniforms.uFlightEdgePull.value.set(pull.angle,
      this.stringFlightMode === 'edge' && this.stringFlightProgress > 0 && !this.reducedMotion ? pull.displacement : 0,
      pull.spread)
    if (this.stringFlightProgress > 0) {
      const camera = resolveStringFlightCamera({
        zoom: uniforms.uZoom.value,
        roll: THREE.MathUtils.radToDeg(uniforms.uRoll.value),
        inclination: THREE.MathUtils.radToDeg(uniforms.uInclination.value),
        centerX: this.cameraCenter.x,
        centerY: this.cameraCenter.y,
      }, this.stringFlightProgress, this.stringFlightMode, this.cssWidth / this.cssHeight, getStringFlightEdgeFrame())
      this.cameraCenter.set(camera.centerX, camera.centerY)
      uniforms.uZoom.value = camera.zoom
      uniforms.uRoll.value = THREE.MathUtils.degToRad(camera.roll)
      uniforms.uInclination.value = THREE.MathUtils.degToRad(camera.inclination)
      uniforms.uFlightCameraRadius.value = camera.radius
      if (this.stringFlightMode === 'edge') publishStringFlightProjection(camera, this.cssWidth, this.cssHeight)
    }
  }

  private cancelFrame() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.nextFrameAt = 0
    this.previousFrame = null
    this.previousWasAmbient = false
  }

  private frame = (now: number) => {
    this.raf = 0
    if (this.disposed || this.contextLost || this.visibilityPaused || this.stringFlightIsCovered()) return
    if (!renderFrameIsDue(this.nextFrameAt, now)) {
      this.requestFrame()
      return
    }
    const ambient = this.ambientIsRunning()
    const elapsed = this.previousFrame === null ? 0 : Math.max(0, now - this.previousFrame)
    const delta = elapsed * 0.001
    if (ambient && this.previousWasAmbient && elapsed > 0) {
      this.samples.push(elapsed)
      if (this.samples.length > SAMPLE_COUNT) this.samples.shift()
      this.sessionSamples.push(elapsed)
      if (this.sessionSamples.length > SESSION_SAMPLE_COUNT) this.sessionSamples.shift()
      this.adaptQuality(elapsed)
    }
    if (ambient) this.simulationTime += delta
    this.advanceCamera(delta)
    this.advancePointer(delta)
    this.syncResponseEffect(delta)
    this.syncDecisionEffect(delta)
    if (this.springIsRunning()) {
      // Exact critically damped spring integration stays stable after long frames.
      const dt = this.previousFrame === null ? 1 / 60 : delta
      const omega = 9
      const displacement = this.night - this.nightTarget
      const decay = Math.exp(-omega * dt)
      const velocityTerm = this.nightVelocity + omega * displacement
      this.night = this.nightTarget + (displacement + velocityTerm * dt) * decay
      this.nightVelocity = (this.nightVelocity - omega * velocityTerm * dt) * decay
      if (!this.springIsRunning()) {
        this.night = this.nightTarget
        this.nightVelocity = 0
      }
    }
    this.material.uniforms.uTime.value = this.simulationTime
    this.material.uniforms.uNight.value = this.night
    this.infall.update(
      this.simulationTime,
      this.material.uniforms.uBurst.value,
      this.night,
      this.resolution,
      this.reducedMotion,
      this.material.uniforms.uZoom.value,
      this.material.uniforms.uRoll.value,
      this.cameraCenter,
    )
    if (this.starTextureDirty) this.renderStars()
    this.renderer.info.reset()
    this.renderer.setRenderTarget(this.sceneTarget)
    this.renderer.render(this.scene, this.camera)
    // The edge surface already follows the shared pull. Fade the homepage's
    // separate cursor lens away before the overlay becomes visible.
    const pointerWeight = this.stringFlightMode === 'edge'
      ? 1 - THREE.MathUtils.smoothstep(this.stringFlightProgress, .05, .5) : 1
    this.bloom.render(this.sceneTarget.texture, this.night, this.pointer, this.pointerStrength * pointerWeight)
    this.renderedFrames++
    this.nextFrameAt = nextRenderDeadline(this.nextFrameAt, now, this.targetFps)
    if (ambient || this.springIsRunning() || this.cameraIsRunning() || this.pointerIsRunning()
      || this.responseEffect.needsFrame(this.reducedMotion, this.paused)
      || this.decisionEffect.needsFrame(this.decisionMotionIsReduced(), this.paused)) {
      this.previousFrame = now
      this.previousWasAmbient = ambient
      this.requestFrame()
    } else {
      this.previousFrame = null
      this.previousWasAmbient = false
      this.publishStats()
    }
  }

  private adaptQuality(elapsed: number) {
    if (this.requestedQuality !== 'auto') return
    const next = this.adaptiveQuality.sample(elapsed, this.quality, this.cameraIsRunning() || this.springIsRunning())
    if (next) {
      this.applyQuality(next)
      this.publishStats()
    }
  }

  private applyQuality(quality: Quality) {
    const changed = this.quality !== quality
    this.quality = quality
    this.material.uniforms.uQuality.value = TIERS[quality].level
    this.adaptiveQuality.resetWindow()
    if (changed) {
      this.samples.length = 0
      this.starTextureDirty = true
      this.resize()
    }
    this.requestFrame()
  }

  private resize() {
    if (this.disposed || this.contextLost) return
    const width = Math.max(1, Math.round(this.host.clientWidth))
    const height = Math.max(1, Math.round(this.host.clientHeight))
    const tier = TIERS[this.quality]
    const ratio = Math.min(window.devicePixelRatio || 1, tier.maxDpr, Math.sqrt(tier.pixels / (width * height)))
    this.resizeStarTexture()
    if (width === this.cssWidth && height === this.cssHeight && Math.abs(ratio - this.activeDpr) < 0.001) return
    this.cssWidth = width
    this.cssHeight = height
    this.activeDpr = ratio
    this.renderer.setPixelRatio(ratio)
    this.renderer.setSize(width, height, false)
    this.renderer.getDrawingBufferSize(this.resolution)
    this.sceneTarget.setSize(this.resolution.x, this.resolution.y)
    this.bloom.resize(this.resolution.x, this.resolution.y, this.quality === 'safe')
    this.adaptiveQuality.resetWindow()
    this.samples.length = 0
    this.requestFrame()
  }

  private resizeStarTexture() {
    // Spherical sampling needs a full-sky atlas independent of the viewport;
    // otherwise projection magnifies tiny source stars into broad streaks.
    const requestedWidth = this.quality === 'ultra' ? 8192 : 4096
    const width = Math.min(requestedWidth, this.renderer.capabilities.maxTextureSize)
    const height = Math.max(1, Math.floor(width / 2))
    if (this.target.width !== width || this.target.height !== height) {
      this.target.setSize(width, height)
      this.starTextureDirty = true
    }
    this.stars.material.uniforms.uPixelRatio.value = 1
  }

  private renderStars() {
    this.stars.geometry.setDrawRange(0, TIERS[this.quality].stars)
    this.renderer.setRenderTarget(this.target)
    this.renderer.clear()
    this.renderer.render(this.starScene, this.camera)
    this.renderer.setRenderTarget(null)
    this.starTextureDirty = false
  }

  private resetMeasurements() {
    this.previousFrame = null
    this.previousWasAmbient = false
    this.samples.length = 0
    this.adaptiveQuality.resetWindow()
  }

  private publishStats = () => {
    if (!this.disposed) this.onStats(this.getSnapshot())
  }

  private syncStatsTimer() {
    if (!this.ambientIsRunning()) {
      this.stopStatsTimer()
    } else if (this.statsTimer === null) {
      this.statsTimer = setInterval(this.publishStats, 1000)
    }
  }

  private stopStatsTimer() {
    if (this.statsTimer !== null) clearInterval(this.statsTimer)
    this.statsTimer = null
  }

  private handleDecisionEffect = (event: Event) => {
    const detail = (event as CustomEvent<Partial<DecisionEffectDetail>>).detail
    this.setDecisionEffect(detail)
  }

  private handleDecisionExit = () => {
    this.beginDecisionExit()
  }

  private handleStringFlight = () => {
    const wasCovered = this.stringFlightIsCovered()
    this.stringFlightProgress = getStringFlight()
    this.stringFlightMode = getStringFlightMode()
    if (wasCovered !== this.stringFlightIsCovered()) {
      // Only a centered passage is covered. An edge arrival keeps the same
      // disk and its ambient clock alive behind the task overlay.
      this.cancelFrame()
      this.resetMeasurements()
      this.syncStatsTimer()
      this.syncDecisionEffect(0)
      this.publishStats()
    }
    // External progress owns the clock. A changed value needs one real GPU
    // frame (including the edge endpoint), even when ambient animation is paused or
    // reduced motion is on. Resetting the clock above prevents hidden catch-up.
    // Hidden/context-lost renderers retain it for their normal resume path.
    this.requestFrame()
  }

  private handleResize = () => {
    this.resize()
  }

  private handleVisibility = () => {
    this.visibilityPaused = document.hidden
    if (this.visibilityPaused && this.decisionEffect.getSnapshot().exiting) {
      this.decisionEffect.advance(DECISION_EXIT_MS / 1000)
      this.syncDecisionEffect(0)
    }
    this.cancelFrame()
    this.resetMeasurements()
    this.syncStatsTimer()
    if (!this.visibilityPaused) {
      this.resize()
      this.requestFrame()
    }
    this.publishStats()
  }

  private handleMotion = (event: MediaQueryListEvent) => {
    this.reducedMotion = event.matches
    if (this.reducedMotion) {
      this.night = this.nightTarget
      this.nightVelocity = 0
      this.finishCameraTransition()
      this.finishPointerTransition()
    }
    this.cancelFrame()
    this.resetMeasurements()
    this.syncStatsTimer()
    this.requestFrame()
    this.publishStats()
  }

  private handlePointer = (event: PointerEvent) => {
    const rect = this.host.getBoundingClientRect()
    this.setPointer(
      (event.clientX - rect.left) / Math.max(rect.width, 1),
      1 - (event.clientY - rect.top) / Math.max(rect.height, 1),
    )
  }

  private handlePointerLeave = () => {
    this.pointerActive = false
    if (this.reducedMotion) this.finishPointerTransition()
    this.requestFrame()
  }

  private handleContextLost = (event: Event) => {
    event.preventDefault()
    this.contextLost = true
    this.cancelFrame()
    this.resetMeasurements()
    this.stopStatsTimer()
    this.onError('图形上下文暂时中断，正在等待浏览器恢复。')
    this.publishStats()
  }

  private handleContextRestored = () => {
    this.contextLost = false
    this.starTextureDirty = true
    this.cssWidth = 0
    this.resetMeasurements()
    this.resize()
    this.syncStatsTimer()
    this.onError('')
    this.requestFrame()
  }
}
