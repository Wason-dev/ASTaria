import test from 'node:test'
import assert from 'node:assert/strict'
import { AdaptiveQualityController } from '../src/prototype/adaptiveQuality.ts'

const rig = (initial = 'ultra') => {
  const controller = new AdaptiveQualityController()
  let quality = initial
  let time = 0
  const changes = []
  const frame = (elapsed = 1000 / 60, transitioning = false) => {
    time += elapsed
    const next = controller.sample(elapsed, quality, transitioning)
    if (next) {
      quality = next
      changes.push({ quality, time })
    }
  }
  const run = (duration, elapsed = 1000 / 60, transitioning = false) => {
    const until = time + duration
    while (time < until) frame(elapsed, transitioning)
  }
  const untilChange = (elapsed = 1000 / 60, limit = 180_000) => {
    const count = changes.length
    const end = time + limit
    while (changes.length === count && time < end) frame(elapsed)
    assert.equal(changes.length, count + 1, 'expected a quality decision within the observation window')
    return changes.at(-1)
  }
  return { controller, frame, run, untilChange, changes, get quality() { return quality }, get time() { return time } }
}

test('isolated stalls and short UI load do not reduce the quality', () => {
  const scene = rig()
  scene.run(10_000)
  scene.frame(10_000)
  scene.run(2_000)
  scene.run(1_000, 1000 / 30)
  scene.run(10_000)
  assert.equal(scene.quality, 'ultra')
  assert.deepEqual(scene.changes, [])
})

test('camera and day/night transitions are excluded from quality assessment', () => {
  const scene = rig()
  scene.run(5_000)
  scene.run(12_000, 1000 / 20, true)
  scene.run(1_000, 1000 / 30)
  scene.run(10_000)
  assert.equal(scene.quality, 'ultra')
  assert.deepEqual(scene.changes, [])
})

test('sustained slow rendering reduces one tier at a time and can reach safe', () => {
  const scene = rig()
  scene.run(30_000, 1000 / 30)
  assert.deepEqual(scene.changes.map(change => change.quality), ['high', 'low', 'safe'])
  assert.ok(scene.changes[0].time >= 4_500)
  scene.run(30_000, 500)
  assert.equal(scene.quality, 'safe')
})

test('safe can recover through every tier after separate stable observation windows', () => {
  const scene = rig('safe')
  scene.run(70_000)
  assert.deepEqual(scene.changes.map(change => change.quality), ['low', 'high', 'ultra'])
  assert.ok(scene.changes[0].time >= 14_000)
  assert.ok(scene.changes[1].time - scene.changes[0].time >= 20_000)
  assert.ok(scene.changes[2].time - scene.changes[1].time >= 26_000)
})

test('unstable performance does not accumulate disconnected periods into a promotion', () => {
  const scene = rig('safe')
  for (let i = 0; i < 8; i++) {
    scene.run(8_000)
    scene.run(1_000, 1000 / 30)
  }
  assert.deepEqual(scene.changes, [])
  assert.equal(scene.quality, 'safe')
})

test('failed recovery retreats and backs off repeated attempts for one then two minutes', () => {
  const scene = rig('high')
  assert.equal(scene.untilChange().quality, 'ultra')
  const firstFailure = scene.untilChange(1000 / 30)
  assert.equal(firstFailure.quality, 'high')
  scene.controller.resetWindow() // A resize must not erase the failed-probe cooldown.
  scene.run(59_000)
  assert.equal(scene.quality, 'high')
  const firstRetry = scene.untilChange()
  assert.ok(firstRetry.time - firstFailure.time >= 60_000)
  assert.equal(firstRetry.quality, 'ultra')
  const secondFailure = scene.untilChange(1000 / 30)
  assert.equal(secondFailure.quality, 'high')
  scene.run(119_000)
  assert.equal(scene.quality, 'high')
  const secondRetry = scene.untilChange()
  assert.ok(secondRetry.time - secondFailure.time >= 120_000)
  assert.equal(secondRetry.quality, 'ultra')
})

test('a successfully sustained recovery clears the previous failure penalty', () => {
  const scene = rig('high')
  scene.untilChange()
  scene.untilChange(1000 / 30)
  scene.untilChange()
  scene.run(35_000)
  const failure = scene.untilChange(1000 / 30)
  const retry = scene.untilChange()
  assert.ok(retry.time - failure.time >= 60_000)
  assert.ok(retry.time - failure.time < 61_000)
})

test('invalid timing is ignored and an explicit policy reset clears prior backoff', () => {
  const scene = rig('high')
  scene.untilChange()
  scene.untilChange(1000 / 30)
  for (const value of [0, -10, NaN, Infinity]) assert.equal(scene.controller.sample(value, 'high'), null)
  scene.controller.reset()
  const resetAt = scene.time
  const retry = scene.untilChange()
  assert.equal(retry.quality, 'ultra')
  assert.ok(retry.time - resetAt < 27_000)
})

test('automatic quality treats a stable 30/45/60 FPS budget as intentional pacing', () => {
  for (const target of [30, 45, 60]) {
    const controller = new AdaptiveQualityController()
    for (let i = 0; i < target * 30; i++) assert.equal(controller.sample(1000 / target, 'ultra', false, target), null)
  }
})
