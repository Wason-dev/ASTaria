import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { transformSync } from 'rolldown/utils'

const sourceRoot = new URL('../src/', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
      for (const extension of ['.ts', '.tsx']) {
        if (existsSync(fileURLToPath(new URL(`${specifier}${extension}`, context.parentURL)))) return next(`${specifier}${extension}`, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    if (url.startsWith(sourceRoot) && /\.tsx?$/.test(url)) return {
      format: 'module', shortCircuit: true,
      source: transformSync(fileURLToPath(url), readFileSync(new URL(url), 'utf8'), { jsx: { runtime: 'automatic' } }).code,
    }
    return next(url, context)
  },
})
const { nearestOrbitAnchor, stableOrbitDropTarget } = await import('../src/xixi/OrbitStudio.tsx')
const { orbitGroupPositions, orbitProjection, orbitPoint, ORBIT_LOOKS } = await import('../src/xixi/orbitScene.ts')
const { cloneOrbitGroups } = await import('../src/xixi/orbitGroups.ts')
const { DEFAULT_ORBIT_TUNING } = await import('../src/xixi/orbitTuning.ts')
hook.deregister()

test('overlapping hitboxes select the nearer light regardless of DOM stacking order', () => {
  const anchors = [['underneath', { x: 100, y: 100 }], ['on-top', { x: 125, y: 100 }]]
  const pointer = { x: 102, y: 100 }
  assert.equal(nearestOrbitAnchor(pointer, anchors, 'on-top'), 'underneath')
  assert.equal(nearestOrbitAnchor(pointer, [...anchors].reverse(), 'on-top'), 'underneath')
  assert.equal(nearestOrbitAnchor({ x: 123, y: 100 }, anchors, 'underneath'), 'on-top')
})

test('pointer distance is measured from the live animated anchor and respects the hit radius', () => {
  const anchors = [['moving', { x: 100, y: 100 }]]
  assert.equal(nearestOrbitAnchor({ x: 140, y: 124 }, anchors, 'moving'), 'moving')
  assert.equal(nearestOrbitAnchor({ x: 149, y: 100 }, anchors, 'moving'), null)
  assert.equal(nearestOrbitAnchor({ x: 100, y: 100 }, [], 'moving'), null)
  assert.equal(nearestOrbitAnchor({ x: 100, y: 100 }, [['moving', { x: NaN, y: 100 }]], 'moving'), null)
})

test('equidistant lights retain the directly targeted button deterministically', () => {
  const anchors = [['first', { x: 100, y: 100 }], ['second', { x: 120, y: 100 }]]
  const pointer = { x: 110, y: 100 }
  for (const order of [anchors, [...anchors].reverse()]) {
    assert.equal(nearestOrbitAnchor(pointer, order, 'first'), 'first')
    assert.equal(nearestOrbitAnchor(pointer, order, 'second'), 'second')
  }
})

test('every visible group remains directly selectable in all looks on narrow and short viewports', () => {
  const groups = cloneOrbitGroups()
  for (const [width, height] of [[320, 568], [390, 844], [568, 320], [1440, 900]]) {
    for (const { id: look } of ORBIT_LOOKS) {
      const anchors = orbitGroupPositions(groups, orbitProjection(width, height, look))
      for (const [id, anchor] of anchors) {
        // Any overlapping DOM button may receive pointerdown, but the actual light wins.
        for (const fallback of groups) {
          assert.equal(nearestOrbitAnchor(anchor, anchors, fallback.id), id, `${look} ${width}×${height}, ${id}`)
        }
      }
    }
  }
})

test('day boundaries resist pointer jitter but intentional crossing switches immediately', () => {
  const geometry = { cx: 0, cy: 0, rx: 500, ry: 500, tilt: 0, start: -1, end: 1 }
  const groups = cloneOrbitGroups(), id = groups[0].id
  const current = { day: 0, index: 0 }
  assert.equal(stableOrbitDropTarget({ x: 332, y: 0 }, geometry, groups, id, current).day, 0)
  const crossed = stableOrbitDropTarget({ x: 338, y: 0 }, geometry, groups, id, current)
  assert.equal(crossed.day, 1)
  assert.equal(stableOrbitDropTarget({ x: 328, y: 0 }, geometry, groups, id, crossed).day, 1)
  assert.equal(stableOrbitDropTarget({ x: 320, y: 0 }, geometry, groups, id, crossed).day, 0)
})

test('a very short custom arc still allows changing order instead of swallowing motion in the dead band', () => {
  const groups = cloneOrbitGroups(), id = groups[0].id
  for (const arcDegrees of [1, 5, 30]) for (const width of [320, 1440]) {
    const geometry = orbitProjection(width, 720, 'accretion', { ...DEFAULT_ORBIT_TUNING, arcDegrees })
    const target = stableOrbitDropTarget(orbitPoint(geometry, 0, .96), geometry, groups, id, { day: 0, index: 0 })
    assert.deepEqual(target, { day: 0, index: 2 })
  }
})

test('same-day insertion remains stable around a neighbor and advances with continued motion', () => {
  const geometry = { cx: 0, cy: 0, rx: 500, ry: 500, tilt: 0, start: -1, end: 1 }
  const groups = cloneOrbitGroups(), id = groups[0].id, first = { day: 0, index: 0 }
  assert.deepEqual(stableOrbitDropTarget(orbitPoint(geometry, 0, .52), geometry, groups, id, first), first)
  const next = stableOrbitDropTarget(orbitPoint(geometry, 0, .54), geometry, groups, id, first)
  assert.deepEqual(next, { day: 0, index: 1 })
  assert.deepEqual(stableOrbitDropTarget(orbitPoint(geometry, 0, .50), geometry, groups, id, next), next)
  assert.deepEqual(stableOrbitDropTarget(orbitPoint(geometry, 0, .47), geometry, groups, id, next), first)
})

test('preview never changes committed order and deliberate arc targets remain reachable', () => {
  const groups = cloneOrbitGroups(), original = structuredClone(groups), id = groups[0].id
  for (const [width, height] of [[320, 568], [1440, 900]]) for (const { id: look } of ORBIT_LOOKS) {
    const geometry = orbitProjection(width, height, look)
    let current = { day: 0, index: 0 }
    for (const day of [2, 0, 1, 2]) {
      current = stableOrbitDropTarget(orbitPoint(geometry, day, .6), geometry, groups, id, current)
      assert.equal(current.day, day, `${look} ${width}×${height}`)
    }
  }
  assert.deepEqual(groups, original)
})
