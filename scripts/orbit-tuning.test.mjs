import assert from 'node:assert/strict'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { cloneOrbitGroups } from '../src/xixi/orbitGroups.ts'
import { orbitLabelPositions } from '../src/xixi/orbitLabels.ts'
import {
  DEFAULT_ORBIT_TUNING, normalizeOrbitTuning, readOrbitTuning, saveOrbitTuning,
} from '../src/xixi/orbitTuning.ts'

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
const { orbitProjection, orbitGroupPositions } = await import(sceneUrl)
hook.deregister()

function storage(t, initial = null) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const state = { raw: initial, writes: [], failRead: false, failWrite: false }
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem() { if (state.failRead) throw new Error('Storage blocked'); return state.raw },
    setItem(key, value) {
      if (state.failWrite) throw new Error('Quota exceeded')
      state.raw = value; state.writes.push({ key, value })
    },
  } })
  t.after(() => {
    if (original) Object.defineProperty(globalThis, 'localStorage', original)
    else delete globalThis.localStorage
  })
  return state
}

test('partial imported parameters retain valid numbers and safely fill unavailable fields', () => {
  const result = normalizeOrbitTuning({ arcDegrees: 168, centerX: -.02, brightness: 1.5,
    scale: '1.2', flatten: null, glow: true, rotationDegrees: [], wave: { value: 1 } })
  assert.deepEqual(result, { ...DEFAULT_ORBIT_TUNING, arcDegrees: 168, centerX: -.02, brightness: 1.5 })
  for (const corrupt of [undefined, null, false, 100, 'not parameters', ['arcDegrees', 168]]) {
    assert.deepEqual(normalizeOrbitTuning(corrupt), DEFAULT_ORBIT_TUNING)
  }
})

test('out-of-range values are bounded, zero remains meaningful and non-finite values fall back', () => {
  const result = normalizeOrbitTuning({ arcDegrees: 720, tiltDegrees: -100, flatten: 0,
    centerX: 999, exitSeconds: 0, scale: Infinity, brightness: NaN,
    flow: 0, wave: 0, diskWidth: 0, glow: 0 })
  assert.deepEqual(result, { ...DEFAULT_ORBIT_TUNING, arcDegrees: 360, tiltDegrees: -70, flatten: .12,
    centerX: 1.25, exitSeconds: 1.4, flow: 0, wave: 0, diskWidth: 0, glow: 0 })
  assert.ok(Object.values(result).every(Number.isFinite))
})

test('normalization does not mutate its input or leak unknown imported properties', () => {
  const input = Object.freeze(JSON.parse('{"centerY":0.7,"__proto__":{"polluted":true},"extra":"not a parameter"}'))
  const first = normalizeOrbitTuning(input), second = normalizeOrbitTuning(input)
  assert.equal(first.centerY, .7)
  assert.equal(Object.hasOwn(first, '__proto__'), false)
  assert.equal(Object.hasOwn(first, 'extra'), false)
  assert.equal(Object.getPrototypeOf(first), Object.prototype)
  first.centerY = .9
  assert.equal(second.centerY, .7)
  assert.equal(input.centerY, .7)
  assert.equal(normalizeOrbitTuning(null).centerY, DEFAULT_ORBIT_TUNING.centerY)
})

test('missing, truncated and wrong-shaped saved data recover to defaults', t => {
  const saved = storage(t)
  for (const raw of [null, '', '{"arcDegrees":', 'null', 'false', '"360"', '[360]']) {
    saved.raw = raw
    assert.deepEqual(readOrbitTuning(), DEFAULT_ORBIT_TUNING)
  }
  assert.equal(saved.writes.length, 0, 'reading a corrupt record does not rewrite storage')
})

test('a partly corrupt saved record preserves its usable fields without coercing strings', t => {
  storage(t, '{"arcDegrees":168,"brightness":1e999,"scale":"1.3","wave":0,"extra":12}')
  assert.deepEqual(readOrbitTuning(), { ...DEFAULT_ORBIT_TUNING, arcDegrees: 168, wave: 0 })
})

