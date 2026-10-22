import test from 'node:test'
import assert from 'node:assert/strict'
import { glassBackdropFilter, supportsGlassRefraction } from '../src/home/glassRendering.ts'
import { createDatabase } from '../server/database.mjs'
import { getPreferences, savePreferences } from '../server/preferences.mjs'

test('mobile detailed glass blurs once before refraction while CSS and desktop paths stay intact', () => {
  assert.equal(glassBackdropFilter(6, 'glass', true), 'blur(6px) url("#glass")')
  assert.equal(glassBackdropFilter(0, 'glass', true), 'url("#glass")')
  assert.equal(glassBackdropFilter(6, 'glass', false), 'url("#glass")')
  assert.equal(glassBackdropFilter(6, undefined, true), 'blur(6px)')
  assert.equal(glassBackdropFilter(0, undefined, true), 'none')
})

test('Windows uses native glass by default and permits explicit detailed refraction', () => {
  const windows = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/150.0 Electron/44.1'
  assert.equal(supportsGlassRefraction(windows), false)
  assert.equal(supportsGlassRefraction(windows, 'detailed'), true)
  assert.equal(supportsGlassRefraction('Mozilla/5.0 (Macintosh) Chrome/150.0'), true)
  assert.equal(supportsGlassRefraction('Mozilla/5.0 (Macintosh) Safari/605.1', 'detailed'), false)
  const android = 'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/110.0.0.0 Mobile Safari/537.36'
  assert.equal(supportsGlassRefraction(android), false)
  assert.equal(supportsGlassRefraction(android, 'detailed'), true)
  assert.equal(supportsGlassRefraction('Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 Mobile Safari/604.1'), false)
})

test('glass rendering upgrades old preferences and persists separately from black-hole quality', () => {
  const db = createDatabase(':memory:')
  try {
    db.setPreference('app', { ...getPreferences(db), render: { profile: 'smooth90' } })
    const expected = getPreferences(db)
    assert.deepEqual(expected.render, { profile: 'smooth90', quality: 'ultra', glass: 'auto', background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' })
    const saved = savePreferences(db, { expected, value: { ...expected, render: { ...expected.render, glass: 'detailed' } } })
    assert.deepEqual(getPreferences(db).render, { profile: 'smooth90', quality: 'ultra', glass: 'detailed', background: 'realtime', mediaResolution: '1080p', mediaQuality: 'high' })
    assert.throws(() => savePreferences(db, { expected: saved, value: { ...saved, render: { ...saved.render, glass: 'invalid' } } }), /玻璃渲染/)
  } finally { db.close() }
})
