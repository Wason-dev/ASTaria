import assert from 'node:assert/strict'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import test from 'node:test'
import { cloneOrbitGroups, moveOrbitGroup, orbitDayGroups } from '../src/xixi/orbitGroups.ts'
import { DEFAULT_ORBIT_TUNING } from '../src/xixi/orbitTuning.ts'

// Transform the renderer's constructor parameter properties without creating a DOM.
const sceneUrl = new URL('../src/xixi/orbitScene.ts', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL === sceneUrl && ['./orbitGroups', './orbitMotion'].includes(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    return url === sceneUrl
      ? { ...result, format: 'module', source: stripTypeScriptTypes(String(result.source), { mode: 'transform' }) }
      : result
  },
})
const { ORBIT_LOOKS, orbitProjection, orbitPoint, orbitBasis, orbitGroupPositions, orbitDropTarget } = await import(sceneUrl)
hook.deregister()

const viewports = [
  [320, 568], [390, 844], [568, 320], [649, 720], [650, 720],
  [768, 1024], [1024, 768], [1440, 900], [2560, 1080],
]
const days = [0, 1, 2]
const ids = groups => groups.map(group => group.id)
const fixtureVariants = () => {
  const groups = cloneOrbitGroups()
  return [groups, groups.map(group => ({ ...group, day: 1 })), groups.filter(group => group.day !== 1)]
}
const description = (look, width, height) => `${look} at ${width}×${height}`

for (const { id: look } of ORBIT_LOOKS) {
  test(`${look}: all group anchors stay finite, on screen, and in the day's order across viewport shapes`, () => {
    for (const [width, height] of viewports) for (const groups of fixtureVariants()) {
      const label = description(look, width, height)
      const projection = orbitProjection(width, height, look)
      const positions = orbitGroupPositions(groups, projection)
      assert.equal(positions.size, groups.length, label)
      for (const group of groups) {
        const position = positions.get(group.id)
        assert.ok([position.x, position.y, position.t, position.angle].every(Number.isFinite), `${label}: ${group.id}`)
        assert.ok(position.x >= 0 && position.x <= width, `${label}: x=${position.x}`)
        assert.ok(position.y >= 0 && position.y <= height, `${label}: y=${position.y}`)
        assert.equal(position.day, group.day, label)
        assert.equal(position.index, orbitDayGroups(groups, group.day).findIndex(item => item.id === group.id), label)
      }
      for (const day of days) {
        const values = orbitDayGroups(groups, day).map(group => positions.get(group.id).t)
        assert.ok(values.every((t, index) => t > 0 && t < 1 && (index === 0 || t > values[index - 1])), label)
      }
    }
  })

  test(`${look}: dropping a group on its own anchor preserves its day and order`, () => {
    for (const [width, height] of viewports) for (const groups of fixtureVariants()) {
      const label = description(look, width, height)
      const projection = orbitProjection(width, height, look)
      const positions = orbitGroupPositions(groups, projection)
      for (const group of groups) {
        const anchor = positions.get(group.id)
        const target = orbitDropTarget(anchor, projection, groups, group.id)
        assert.equal(target.day, group.day, `${label}: ${group.id}`)
        assert.equal(target.index, anchor.index, `${label}: ${group.id}`)
        assert.deepEqual(moveOrbitGroup(groups, group.id, target.day, target.index), groups, label)
      }
    }
  })

  test(`${look}: every between-group slot maps to the correct day and insertion position`, () => {
    for (const [width, height] of viewports) {
      const label = description(look, width, height)
      const groups = cloneOrbitGroups()
      const projection = orbitProjection(width, height, look)
      const positions = orbitGroupPositions(groups, projection)
      for (const group of groups) for (const day of days) {
        const remaining = orbitDayGroups(groups, day).filter(item => item.id !== group.id)
        const stops = [.1, ...remaining.map(item => positions.get(item.id).t), .9]
        for (let index = 0; index <= remaining.length; index++) {
          const point = orbitPoint(projection, day, (stops[index] + stops[index + 1]) / 2)
          const target = orbitDropTarget(point, projection, groups, group.id)
          assert.equal(target.day, day, `${label}: move ${group.id} into day ${day}, slot ${index}`)
          assert.equal(target.index, index, label)
          const moved = moveOrbitGroup(groups, group.id, target.day, target.index)
          const expected = ids(remaining)
          expected.splice(index, 0, group.id)
          assert.deepEqual(ids(orbitDayGroups(moved, day)), expected, label)
          assert.equal(moved.length, groups.length, label)
        }
      }
    }
  })

  test(`${look}: an empty day remains a valid drop target along its full arc`, () => {
    for (const [width, height] of viewports) {
      const label = description(look, width, height)
      const projection = orbitProjection(width, height, look)
      for (const day of days) {
        const groups = cloneOrbitGroups().filter(group => group.day !== day)
        const chosen = groups[0]
        for (const t of [.01, .1, .25, .5, .75, .9, .99]) {
          const target = orbitDropTarget(orbitPoint(projection, day, t), projection, groups, chosen.id)
          assert.equal(target.day, day, `${label}: empty day ${day} at ${t}`)
          assert.equal(target.index, 0, label)
          const moved = moveOrbitGroup(groups, chosen.id, target.day, target.index)
          assert.deepEqual(ids(orbitDayGroups(moved, day)), [chosen.id], label)
          assert.equal(moved.find(group => group.id === chosen.id).tasks, chosen.tasks, label)
        }
      }
    }
  })
}

