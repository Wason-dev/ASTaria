import assert from 'node:assert/strict'
import test from 'node:test'
import { orbitWave, springStep } from '../src/xixi/orbitMotion.ts'

const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) < epsilon, `${a} ≈ ${b}`)
const withoutAmbient = (day, t, time, pulses = [], pointer = null) =>
  orbitWave(day, t, time, pulses, pointer) - orbitWave(day, t, time, [], null)

test('analytic spring agrees across frame partitions in all damping regimes', () => {
  for (const damping of [.35, .86, 1, 1.6]) {
    const initial = Object.freeze({ value: -75, velocity: 270 })
    const whole = springStep(initial, 132, .08, 12, damping)
    let divided = initial
    for (const dt of [.012, .008, .025, .015, .02]) divided = springStep(divided, 132, dt, 12, damping)
    near(whole.value, divided.value)
    near(whole.velocity, divided.velocity)
    assert.deepEqual(initial, { value: -75, velocity: 270 })
  }
})

test('default spring converges quickly with a subtle bounded overshoot', () => {
  let state = { value: 0, velocity: 0 }
  let max = 0
  for (let frame = 0; frame < 120; frame++) {
    state = springStep(state, 100, 1 / 60)
    max = Math.max(max, state.value)
  }
  assert.ok(max <= 100.6)
  near(state.value, 100, .0001)
  near(state.velocity, 0, .0001)
})

test('retargeting preserves momentum rather than resetting an in-flight group', () => {
  const moving = springStep({ value: 0, velocity: 0 }, 100, .08)
  const retargeted = springStep(moving, -100, .001)
  assert.ok(moving.velocity > 0)
  assert.ok(retargeted.velocity > 0)
  assert.ok(retargeted.value > moving.value)
  assert.ok(Math.abs(retargeted.velocity - moving.velocity) < 50)
})

test('spring clamps stalled frames, handles invalid input and does not mutate state', () => {
  const state = Object.freeze({ value: 12, velocity: 30 })
  assert.deepEqual(springStep(state, 40, 10), springStep(state, 40, .1))
  for (const dt of [0, -1, NaN, Infinity]) assert.deepEqual(springStep(state, 40, dt), state)
  for (const damping of [NaN, Infinity, -4, 0, .999999, 1.000001, 50]) {
    const result = springStep({ value: NaN, velocity: Infinity }, NaN, .05, Infinity, damping)
    assert.ok(Object.values(result).every(Number.isFinite))
  }
  assert.deepEqual(springStep(state, 100, .1, 0), { value: 15, velocity: 30 })
})

test('ambient waves stay gentle and multiple overlapping impulses remain bounded', () => {
  const pulses = Object.freeze(Array.from({ length: 20 }, (_, i) => Object.freeze({ day: i % 3, t: .4, started: 0, strength: 1 })))
  const before = structuredClone(pulses)
  for (let day = 0; day <= 2; day += .2) for (let t = 0; t <= 1; t += .025) for (const time of [0, .2, .75, 1.2, 4, 15]) {
    assert.ok(Math.abs(orbitWave(day, t, time, [], null)) <= .8)
    const value = orbitWave(day, t, time, pulses, { day: 1.1, t: .4, strength: 1 })
    assert.ok(Number.isFinite(value) && Math.abs(value) <= 5)
  }
  assert.deepEqual(pulses, before)
})

test('pointer attraction is local along the arc and continuous between days', () => {
  const pointer = Object.freeze({ day: 1, t: .5, strength: 1 })
  const center = withoutAmbient(1, .5, 0, [], pointer)
  const far = withoutAmbient(1, .98, 0, [], pointer)
  assert.ok(center > 2 && center < 4)
  assert.ok(Math.abs(far) < .02)
  assert.ok(withoutAmbient(1.5, .5, 0, [], pointer) < center)
  near(orbitWave(1 - 1e-7, .5, 0, [], pointer), orbitWave(1 + 1e-7, .5, 0, [], pointer), 1e-5)
  assert.equal(orbitWave(1, .5, 0, [], { ...pointer, strength: 0 }), orbitWave(1, .5, 0, [], null))
})

test('pulse travels at .30 arc units per second and leaves the source behind', () => {
  const pulse = Object.freeze([{ day: 0, t: .2, started: 0, strength: 1 }])
  for (const age of [.4, .8, 1.2]) {
    const front = .2 + .30 * age
    const peak = withoutAmbient(0, front, age, pulse)
    const ahead = Math.abs(withoutAmbient(0, front + .16, age, pulse))
    assert.ok(peak > .2)
    assert.ok(peak > ahead * 10)
  }
  assert.ok(Math.abs(withoutAmbient(0, .2, 1.2, pulse)) < .001)
  assert.equal(withoutAmbient(0, .2, 0, pulse), 0)
  assert.equal(withoutAmbient(0, .2, -1, pulse), 0)
})

test('pulse decays smoothly, reduced motion is still, invalid samples are safe', () => {
  const pulses = [{ day: 0, t: .1, started: 0, strength: 1 }]
  const early = withoutAmbient(0, .1 + .30 * .5, .5, pulses)
  const later = withoutAmbient(0, .1 + .30 * 2, 2, pulses)
  assert.ok(later < early * .6)
  assert.ok(Math.abs(withoutAmbient(0, .5, 20, pulses)) < .000001)
  assert.equal(orbitWave(0, .5, 1, pulses, { day: 0, t: .5, strength: 1 }, true), 0)
  for (const [day, t, time] of [[NaN, .5, 0], [0, Infinity, 0], [0, .5, NaN]]) {
    assert.equal(orbitWave(day, t, time, pulses, null), 0)
  }
  assert.equal(orbitWave(0, .5, 0, [{ day: 0, t: NaN, started: 0, strength: 1 }], { day: NaN, t: .5, strength: 1 }), orbitWave(0, .5, 0, [], null))
})
