import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_RESPONSE_EFFECT, ResponseEffectController, normalizeResponseEffect } from '../src/prototype/responseEffects.ts'

function run(effect, seconds, systemReduced = false, paused = false, fps = 60) {
  for (let i = 0; i < Math.ceil(seconds * fps); i++) effect.advance(1 / fps, systemReduced, paused)
  return effect.getSnapshot(systemReduced)
}

test('idle is exactly the baseline and off removes even existing afterglow', () => {
  const effect = new ResponseEffectController()
  assert.equal(run(effect, 20).strength, 0)
  assert.equal(effect.needsFrame(false), false)
  effect.setPhase('thinking')
  assert.ok(run(effect, 2).strength > 0.4)
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, style: 'off' })
  assert.equal(effect.getSnapshot().strength, 0)
  assert.equal(effect.getSnapshot().time, 0)
  assert.equal(effect.needsFrame(false), false)
})

test('thinking settles at a bounded intensity during long waits', () => {
  const effect = new ResponseEffectController()
  effect.setPhase('thinking')
  const settled = run(effect, 10)
  const late = run(effect, 3_600)
  assert.equal(settled.strength, 0.42)
  assert.equal(late.strength, settled.strength)
  assert.equal(late.reply, 0)
  assert.ok(Math.abs(late.time - 3_610) < 0.001)
})

test('reply changes continuously, repeated updates never restart the response clock', () => {
  const effect = new ResponseEffectController()
  effect.setPhase('thinking')
  run(effect, 2)
  effect.setPhase('replying')
  const first = run(effect, 1 / 60)
  assert.ok(first.reply > 0 && first.reply < 0.1)
  effect.setPhase('replying')
  const next = run(effect, 1 / 60)
  assert.ok(next.reply > first.reply)
  assert.ok(next.time > first.time)
  effect.setPhase('idle')
  const tail = run(effect, 0.4)
  assert.ok(tail.strength > 0 && tail.strength < first.strength)
  assert.ok(tail.reply > 0)
  assert.equal(run(effect, 4).strength, 0)
  assert.equal(effect.needsFrame(false), false)
})

test('style changes crossfade with conserved light instead of flashing', () => {
  const effect = new ResponseEffectController()
  effect.setPhase('thinking')
  run(effect, 3)
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, style: 'filaments', intensity: 'vivid' })
  const transition = run(effect, 0.1)
  assert.ok(transition.weights[0] > 0 && transition.weights[1] > 0)
  assert.ok(Math.abs(transition.weights.reduce((sum, value) => sum + value, 0) - 1) < 0.001)
  assert.ok(transition.strength > 0.42 && transition.strength < 1)
  const settled = run(effect, 3)
  assert.deepEqual(settled.weights, [0, 1, 0])
  assert.equal(settled.strength, 1)
})

test('system and manual reduced motion stop movement and lower light intensity', () => {
  for (const motion of ['system', 'reduced']) {
    const effect = new ResponseEffectController()
    effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, motion })
    effect.setPhase('thinking')
    const systemReduced = motion === 'system'
    const state = run(effect, 10, systemReduced)
    assert.equal(state.time, 0)
    assert.equal(state.reducedMotion, true)
    assert.equal(state.strength, 0.42 * 0.4)
    assert.equal(effect.needsFrame(systemReduced), false)
    effect.setPhase('replying')
    assert.equal(run(effect, 1 / 60, systemReduced).reply, 1)
    effect.setPhase('idle')
    assert.equal(run(effect, 1 / 60, systemReduced).strength, 0)
  }
})

test('explicit full motion can animate the response while ambient system motion is reduced', () => {
  const effect = new ResponseEffectController()
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, motion: 'full' })
  effect.setPhase('thinking')
  assert.ok(run(effect, 1, true).time > 0)
  assert.equal(effect.needsFrame(true), true)
})

test('pause holds a static snapshot and interrupted replies restart without a jump', () => {
  const effect = new ResponseEffectController()
  effect.setPhase('replying')
  run(effect, 2)
  const frozen = run(effect, 3, false, true)
  assert.ok(Math.abs(frozen.time - 2) < 0.001)
  assert.equal(effect.needsFrame(false, true), false)
  effect.setPhase('idle')
  run(effect, 0.4)
  const previous = effect.getSnapshot()
  effect.setPhase('thinking')
  assert.equal(effect.getSnapshot().time, previous.time)
  const next = run(effect, 1 / 60)
  assert.ok(next.strength > previous.strength)
  assert.ok(next.reply < previous.reply)
})

test('invalid timing is ignored, long frames are bounded, and frame rate does not change the envelope', () => {
  const a = new ResponseEffectController(), b = new ResponseEffectController()
  a.setPhase('thinking'); b.setPhase('thinking')
  for (const delta of [NaN, Infinity, -1]) a.advance(delta, false)
  assert.equal(a.getSnapshot().time, 0)
  a.advance(100, false)
  assert.equal(a.getSnapshot().time, 0.1)
  run(a, 0.9, false, false, 30)
  run(b, 1, false, false, 120)
  assert.ok(Math.abs(a.getSnapshot().strength - b.getSnapshot().strength) < 0.00001)
})

test('preferences recover safely from invalid persisted values without sharing mutable defaults', () => {
  assert.deepEqual(normalizeResponseEffect({ style: 'bad', intensity: null, motion: false }), DEFAULT_RESPONSE_EFFECT)
  const effect = new ResponseEffectController()
  effect.getSnapshot().settings.style = 'off'
  effect.getSnapshot().weights[0] = 0
  assert.equal(effect.getSnapshot().settings.style, 'tide')
  assert.deepEqual(effect.getSnapshot().weights, [1, 0, 0])
})
