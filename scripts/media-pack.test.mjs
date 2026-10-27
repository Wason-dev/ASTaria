import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { MediaPackController, downloadVerifiedMedia } from '../src/prototype/mediaPackCore.ts'
import { MEDIA_PACK_ASSETS, MEDIA_PACK_BYTES, MEDIA_PACK_BASE, MEDIA_PACK_PUBLISHED } from '../src/prototype/mediaPackCatalog.ts'

const bytes = new TextEncoder().encode('synthetic video bytes')
const asset = { file: 'test.mp4', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
const second = { ...asset, file: 'second.mp4', sha256: 'a'.repeat(64) }
function store() {
  const rows = new Map(), blobs = new Map()
  return { rows, blobs,
    list: async () => [...rows.values()], read: async key => blobs.get(key),
    put: async (asset, blob) => { rows.set(asset.sha256, asset); blobs.set(asset.sha256, blob) },
    remove: async key => { rows.delete(key); blobs.delete(key) },
    clear: async () => { rows.clear(); blobs.clear() },
  }
}
test('download checks actual streaming bytes, size and SHA256 before exposing the blob', async () => {
  const progress = []; let verified = false
  const blob = await downloadVerifiedMedia(asset, 'https://example.test/a.mp4', new AbortController().signal,
    n => progress.push(n), () => { verified = true }, async (_url, options) => {
      assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error')
      return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 7)); c.enqueue(bytes.slice(7)); c.close() } }))
    })
  assert.equal(blob.size, bytes.length); assert.equal(blob.type, 'video/mp4'); assert.deepEqual(progress, [7, bytes.length]); assert.equal(verified, true)
  for (const response of [new Response(bytes.slice(1)), new Response(new Uint8Array(bytes.length)), new Response(new Uint8Array(bytes.length + 1)), new Response(bytes, { headers: { 'Content-Length': '9' } }), new Response('', { status: 404 })]) {
    await assert.rejects(downloadVerifiedMedia(asset, 'https://example.test/a.mp4', new AbortController().signal, () => {}, () => {}, async () => response))
  }
})
test('cancel preserves completed clips, deduplicates downloads, and retry finishes only missing clips', async () => {
  const cache = store(), calls = []; let fail = true
  const controller = new MediaPackController([asset, second], cache, async (row, signal) => {
    calls.push(row.file)
    if (row === second && fail) await new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
    return new Blob([bytes])
  })
  await controller.initialize()
  const run = controller.start(); assert.equal(controller.start(), run)
  while (calls.length < 2) await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.snapshot().ready, false)
  controller.cancel(); await run
  assert.equal(controller.snapshot().phase, 'paused'); assert.equal(controller.snapshot().completedFiles, 1)
  fail = false; await controller.start()
  assert.equal(controller.snapshot().ready, true); assert.deepEqual(calls, ['test.mp4', 'second.mp4', 'second.mp4'])
  assert.equal((await controller.read('test.mp4')).size, bytes.length)
  await controller.clear(); assert.equal(controller.snapshot().ready, false); assert.equal(cache.blobs.size, 0)
})
test('restarting stays offline and discovers complete cache; missing file invalidates readiness', async () => {
  const cache = store(); await cache.put(asset, new Blob([bytes])); let network = 0
  const controller = new MediaPackController([asset], cache, async () => { network++; return new Blob([bytes]) })
  await controller.initialize(); assert.equal(network, 0); assert.equal(controller.snapshot().ready, true)
  cache.blobs.clear()
  assert.equal(await controller.read(asset.file), undefined); assert.equal(controller.snapshot().ready, false)
  await controller.start(); assert.equal(network, 1); assert.equal(controller.snapshot().ready, true)
})
test('failed transfers and storage quota errors never mark incomplete resources ready', async () => {
  for (const failure of ['download', 'storage']) {
    const cache = store()
    if (failure === 'storage') cache.put = async () => { throw new Error('存储空间不足') }
    const controller = new MediaPackController([asset], cache, async () => {
      if (failure === 'download') throw new Error('校验失败')
      return new Blob([bytes])
    })
    await controller.start(); assert.equal(controller.snapshot().ready, false); assert.equal(controller.snapshot().phase, 'error'); assert.equal(cache.rows.size, 0)
  }
})
test('the install payload contains only 1080p high videos and 4K high stills; optional pack is pinned', async () => {
  let bundled = []
  for (const name of ['manifest.json', 'horizon-manifest.json']) {
    const m = JSON.parse(await readFile(new URL(`../public/backgrounds/${name}`, import.meta.url)))
    assert.equal(m.assets.length, 8); bundled.push(...m.assets)
  }
  for (const a of bundled) {
    assert.equal(a.quality, 'high'); assert.equal(a.resolution, a.kind === 'video' ? '1080p' : '4k')
    const b = await readFile(new URL(`../public/backgrounds/${a.file}`, import.meta.url))
    assert.equal(b.length, a.bytes); assert.equal(createHash('sha256').update(b).digest('hex'), a.sha256)
  }
  const actual = (await readdir(new URL('../public/backgrounds/', import.meta.url))).filter(n => /\.(mp4|webp)$/.test(n))
  assert.deepEqual(actual.sort(), bundled.map(a => a.file).sort()); assert.ok(bundled.reduce((sum, a) => sum + a.bytes, 0) < 140 * 1024 ** 2)
  assert.equal(MEDIA_PACK_ASSETS.length, 8); assert.equal(MEDIA_PACK_BYTES, MEDIA_PACK_ASSETS.reduce((sum, a) => sum + a.bytes, 0))
  assert.match(MEDIA_PACK_BASE, /^https:\/\/raw\.githubusercontent\.com\/Wason-dev\/ASTaria\/[a-f0-9]{40}\/$/)
  assert.equal(MEDIA_PACK_PUBLISHED, false, 'resource publication is explicitly deferred by the user')
  const desktop = await readFile(new URL('../desktop/server.mjs', import.meta.url), 'utf8')
  assert.ok(desktop.includes(MEDIA_PACK_BASE), 'CSP must allow exactly the catalog resource commit')
})
