/** Run with Node 24+: node --test scripts/spatial-scene.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createScene, readableDate, sceneProjection, STATUS_LABELS } from '../src/spatial/scene.ts'

const camera = {
  zoom: .70, inclination: 83, roll: 18, centerX: .65, centerY: .51,
  cameraTransition: false, reducedMotion: false, paused: false, simulationTime: 12,
}

function task(id, status = 'todo', extra = {}) {
  return {
    id, title: `Task ${id}`, status, area: null, source: 'manual', inbox: false,
    leadDays: 0, importance: 2, energy: 'light', context: ['anywhere'],
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
    deletedAt: null, ...extra,
  }
}

function close(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-7, `expected ${expected}, got ${actual}`)
}

test('active nodes exclude deleted, completed and dropped tasks while keeping readable statuses', () => {
  const scene = createScene([
    task('todo'), task('doing', 'doing'), task('done', 'done'), task('dropped', 'dropped'),
    task('deleted', 'todo', { deletedAt: '2026-09-16T01:00:00Z' }),
    task('deleted-done', 'done', { deletedAt: '2026-09-16T01:00:00Z' }),
  ], camera, 'work', null)

  assert.deepEqual(scene.nodes.map(node => node.id), ['todo', 'doing'])
  assert.equal(scene.activeCount, 2)
  assert.equal(scene.completedCount, 1)
  assert.ok(scene.nodes[0].radius > scene.nodes[1].radius, 'starting a task moves it to the inner orbit')
  assert.deepEqual(scene.nodes.map(node => STATUS_LABELS[node.status]), ['待开始', '进行中'])
  assert.equal(STATUS_LABELS.done, '已完成')
  assert.equal(STATUS_LABELS.dropped, '已搁置')
})

test('node order is stable across input order, and scene construction does not mutate tasks', () => {
  const tasks = [task('c'), task('b'), task('a', 'todo', { createdAt: '2026-09-15T00:00:00.000Z' })]
  const before = structuredClone(tasks)
  tasks.forEach(Object.freeze)
  Object.freeze(tasks)

  const scene = createScene(tasks, camera, 'analysis', 'c')
  assert.deepEqual(scene.nodes.map(node => node.id), ['a', 'b', 'c'])
  assert.deepEqual(scene.nodes, createScene([...tasks].reverse(), camera, 'analysis', 'c').nodes)
  assert.deepEqual(tasks, before)
})

test('each orbit has at most six nodes, retains an overflow selection, and counts every active task', () => {
  const tasks = ['todo', 'doing'].flatMap(status =>
    Array.from({ length: 9 }, (_, index) => task(`${status}-${index}`, status)))

  for (const selectedId of ['todo-8', 'doing-8']) {
    const scene = createScene(tasks, camera, 'work', selectedId)
    assert.equal(scene.activeCount, 18)
    assert.equal(scene.nodes.filter(node => node.status === 'todo').length, 6)
    assert.equal(scene.nodes.filter(node => node.status === 'doing').length, 6)
    assert.equal(new Set(scene.nodes.map(node => node.id)).size, 12)
    assert.equal(scene.nodes.filter(node => node.id === selectedId).length, 1)
    assert.equal(scene.selectedId, selectedId)
  }
})

test('frozen camera presets project to the expected desktop and mobile CSS centers and scales', () => {
  const interstellar = { ...camera, zoom: 2.05, inclination: 84, roll: 7, centerX: .98 }
  // Expected values use the frozen P0 viewport contract, in CSS pixels.
  const fixtures = [
    [camera, 1440, 900, 936, 441, 61.76470588235294],
    [camera, 390, 844, 206.7, 371.36, 42.81159420289855],
    [interstellar, 1440, 900, 1411.2, 441, 180.88235294117646],
    [interstellar, 390, 844, 232.44, 371.36, 125.37681159420289],
  ]
  for (const [preset, width, height, cx, cy, unit] of fixtures) {
    const projection = sceneProjection(preset, width, height)
    close(projection.cx, cx)
    close(projection.cy, cy)
    close(projection.unit, unit)
    assert.deepEqual(projection.point(0, 0), { x: projection.cx, y: projection.cy })
    // A world angle opposite the camera roll lands directly right of the center.
    const point = projection.point(1, -preset.roll * Math.PI / 180)
    close(point.x, cx + unit)
    close(point.y, cy)
  }
})

test('positive roll turns upward on screen and zoom scales distance from the center', () => {
  for (const [width, height] of [[1440, 900], [390, 844]]) {
    const base = sceneProjection({ ...camera, roll: 0 }, width, height)
    const rotated = sceneProjection({ ...camera, roll: 90, zoom: camera.zoom * 2 }, width, height)
    const point = rotated.point(1, 0)
    close(point.x, base.cx)
    close(point.y, base.cy - 2 * base.unit)
  }
})

test('projection uses CSS viewport dimensions independently of device pixel ratio', () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  const previousDpr = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio')
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const results = [1, 2, 3].map(devicePixelRatio => {
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { devicePixelRatio } })
        Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value: devicePixelRatio })
        const projection = sceneProjection(camera, width, height)
        return { cx: projection.cx, cy: projection.cy, unit: projection.unit, point: projection.point(4.6, 1) }
      })
      assert.deepEqual(results[1], results[0])
      assert.deepEqual(results[2], results[0])
    }
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else delete globalThis.window
    if (previousDpr) Object.defineProperty(globalThis, 'devicePixelRatio', previousDpr)
    else delete globalThis.devicePixelRatio
  }
})

test('readable dates handle missing and invalid persisted values without throwing', () => {
  assert.equal(readableDate(), '未设截止时间')
  assert.equal(readableDate(''), '未设截止时间')
  for (const value of ['invalid-date', '2026-99-99', '2026-09-16T25:00:00Z']) {
    assert.equal(readableDate(value), '截止时间待确认')
  }
  assert.ok(readableDate('2026-09-16T12:00:00Z').length > 0)
})
