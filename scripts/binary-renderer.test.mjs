import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync } from 'node:fs'
import { DEFAULT_BINARY_EFFECT, DEFAULT_RESPONSE_EFFECT, ResponseEffectController } from '../src/prototype/responseEffects.ts'

const root = new URL('../src/', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  return next(context.parentURL?.startsWith(root) && specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier) ? `${specifier}.ts` : specifier, context)
} })
const { BlackHoleRenderer } = await import('../src/prototype/BlackHoleRenderer.ts')
hooks.deregister()

function renderer() {
  const uniforms = Object.fromEntries([
    'uResponseStrength', 'uResponseReply', 'uResponseTime', 'uResponseMotion',
    'uBinaryEnabled', 'uBinaryDensity', 'uBinaryBrightness', 'uBinaryGain',
    'uBinaryVisibleFraction', 'uBinarySparkFrequency', 'uBinarySparkBrightness',
    'uBinaryFlowSpeed', 'uBinaryFlowOffset',
  ].map(name => [name, { value: 0 }]))
  const state = {
    responseEffect: new ResponseEffectController(), reducedMotion: false, paused: false,
    material: { uniforms }, responseWeights: { set(...weights) { this.value = weights } },
    ambientIsRunning: () => true, simulationTime: 24, binaryFlowOffset: 0,
    binaryFlowRate: DEFAULT_BINARY_EFFECT.flowSpeed,
  }
  return {
    state,
    sync: delta => BlackHoleRenderer.prototype.syncResponseEffect.call(state, delta),
    values: () => Object.fromEntries(Object.entries(uniforms).map(([name, uniform]) => [name, uniform.value])),
  }
}

test('changing digit gain updates only its uniform, preserving response intensity and the flow phase', () => {
  for (const intensity of ['gentle', 'standard', 'vivid']) {
    const engine = renderer(), settings = { ...DEFAULT_RESPONSE_EFFECT, intensity }
    engine.state.responseEffect.setSettings(settings)
    engine.state.responseEffect.setPhase('thinking')
    for (let i = 0; i < 30; i++) engine.sync(.1)
    const before = engine.values(), weights = [...engine.state.responseWeights.value]
    for (const brightness of [.5, 3, 1.25]) {
      engine.state.responseEffect.setSettings({ ...settings, binary: { ...DEFAULT_BINARY_EFFECT, brightness } })
      engine.sync(0)
      assert.deepEqual(engine.values(), { ...before, uBinaryGain: brightness })
      assert.deepEqual(engine.state.responseWeights.value, weights)
      assert.equal(engine.state.simulationTime, 24)
      assert.equal(engine.state.binaryFlowOffset, 0)
    }
  }
})

test('maximum digit gain still renders zero when off, and finishes its reply/idle fade', () => {
  for (const phase of ['replying', 'idle']) {
    const engine = renderer()
    const settings = { ...DEFAULT_RESPONSE_EFFECT, style: 'off', binary: { ...DEFAULT_BINARY_EFFECT, brightness: 3 } }
    engine.state.responseEffect.setSettings(settings)
    engine.state.responseEffect.setPhase('thinking')
    for (let i = 0; i < 30; i++) engine.sync(.1)
    assert.equal(engine.values().uBinaryEnabled, 1)
    assert.equal(engine.values().uResponseStrength, 0)
    engine.state.responseEffect.setPhase(phase)
    engine.sync(.1)
    assert.ok(engine.values().uBinaryEnabled > 0 && engine.values().uBinaryEnabled < 1)
    for (let i = 0; i < 13; i++) engine.sync(.1)
    assert.equal(engine.values().uBinaryEnabled * engine.values().uBinaryGain, 0)
    engine.state.responseEffect.setPhase('thinking'); engine.sync(.1)
    engine.state.responseEffect.setSettings({ ...settings, binary: { ...settings.binary, enabled: false } })
    engine.sync(0)
    assert.equal(engine.values().uBinaryEnabled, 0)
    assert.equal(engine.state.responseEffect.needsFrame(false), false)
  }
})

test('the shader applies digit gain only to the final binary emission', () => {
  const source = readFileSync(new URL('../src/prototype/shaders.ts', import.meta.url), 'utf8')
  const binary = source.match(/vec3 binaryInterior\([^]*?\n\}/)?.[0]
  assert.ok(binary)
  assert.match(binary, /return vec3\(light\*strength\*rimFade\*uBinaryEnabled\*uBinaryGain\);/)
  assert.match(binary, /if \(uBinaryEnabled <= \.00001 \|\| uBinaryDensity <= 0\.0\) return vec3\(0\.0\);/)
  assert.equal(source.replace(binary, '').match(/\buBinaryGain\b/g)?.length, 1, 'only the uniform declaration exists outside the digit function')
})
