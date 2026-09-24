import assert from 'node:assert/strict'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { cloneOrbitGroups, moveOrbitGroup } from '../src/xixi/orbitGroups.ts'
import { DEFAULT_ORBIT_TUNING } from '../src/xixi/orbitTuning.ts'

const FULL_DISK_TUNING = { ...DEFAULT_ORBIT_TUNING, arcDegrees: 360, diskWidth: .9,
  tiltDegrees: -12, flatten: .42, gap: .22, scale: .9, centerX: .5, flow: .6, wave: 1 }

const sceneUrl = new URL('../src/xixi/orbitScene.ts', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL === sceneUrl && ['./orbitGroups', './orbitMotion'].includes(specifier)) return next(`${specifier}.ts`, context)
    return next(specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    return url === sceneUrl
      ? { ...result, format: 'module', source: stripTypeScriptTypes(String(result.source), { mode: 'transform' }) }
      : result
  },
})
const { OrbitCanvas, orbitGroupPositions, orbitProjection, orbitPoint, orbitDropTarget } = await import(sceneUrl)
hook.deregister()

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)
const near = (a, b, epsilon = 1e-5) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≈ ${b}`)

function fakeContext() {
  let path = []
  const gradient = () => ({ stops: [], addColorStop(at, color) { this.stops.push([at, color]) } })
  const context = {
    strokes: [], fills: [], images: [], rotations: [],
    beginPath() { path = [] },
    moveTo(x, y) { path.push({ x, y }) }, lineTo(x, y) { path.push({ x, y }) },
    stroke() { this.strokes.push({ points: path.map(point => ({ ...point })), style: this.strokeStyle, alpha: this.globalAlpha, width: this.lineWidth }) },
    fillRect(...rect) { this.fills.push(rect) },
    clearRect() { this.strokes = []; this.fills = []; this.images = []; this.rotations = [] },
    createLinearGradient: gradient, createRadialGradient: gradient,
    arc() {}, fill() {}, save() {}, restore() {}, translate() {}, scale() {}, setTransform() {}, transform() {}, closePath() {}, clip() {},
    rotate(angle) { this.rotations.push(angle) },
    drawImage(image, ...args) { this.images.push({ image, args, alpha: this.globalAlpha }) },
  }
  return context
}

function harness(t, initial = {}) {
  const originals = new Map(['document', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'devicePixelRatio']
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const pending = new Map(), listeners = new Map(), observers = [], canvases = []
  let nextFrame = 0, stamp = 0, placements = 0, disposed = false
  let positions = new Map()
  let geometry
  const makeCanvas = () => {
    const context = fakeContext()
    const canvas = { width: 0, height: 0, context, getContext: () => context,
      getBoundingClientRect: () => ({ width: 1440, height: 900 }) }
    canvases.push(canvas); return canvas
  }
  const document = {
    hidden: false, createElement: makeCanvas,
    addEventListener(name, listener) { listeners.set(name, listener) },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name) },
  }
  const globals = {
    document, devicePixelRatio: 1,
    requestAnimationFrame(callback) { const id = ++nextFrame; pending.set(id, callback); return id },
    cancelAnimationFrame(id) { pending.delete(id) },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this) }
      observe() {} disconnect() { this.disconnected = true }
    },
  }
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  const canvas = makeCanvas()
  let state = { look: 'accretion', groups: cloneOrbitGroups(), reduced: false, reveal: 1,
    pointer: null, dragging: null, expanded: null, dropTarget: null, ...initial }
  const renderer = new OrbitCanvas(canvas, () => state, (value, projection) => { placements++; positions = value; geometry = projection })
  const dispose = () => { if (!disposed) { renderer.destroy(); disposed = true } }
  t.after(() => {
    dispose()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  return {
    canvas, canvases, pending, listeners, observers, document, dispose,
    get state() { return state }, get positions() { return positions }, get placements() { return placements }, get geometry() { return geometry },
    update(patch) { state = { ...state, ...patch } },
    frame(ms = 1000 / 60) {
      stamp += ms
      const callbacks = [...pending.values()]; pending.clear()
      callbacks.forEach(callback => callback(stamp))
      return positions
    },
    run(count = 60, ms = 1000 / 60) { for (let i = 0; i < count; i++) this.frame(ms); return positions },
  }
}

test('live drop preview moves neighbors smoothly before committed groups change', t => {
  const h = harness(t)
  h.frame()
  const initial = structuredClone(h.state.groups), chosen = initial[0], neighbor = initial[1]
  const before = h.positions.get(neighbor.id)
  const dropTarget = { day: 0, index: 2 }
  const preview = orbitGroupPositions(moveOrbitGroup(initial, chosen.id, 0, 2), orbitProjection(1440, 900, 'accretion'))
  h.update({ dragging: { id: chosen.id, x: 900, y: 650 }, dropTarget })
  h.frame()
  const first = h.positions.get(neighbor.id)
  assert.ok(first.t < before.t && first.t > preview.get(neighbor.id).t)
  h.run(45)
  near(h.positions.get(neighbor.id).t, preview.get(neighbor.id).t, .00001)
  assert.deepEqual(h.state.groups, initial)
})

test('canceled drag restores original day and order after its preview animation', t => {
  const h = harness(t)
  h.frame()
  const original = structuredClone(h.state.groups), chosen = original[0]
  const initial = new Map(h.positions)
  h.update({ dragging: { id: chosen.id, x: 1150, y: 400 }, dropTarget: { day: 2, index: 0 } })
  h.run(45)
  assert.ok(distance(h.positions.get(original[1].id), initial.get(original[1].id)) > 20)
  h.update({ dragging: null, dropTarget: null })
  h.run(75)
  for (const [id, point] of initial) {
    near(h.positions.get(id).t, point.t)
    assert.equal(h.positions.get(id).day, point.day)
    assert.ok(distance(h.positions.get(id), point) < 4, `${id} returns to its original orbit, allowing ambient waves`)
  }
  assert.deepEqual(h.state.groups, original)
})

test('release settles continuously from the visible pointer position to the newly committed arc', t => {
  const h = harness(t)
  h.frame()
  const chosen = h.state.groups[0], original = h.positions.get(chosen.id)
  const pointer = { x: 780, y: 180 }
  h.update({ dragging: { id: chosen.id, ...pointer }, dropTarget: { day: 2, index: 1 } })
  h.run(45)
  const held = h.positions.get(chosen.id)
  assert.ok(distance(held, pointer) < .1)
  const committed = moveOrbitGroup(h.state.groups, chosen.id, 2, 1)
  h.update({ groups: committed, dragging: null, dropTarget: null })
  h.frame()
  const released = h.positions.get(chosen.id)
  assert.ok(distance(released, held) < 25, 'first released frame remains close to the held light')
  assert.ok(distance(released, held) < distance(original, held) * .15, 'release does not jump back to the source slot')
  h.run(75)
  const target = orbitGroupPositions(committed, orbitProjection(1440, 900, 'accretion')).get(chosen.id)
  assert.equal(h.positions.get(chosen.id).day, 2)
  near(h.positions.get(chosen.id).t, target.t)
  assert.ok(distance(h.positions.get(chosen.id), target) < 3)
})

test('lifted group changes from a curved orbit segment into a flatter detached strand', t => {
  const groups = cloneOrbitGroups().slice(0, 1)
  const h = harness(t, { groups, reduced: true })
  h.frame(100)
  const groupPaths = () => h.canvas.context.strokes.filter(stroke => stroke.style?.stops?.some(([, color]) => color === '#fff0c9'))
  const bow = points => {
    const first = points[0], last = points.at(-1), length = distance(first, last)
    return Math.max(...points.map(point => Math.abs((last.x - first.x) * (first.y - point.y) - (first.x - point.x) * (last.y - first.y)) / length))
  }
  const attached = groupPaths()[Math.floor(groupPaths().length / 2)].points
  assert.ok(bow(attached) > 5)
  h.update({ dragging: { id: groups[0].id, x: 780, y: 350 }, dropTarget: { day: 0, index: 0 } })
  h.frame(100)
  const detached = groupPaths()[Math.floor(groupPaths().length / 2)].points
  assert.ok(bow(detached) < bow(attached) * .2, 'lifting should deform the strand rather than translate the old bend')
  assert.ok(Math.abs(detached.at(-1).x - detached[0].x) > Math.abs(attached.at(-1).x - attached[0].x), 'detached strand opens out across the pointer')
})

test('reduced motion holds ribbons and anchors still despite pointer movement and elapsed time', t => {
  const h = harness(t, { reduced: true })
  h.frame(100)
  const initial = structuredClone(h.positions)
  const paths = structuredClone(h.canvas.context.strokes.map(stroke => stroke.points))
  h.update({ pointer: { x: 800, y: 500 } })
  h.run(12, 100)
  assert.deepEqual(h.positions, initial)
  assert.deepEqual(h.canvas.context.strokes.map(stroke => stroke.points), paths)
})

test('reduced motion keeps direct dragging responsive while its surrounding ribbons stay still', t => {
  const h = harness(t, { reduced: true })
  h.frame(100)
  const chosen = h.state.groups[0]
  const ambientPaths = () => h.canvas.context.strokes
    .filter(stroke => !stroke.style?.stops?.some(([, color]) => color === '#fff0c9'))
    .map(stroke => stroke.points)
  const initialRibbons = structuredClone(ambientPaths())
  for (let frame = 0; frame < 5; frame++) {
    const pointer = { x: 800 + frame * 15, y: 400 + frame * 8 }
    const before = h.placements
    h.update({ pointer, dragging: { id: chosen.id, ...pointer }, dropTarget: { day: 0, index: 0 } })
    h.frame(1000 / 60)
    assert.equal(h.placements, before + 1, 'every input frame should reach the visible light')
    assert.equal(h.positions.get(chosen.id).x, pointer.x)
    assert.equal(h.positions.get(chosen.id).y, pointer.y)
    assert.deepEqual(ambientPaths(), initialRibbons)
  }
})

test('visibility pauses the frame loop and destroy detaches every observer and callback', t => {
  const h = harness(t)
  h.frame()
  assert.equal(h.pending.size, 1)
  h.document.hidden = true
  h.listeners.get('visibilitychange')()
  assert.equal(h.pending.size, 0)
  h.document.hidden = false
  h.listeners.get('visibilitychange')()
  assert.equal(h.pending.size, 1)
  const staleCallback = [...h.pending.values()][0], placements = h.placements
  h.dispose()
  assert.equal(h.pending.size, 0)
  assert.equal(h.listeners.size, 0)
  assert.ok(h.observers.every(observer => observer.disconnected))
  staleCallback(1000)
  assert.equal(h.pending.size, 0)
  assert.equal(h.placements, placements)
})

test('continuous disk material is cached across ordinary frames and diskWidth zero returns to ribbons', t => {
  const h = harness(t, { tuning: { ...FULL_DISK_TUNING } })
  h.frame()
  const baked = h.canvases.length, diskImages = () => h.canvas.context.images.filter(item => item.image.width === 1024)
  assert.ok(diskImages().length >= 3, 'all three overlapping orbital materials fill the disk')
  assert.equal(h.canvases.filter(canvas => canvas.width === 1024).length, 3)
  h.run(45)
  assert.equal(h.canvases.length, baked, 'animation does not allocate or rebake textures')
  h.update({ tuning: { ...h.state.tuning, tiltDegrees: 41, brightness: .7, glow: 1.2 } })
  h.run(20)
  assert.equal(h.canvases.length, baked, 'projection and lighting controls reuse the same radial material')
  const materials = h.canvases.filter(canvas => canvas.width === 1024)
  const previousPaths = structuredClone(materials.map(canvas => canvas.context.strokes.map(stroke => stroke.points)))
  for (let step = 0; step < 12; step++) {
    h.update({ tuning: { ...h.state.tuning, gap: .13 + step * .012, diskWidth: .25 + step * .055 } }); h.frame()
    assert.equal(h.canvases.length, baked, 'dragging radial sliders must not allocate new backing canvases')
    assert.deepEqual(h.canvases.filter(canvas => canvas.width === 1024), materials)
  }
  assert.notDeepEqual(materials.map(canvas => canvas.context.strokes.map(stroke => stroke.points)), previousPaths, 'reused materials are cleared and repainted for the new profile')
  h.update({ tuning: { ...h.state.tuning, diskWidth: 0 } }); h.frame()
  assert.equal(diskImages().length, 0)
  assert.ok(h.canvas.context.strokes.length > 0, 'task ribbons remain available in thin-line mode')
})

test('full-circle waved ribbons close their seam during pointer attraction and flow', t => {
  const tuning = { ...FULL_DISK_TUNING, wave: 2, flow: 1.5 }
  const h = harness(t, { tuning })
  const projection = orbitProjection(1440, 900, 'accretion', tuning)
  h.frame()
  for (let frame = 0; frame < 30; frame++) {
    h.update({ pointer: orbitPoint(projection, 1, frame % 2 ? .998 : .002) }); h.frame()
    const rings = h.canvas.context.strokes.filter(stroke => stroke.points.length === 161 && stroke.style?.stops?.some(([, color]) => color === '#fff0c1dd'))
    assert.equal(rings.length, 18)
    for (const ring of rings) assert.ok(distance(ring.points[0], ring.points.at(-1)) < 1e-8, 'no broken line at the 360° join')
  }
})

test('flow and wave controls independently govern material advection and pointer displacement', t => {
  const h = harness(t, { tuning: { ...FULL_DISK_TUNING, flow: 0, wave: 0 } })
  h.run(30)
  const still = structuredClone(h.positions), stillPaths = structuredClone(h.canvas.context.strokes.map(stroke => stroke.points))
  const rotations = [...h.canvas.context.rotations]
  h.run(30)
  assert.deepEqual(h.positions, still)
  assert.deepEqual(h.canvas.context.strokes.map(stroke => stroke.points), stillPaths)
  assert.deepEqual(h.canvas.context.rotations, rotations)
  h.update({ tuning: { ...h.state.tuning, flow: 1 } }); h.run(30)
  assert.deepEqual(h.positions, still, 'flow does not silently reorder or rotate task anchors')
  assert.notDeepEqual(h.canvas.context.rotations, rotations, 'cached materials genuinely rotate')
  const id = h.state.groups[0].id
  h.update({ tuning: { ...h.state.tuning, flow: 0, wave: 2 }, pointer: still.get(id) }); h.run(30)
  assert.ok(distance(h.positions.get(id), still.get(id)) > .5, 'wave control affects the actual pointer-responsive geometry')
})

test('brightness and glow alter rendered energy, not only control labels', t => {
  const h = harness(t, { tuning: { ...FULL_DISK_TUNING, brightness: .25, glow: 0 }, reduced: true })
  h.frame(100)
  const energy = () => h.canvas.context.images.filter(item => item.image.width === 1024).reduce((sum, image) => sum + image.alpha, 0)
  const faint = energy(), firstHalos = h.canvas.context.strokes.filter(stroke => stroke.points.length === 161).slice(0, 3)
  assert.ok(firstHalos.every(stroke => stroke.alpha === 0))
  h.update({ tuning: { ...h.state.tuning, brightness: 1.8, glow: 1.5 } }); h.frame(100)
  assert.ok(energy() > faint * 3)
  assert.ok(h.canvas.context.strokes.filter(stroke => stroke.points.length === 161).slice(0, 3).every(stroke => stroke.alpha > 0))
})

test('configured full disks also honor reduced motion with maximal flow and wave settings', t => {
  const h = harness(t, { tuning: { ...FULL_DISK_TUNING, flow: 2, wave: 2 }, reduced: true })
  h.frame(100)
  const initial = structuredClone(h.positions), rotations = [...h.canvas.context.rotations]
  h.update({ pointer: { x: 650, y: 340 } }); h.run(20, 100)
  assert.deepEqual(h.positions, initial)
  assert.deepEqual(h.canvas.context.rotations, rotations)
})

test('full-to-one-degree tuning publishes the same smooth geometry used by visible anchors and drop hit tests', t => {
  const h = harness(t, { tuning: { ...FULL_DISK_TUNING, wave: 0 } })
  h.run(15)
  h.update({ tuning: { ...h.state.tuning, arcDegrees: 1, rotationDegrees: 129, tiltDegrees: 70, flatten: .12, scale: .45 } })
  const caches = h.canvases.length
  let previousSpan = Math.PI * 2
  for (let frame = 0; frame < 100; frame++) {
    h.frame()
    const geometry = h.geometry, span = geometry.end - geometry.start
    assert.ok(span <= previousSpan + 1e-8 && span >= Math.PI / 180 - 1e-8)
    previousSpan = span
    const targets = orbitGroupPositions(h.state.groups, geometry)
    for (const group of h.state.groups) {
      const drawn = h.positions.get(group.id)
      const curve = orbitPoint(geometry, group.day, drawn.t)
      assert.ok(distance(drawn, curve) < 1, 'visible anchor follows the shared sampled projection')
      const target = orbitDropTarget(targets.get(group.id), geometry, h.state.groups, group.id)
      assert.equal(target.day, group.day)
      assert.equal(target.index, targets.get(group.id).index)
    }
  }
  assert.equal(h.canvases.length, caches, 'arc clipping and affine changes reuse radial textures')
  assert.ok(Math.abs(previousSpan - Math.PI / 180) < .0001)
})

test('minimal draws only three fine tracks and one strand per group even with dense-disk settings', t => {
  const h = harness(t, { look: 'minimal', tuning: { ...FULL_DISK_TUNING, diskWidth: 1, glow: 1.5 }, reduced: true })
  h.frame(100)
  assert.equal(h.canvases.length, 2, 'only the visible canvas and a plain background are needed')
  assert.equal(h.canvas.context.images.length, 1)
  assert.equal(h.canvas.context.fills.length, 0, 'no particle squares, large auras, or central haze are drawn')
  const background = h.canvas.context.images[0].image
  assert.equal(background.context.fills.length, 1, 'background is a single solid fill')
  assert.equal(background.context.strokes.length, 0)
  assert.equal(h.canvas.context.strokes.length, 3 + h.state.groups.length)
  assert.ok(h.canvas.context.strokes.slice(0, 3).every(stroke => stroke.width <= 1))
  h.update({ tuning: { ...h.state.tuning, gap: .31, diskWidth: .45 } }); h.frame(100)
  assert.equal(h.canvases.length, 2, 'radial controls never trigger a texture bake in minimal mode')
  h.update({ look: 'accretion' }); h.frame(100)
  assert.ok(h.canvas.context.images.some(item => item.image.width === 1024), 'the legacy disk remains available')
  h.update({ look: 'minimal' }); h.frame(100)
  assert.equal(h.canvas.context.images.length, 1, 'switching back does not crossfade old stars or disk material into minimal')
  assert.equal(h.canvas.context.fills.length, 0)
})

test('minimal keeps task lifting, neighbor preview and cancel restoration without multi-strand effects', t => {
  const h = harness(t, { look: 'minimal', tuning: { ...DEFAULT_ORBIT_TUNING, flow: 0, wave: 0 }, reduced: true })
  h.frame(100)
  const original = structuredClone(h.state.groups), positions = new Map(h.positions), chosen = original[0]
  const groupPaths = () => h.canvas.context.strokes.filter(stroke => stroke.points.length === 29)
  const bow = points => {
    const first = points[0], last = points.at(-1), length = distance(first, last)
    return Math.max(...points.map(point => Math.abs((last.x - first.x) * (first.y - point.y) - (first.x - point.x) * (last.y - first.y)) / length))
  }
  const attached = groupPaths()[0].points
  assert.ok(bow(attached) > .01)
  const pointer = { x: 650, y: 240 }
  h.update({ dragging: { id: chosen.id, ...pointer }, dropTarget: { day: 2, index: 0 } }); h.frame()
  assert.equal(groupPaths().length, original.length, 'each group remains one path while dragging')
  assert.ok(bow(groupPaths()[0].points) < .001, 'the lifted short line straightens rather than carrying its orbital bend')
  assert.equal(h.positions.get(chosen.id).x, pointer.x)
  assert.equal(h.positions.get(chosen.id).y, pointer.y)
  assert.ok(distance(h.positions.get(original[1].id), positions.get(original[1].id)) > 5)
  assert.deepEqual(h.state.groups, original)
  h.update({ dragging: null, dropTarget: null }); h.frame(100)
  assert.deepEqual(h.positions, positions)
  assert.deepEqual(h.state.groups, original)
  assert.equal(h.canvas.context.fills.length, 0)
})

test('minimal pointer response stays subtle and shares the unchanged tuning projection', t => {
  const h = harness(t, { look: 'minimal', tuning: { ...DEFAULT_ORBIT_TUNING, flow: 0, wave: 1 } })
  h.run(30)
  const projection = structuredClone(h.geometry), id = h.state.groups[0].id, initial = h.positions.get(id)
  h.update({ pointer: initial }); h.run(40)
  assert.deepEqual(h.geometry, projection, 'pointer response displaces the sampled string, not the configured layout')
  assert.ok(distance(h.positions.get(id), initial) > .1)
  assert.ok(distance(h.positions.get(id), initial) < 2, 'minimal mode keeps a taut, restrained response')
  assert.equal(h.canvas.context.fills.length, 0)
  const last = structuredClone(h.positions)
  h.update({ reduced: true }); h.frame(100)
  const reduced = structuredClone(h.positions)
  h.update({ pointer: { x: 30, y: 30 } }); h.run(12, 100)
  assert.deepEqual(h.positions, reduced)
  assert.ok(distance(last.get(id), reduced.get(id)) < 2)
})
