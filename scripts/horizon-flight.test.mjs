import assert from 'node:assert/strict'
import test from 'node:test'
import { CRITICAL_IMPACT, geodesicImpactForAngle } from '../src/prototype/geodesics.ts'
import { orbitTransitionFrame } from '../src/xixi/orbitTransition.ts'
import {
  STRING_FLIGHT_EVENT, STRING_FLIGHT_START_RADIUS, STRING_FLIGHT_EDGE_RADIUS,
  STRING_FLIGHT_EDGE_LIMB, getStringFlight, getStringFlightMode,
  getStringFlightEdgeFrame, getStringFlightProjection, publishStringFlightProjection,
  getStringFlightEdgePull, setStringFlightEdgePull, stringFlightEdgeDisplacement,
  resolveStringFlightCamera, setStringFlight, setStringFlightEdgeFrame,
} from '../src/prototype/stringFlight.ts'

const panorama = Object.freeze({ zoom: .7, roll: 18, inclination: 83, centerX: .65, centerY: .51 })
const interstellar = Object.freeze({ zoom: 2.05, roll: 7, inclination: 84, centerX: .98, centerY: .51 })
const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) <= epsilon, `${a} ≈ ${b}`)
const nearCamera = (a, b, epsilon = 1e-9) => {
  for (const key of Object.keys(a)) near(a[key], b[key], epsilon)
}

// Evaluate a screen ray independently with the same lens/portrait conventions
// as the black-hole shader, then use the geodesic model for capture/escape.
function screenImpact(camera, aspect, x, y) {
  const narrow = aspect < .8
  const cx = narrow ? .5 + (camera.centerX - .5) * .2 : camera.centerX
  const cy = narrow ? .5 + (camera.centerY - .5) * 6 : camera.centerY
  const scale = (narrow ? 13.8 : 10.2) / camera.zoom
  const imageRadius = Math.hypot((x - cx) * aspect, y - cy) * scale
  return geodesicImpactForAngle(imageRadius / Math.hypot(30, imageRadius), camera.radius)
}

test('zero and invalid progress exactly preserve the caller camera for either flight mode', () => {
  for (const camera of [panorama, interstellar]) for (const mode of ['center', 'edge']) {
    for (const progress of [0, -1, NaN, Infinity]) {
      assert.deepEqual(resolveStringFlightCamera(camera, progress, mode), {
        ...camera, radius: STRING_FLIGHT_START_RADIUS,
      })
    }
  }
})

test('legacy centered flight retains its existing endpoint and intermediate camera', () => {
  nearCamera(resolveStringFlightCamera(panorama, .5), {
    zoom: .7, roll: 12.57882159948349, inclination: 81.4119841469683,
    centerX: .5, centerY: .5, radius: 9.83009961989974,
  })
  nearCamera(resolveStringFlightCamera(panorama, 1), {
    zoom: .7, roll: 11, inclination: 74, centerX: .5, centerY: .5, radius: 1.6,
  })
  assert.deepEqual(resolveStringFlightCamera(interstellar, .42), resolveStringFlightCamera(interstellar, .42, 'center'))
})

test('edge flight stops outside the photon sphere with a visible lower horizon in both presets and orientations', () => {
  for (const camera of [panorama, interstellar]) for (const aspect of [16 / 9, 1, 9 / 16]) {
    const end = resolveStringFlightCamera(camera, 1, 'edge', aspect)
    near(end.radius, STRING_FLIGHT_EDGE_RADIUS)
    assert.ok(end.radius > 1.5)
    assert.ok(end.zoom > 0, 'the temporary lens fits the shared horizon without changing the base camera')
    assert.equal(end.roll, camera.roll - 3)
    const centerY = aspect < .8 ? .5 + (end.centerY - .5) * 6 : end.centerY
    assert.ok(centerY < 0, 'the shadow center is below the viewport')
    near(screenImpact(end, aspect, .5, STRING_FLIGHT_EDGE_LIMB), CRITICAL_IMPACT)
    assert.ok(screenImpact(end, aspect, .5, .5) > CRITICAL_IMPACT, 'the view center looks above the captured shadow')
    assert.ok(screenImpact(end, aspect, .5, 0) < CRITICAL_IMPACT, 'the lower viewport retains the shadow')
  }
})

