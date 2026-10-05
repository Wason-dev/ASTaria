/**
 * Behaviour regressions for the Beta11 motion optimizations.
 *
 * These specs drive the shipped helpers with real inputs instead of scanning the
 * source: `sameCameraSample` decides whether the per-frame camera consumer and the
 * React publish step run at all, so a missed field would silently freeze the scene
 * geometry, and a field that should be ignored would make a 160 Hz display rewrite
 * backdrop-filter attributes on every sample. `glassBlurFilter` keeps a zero-radius
 * blur from creating a backdrop pass.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sameCameraSample } from '../src/spatial/cameraSample.ts'
import { glassBlurFilter } from '../src/home/glassRendering.ts'

/** The shipped initial camera (src/spatial/useSceneCamera.ts INITIAL_CAMERA). */
function camera(patch = {}) {
  return {
    zoom: .7, roll: 18, inclination: 83, centerX: .65, centerY: .51,
    cameraTransition: false, reducedMotion: false, paused: false, simulationTime: 0,
    ...patch,
  }
}

/** A different value of the same kind for every field, so no case can silently no-op. */
const OTHER = {
  zoom: .95, roll: -22, inclination: 61, centerX: .4, centerY: .72,
  cameraTransition: true, reducedMotion: true, paused: true, simulationTime: 12.5,
}

const FIELD_NAMES = Object.keys(camera())
const COMPARED = FIELD_NAMES.filter(name => name !== 'simulationTime')

test('the camera sample compares every field except the simulation clock', () => {
  // Guard the list itself: a new field must be added deliberately, not inherited.
  assert.deepEqual([...FIELD_NAMES].sort(), ['cameraTransition', 'centerX', 'centerY', 'inclination', 'paused', 'reducedMotion', 'roll', 'simulationTime', 'zoom'])
  assert.equal(COMPARED.length, FIELD_NAMES.length - 1, 'exactly one field is exempt')

  const a = camera()
  assert.equal(sameCameraSample(a, camera({ simulationTime: 5 })), true, 'only the clock moved')
  assert.equal(sameCameraSample(a, camera({ simulationTime: 0 })), true, 'an unchanged clock is a match')

  for (const name of COMPARED) {
    const changed = camera({ [name]: OTHER[name] })
    assert.equal(sameCameraSample(a, changed), false, `${name} is compared and must invalidate the sample`)
    assert.equal(sameCameraSample(changed, a), false, `${name} is compared in both directions`)
    assert.equal(sameCameraSample(changed, changed), true, `${name} compared with itself stays equal`)
  }
})

test('an absent previous sample and a partially filled one never match', () => {
  const next = camera()
  assert.equal(sameCameraSample(undefined, next), false, 'no previous sample is not a match')
  assert.equal(sameCameraSample(undefined, camera({ simulationTime: 9 })), false, 'the clock cannot rescue a missing sample')
  // The helper reads required fields off the candidate; a half-built camera cannot be trusted.
  const partial = { ...next }
  delete partial.paused
  assert.equal(sameCameraSample(partial, next), false, 'a missing paused flag cannot match')
  assert.equal(sameCameraSample({ ...next, inclination: undefined }, next), false, 'an undefined angle cannot match')
})

test('transition end, pause and reduced-motion edges each change the sample exactly once', () => {
  // A running transition keeps the rAF loop alive; its end must invalidate the sample.
  const running = camera({ cameraTransition: true, zoom: .9 })
  const ended = camera({ cameraTransition: false, zoom: .9 })
  assert.equal(sameCameraSample(running, ended), false, 'the transition ending is a new sample')
  assert.equal(sameCameraSample(ended, ended), true, 'a settled camera stops re-sampling')
  // Pausing and reduced motion are geometry decisions, not just styling.
  assert.equal(sameCameraSample(camera({ paused: false }), camera({ paused: true })), false, 'pausing re-samples')
  assert.equal(sameCameraSample(camera({ reducedMotion: false }), camera({ reducedMotion: true })), false, 'reduced motion re-samples')
  assert.equal(sameCameraSample(camera({ reducedMotion: true, paused: true }), camera({ reducedMotion: true, paused: true })), true, 'reduced and paused still settles')
  // Floating point paths must stay strict, including an infinite comparison value.
  assert.equal(sameCameraSample(camera({ zoom: .70000000001 }), camera({ zoom: .7 })), false, 'a sub-pixel zoom change re-samples')
  assert.equal(sameCameraSample(camera({ centerX: Infinity }), camera({ centerX: Infinity })), true, 'identical non-finite values compare')
  assert.equal(sameCameraSample(camera({ centerX: Infinity }), camera({ centerX: -Infinity })), false, 'opposite non-finite values differ')
})

test('the blur filter is none at zero radius and keeps the full value above it', () => {
  // Shipped call sites feed backdrop-filter directly (GlassSurface.tsx, workbench.css).
  assert.equal(glassBlurFilter(0), 'none', 'a zero radius creates no backdrop pass')
  assert.equal(glassBlurFilter(6), 'blur(6px)', 'the soft-glass preset keeps its exact radius')
  assert.equal(glassBlurFilter(2), 'blur(2px)', 'the default HOME_GLASS blur keeps its exact radius')
  assert.equal(glassBlurFilter(.5), 'blur(0.5px)', 'positive fractions are not rounded away')
  assert.equal(glassBlurFilter(24), 'blur(24px)', 'large radii stay verbatim')
  assert.equal(glassBlurFilter(-4), 'none', 'a negative radius must not emit blur(-4px)')
  assert.equal(glassBlurFilter(Number.NaN), 'none', 'a non-finite radius must not emit an invalid filter')
  // A zero radius and an absent radius must not collapse into the same string.
  assert.notEqual(glassBlurFilter(0), glassBlurFilter(1))
})