test('changing visual projection preserves the complete group model and relative order', () => {
  const groups = moveOrbitGroup(cloneOrbitGroups(), 'orbit-today-review', 2, 1)
  const before = structuredClone(groups)
  for (const { id: look } of ORBIT_LOOKS) {
    const positions = orbitGroupPositions(groups, orbitProjection(1024, 768, look))
    for (const day of days) {
      const visualOrder = [...positions].filter(([, point]) => point.day === day).sort(([, a], [, b]) => a.t - b.t).map(([id]) => id)
      assert.deepEqual(visualOrder, ids(orbitDayGroups(groups, day)))
    }
  }
  assert.deepEqual(groups, before)
})

test('configured disk uses one genuinely rotated basis for positions, radial offsets and tangents', () => {
  const tuning = { ...DEFAULT_ORBIT_TUNING, arcDegrees: 237, rotationDegrees: 81, tiltDegrees: 67, flatten: .21 }
  const projection = orbitProjection(1440, 900, 'accretion', tuning)
  const unrotated = orbitProjection(1440, 900, 'accretion', { ...tuning, tiltDegrees: 0 })
  assert.equal(projection.cx, 1440 * tuning.centerX)
  assert.equal(projection.cy, 900 * tuning.centerY)
  assert.equal(projection.rx, Math.min(1440 * .46, 900 * .9) * tuning.scale)
  assert.equal(projection.ry, projection.rx * tuning.flatten)
  const radians = tuning.tiltDegrees * Math.PI / 180, close = (a, b) => assert.ok(Math.abs(a - b) < .0001, `${a} ≈ ${b}`)
  for (const day of days) for (const t of [0, .173, .5, .863, 1]) {
    const p = orbitPoint(projection, day, t), old = orbitPoint(unrotated, day, t), basis = orbitBasis(projection, t)
    const x = old.x - unrotated.cx, y = old.y - unrotated.cy
    close(p.x - projection.cx, x * Math.cos(radians) - y * Math.sin(radians))
    close(p.y - projection.cy, x * Math.sin(radians) + y * Math.cos(radians))
    const offset = orbitPoint(projection, day, t, .01)
    close(offset.x - p.x, basis.radialX * .01); close(offset.y - p.y, basis.radialY * .01)
    const epsilon = .00001, before = orbitPoint(projection, day, t - epsilon), after = orbitPoint(projection, day, t + epsilon)
    const radius = 1 - (2 - day) * tuning.gap, span = projection.end - projection.start
    close((after.x - before.x) / (2 * epsilon), basis.tangentX * radius * span)
    close((after.y - before.y) / (2 * epsilon), basis.tangentY * radius * span)
  }
})