test('edge tuning aligns the full viewport arc with the real critical-impact silhouette', () => {
  for (const camera of [panorama, interstellar]) for (const [width, height] of [[1280, 720], [720, 1280], [960, 960]]) {
    const aspect = width / height
    for (const frame of [{ height: .62, curvature: .16 }, { height: .38, curvature: .04 }, { height: .78, curvature: .4 }]) {
      const end = resolveStringFlightCamera(camera, 1, 'edge', aspect, frame)
      const sag = width * frame.curvature
      const radius = Math.max((width * width / 4 + sag * sag) / (2 * sag), height * (1 - frame.height + .08))
      const cy = height * frame.height + radius
      for (const x of [0, width * .25, width * .5, width * .75, width]) {
        const y = cy - Math.sqrt(radius * radius - (x - width / 2) ** 2)
        near(screenImpact(end, aspect, x / width, 1 - y / height), CRITICAL_IMPACT)
      }
      near(end.radius, STRING_FLIGHT_EDGE_RADIUS)
      assert.equal(camera.zoom, camera === panorama ? .7 : 2.05, 'the homepage preset stays untouched')
    }
  }
})

test('shared projection tracks the camera actually applied during approach, hold, and retreat', () => {
  try {
    for (const camera of [panorama, interstellar]) for (const [width, height] of [[1280, 720], [720, 1280]]) {
      for (const progress of [.1, .45, .8, 1, .8, .25]) {
        setStringFlight(progress, 'edge')
        const applied = resolveStringFlightCamera(camera, progress, 'edge', width / height)
        publishStringFlightProjection(applied, width, height)
        const geometry = getStringFlightProjection(width, height)
        assert.ok(geometry)
        near(geometry.cy - geometry.radius, geometry.apexY)
        for (const angle of [-.3, 0, .3]) {
          const x = geometry.cx + geometry.radius * Math.sin(angle)
          const y = geometry.cy - geometry.radius * Math.cos(angle)
          near(screenImpact(applied, width / height, x / width, 1 - y / height), CRITICAL_IMPACT)
        }
        const scaled = getStringFlightProjection(width * .5, height * .5)
        for (const key of ['width', 'height', 'cx', 'cy', 'radius', 'apexY']) near(scaled[key], geometry[key] * .5)
        // A flight event can precede its GPU frame: keep the previous real
        // projection until the renderer applies the next one.
        setStringFlight(progress / 2, 'edge')
        assert.deepEqual(getStringFlightProjection(width, height), geometry)
      }
    }
    setStringFlight(0, 'edge')
    assert.equal(getStringFlightProjection(1280, 720), null)
    setStringFlight(.5, 'edge')
    assert.equal(getStringFlightProjection(1280, 720), null, 'a new flight never reuses an earlier endpoint')
    publishStringFlightProjection(resolveStringFlightCamera(panorama, .5, 'edge'), 1280, 720)
    setStringFlight(.5, 'center')
    assert.equal(getStringFlightProjection(1280, 720), null)
  } finally { setStringFlight(0) }
})

