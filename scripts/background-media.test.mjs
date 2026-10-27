import test from 'node:test'
import assert from 'node:assert/strict'
import { backgroundAsset, MediaSceneCamera } from '../src/prototype/backgroundMedia.ts'
import { parseMediaRange } from '../desktop/server.mjs'

test('media camera preserves uninterrupted camera progress on reversal and settles without a permanent clock', () => {
  const camera = new MediaSceneCamera()
  camera.setView('interstellar')
  camera.advance(.25)
  const halfway = camera.snapshot()
  assert.ok(halfway.zoom > .7 && halfway.zoom < 2.05)
  camera.setView('panorama')
  assert.equal(camera.snapshot().zoom, halfway.zoom)
  for (let frame = 0; frame < 600; frame++) camera.advance(1 / 60)
  assert.equal(camera.snapshot().zoom, .7)
  assert.equal(camera.snapshot().cameraTransition, false)
  const settled = camera.snapshot()
  camera.advance(10)
  assert.deepEqual(camera.snapshot(), settled)
  camera.setView('interstellar'); camera.advance(0, true)
  assert.equal(camera.snapshot().zoom, 2.05)
  assert.equal(camera.snapshot().cameraTransition, false)
})

test('media paths select independent orientation, theme, resolution and quality', () => {
  assert.equal(backgroundAsset('portrait', false, '4k', 'high', 'video'), '/backgrounds/portrait-light-4k-high.mp4')
  assert.equal(backgroundAsset('landscape', true, '720p', 'standard', 'image'), '/backgrounds/landscape-dark-4k-high.webp')
  assert.equal(backgroundAsset('portrait', false, '720p', 'standard', 'video'), '/backgrounds/portrait-light-1080p-high.mp4')
})

test('video byte ranges handle suffix and open requests and reject unsafe or unsatisfiable reads', () => {
  assert.deepEqual(parseMediaRange('bytes=0-99', 500), { start: 0, end: 99 })
  assert.deepEqual(parseMediaRange('bytes=100-', 500), { start: 100, end: 499 })
  assert.deepEqual(parseMediaRange('bytes=-25', 500), { start: 475, end: 499 })
  assert.deepEqual(parseMediaRange('bytes=450-600', 500), { start: 450, end: 499 })
  for (const range of ['bytes=500-', 'bytes=-0', 'bytes=90-20', 'bytes=-', 'bytes=0-1,3-4', 'bytes=9007199254740993-', 'junk']) assert.equal(parseMediaRange(range, 500), null)
})