test('extreme adjustable arcs preserve exact group selection and insertion ordering', () => {
  const groups = cloneOrbitGroups()
  const presets = [
    { arcDegrees: 1, rotationDegrees: -180, tiltDegrees: -70, flatten: .12, scale: .45, gap: .12, centerX: -.25, centerY: 0 },
    { arcDegrees: 1, rotationDegrees: 173, tiltDegrees: 70, flatten: 1, scale: 1.65, gap: .32, centerX: 1.25, centerY: 1 },
    { arcDegrees: 30, rotationDegrees: -180, tiltDegrees: -70, flatten: .12, scale: .45, gap: .12, centerX: -.25, centerY: 0 },
    { arcDegrees: 30, rotationDegrees: 180, tiltDegrees: 70, flatten: 1, scale: 1.65, gap: .32, centerX: 1.25, centerY: 1 },
    { arcDegrees: 168, rotationDegrees: 92, tiltDegrees: 61, flatten: .12, gap: .32 },
    { arcDegrees: 320, rotationDegrees: -117, tiltDegrees: -42, flatten: .28, gap: .12 },
    { arcDegrees: 359, rotationDegrees: 179, tiltDegrees: 70, flatten: .12, gap: .12 },
    { arcDegrees: 360, rotationDegrees: 0, tiltDegrees: -12, flatten: .42, gap: .22 },
    { arcDegrees: 360, rotationDegrees: -180, tiltDegrees: -70, flatten: .12, gap: .32 },
  ]
  for (const [width, height] of [[320, 568], [1440, 900], [2560, 1080]]) for (const patch of presets) {
    const tuning = { ...DEFAULT_ORBIT_TUNING, ...patch }, projection = orbitProjection(width, height, 'accretion', tuning)
    const positions = orbitGroupPositions(groups, projection), label = `${width}×${height}, ${JSON.stringify(patch)}`
    assert.ok(Object.values(projection).every(Number.isFinite), label)
    for (const group of groups) {
      const anchor = positions.get(group.id), target = orbitDropTarget(anchor, projection, groups, group.id)
      assert.equal(target.day, group.day, label)
      assert.equal(target.index, anchor.index, label)
      assert.ok(target.distance < .0001, label)
    }
    const chosen = groups[0]
    for (const day of days) {
      const remaining = orbitDayGroups(groups, day).filter(group => group.id !== chosen.id)
      const stops = [0, ...remaining.map(group => positions.get(group.id).t), 1]
      for (let index = 0; index < stops.length - 1; index++) {
        const at = (stops[index] + stops[index + 1]) / 2
        const target = orbitDropTarget(orbitPoint(projection, day, at), projection, groups, chosen.id)
        assert.equal(target.day, day, label); assert.equal(target.index, index, label)
      }
    }
  }
})

test('a full disk closes position and tangent seams while retaining the two adjacent insertion edges', () => {
  const groups = cloneOrbitGroups(), id = groups[0].id
  for (const rotationDegrees of [-180, -72, 0, 179]) {
    const projection = orbitProjection(1440, 900, 'accretion', { ...DEFAULT_ORBIT_TUNING, arcDegrees: 360, rotationDegrees, tiltDegrees: 53 })
    for (const day of days) {
      const start = orbitPoint(projection, day, 0), end = orbitPoint(projection, day, 1)
      assert.ok(Math.hypot(start.x - end.x, start.y - end.y) < 1e-8)
      const a = orbitBasis(projection, 0), b = orbitBasis(projection, 1)
      for (const key of Object.keys(a)) assert.ok(Math.abs(a[key] - b[key]) < 1e-8)
      for (const t of [0, 1]) assert.equal(orbitDropTarget(orbitPoint(projection, day, t), projection, groups, id).index, 0)
      const head = orbitDropTarget(orbitPoint(projection, day, .0001), projection, groups, id)
      const tail = orbitDropTarget(orbitPoint(projection, day, .9999), projection, groups, id)
      assert.equal(head.day, day); assert.equal(tail.day, day)
      assert.equal(head.index, 0)
      assert.equal(tail.index, orbitDayGroups(groups, day).filter(group => group.id !== id).length)
    }
  }
})

test('opening the first tiny gap in a full disk does not abruptly reposition all group anchors', () => {
  const groups = cloneOrbitGroups(), closed = orbitGroupPositions(groups, orbitProjection(1440, 900, 'accretion', { ...DEFAULT_ORBIT_TUNING, arcDegrees: 360 }))
  const opened = orbitGroupPositions(groups, orbitProjection(1440, 900, 'accretion', { ...DEFAULT_ORBIT_TUNING, arcDegrees: 359.99 }))
  for (const [id, point] of closed) assert.ok(Math.hypot(point.x - opened.get(id).x, point.y - opened.get(id).y) < .25, id)
})
