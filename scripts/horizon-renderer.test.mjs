import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { cloneOrbitGroups, moveOrbitGroup } from '../src/xixi/orbitGroups.ts'
import { DEFAULT_HORIZON_TUNING } from '../src/xixi/horizonTuning.ts'
import { getStringFlightEdgePull, publishStringFlightProjection, setStringFlight } from '../src/prototype/stringFlight.ts'

const sceneUrl = new URL('../src/xixi/horizonScene.ts', import.meta.url).href
const hook = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL === sceneUrl && ['./orbitGroups', './orbitMotion', '../prototype/stringFlight'].includes(specifier)
    ? `${specifier}.ts` : specifier, context)
} })
const { HorizonCanvas, horizonProjection, horizonPoint, horizonGroupPositions, horizonDropIndex } = await import(sceneUrl)
hook.deregister()
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const near = (a, b, epsilon = 1e-4) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≈ ${b}`)
const strokeSnapshot = h => JSON.parse(JSON.stringify(h.canvas.context.strokes))

function fakeContext() {
  let path = []
  const stack = [], properties = ['globalAlpha', 'globalCompositeOperation', 'lineWidth', 'strokeStyle', 'fillStyle']
  const gradient = (...coordinates) => ({ coordinates, stops: [], addColorStop(at, color) { this.stops.push([at, color]) } })
  return {
    strokes: [], fills: [], images: [], globalAlpha: 1, globalCompositeOperation: 'source-over',
    beginPath() { path = [] }, moveTo(x, y) { path.push({ x, y }) }, lineTo(x, y) { path.push({ x, y }) },
    stroke() { this.strokes.push({ points: path.map(p => ({ ...p })), alpha: this.globalAlpha, width: this.lineWidth, style: this.strokeStyle }) },
    fill() { this.fills.push({ points: [...path], style: this.fillStyle }) },
    fillRect(...rect) { this.fills.push({ rect, style: this.fillStyle }) }, arc() {}, closePath() {},
    save() { stack.push(Object.fromEntries(properties.map(key => [key, this[key]]))) },
    restore() { Object.assign(this, stack.pop()) },
    setTransform(...value) { this.transform = value },
    clearRect() { this.strokes = []; this.fills = []; this.images = [] },
    createLinearGradient: gradient,
    createRadialGradient(...coordinates) { return { ...gradient(...coordinates), radial: true } },
    drawImage(image, ...args) { this.images.push({ image, args, alpha: this.globalAlpha }) },
  }
}

function harness(t, initial = {}) {
  const keys = ['document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio']
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const pending = new Map(), listeners = new Map(), observers = [], canvases = []
  let stamp = 0, nextId = 0, placements = 0, disposed = false, positions = new Map(), geometry
  let size = { width: 1440, height: 900 }
  const makeCanvas = () => {
    const context = fakeContext(), canvas = { context, width: 0, height: 0,
      getContext: (_kind, options) => { canvas.contextOptions = options; return context }, getBoundingClientRect: () => size }
    canvases.push(canvas); return canvas
  }
  const document = { hidden: false, createElement: makeCanvas,
    addEventListener(name, callback) { listeners.set(name, callback) },
    removeEventListener(name, callback) { if (listeners.get(name) === callback) listeners.delete(name) },
  }
  const globals = { document, devicePixelRatio: 3,
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; observers.push(this) }
      observe() {} disconnect() { this.disconnected = true }
    },
    requestAnimationFrame(callback) { pending.set(++nextId, callback); return nextId },
    cancelAnimationFrame(id) { pending.delete(id) },
  }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  let state = { groups: cloneOrbitGroups(), day: 0, tuning: { ...DEFAULT_HORIZON_TUNING }, reduced: false,
    reveal: 1, pointer: null, dragging: null, dropTarget: null, expanded: null, ...initial }
  const canvas = makeCanvas(), renderer = new HorizonCanvas(canvas, () => state, (value, projection) => {
    positions = value; geometry = projection; placements++
  })
  const dispose = () => { if (!disposed) { disposed = true; renderer.destroy() } }
  t.after(() => {
    dispose()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key]
    }
  })
  return { canvas, canvases, pending, observers, listeners, document, dispose,
    get positions() { return positions }, get geometry() { return geometry }, get state() { return state }, get placements() { return placements },
    update(patch) { state = { ...state, ...patch } },
    resize(width, height) { size = { width, height }; observers[0].callback() },
    frame(ms = 1000 / 60) {
      stamp += ms; const callbacks = [...pending.values()]; pending.clear(); callbacks.forEach(callback => callback(stamp))
    },
    run(count = 60, ms = 1000 / 60) { for (let index = 0; index < count; index++) this.frame(ms) },
  }
}

test('the horizon spans the screen with its center below the viewport and one active day', () => {
  const groups = cloneOrbitGroups()
  for (const [width, height] of [[320, 568], [390, 844], [768, 1024], [1440, 900], [2560, 1080]]) {
    for (const curvature of [.04, .16, .4]) {
      const p = horizonProjection(width, height, { ...DEFAULT_HORIZON_TUNING, curvature })
      assert.ok(p.cy > height)
      near(horizonPoint(p, .5).y, p.apexY)
      assert.equal(horizonPoint(p, 0).x, 0); assert.equal(horizonPoint(p, 1).x, width)
      near(horizonPoint(p, 0).y, horizonPoint(p, 1).y)
      assert.ok(horizonPoint(p, 0).y > horizonPoint(p, .5).y)
      for (const day of [0, 1, 2]) {
        const positions = horizonGroupPositions(groups, day, p), items = groups.filter(group => group.day === day)
        assert.equal(positions.size, items.length)
        for (const [index, group] of items.entries()) {
          const anchor = positions.get(group.id)
          assert.equal(anchor.day, day); assert.equal(anchor.index, index)
          assert.ok(anchor.x > 0 && anchor.x < width && anchor.y < height)
          assert.equal(horizonDropIndex(anchor, p, groups, day, group.id), index)
        }
      }
    }
  }
})

test('insertion slots use original anchors, including single-group and empty days', () => {
  const groups = cloneOrbitGroups(), p = horizonProjection(1440, 900, DEFAULT_HORIZON_TUNING)
  for (const group of groups) for (const day of [0, 1, 2]) {
    const positions = horizonGroupPositions(groups, day, p)
    const remaining = groups.filter(item => item.day === day && item.id !== group.id)
    const boundaries = [0, ...remaining.map(item => positions.get(item.id).t), 1]
    for (let index = 0; index < boundaries.length - 1; index++) {
      const point = horizonPoint(p, (boundaries[index] + boundaries[index + 1]) / 2)
      assert.equal(horizonDropIndex(point, p, groups, day, group.id), index)
    }
  }
  const one = [groups[0]]
  assert.equal(horizonGroupPositions(one, 0, p).get(one[0].id).t, .5)
  assert.equal(horizonDropIndex({ x: 900, y: 600 }, p, one, 1, one[0].id), 0)
})

test('flow changes long band filaments without moving the horizon or group anchors', t => {
  const h = harness(t)
  h.frame()
  const positions = structuredClone(h.positions), geometry = structuredClone(h.geometry)
  const paths = strokeSnapshot(h)
  h.run(30)
  assert.deepEqual(h.geometry, geometry); assert.deepEqual(h.positions, positions)
  assert.notDeepEqual(strokeSnapshot(h), paths)
  assert.ok(h.canvas.context.strokes.some(stroke => stroke.width === 22 && stroke.points.length === 225))
  assert.ok(h.canvas.context.strokes.filter(stroke => stroke.points.length > 20 && stroke.width <= 1.3).length > 40)
  assert.deepEqual([...h.positions.keys()], h.state.groups.filter(group => group.day === 0).map(group => group.id))
  assert.equal(h.canvases.length, 2, 'only the transparent overlay and cached halo; the homepage provides the sky')
  assert.equal(h.canvas.contextOptions.alpha, true)
  assert.deepEqual(h.canvas.context.fills, [], 'the overlay never paints an opaque sky or black-hole mask')
})

test('task strands track the camera actually rendered while flying and retreating', t => {
  const h = harness(t, { reduced: true })
  t.after(() => setStringFlight(0))
  const camera = { zoom: .8, roll: 15, inclination: 80, centerX: .5, centerY: -.6, radius: 5 }
  setStringFlight(.85, 'edge')
  publishStringFlightProjection(camera, 1440, 900)
  h.frame()
  const arriving = structuredClone(h.geometry)
  near(h.geometry.cy, 1440)
  for (const anchor of h.positions.values()) near(anchor.y, horizonPoint(h.geometry, anchor.t).y, .05)
  // The camera recedes; the overlay must use its new curve, not a final-screen
  // approximation that would briefly draw a second, disconnected horizon.
  setStringFlight(.65, 'edge')
  publishStringFlightProjection({ ...camera, centerY: -.3, radius: 7 }, 1440, 900)
  h.frame()
  near(h.geometry.cy, 1170)
  assert.ok(h.geometry.radius < arriving.radius)
  for (const anchor of h.positions.values()) near(anchor.y, horizonPoint(h.geometry, anchor.t).y, .05)
  assert.deepEqual(h.canvas.context.fills, [])
  setStringFlight(0, 'edge'); h.frame()
  assert.deepEqual(h.geometry, horizonProjection(1440, 900, h.state.tuning))
})

test('same-day preview moves neighbors with springs without mutating data; cancel restores them', t => {
  const h = harness(t, { tuning: { ...DEFAULT_HORIZON_TUNING, wave: 0 } })
  h.frame()
  const original = structuredClone(h.state.groups), chosen = original[0], neighbor = original[1]
  const positions = structuredClone(h.positions), destination = horizonGroupPositions(moveOrbitGroup(original, chosen.id, 0, 2), 0, h.geometry)
  h.update({ dragging: { id: chosen.id, x: 980, y: 300 }, dropTarget: { day: 0, index: 2 } }); h.frame()
  const first = h.positions.get(neighbor.id)
  assert.ok(first.t < positions.get(neighbor.id).t && first.t > destination.get(neighbor.id).t)
  h.run(60)
  near(h.positions.get(neighbor.id).t, destination.get(neighbor.id).t)
  assert.deepEqual(h.state.groups, original)
  h.update({ dragging: null, dropTarget: null }); h.run(90)
  for (const [id, position] of positions) assert.ok(distance(position, h.positions.get(id)) < .01)
  assert.deepEqual(h.state.groups, original)
})

test('a cross-day drop preview retains the current day and its original neighbor anchors', t => {
  const h = harness(t)
  h.frame()
  const before = structuredClone(h.positions), id = h.state.groups[0].id
  h.update({ dragging: { id, x: 1040, y: 200 }, dropTarget: { day: 2, index: 0 } }); h.run(60)
  for (const [groupId, position] of before) if (groupId !== id) assert.deepEqual(h.positions.get(groupId), position)
  assert.ok(distance(h.positions.get(id), { x: 1040, y: 200 }) < .01)
  assert.equal(h.positions.size, before.size)
})

test('release begins at the visible lifted strand and settles on the committed slot', t => {
  const h = harness(t)
  h.frame()
  const id = h.state.groups[0].id, pointer = { x: 1100, y: 240 }
  h.update({ dragging: { id, ...pointer }, dropTarget: { day: 0, index: 2 } }); h.run(60)
  const held = h.positions.get(id), groups = moveOrbitGroup(h.state.groups, id, 0, 2)
  h.update({ groups, dragging: null, dropTarget: null }); h.frame()
  assert.ok(distance(h.positions.get(id), held) < 20, 'release does not jump to its old or new arc anchor')
  h.run(90)
  const destination = horizonGroupPositions(groups, 0, h.geometry).get(id)
  assert.ok(distance(h.positions.get(id), destination) < .01)
  assert.equal(h.positions.get(id).index, 2)
})

test('lifting flattens the curved group segment and publishes its exact rendered center', t => {
  const h = harness(t, { groups: cloneOrbitGroups().slice(0, 1), reduced: true })
  h.frame()
  const groupPath = () => h.canvas.context.strokes.filter(stroke => stroke.points.length === 41).at(-1).points
  const bow = points => {
    const first = points[0], last = points.at(-1), length = distance(first, last)
    return Math.max(...points.map(point => Math.abs((last.x - first.x) * (first.y - point.y) - (first.x - point.x) * (last.y - first.y)) / length))
  }
  assert.ok(bow(groupPath()) > 1)
  const id = h.state.groups[0].id, pointer = { x: 650, y: 300 }
  h.update({ dragging: { id, ...pointer }, dropTarget: { day: 0, index: 0 } }); h.frame()
  assert.ok(bow(groupPath()) < .0001)
  assert.deepEqual(groupPath()[20], pointer)
  near(distance(h.positions.get(id), pointer), 0)
})

test('day changes preserve camera geometry while fading and drifting the new day anchors', t => {
  const h = harness(t)
  h.frame()
  const geometry = structuredClone(h.geometry)
  h.update({ day: 1 }); h.frame()
  assert.deepEqual(h.geometry, geometry)
  assert.ok([...h.positions.values()].every(position => position.day === 1))
  const targets = horizonGroupPositions(h.state.groups, 1, geometry)
  assert.ok([...h.positions].some(([id, position]) => distance(position, targets.get(id)) > 1))
  h.run(75)
  for (const [id, target] of targets) assert.ok(distance(h.positions.get(id), target) < .01)
})

test('pointer response is local and restrained; reduced motion freezes all material animation', t => {
  const h = harness(t)
  h.frame()
  const id = h.state.groups[0].id, before = structuredClone(h.positions), geometry = structuredClone(h.geometry)
  h.update({ pointer: { x: before.get(id).x, y: before.get(id).y - 60 } }); h.run(60)
  assert.deepEqual(h.geometry, geometry)
  assert.ok(distance(h.positions.get(id), before.get(id)) > 3)
  assert.ok(distance(h.positions.get(id), before.get(id)) < 8)
  const farId = h.state.groups[2].id
  assert.ok(distance(h.positions.get(farId), before.get(farId)) < .02)
  h.update({ reduced: true }); h.frame()
  const still = strokeSnapshot(h), positions = structuredClone(h.positions)
  h.update({ pointer: { x: 30, y: 100 } }); h.run(20)
  assert.deepEqual(strokeSnapshot(h), still); assert.deepEqual(h.positions, positions)
})

test('the luminous core stays on the critical boundary at every band thickness', t => {
  const h = harness(t, { reduced: true })
  for (const thickness of [8, 22, 52]) {
    h.update({ tuning: { ...h.state.tuning, thickness } }); h.frame()
    const core = h.canvas.context.strokes.find(stroke => stroke.style === '#fffbee')
    for (const index of [40, 112, 184]) {
      const actual = core.points[index], expected = horizonPoint(h.geometry, index / 224)
      assert.ok(distance(actual, expected) < .01, 'thickness must not move the brightest strand off the limb')
    }
  }
})

test('maximum pointer pull moves the band and its shared GPU field together without a fixed halo', t => {
  const h = harness(t, { tuning: { ...DEFAULT_HORIZON_TUNING, wave: 3 } })
  t.after(() => setStringFlight(0))
  setStringFlight(1, 'edge'); h.frame()
  const middle = horizonPoint(h.geometry, .5)
  h.update({ pointer: { x: middle.x, y: middle.y - 70 } }); h.run(60)
  const core = () => h.canvas.context.strokes.find(stroke => stroke.style === '#fffbee').points[112]
  const lift = middle.y - core().y
  assert.ok(lift > 32 && lift < 48, 'the highest setting gives a clearly visible but bounded pull')
  near(getStringFlightEdgePull().displacement * h.geometry.height, lift)
  assert.equal(h.canvas.context.images.length, 0, 'no circular halo remains behind the deformed surface')
  h.update({ pointer: { x: middle.x, y: middle.y + 70 } }); h.run(90)
  assert.ok(core().y - middle.y > 32, 'pulling below the band pulls inward as well')
  h.update({ reduced: true }); h.frame()
  near(core().y, middle.y)
  assert.equal(getStringFlightEdgePull().displacement, 0)
})

test('brightness, glow and thickness directly control visible band energy', t => {
  const h = harness(t, { reduced: true, tuning: { ...DEFAULT_HORIZON_TUNING, brightness: .4, glow: 0, thickness: 8 } })
  h.frame()
  const first = h.canvas.context.strokes
  assert.equal(h.canvas.context.images.length, 0, 'glow zero leaves the homepage scene unobscured')
  const body = first[0]
  assert.equal(body.width, 8)
  h.update({ tuning: { ...h.state.tuning, brightness: 1.6, glow: 1.5, thickness: 52 } }); h.frame()
  const next = h.canvas.context.strokes
  assert.ok(h.canvas.context.images.length > 1)
  near(h.canvas.context.images.reduce((sum, image) => sum + image.alpha, 0), 1.6 * 1.5)
  assert.equal(next[0].width, 52); assert.ok(next[0].alpha > body.alpha * 3)
  h.update({ tuning: { ...h.state.tuning, brightness: 0 } }); h.frame()
  assert.equal(h.canvas.context.images.length, 0, 'brightness zero also hides the atmosphere')
  assert.ok(h.canvas.context.strokes.every(stroke => stroke.alpha === 0))
})

test('atmosphere has a continuous soft falloff, is reused during flow, and invalidates with geometry', t => {
  const h = harness(t)
  h.frame()
  const halo = h.canvas.context.images[0].image
  const gradient = halo.context.fills[0].style
  assert.ok(gradient.radial)
  assert.ok(halo.height < h.canvas.height, 'the halo texture is cropped around the visible horizon')
  const opacity = gradient.stops.map(([, color]) => Number(color.match(/,([.\d]+)\)$/)[1]))
  assert.equal(opacity[0], 0); assert.equal(opacity.at(-1), 0)
  assert.ok(opacity.slice(0, 33).every((value, index, list) => index === 0 || value >= list[index - 1]))
  assert.ok(opacity.slice(32).every((value, index, list) => index === 0 || value <= list[index - 1]))
  h.run(30)
  assert.equal(h.canvas.context.images[0].image, halo)
  h.update({ tuning: { ...h.state.tuning, brightness: .8, glow: .5 } }); h.frame()
  assert.equal(h.canvas.context.images[0].image, halo, 'brightness changes reuse the same cached falloff')
  h.update({ tuning: { ...h.state.tuning, curvature: .25 } }); h.frame()
  const curved = h.canvas.context.images[0].image
  assert.notEqual(curved, halo); assert.equal(halo.width, 0, 'obsolete texture storage is released')
  h.resize(390, 844); h.frame()
  const portrait = h.canvas.context.images[0].image
  assert.notEqual(portrait, curved); assert.equal(curved.width, 0)
  assert.equal(portrait.width, 390)
  h.dispose(); assert.equal(portrait.width, 0); assert.equal(portrait.height, 0)
})

test('group segments fade over 400ms for detail mode while the main horizon keeps its energy', t => {
  const h = harness(t)
  const groups = () => h.canvas.context.strokes.filter(stroke => stroke.points.length === 41 && stroke.width === 2.2)
  h.frame()
  const core = groups()[0].alpha, band = h.canvas.context.strokes[0].alpha
  h.update({ expanded: h.state.groups[0].id }); h.frame()
  assert.ok(groups()[0].alpha > core * .98, 'opening does not abruptly hide the groups')
  h.run(11)
  near(groups()[0].alpha, core * .5)
  assert.equal(h.canvas.context.strokes[0].alpha, band)
  h.run(13)
  assert.equal(groups().length, 0, 'all original group segments give way to the in-group overlay')
  assert.equal(h.canvas.context.strokes[0].alpha, band)
  h.update({ expanded: null }); h.frame()
  assert.ok(groups()[0].alpha < core * .02)
  h.run(24); near(groups()[0].alpha, core)
  h.update({ expanded: h.state.groups[0].id, reduced: true }); h.frame()
  assert.equal(groups().length, 0, 'reduced motion has no transition')
})

test('backing resolution is capped; hidden frames pause; resize and destruction clean up', t => {
  const h = harness(t)
  h.frame()
  assert.equal(h.canvas.width, 1440 * 1.6); assert.equal(h.canvas.height, 900 * 1.6)
  assert.equal(h.pending.size, 1)
  h.document.hidden = true; h.listeners.get('visibilitychange')()
  assert.equal(h.pending.size, 0)
  const placements = h.placements
  h.frame(30000); assert.equal(h.placements, placements)
  h.document.hidden = false; h.listeners.get('visibilitychange')(); h.frame()
  assert.equal(h.pending.size, 1); assert.equal(h.placements, placements + 1)
  h.resize(390, 844); h.frame()
  assert.equal(h.geometry.width, 390); assert.equal(h.canvas.width, 624)
  h.dispose(); h.dispose()
  assert.equal(h.pending.size, 0); assert.equal(h.listeners.size, 0)
  assert.ok(h.observers.every(observer => observer.disconnected))
  h.observers[0].callback(); h.frame()
  assert.equal(h.pending.size, 0)
})
