import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRenderProfile, RENDER_PROFILES } from '../src/prototype/renderProfile.ts'

test('render profiles keep the full visual stack while reducing the render budget', () => {
  assert.deepEqual(RENDER_PROFILES, {
    full: { quality: 'ultra', frameRate: 60 },
    smooth90: { quality: 'ultra', frameRate: 90 },
    smooth120: { quality: 'ultra', frameRate: 120 },
    balanced: { quality: 'high', frameRate: 45 },
    economy: { quality: 'low', frameRate: 30 },
    rest: { quality: 'safe', frameRate: 20 },
  })
  assert.equal(normalizeRenderProfile('balanced'), 'balanced')
  assert.equal(normalizeRenderProfile('smooth90'), 'smooth90')
  assert.equal(normalizeRenderProfile('smooth120'), 'smooth120')
  assert.equal(normalizeRenderProfile('unknown'), 'full')
  assert.equal(normalizeRenderProfile(null), 'full')
})
