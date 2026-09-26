import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_BINARY_EFFECT, DEFAULT_RESPONSE_EFFECT, ResponseEffectController, normalizeResponseEffect } from '../src/prototype/responseEffects.ts'
import { DEFAULT_BINARY_EFFECT as SERVER_BINARY_DEFAULT } from '../server/preferences.mjs'

function run(effect, seconds, systemReduced = false, paused = false, fps = 60) {
  for (let i = 0; i < Math.ceil(seconds * fps); i++) effect.advance(1 / fps, systemReduced, paused)
  return effect.getSnapshot(systemReduced)
}

test('idle is exactly the baseline and disabling both effects removes existing afterglow', () => {
  const effect = new ResponseEffectController()
  assert.equal(run(effect, 20).strength, 0)
  assert.equal(effect.needsFrame(false), false)
  effect.setPhase('thinking')
  assert.ok(run(effect, 2).strength > 0.4)
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, style: 'off', binary: { ...DEFAULT_BINARY_EFFECT, enabled: false } })
  assert.equal(effect.getSnapshot().strength, 0)
  assert.equal(effect.getSnapshot().time, 0)
  assert.equal(effect.needsFrame(false), false)
})

test('binary appears only for thinking and fades out on reply, cancellation or completion', () => {
  const effect = new ResponseEffectController()
  assert.equal(run(effect, 30).binaryAmount, 0)
  effect.setPhase('replying')
  assert.equal(run(effect, 3).binaryAmount, 0)
  for (const exit of ['replying', 'idle']) {
    effect.setPhase('thinking')
    const start = run(effect, 1 / 60)
    assert.ok(start.binaryAmount > 0 && start.binaryAmount < .1)
    assert.equal(run(effect, 3).binaryAmount, 1)
    effect.setPhase(exit)
    assert.equal(effect.getSnapshot().binaryAmount, 1)
    const early = run(effect, .1).binaryAmount
    const middle = run(effect, .3).binaryAmount
    const tail = run(effect, .5).binaryAmount
    assert.ok(early > .9 && early < 1)
    assert.ok(middle > .5 && middle < early)
    assert.ok(tail > 0 && tail < .2)
    assert.equal(run(effect, 1.5).binaryAmount, 0)
  }
})

test('binary transitions independently when disk effects are off and interrupted fades remain continuous', () => {
  const effect = new ResponseEffectController()
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, style: 'off' })
  effect.setPhase('thinking')
  assert.ok(run(effect, 1).binaryAmount > .99)
  assert.equal(effect.getSnapshot().strength, 0)
  assert.equal(effect.needsFrame(false), true)
  effect.setPhase('idle')
  const tail = run(effect, .1).binaryAmount
  assert.equal(effect.needsFrame(false), true)
  effect.setPhase('thinking')
  assert.equal(effect.getSnapshot().binaryAmount, tail)
  const resumed = run(effect, 1 / 60).binaryAmount
  assert.ok(resumed > tail && resumed < tail + .1)
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, style: 'off', binary: { ...DEFAULT_BINARY_EFFECT, enabled: false } })
  assert.equal(effect.getSnapshot().binaryAmount, 0)
  assert.equal(effect.needsFrame(false), false)
})

test('binary reduced motion and pause are static, and full motion still renders when ambient motion is reduced', () => {
  const effect = new ResponseEffectController()
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, style: 'off' })
  effect.setPhase('thinking')
  assert.equal(run(effect, .1, true).binaryAmount, 1)
  assert.equal(effect.needsFrame(true), false)
  effect.setPhase('idle')
  assert.equal(run(effect, .1, true).binaryAmount, 0)
  effect.setPhase('thinking')
  assert.equal(run(effect, .1, false, true).binaryAmount, 1)
  assert.equal(effect.needsFrame(false, true), false)
  effect.setSettings({ ...DEFAULT_RESPONSE_EFFECT, style: 'off', motion: 'full' })
  assert.equal(effect.needsFrame(true), true)
  effect.setPhase('replying')
  assert.ok(run(effect, .5, true).binaryAmount > 0)
  assert.equal(effect.needsFrame(true), true)
  assert.equal(run(effect, 1.5, true).binaryAmount, 0)
  assert.equal(effect.needsFrame(true), false)
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
  effect.getSnapshot().settings.binary.emberBrightness = 1
  effect.getSnapshot().weights[0] = 0
  assert.equal(effect.getSnapshot().settings.style, 'tide')
  assert.equal(effect.getSnapshot().settings.binary.emberBrightness, DEFAULT_BINARY_EFFECT.emberBrightness)
  assert.deepEqual(effect.getSnapshot().weights, [1, 0, 0])
})

test('binary settings normalize independently, retain explicit zero values and own their snapshots', () => {
  assert.deepEqual(DEFAULT_BINARY_EFFECT, SERVER_BINARY_DEFAULT)
  assert.deepEqual(normalizeResponseEffect({ style: 'off' }).binary, DEFAULT_BINARY_EFFECT)
  const binary = {
    enabled: false, density: 0, emberBrightness: -1, visibleFraction: 2,
    sparkFrequency: NaN, sparkBrightness: Infinity, flowSpeed: 0,
  }
  const normalized = normalizeResponseEffect({ binary })
  assert.deepEqual(normalized.binary, {
    enabled: false, density: 0, emberBrightness: 0, visibleFraction: 1,
    sparkFrequency: DEFAULT_BINARY_EFFECT.sparkFrequency,
    sparkBrightness: DEFAULT_BINARY_EFFECT.sparkBrightness, flowSpeed: 0,
  })
  const controller = new ResponseEffectController()
  controller.setSettings(normalized)
  normalized.binary.enabled = true
  normalized.binary.density = 1
  assert.equal(controller.getSnapshot().settings.binary.enabled, false)
  assert.equal(controller.getSnapshot().settings.binary.density, 0)
  assert.equal(normalizeResponseEffect({ binary: { enabled: 'false', density: '0.5' } }).binary.enabled, true)
  const first = normalizeResponseEffect()
  first.binary.density = 0
  assert.equal(normalizeResponseEffect().binary.density, DEFAULT_BINARY_EFFECT.density)
})
