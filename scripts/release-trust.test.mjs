import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verifyReleaseManifest } from '../desktop/releaseTrust.mjs'
import { createUpdateService, RELEASES_URL } from '../desktop/updates.mjs'
import { prepareMacUpdate } from '../desktop/updateInstaller.mjs'
import { signTestManifest, testReleaseKeys } from './fixtures/release-signing.mjs'

test('release trust authenticates the whole payload, independent of property order', () => {
  const signed = signTestManifest({ version: '1.2.3', sha256: 'a'.repeat(64), buildInfo: { source: { commit: 'b'.repeat(40) } } })
  assert.equal(verifyReleaseManifest(signed, testReleaseKeys), signed)
  verifyReleaseManifest(Object.fromEntries(Object.entries(signed).reverse()), testReleaseKeys)
  for (const changed of [
    { ...signed, signature: undefined },
    { ...signed, sha256: 'c'.repeat(64) },
    { ...signed, buildInfo: { source: { commit: 'c'.repeat(40) } } },
    { ...signed, signature: { ...signed.signature, keyId: '__proto__' } },
    { ...signed, signature: { ...signed.signature, algorithm: 'none' } },
  ]) assert.throws(() => verifyReleaseManifest(changed, testReleaseKeys), /发布者签名/)
  // A release-provided key, even alongside a valid signature, is never trusted.
  assert.throws(() => verifyReleaseManifest(signed), /发布者签名/)
})

test('a self-consistent forged ready cache cannot enable installation; signed offline caches can', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-trust-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const bytes = Buffer.from('dmg fixture'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const version = '1.0.0-beta.5', stem = `ASTaria-${version}-mac-arm64-adhoc`, tag = `v${version}`
  const manifest = { schemaVersion: 1, name: 'ASTaria', bundleId: 'dev.wason.ASTaria', version, platform: 'darwin', arch: 'arm64',
    dmg: `${stem}.dmg`, sizeBytes: bytes.length, sha256, buildInfo: { version, builtAt: '2026-09-29T01:00:00Z', source: { commit: 'b'.repeat(40) } } }
  const releases = [{ tag_name: tag, prerelease: true, assets: ['dmg', 'manifest.json'].map(ext => ({ name: `${stem}.${ext}`,
    state: 'uploaded', size: ext === 'dmg' ? bytes.length : 900, browser_download_url: `${RELEASES_URL}/download/${tag}/${stem}.${ext}` })) }]
  const stateFile = join(dir, 'state.json'); await writeFile(join(dir, `${sha256}.dmg`), bytes)
  for (const signed of [false, true]) {
    await writeFile(stateFile, JSON.stringify({ schema: 1, releases, manifest: signed ? signTestManifest(manifest) : manifest,
      status: 'ready', downloaded: { sha256 } }))
    let installs = 0
    const service = createUpdateService({ current: { version: '1.0.0-beta.4', platform: 'darwin', arch: 'arm64' }, stateFile,
      downloadDirectory: dir, trustedKeys: testReleaseKeys, installer: async () => { installs++ }, fetcher: async () => { throw Error('offline') } })
    t.after(() => service.close())
    const state = await service.getStatus()
    assert.equal(state.canInstall, signed)
    if (signed) { await service.install(); await service.whenIdle(); assert.equal(installs, 1) }
    else { await assert.rejects(service.install(), /请先下载/); assert.equal(installs, 0) }
  }
})

test('installer authenticates before touching paths or mounting a disk image', async () => {
  let commands = 0
  await assert.rejects(prepareMacUpdate({ appBundle: '/nonexistent/ASTaria.app', path: '/nonexistent/evil.dmg', manifest: {},
    resultFile: '/nonexistent/result', run: async () => { commands++ } }), /发布者签名/)
  assert.equal(commands, 0)
})

test('a ready package corrupted after verification can be downloaded again without restarting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-trust-recovery-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const bytes = Buffer.from('trusted dmg fixture'), sha256 = createHash('sha256').update(bytes).digest('hex')
  const version = '1.0.0-beta.5', stem = `ASTaria-${version}-mac-arm64-adhoc`, tag = `v${version}`
  const manifest = signTestManifest({ schemaVersion: 1, name: 'ASTaria', bundleId: 'dev.wason.ASTaria', version, platform: 'darwin', arch: 'arm64',
    dmg: `${stem}.dmg`, sizeBytes: bytes.length, sha256, buildInfo: { version, builtAt: '2026-09-29T01:00:00Z', source: { commit: 'b'.repeat(40) } } })
  const releases = [{ tag_name: tag, prerelease: true, assets: ['dmg', 'manifest.json'].map(ext => ({ name: `${stem}.${ext}`,
    state: 'uploaded', size: ext === 'dmg' ? bytes.length : 900, browser_download_url: `${RELEASES_URL}/download/${tag}/${stem}.${ext}` })) }]
  const path = join(dir, `${sha256}.dmg`), stateFile = join(dir, 'state.json')
  await writeFile(path, bytes)
  await writeFile(stateFile, JSON.stringify({ schema: 1, releases, manifest, status: 'ready', downloaded: { sha256 } }))
  let installs = 0, requests = 0
  const options = { current: { version: '1.0.0-beta.4', platform: 'darwin', arch: 'arm64' }, stateFile,
    downloadDirectory: dir, trustedKeys: testReleaseKeys, installer: async () => { installs++ }, fetcher: async url => {
      requests++
      assert.equal(url, releases[0].assets[0].browser_download_url)
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } })
    } }
  const service = createUpdateService(options); t.after(() => service.close())
  assert.equal((await service.getStatus()).canInstall, true)
  // Preserve the length so the content hash, rather than only a size check,
  // must detect a package changed between cache adoption and installation.
  await writeFile(path, Buffer.alloc(bytes.length, 120))
  await service.install(); await service.whenIdle()
  const rejected = await service.getStatus()
  assert.equal(installs, 0)
  assert.equal(rejected.canInstall, false)
  assert.equal(rejected.download, null)
  assert.match(rejected.error, /校验失败.*重新下载/u)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).downloaded, null)
  const restarted = createUpdateService(options)
  assert.equal((await restarted.getStatus()).canInstall, false, 'failure is durable across a restart')
  restarted.close()
  await service.download(); await service.whenIdle()
  assert.equal(requests, 1, 'the existing running service must allow a fresh download')
  assert.equal((await service.getStatus()).canInstall, true)
  assert.deepEqual(await readFile(path), bytes)
  await service.install(); await service.whenIdle()
  assert.equal(installs, 1, 'only the repaired, verified package reaches the installer')
})

test('settings can explain the previous install result after restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-install-result-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const installResultFile = join(dir, 'result'); await writeFile(installResultFile, 'failed')
  const service = createUpdateService({ current: { version: '1.0.0' }, installResultFile, allowNetwork: false })
  assert.equal((await service.getStatus()).lastInstall.status, 'failed')
  assert.match((await service.getStatus()).lastInstall.message, /原版本已保留或恢复/)
  await writeFile(installResultFile, 'recovery-required')
  assert.equal((await service.getStatus()).lastInstall.status, 'recovery-required', 'a running app must see the installer result')
  service.close()
  const recovery = createUpdateService({ current: { version: '1.0.0' }, installResultFile, allowNetwork: false })
  assert.equal((await recovery.getStatus()).lastInstall.status, 'recovery-required')
  assert.match((await recovery.getStatus()).lastInstall.message, /回退未完成/)
  recovery.close()
})
