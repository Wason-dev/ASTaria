import assert from 'node:assert/strict'
import test from 'node:test'
import { orbitTransitionDuration, orbitTransitionFrame } from '../src/xixi/orbitTransition.ts'

const near = (a, b, epsilon = 1e-9) => assert.ok(Math.abs(a - b) <= epsilon, `${a} ≈ ${b}`)

test('entry and exit have exact transparent/covered endpoints', () => {
  assert.deepEqual(orbitTransitionFrame(0, 0, false), { flight: 0, reveal: 0, darkness: 0, revealDestination: false })
  assert.deepEqual(orbitTransitionFrame(1, 0, false), { flight: 1, reveal: 1, darkness: 1, revealDestination: false })
  assert.deepEqual(orbitTransitionFrame(0, 1, true), { flight: 1, reveal: 1, darkness: 1, revealDestination: false })
  assert.deepEqual(orbitTransitionFrame(1, 1, true), { flight: 0, reveal: 0, darkness: 0, revealDestination: true })
})

test('canceling at any point of entry preserves its visible frame before reversing', () => {
  for (const reduced of [false, true]) for (let step = 0; step <= 100; step++) {
    const entry = orbitTransitionFrame(step / 100, 0, false, reduced)
    const exit = orbitTransitionFrame(0, entry.flight, true, reduced)
    for (const key of ['flight', 'reveal', 'darkness']) near(exit[key], entry[key])
    assert.deepEqual(orbitTransitionFrame(1, entry.flight, true, reduced), {
      flight: 0, reveal: 0, darkness: 0, revealDestination: true,
    })
    if (entry.darkness < .95) assert.equal(exit.revealDestination, true)
  }
})

test('camera and fades progress monotonically without overshoot or destination re-hiding', () => {
  for (const reduced of [false, true]) for (const exit of [false, true]) for (const from of [0, .25, .53, .76, 1]) {
    let previous = orbitTransitionFrame(0, from, exit, reduced)
    for (let step = 1; step <= 300; step++) {
      const frame = orbitTransitionFrame(step / 300, from, exit, reduced)
      for (const key of ['flight', 'reveal', 'darkness']) {
        assert.ok(Number.isFinite(frame[key]) && frame[key] >= 0 && frame[key] <= 1)
        assert.ok(exit ? frame[key] <= previous[key] + 1e-12 : frame[key] >= previous[key] - 1e-12)
      }
      if (previous.revealDestination) assert.equal(frame.revealDestination, true)
      previous = frame
    }
  }
})

test('workspace starts its arrival under full cover and finishes before the veil opens', () => {
  const duration = orbitTransitionDuration(true, false)
  let revealAt = 0
  while (!orbitTransitionFrame(revealAt, 1, true).revealDestination) revealAt += .001
  assert.ok(revealAt * duration < 350)
  near(orbitTransitionFrame(revealAt, 1, true).darkness, 1)
  near(orbitTransitionFrame(revealAt + 480 / duration, 1, true).darkness, 1, .000001)
  assert.ok(orbitTransitionFrame(revealAt, 1, true).reveal > .98)
  assert.ok(orbitTransitionFrame(.70, 1, true).darkness < .5)
  near(orbitTransitionFrame(.96, 1, true).darkness, 0)
})

test('exit retains the orbit briefly, then gives it a long fade with gentle camera endpoints', () => {
  const duration = orbitTransitionDuration(true, false)
  const firstFrame = orbitTransitionFrame(16 / duration, 1, true)
  near(firstFrame.reveal, 1)
  assert.ok(1 - firstFrame.flight < .00001)
  assert.ok(orbitTransitionFrame(400 / duration, 1, true).reveal > .94)
  assert.ok(orbitTransitionFrame(1000 / duration, 1, true).reveal > .2)
  const nearEnd = orbitTransitionFrame(1 - 16 / duration, 1, true)
  assert.ok(nearEnd.flight < .00001)
  assert.equal(nearEnd.reveal, 0)
  assert.equal(nearEnd.darkness, 0)
})

test('duration can be tuned while reduced motion stays short and reveals the workspace immediately', () => {
  assert.equal(orbitTransitionDuration(true, false), 2400)
  assert.equal(orbitTransitionDuration(true, false, 3.6), 3600)
  assert.equal(orbitTransitionDuration(false, false, 3.6), 5600)
  for (const seconds of [.2, 2.4, 10]) for (const exit of [false, true]) {
    assert.equal(orbitTransitionDuration(exit, true, seconds), 180)
  }
  assert.equal(orbitTransitionFrame(0, 1, true, true).revealDestination, true)
  const half = orbitTransitionFrame(.5, 1, true, true)
  near(half.reveal, .5); near(half.darkness, .5)
})

test('invalid or out-of-range parameters stay finite and within safe bounds', () => {
  for (const progress of [NaN, Infinity, -2, 2]) for (const from of [NaN, Infinity, -2, 2]) {
    const frame = orbitTransitionFrame(progress, from, true)
    assert.ok(['flight', 'reveal', 'darkness'].every(key => Number.isFinite(frame[key]) && frame[key] >= 0 && frame[key] <= 1))
  }
  for (const seconds of [NaN, Infinity, -1, 0]) assert.equal(orbitTransitionDuration(true, false, seconds), 2400)
  assert.equal(orbitTransitionDuration(true, false, .01), 200)
  assert.equal(orbitTransitionDuration(true, false, 100), 10000)
})
