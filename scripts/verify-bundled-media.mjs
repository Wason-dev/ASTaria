/** Fail packaging if an old/all-quality media directory leaks into a build. */
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { resolve, join } from 'node:path'
const root = resolve(process.argv[2] ?? 'dist', 'backgrounds')
const expected = []
for (const name of ['manifest.json', 'horizon-manifest.json']) {
  const manifest = JSON.parse(await readFile(join(root, name), 'utf8'))
  assert.equal(manifest.distribution, 'bundled-1080p-video-4k-still')
  assert.equal(manifest.assets.length, 8)
  for (const asset of manifest.assets) {
    assert.equal(asset.quality, 'high')
    assert.equal(asset.resolution, asset.kind === 'video' ? '1080p' : '4k')
    assert.match(asset.file, /^(?:horizon-)?(?:portrait|landscape)-(?:dark|light)-(?:1080p-high\.mp4|4k-high\.webp)$/)
    const bytes = await readFile(join(root, asset.file))
    assert.equal(bytes.length, asset.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256)
    expected.push(asset.file)
  }
}
const actual = (await readdir(root)).filter(name => !name.startsWith('.'))
assert.deepEqual(actual.sort(), [...expected, 'manifest.json', 'horizon-manifest.json', 'README.md'].sort())
console.log('Verified 16 bundled media assets: 1080p high video and 4K high stills; no optional or obsolete encodes')
