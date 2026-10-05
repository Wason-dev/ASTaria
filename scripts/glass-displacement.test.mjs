/**
 * Pixel-for-pixel contract for the glass displacement texture.
 *
 * `glassDisplacement` primes the whole ImageData with the neutral displacement
 * and only shades the edge frame of `max(radius, band)`. These specs capture the
 * pre-optimization full-resolution kernel as an independent reference and prove
 * that both produce identical RGBA bytes, then report kernel cost on real
 * surface sizes without turning timing into an assertion.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOME_GLASS, glassDisplacement } from '../src/home/glass.ts'

/* -------------------------------------------------------------------------- *
 * Fake canvas host: captures the ImageData handed to putImageData and answers
 * toDataURL with a PNG-shaped payload that the specs can decode.
 * -------------------------------------------------------------------------- */

const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const PNG_PAYLOAD_BYTES = 48

const host = { canvases: 0, puts: 0, urls: 0, last: null, lastType: '', lastContextOptions: null, failContext: false, viewOffset: 0 }

class FakeImageData {
  constructor(width, height) {
    this.width = width
    this.height = height
    // A plain buffer is what a browser hands out; the offset arm exercises the
    // byte-wise neutral fill that an unaligned view would need.
    this.data = host.viewOffset
      ? new Uint8ClampedArray(new ArrayBuffer(width * height * 4 + host.viewOffset), host.viewOffset, width * height * 4)
      : new Uint8ClampedArray(width * height * 4)
  }
}

globalThis.document = {
  createElement(tag) {
    assert.equal(tag, 'canvas', 'the texture only ever asks for a canvas element')
    host.canvases++
    const canvas = {
      width: 0,
      height: 0,
      getContext(type, options) {
        host.lastContextOptions = options
        if (type !== '2d' || host.failContext) return null
        return {
          createImageData: (width, height) => new FakeImageData(width, height),
          putImageData(image) {
            host.puts++
            assert.equal(image.width, canvas.width, 'putImageData keeps the canvas width')
            assert.equal(image.height, canvas.height, 'putImageData keeps the canvas height')
            assert.equal(image.data.length, canvas.width * canvas.height * 4, 'the texture is fully sized')
            host.last = { width: image.width, height: image.height, data: image.data }
          },
        }
      },
      toDataURL(type) {
        host.urls++
        host.lastType = type
        const pixels = host.last.data
        const payload = new Uint8Array(16 + PNG_PAYLOAD_BYTES)
        payload.set(PNG_SIGNATURE, 0)
        new DataView(payload.buffer).setUint32(8, canvas.width, false)
        new DataView(payload.buffer).setUint32(12, canvas.height, false)
        payload.set(pixels.subarray(0, PNG_PAYLOAD_BYTES), 16)
        return `data:${type};base64,${Buffer.from(payload).toString('base64')}`
      },
    }
    return canvas
  },
}

function decodePayload(map) {
  return new Uint8Array(Buffer.from(map.slice(map.indexOf(',') + 1), 'base64'))
}

/* -------------------------------------------------------------------------- *
 * Reference kernel: a frozen copy of the algorithm as it shipped before the
 * frame optimization, running over every pixel of the texture.
 * -------------------------------------------------------------------------- */

function fillReference(data, w, h, radius) {
  const r = Math.min(radius, w / 2, h / 2)
  const band = Math.min(HOME_GLASS.edgeWidth, h / 2)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + .5 - w / 2, py = y + .5 - h / 2
    const qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r)
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0), length = Math.hypot(ax, ay)
    const distance = length + Math.min(Math.max(qx, qy), 0) - r
    const edge = Math.max(0, 1 - Math.max(0, -distance) / band)
    let nx = 0, ny = 0
    if (length > 0) { nx = ax / length * Math.sign(px); ny = ay / length * Math.sign(py) }
    else if (qx > qy) nx = Math.sign(px)
    else ny = Math.sign(py)
    const i = (y * w + x) * 4
    data[i] = Math.round(127.5 - nx * edge * edge * 127.5)
    data[i + 1] = Math.round(127.5 - ny * edge * edge * 127.5)
    data[i + 2] = 128
    data[i + 3] = 255
  }
}