test('edge framing changes redraw an already settled camera and normalize invalid input', () => {
  const previousWindow = globalThis.window
  globalThis.window = new EventTarget()
  const events = []
  globalThis.window.addEventListener(STRING_FLIGHT_EVENT, (event) => events.push(event.detail))
  try {
    setStringFlight(1, 'edge')
    events.length = 0
    setStringFlightEdgeFrame({ height: .7, curvature: .1 })
    assert.deepEqual(getStringFlightEdgeFrame(), { height: .7, curvature: .1 })
    const copy = getStringFlightEdgeFrame(); copy.height = 0
    assert.equal(getStringFlightEdgeFrame().height, .7)
    setStringFlightEdgeFrame({ height: .7, curvature: .1 })
    assert.deepEqual(events, [1], 'identical values do not restart or redraw a settled flight')
    const camera = resolveStringFlightCamera(panorama, 1, 'edge', 16 / 9, getStringFlightEdgeFrame())
    near(screenImpact(camera, 16 / 9, .5, .3), CRITICAL_IMPACT)
    setStringFlightEdgeFrame({ height: NaN, curvature: Infinity })
    assert.deepEqual(getStringFlightEdgeFrame(), { height: .62, curvature: .16 })
    setStringFlightEdgeFrame({ height: -4, curvature: 10 })
    assert.deepEqual(getStringFlightEdgeFrame(), { height: .25, curvature: .45 })
    setStringFlight(0)
    events.length = 0
    setStringFlightEdgeFrame({ height: .5, curvature: .2 })
    assert.deepEqual(events, [], 'inactive tuning leaves the homepage renderer alone')
  } finally {
    setStringFlight(0); setStringFlightEdgeFrame({ height: .62, curvature: .16 })
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('edge pull is a signed, local angular field with a seamless wrapped center', () => {
  for (const displacement of [-.05, .05]) {
    const pull = { angle: Math.PI - .03, displacement, spread: .12 }
    near(stringFlightEdgeDisplacement(pull.angle, pull), displacement)
    near(stringFlightEdgeDisplacement(pull.angle + 2 * Math.PI, pull), displacement)
    near(stringFlightEdgeDisplacement(-Math.PI + .03, pull), displacement * Math.exp(-.125))
    near(stringFlightEdgeDisplacement(pull.angle + .12, pull), displacement * Math.exp(-.5))
    assert.ok(Math.abs(stringFlightEdgeDisplacement(pull.angle + 1, pull)) < 1e-12)
  }
  near(stringFlightEdgeDisplacement(0, { angle: 0, displacement: 8, spread: .2 }), .08)
  near(stringFlightEdgeDisplacement(0, { angle: 0, displacement: -8, spread: .2 }), -.08)
  assert.equal(stringFlightEdgeDisplacement(NaN, { angle: 0, displacement: .05, spread: .2 }), 0)
  assert.equal(stringFlightEdgeDisplacement(0, { angle: NaN, displacement: Infinity, spread: NaN }), 0)
})

test('positive and negative canvas pulls stay on the inverse-warped GPU capture boundary', () => {
  try {
    for (const [width, height] of [[1280, 720], [720, 1280], [960, 960]]) {
      const aspect = width / height, narrow = aspect < .8
      const camera = resolveStringFlightCamera(panorama, 1, 'edge', aspect)
      setStringFlight(1, 'edge'); publishStringFlightProjection(camera, width, height)
      const geometry = getStringFlightProjection(width, height)
      const scale = (narrow ? 13.8 : 10.2) / camera.zoom
      for (const displacement of [-.06, 0, .06]) {
        const pull = { angle: .18, displacement, spread: .15 }
        for (const angle of [-.3, .05, .18, .31, .6]) {
          // Canvas forward map: retain angle and move along the circle normal.
          const radius = geometry.radius + height * stringFlightEdgeDisplacement(angle, pull)
          const x = geometry.cx + radius * Math.sin(angle)
          const y = geometry.cy - radius * Math.cos(angle)
          const imageX = (x - geometry.cx) / height * scale
          const imageY = (geometry.cy - y) / height * scale
          // Evaluate the shader's inverse warp independently in image-plane units.
          const rayAngle = Math.atan2(imageX, imageY)
          const delta = ((rayAngle - pull.angle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
          const offset = pull.displacement * Math.exp(-.5 * (delta / pull.spread) ** 2) * scale
          const rayRadius = Math.max(.000001, Math.hypot(imageX, imageY) - offset)
          near(geodesicImpactForAngle(rayRadius / Math.hypot(30, rayRadius), camera.radius), CRITICAL_IMPACT)
        }
      }
    }
  } finally { setStringFlight(0) }
})

test('edge pull redraws the current scene and is cleared before returning home or centered flight', () => {
  const previousWindow = globalThis.window
  globalThis.window = new EventTarget()
  const events = []
  globalThis.window.addEventListener(STRING_FLIGHT_EVENT, event => events.push(event.detail))
  const empty = { angle: 0, displacement: 0, spread: .1 }
  try {
    setStringFlight(0)
    setStringFlightEdgePull({ angle: 1, displacement: .04, spread: .2 })
    assert.deepEqual(getStringFlightEdgePull(), empty)
    setStringFlight(1, 'edge'); events.length = 0
    const pull = { angle: 0, displacement: .04, spread: .2 }
    setStringFlightEdgePull(pull)
    assert.deepEqual(events, [1])
    assert.deepEqual(getStringFlightEdgePull(), pull)
    getStringFlightEdgePull().displacement = -1
    assert.equal(getStringFlightEdgePull().displacement, .04)
    setStringFlightEdgePull(pull)
    assert.deepEqual(events, [1], 'unchanged values do not request redundant GPU frames')
    setStringFlightEdgePull({ angle: Infinity, displacement: 4, spread: 0 })
    assert.deepEqual(getStringFlightEdgePull(), { angle: 0, displacement: .08, spread: .015 })
    setStringFlight(.5, 'center')
    assert.deepEqual(getStringFlightEdgePull(), empty)
    setStringFlightEdgePull(pull)
    assert.deepEqual(getStringFlightEdgePull(), empty)
    setStringFlight(.5, 'edge'); setStringFlightEdgePull(pull)
    setStringFlight(0, 'edge')
    assert.deepEqual(getStringFlightEdgePull(), empty)
    setStringFlight(1, 'edge')
    assert.deepEqual(getStringFlightEdgePull(), empty, 'a new visit cannot reuse an old cursor deformation')
  } finally {
    setStringFlight(0)
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})

test('edge approach remains finite, moves inward without overshoot, and settles gently', () => {
  for (const camera of [panorama, interstellar]) for (const aspect of [16 / 9, 9 / 16]) {
    let previous = resolveStringFlightCamera(camera, 0, 'edge', aspect)
    for (let step = 1; step <= 1000; step++) {
      const current = resolveStringFlightCamera(camera, step / 1000, 'edge', aspect)
      assert.ok(Object.values(current).every(Number.isFinite))
      assert.ok(current.radius >= STRING_FLIGHT_EDGE_RADIUS && current.radius <= previous.radius)
      assert.ok(current.centerY <= previous.centerY + 1e-12, 'the center continues down toward the limb')
      previous = current
    }
    nearCamera(resolveStringFlightCamera(camera, .0001, 'edge', aspect), resolveStringFlightCamera(camera, 0, 'edge', aspect), 1e-6)
    nearCamera(resolveStringFlightCamera(camera, .9999, 'edge', aspect), resolveStringFlightCamera(camera, 1, 'edge', aspect), 1e-6)
    const endSpeed = Math.abs(resolveStringFlightCamera(camera, .99, 'edge', aspect).radius - previous.radius)
    const midSpeed = Math.abs(resolveStringFlightCamera(camera, .5, 'edge', aspect).radius - resolveStringFlightCamera(camera, .51, 'edge', aspect).radius)
    assert.ok(endSpeed < midSpeed / 100)
  }
})

test('interrupted retreats retrace the same camera without discontinuity or state mutation', () => {
  for (const entryProgress of [.08, .32, .61, .92, 1]) {
    const from = orbitTransitionFrame(entryProgress, 0, false).flight
    const approach = resolveStringFlightCamera(panorama, from, 'edge')
    const firstExit = orbitTransitionFrame(0, from, true).flight
    assert.deepEqual(resolveStringFlightCamera(panorama, firstExit, 'edge'), approach)
    const nextExit = orbitTransitionFrame(.0001, from, true).flight
    nearCamera(resolveStringFlightCamera(panorama, nextExit, 'edge'), approach, 1e-5)
    let previous = approach
    for (let step = 0; step <= 100; step++) {
      const progress = orbitTransitionFrame(step / 100, from, true).flight
      const reverse = resolveStringFlightCamera(panorama, progress, 'edge')
      assert.ok(Object.values(reverse).every(Number.isFinite))
      assert.ok(reverse.radius >= previous.radius - 1e-12)
      previous = reverse
    }
    assert.deepEqual(previous, { ...panorama, radius: STRING_FLIGHT_START_RADIUS })
  }
})

test('shared state retains mode for mount ordering and publishes mode-only changes', () => {
  const previousWindow = globalThis.window
  globalThis.window = new EventTarget()
  const events = []
  globalThis.window.addEventListener(STRING_FLIGHT_EVENT, (event) => events.push(event.detail))
  try {
    setStringFlight(.42, 'edge')
    assert.equal(getStringFlight(), .42)
    assert.equal(getStringFlightMode(), 'edge')
    setStringFlight(.42, 'edge')
    setStringFlight(.42)
    assert.equal(getStringFlightMode(), 'center', 'legacy calls always select the legacy trajectory')
    assert.deepEqual(events, [.42, .42])
  } finally {
    setStringFlight(0)
    if (previousWindow === undefined) delete globalThis.window
    else globalThis.window = previousWindow
  }
})