test('saved values round-trip across independent reads and subsequent updates replace them', t => {
  const saved = storage(t)
  const authored = { ...DEFAULT_ORBIT_TUNING, arcDegrees: 230, rotationDegrees: -35, centerX: .38,
    flatten: .64, exitSeconds: 3.7, flow: 0 }
  assert.equal(saveOrbitTuning(authored), true)
  assert.deepEqual(JSON.parse(saved.raw), authored)
  assert.deepEqual(readOrbitTuning(), authored)
  const detached = readOrbitTuning(); detached.arcDegrees = 80
  assert.equal(readOrbitTuning().arcDegrees, 230)
  assert.equal(saveOrbitTuning({ ...authored, arcDegrees: 320 }), true)
  assert.equal(readOrbitTuning().arcDegrees, 320)
  assert.equal(saved.writes.length, 2)
  assert.equal(saved.writes[0].key, saved.writes[1].key)
})

test('saving sanitizes invalid values rather than persisting an unusable JSON record', t => {
  const saved = storage(t)
  assert.equal(saveOrbitTuning({ ...DEFAULT_ORBIT_TUNING, rotationDegrees: Infinity, glow: 20, extra: 'omit' }), true)
  assert.deepEqual(JSON.parse(saved.raw), { ...DEFAULT_ORBIT_TUNING, glow: 1.5 })
  assert.deepEqual(readOrbitTuning(), { ...DEFAULT_ORBIT_TUNING, glow: 1.5 })
})

test('storage access and quota failures stay recoverable and preserve the last good record', t => {
  const authored = { ...DEFAULT_ORBIT_TUNING, exitSeconds: 3.2 }
  const saved = storage(t, JSON.stringify(authored))
  saved.failRead = true
  assert.deepEqual(readOrbitTuning(), DEFAULT_ORBIT_TUNING)
  saved.failRead = false; saved.failWrite = true
  assert.equal(saveOrbitTuning({ ...authored, exitSeconds: 4 }), false)
  assert.deepEqual(readOrbitTuning(), authored)
  delete globalThis.localStorage
  assert.deepEqual(readOrbitTuning(), DEFAULT_ORBIT_TUNING)
  assert.equal(saveOrbitTuning(authored), false)
})

function assertReadableLabels(labels, width, height) {
  const entries = [...labels], labelWidth = width < 650 ? 120 : 158
  for (let index = 0; index < entries.length; index++) {
    const [id, point] = entries[index]
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y), id)
    assert.ok(point.x - labelWidth / 2 >= 0 && point.x + labelWidth / 2 <= width, `${id}: label stays inside horizontal viewport`)
    assert.ok(point.y >= 0 && point.y + 34 <= height, `${id}: label stays inside vertical viewport`)
    for (const [otherId, other] of entries.slice(index + 1)) {
      assert.ok(Math.abs(point.x - other.x) >= labelWidth || Math.abs(point.y - other.y) >= 34, `${width}×${height}: ${id} overlaps ${otherId}`)
    }
  }
}

test('all default group names stay readable on desktop, narrow portrait and short landscape viewports', () => {
  const groups = cloneOrbitGroups()
  for (const [width, height] of [[1440, 900], [1024, 768], [800, 600], [650, 720], [390, 844], [320, 568], [568, 320]]) {
    const anchors = orbitGroupPositions(groups, orbitProjection(width, height, 'accretion', DEFAULT_ORBIT_TUNING))
    const before = structuredClone(anchors)
    const labels = orbitLabelPositions(anchors, width, height)
    assert.deepEqual([...labels.keys()], [...anchors.keys()])
    assertReadableLabels(labels, width, height)
    assert.deepEqual(anchors, before, 'label separation must not move the orbit anchors')
    assert.deepEqual(orbitLabelPositions(anchors, width, height), labels, 'unchanged geometry must keep label assignment stable')
  }
})

test('flattened or offscreen custom anchors still expose every group name in a usable position', () => {
  const ids = cloneOrbitGroups().map(group => group.id)
  for (const [width, height] of [[650, 720], [320, 568], [568, 320]]) for (const point of [{ x: 180, y: 170 }, { x: -500, y: 1200 }]) {
    const anchors = new Map(ids.map(id => [id, Object.freeze({ ...point })]))
    const labels = orbitLabelPositions(anchors, width, height)
    assert.equal(labels.size, ids.length)
    assertReadableLabels(labels, width, height)
  }
})