function referencePixels(w, h, radius) {
  const data = new Uint8ClampedArray(w * h * 4)
  fillReference(data, w, h, radius)
  return data
}

/** The whole pre-optimization code path, canvas round trip included. */
function referenceRender(width, height, radius) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return ''
  const pixels = context.createImageData(w, h)
  fillReference(pixels.data, w, h, radius)
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}

/* -------------------------------------------------------------------------- *
 * Comparison helpers
 * -------------------------------------------------------------------------- */

function renderOptimized(width, height, radius) {
  const canvases = host.canvases
  const map = glassDisplacement(width, height, radius)
  assert.equal(host.canvases, canvases + 1, `${width}x${height} r=${radius} rendered a fresh texture`)
  return { map, shot: host.last }
}

function describeMismatch(data, expected, w) {
  for (let i = 0; i < expected.length; i++) {
    if (data[i] === expected[i]) continue
    const pixel = i >> 2
    return `byte ${i} (x=${pixel % w}, y=${Math.floor(pixel / w)}, channel=${'RGBA'[i & 3]}) is ${data[i]}, expected ${expected[i]}`
  }
  return ''
}

function assertMatchesReference(width, height, radius) {
  const label = `${width}x${height} r=${radius}`
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const { map, shot } = renderOptimized(width, height, radius)
  assert.equal(shot.width, w, `${label}: texture width`)
  assert.equal(shot.height, h, `${label}: texture height`)
  const expected = referencePixels(w, h, radius)
  assert.equal(shot.data.length, expected.length, `${label}: texture length`)
  const mismatch = describeMismatch(shot.data, expected, w)
  assert.equal(mismatch, '', `${label}: ${mismatch}`)
  assert.equal(host.lastType, 'image/png', `${label}: texture format`)
  assert.ok(map.startsWith('data:image/png;base64,'), `${label}: data URL`)
  const payload = decodePayload(map)
  assert.deepEqual(Array.from(payload.subarray(0, 8)), Array.from(PNG_SIGNATURE), `${label}: PNG signature`)
  assert.equal(new DataView(payload.buffer).getUint32(8, false), w, `${label}: payload width`)
  assert.equal(new DataView(payload.buffer).getUint32(12, false), h, `${label}: payload height`)
  return shot
}

function medianMs(runs, run) {
  const samples = []
  for (let i = 0; i < runs; i++) {
    const start = performance.now()
    run(i)
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return samples[samples.length >> 1]
}

/* -------------------------------------------------------------------------- *
 * Specs
 * -------------------------------------------------------------------------- */

test('ordinary, large, tiny, heavily rounded and fractional surfaces match the full-resolution kernel', () => {
  const surfaces = [
    // Ordinary panels and pills the home view actually renders.
    [320, 640, 24], [640, 480, 16], [1180, 840, 16], [760, 56, 16],
    // Large surfaces: the neutral core dwarfs the edge frame here.
    [1440, 900, 19], [2048, 1280, 19], [2560, 1440, 19],
    // Radius limits: zero, half the short side, and far past the clamp.
    [200, 200, 0], [200, 200, 100], [200, 200, 9999], [128, 64, 32], [64, 128, 32],
    [32, 32, 16], [33, 33, 16.4],
    // Tiny surfaces, including the 1 px textures before layout settles.
    [1, 1, 0], [1, 1, 8], [1, 1, 0.5], [1, 500, 5], [500, 1, 5], [2, 2, 1],
    [3, 3, 1.5], [5, 5, 2.5], [16, 16, 8], [40, 40, 20],
    // Thin strips where the band clamp (h / 2) takes over.
    [7, 300, 3.5], [300, 7, 3.5], [2, 1000, 1], [17, 96, 16.5], [37, 41, 3.25],
    // Fractional inputs round exactly like the shipped cache key does.
    [320.4, 640.6, 14.3], [99.5, 60.5, 7.75], [0.2, 0.4, 3], [12.5, 12.5, 2.25],
    // Radii that cannot describe a rounded rectangle keep the plain full pass.
    [120, 80, -5], [64, 64, NaN], [64, 64, Infinity], [64, 64, -Infinity], [64, 64, undefined],
  ]
  for (const [width, height, radius] of surfaces) assertMatchesReference(width, height, radius)
})

test('the texture stays neutral away from the edge frame and only the frame is shaded', () => {
  const original = Math.hypot
  let calls = 0
  Math.hypot = (...args) => { calls++; return original(...args) }
  try {
    // Frame of max(radius, band) on every side, so these counts are exact.
    const frames = [[352, 672, 24, 46848], [656, 496, 16, 35840], [400, 300, 50, 60000]]
    for (const [w, h, radius, shaded] of frames) {
      calls = 0
      glassDisplacement(w, h, radius)
      assert.equal(calls, shaded, `${w}x${h} r=${radius} shaded samples`)
      assert.ok(shaded <= w * h / 2, `${w}x${h} r=${radius} never shades past the edge frame`)
    }
    // The reference algorithm shades every single pixel.
    calls = 0
    referencePixels(64, 64, 8)
    assert.equal(calls, 64 * 64, 'the reference kernel stays full resolution')
  } finally {
    Math.hypot = original
  }
})

test('the upload-and-encode canvas requests a readback-friendly context without changing pixel output', () => {
  assertMatchesReference(341, 619, 23)
  assert.deepEqual(host.lastContextOptions, { willReadFrequently: true })
})

test('a cached texture is returned for the exact rounded size without touching the canvas', () => {
  const first = glassDisplacement(320.4, 640.6, 14.3)
  const canvases = host.canvases, urls = host.urls, puts = host.puts
  const second = glassDisplacement(320, 641, 14.3)
  assert.equal(second, first, 'the same rounded size reuses the cached PNG')
  assert.equal(host.canvases, canvases, 'no canvas is created on a cache hit')
  assert.equal(host.puts, puts, 'no pixels are uploaded on a cache hit')
  assert.equal(host.urls, urls, 'no PNG is encoded on a cache hit')
  // A different radius is a different texture, even at the same size.
  const rounded = glassDisplacement(320, 641, 14.5)
  assert.notEqual(rounded, first)
  assert.equal(host.canvases, canvases + 1)
})

test('the cache keeps 48 entries and evicts the oldest first', () => {
  const SIZE = 49
  const key = index => [211 + index, 307 + index, 7.5]
  const canvases = host.canvases
  for (let index = 0; index < SIZE; index++) glassDisplacement(...key(index))
  assert.equal(host.canvases, canvases + SIZE, 'every fresh size renders once')

  // 49 inserts leave exactly 48 entries, so the oldest one is already gone.
  glassDisplacement(...key(0))
  assert.equal(host.canvases, canvases + SIZE + 1, 'the oldest entry was evicted')
  // Re-inserting it pushes the next oldest out: the window is exactly 48 wide.
  glassDisplacement(...key(1))
  assert.equal(host.canvases, canvases + SIZE + 2, 'the cache never grows past 48')
  // Everything inside the retained window is still a hit.
  glassDisplacement(...key(20))
  glassDisplacement(...key(SIZE - 1))
  assert.equal(host.canvases, canvases + SIZE + 2, 'retained entries stay cached')
})

test('byte-identical RGBA at a new radius reuses the PNG without re-encoding', () => {
  // A size no other spec touches, so the bounded reuse buffer starts empty.
  const w = 72, h = 40
  // r = 0 and r = 0.5 are both below the band clamp min(edgeWidth, h / 2) = 16 at
  // h = 40, and land on the same r-independent arm of `distance`, so the reference
  // kernels are byte-identical even though the cache keys differ.
  assertMatchesReference(w, h, 0)
  assert.equal(describeMismatch(referencePixels(w, h, 0), referencePixels(w, h, .5), w), '',
    'the two reference kernels really are byte-identical before the call under test')
  const before = host.puts, urlsBefore = host.urls, canvasesBefore = host.canvases
  const map = glassDisplacement(w, h, .5)
  assert.equal(host.canvases, canvasesBefore + 1, 'the new radius still builds its own texture')
  assert.equal(host.puts, before, 'identical pixels skip putImageData')
  assert.equal(host.urls, urlsBefore, 'identical pixels skip PNG encoding')
  // Asserting only on the returned URL would pass even when every pixel differs:
  // the fake PNG payload is a fixed 48-byte prefix, so two different textures can
  // share one URL. Compare the captured RGBA against an independent reference.
  const captured = Uint8ClampedArray.from(host.last.data)
  const expected = referencePixels(w, h, .5)
  assert.equal(captured.length, expected.length, 'captured texture length')
  assert.equal(describeMismatch(captured, expected, w), '', 'captured texture matches the reference kernel')
  assert.deepEqual(Array.from(captured), Array.from(referencePixels(w, h, 0)),
    'the reused texture is the byte-identical one an encode would have shipped')
  assert.ok(map, 'the reused texture still returns a data URL')
})

test('pixels that genuinely differ are re-encoded, not reused', () => {
  const w = 96, h = 48
  assertMatchesReference(w, h, 8)
  const first = Uint8ClampedArray.from(host.last.data)
  const puts = host.puts, urls = host.urls

  const same = glassDisplacement(w, h, 8)
  assert.equal(host.puts, puts, 'an identical radius is answered by the exact-size cache')
  assert.equal(host.urls, urls, 'an identical radius never encodes again')
  assert.ok(same, 'the exact-size cache still returns a data URL')

  // r = 16 shades strictly more of this 96x48 texture than r = 8 (measured: the
  // two references differ), so the RGBA cannot be equal and the PNG must be redone.
  const second = glassDisplacement(w, h, 16)
  assert.equal(host.puts, puts + 1, 'changed pixels are uploaded')
  assert.equal(host.urls, urls + 1, 'changed pixels are encoded again')
  const updated = Uint8ClampedArray.from(host.last.data)
  assert.equal(describeMismatch(updated, referencePixels(w, h, 16), w), '', 'the re-encoded texture matches its r=16 reference')
  assert.equal(describeMismatch(first, referencePixels(w, h, 8), w), '', 'the first texture matches its own r=8 reference')
  assert.notEqual(describeMismatch(referencePixels(w, h, 8), referencePixels(w, h, 16), w), '',
    'the two references describe different textures, so reuse would have been wrong')
  let changed = 0
  for (let index = 0; index < updated.length; index += 4) if (updated[index] !== first[index]) changed++
  assert.ok(changed > 0, `r=16 shades ${changed} pixels differently from r=8`)
  assert.ok(second, 'the re-encoded texture returns a data URL')
})

test('the full chat-panel texture at 679x680 r=15 reuses its PNG across a 1e-9 radius nudge', () => {
  // Real chat panel size; band = min(edgeWidth 16, h / 2 = 340) = 16, so the shaded
  // frame is max(15, 16) = 16 and the sampled pixels sit close enough to the
  // rounded outline that a 1e-9 radius change rounds to the very same RGBA bytes.
  const w = 679, h = 680, radius = 15, nudged = 15 + 1e-9
  assertMatchesReference(w, h, radius)
  const shot = host.last
  const first = Uint8ClampedArray.from(shot.data)
  const expectedFirst = referencePixels(w, h, radius)
  const expectedNudged = referencePixels(w, h, nudged)
  assert.equal(describeMismatch(expectedFirst, expectedNudged, w), '',
    'the two references are byte-identical before the call under test')
  // Guard the spec's own premise: this radius really does sit on a sensitive edge.
  assert.notEqual(describeMismatch(expectedFirst, referencePixels(w, h, radius + .01), w), '',
    'a 0.01 radius change does move pixels, so equality above is not vacuous')

  const puts = host.puts, urls = host.urls
  const map = glassDisplacement(w, h, nudged)
  assert.equal(host.puts, puts, 'byte-identical pixels skip putImageData at chat-panel size')
  assert.equal(host.urls, urls, 'byte-identical pixels skip PNG encoding at chat-panel size')
  // The fake PNG payload is a 48-byte prefix, so URL equality alone cannot prove
  // the whole texture matched; compare every captured RGBA byte instead.
  assert.equal(shot.data.length, expectedFirst.length, 'the captured texture keeps its full size')
  assert.equal(describeMismatch(shot.data, expectedFirst, w), '', 'the reused texture is the byte-identical reference')
  assert.deepEqual(Array.from(shot.data), Array.from(expectedNudged), 'the reuse decision compared all pixels')
  assert.ok(map, 'the reused texture still returns a data URL')
})

test('a pixel view without a 32-bit aligned buffer still fills neutral bytes', () => {
  host.viewOffset = 1
  try {
    assertMatchesReference(48, 32, 12)
  } finally {
    host.viewOffset = 0
  }
})

test('a missing 2D context still yields an empty map and is never cached', () => {
  host.failContext = true
  try {
    assert.equal(glassDisplacement(97, 53, 9), '')
  } finally {
    host.failContext = false
  }
  const canvases = host.canvases
  const map = glassDisplacement(97, 53, 9)
  assert.ok(map.startsWith('data:image/png;base64,'), 'the failed texture was not cached')
  assert.equal(host.canvases, canvases + 1, 'a retry renders normally')
})

test('kernel cost on real surface sizes', t => {
  const surfaces = [
    { label: 'menu bar', width: 760, height: 56, radius: 16 },
    { label: 'chat panel', width: 1180, height: 840, radius: 16 },
    { label: 'workspace panel', width: 1440, height: 900, radius: 19 },
    { label: 'wide chat panel', width: 2560, height: 1440, radius: 19 },
  ]
  const rows = ['surface             size         radius   full kernel   edge frame   speedup   frame samples']
  for (const { label, width, height, radius } of surfaces) {
    const full = medianMs(5, () => referenceRender(width, height, radius))
    // Distinct radii keep every timed call a cache miss at a shipped radius.
    const frame = medianMs(5, run => glassDisplacement(width, height, radius - 2 + run))
    // The sample count rides a fresh radius too, so the cache cannot answer it.
    const original = Math.hypot
    let shaded = 0
    Math.hypot = (...args) => { shaded++; return original(...args) }
    try {
      glassDisplacement(width, height, radius + 3)
    } finally {
      Math.hypot = original
    }
    const pixels = width * height
    rows.push(
      `${label.padEnd(20)}${`${width}x${height}`.padEnd(13)}${String(radius).padEnd(9)}` +
      `${`${full.toFixed(2)} ms`.padEnd(14)}${`${frame.toFixed(2)} ms`.padEnd(13)}` +
      `${`${(full / frame).toFixed(1)}x`.padEnd(10)}${`${shaded}/${pixels} (${(shaded / pixels * 100).toFixed(1)}%) at r=${radius + 3}`}`,
    )
  }
  for (const row of rows) {
    console.log(row)
    t.diagnostic(row)
  }
  const note = 'both columns are median cache-miss kernels through the same canvas stub (ImageData allocation, putImageData and PNG call included); sizes and radii come from the shipped home surfaces. Cost is reported, never asserted: only the pixel contract above is binding.'
  console.log(note)
  t.diagnostic(note)
})
