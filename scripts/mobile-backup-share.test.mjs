import assert from 'node:assert/strict'
import test from 'node:test'
import { Directory, Encoding } from '@capacitor/filesystem'
import { exportMobileBackup, shareMobileBackup } from '../mobile/runtime/backupShare.ts'
import { createDatabase } from '../server/database.mjs'
import { BACKUP_MAX_BYTES, serializeBackup } from '../src/xixi/backupLimits.ts'

const NOW = new Date('2026-10-12T12:00:00+08:00').getTime(), CACHE = 'astaria-backup-share-v1'
const value = { format: 'astaria-backup', version: 1, createdAt: '2026-10-12T04:00:00Z', tables: { tasks: [], state: [] }, checksum: 'synthetic-fixture' }
const name = 'ASTaria-backup-2026-10-12.json'
function fixture({ platform = 'ios', available = true, files = [] } = {}) {
  const calls = [], stored = new Map(files.map(file => [file.path, { ...file }]))
  const control = { fail: null, canShare: true, result: { activityType: 'synthetic.recipient' }, mismatch: false, uri: null, time: NOW, uuid: 0, gate: null }
  const record = (kind, options) => { calls.push([kind, options]); if (control.fail === kind) throw Error(`synthetic ${kind} failure`) }
  const fs = {
    async mkdir(options) { record('mkdir', options) },
    async readdir(options) { record('readdir', options); return { files: [...stored.values()].filter(file => file.path.startsWith(`${options.path}/`) && !file.path.slice(options.path.length + 1).includes('/')).map(file => ({ name: file.path.slice(options.path.length + 1), type: file.type ?? 'file', mtime: file.mtime, size: 0, uri: '' })) } },
    async writeFile(options) { record('write', options); stored.set(options.path, { path: options.path, data: options.data, mtime: control.time }); return { uri: `file:///private/Cache/${options.path}` } },
    async readFile(options) { record('read', options); return { data: control.mismatch ? 'incomplete' : stored.get(options.path)?.data } },
    async getUri(options) { record('uri', options); return { uri: control.uri ?? `file:///private/Cache/${options.path}` } },
    async deleteFile(options) { record('delete', options); stored.delete(options.path) },
  }
  const share = {
    async canShare() { record('canShare'); return { value: control.canShare } },
    async share(options) { record('share', options); if (control.gate) await control.gate; return control.result },
  }
  const deps = {
    platform: { isNativePlatform: () => platform !== 'web', getPlatform: () => platform, isPluginAvailable: () => available },
    filesystem: fs, share, now: () => control.time, uuid: () => `synthetic-${++control.uuid}`,
  }
  return { calls, stored, control, deps, of: kind => calls.filter(call => call[0] === kind) }
}

test('native backup is exact UTF-8 JSON in private Cache and shares a local file after the write is verified', async () => {
  for (const platform of ['ios', 'android']) {
    const f = fixture({ platform })
    await exportMobileBackup(value, name, f.deps)
    const write = f.of('write')[0][1], share = f.of('share')[0][1]
    assert.equal(write.directory, Directory.Cache); assert.equal(write.encoding, Encoding.UTF8)
    assert.equal(write.data, serializeBackup(value)); assert.ok(write.path.startsWith(`${CACHE}/ASTaria-backup-2026-10-12-`))
    assert.deepEqual(share.files, [`file:///private/Cache/${write.path}`]); assert.equal(share.url, undefined); assert.equal(share.text, undefined)
    assert.ok(f.calls.findIndex(call => call[0] === 'read') < f.calls.findIndex(call => call[0] === 'share'))
    assert.ok(f.stored.has(write.path), 'the chosen app may still be reading the successful share URI')
    assert.ok(f.calls.filter(([, options]) => options?.directory).every(([, options]) => options.directory === Directory.Cache))
  }
})

test('settings shareMobileBackup entry retains the same native export contract', async () => {
  const f = fixture()
  await shareMobileBackup(value, name, f.deps)
  assert.equal(f.of('share').length, 1)
  assert.equal(f.of('write')[0][1].data, serializeBackup(value))
})

test('a real in-memory public export retains its checksum and restores without bringing credentials into the share', async () => {
  const source = createDatabase(':memory:'), restored = createDatabase(':memory:')
  try {
    source.createTask({ title: '虚构的离线备份', notes: '测试正文保留' })
    const backup = source.exportData(), f = fixture()
    await exportMobileBackup(backup, name, f.deps)
    const shared = JSON.parse(f.of('write')[0][1].data)
    assert.equal(shared.checksum, backup.checksum); assert.deepEqual(shared, JSON.parse(serializeBackup(backup)))
    restored.importData(shared); assert.equal(restored.listTasks()[0].title, '虚构的离线备份')
    assert.ok(!Object.hasOwn(shared, 'apiKey'))
  } finally { source.close(); restored.close() }
})

test('web preview and missing native plugins have no web-download fallback or filesystem side effect', async () => {
  for (const args of [{ platform: 'web' }, { platform: 'windows' }, { available: false }]) {
    const f = fixture(args)
    await assert.rejects(exportMobileBackup(value, name, f.deps), /预览|分享/u)
    assert.deepEqual(f.calls, []); assert.equal(f.stored.size, 0)
  }
})

test('unavailable share does not write a cache file', async () => {
  const f = fixture(); f.control.canShare = false
  await assert.rejects(exportMobileBackup(value, name, f.deps), /分享/u)
  assert.equal(f.of('write').length, 0); assert.equal(f.of('share').length, 0)
})

test('cleanup is limited to old generated files in this backup Cache subdirectory', async () => {
  const old = `${CACHE}/ASTaria-backup-2026-10-01-${NOW - 2 * 86400000}-old.json`
  const recent = `${CACHE}/ASTaria-backup-2026-10-12-${NOW}-recent.json`
  const f = fixture({ files: [
    { path: old, mtime: NOW - 2 * 86400000 }, { path: recent, mtime: NOW },
    { path: `${CACHE}/keep.json`, mtime: 0 }, { path: `${CACHE}/subdirectory`, type: 'directory', mtime: 0 },
    { path: 'other-feature/old.json', mtime: 0 }, { path: 'Data/astaria-v1.sqlite', mtime: 0 },
  ] })
  await exportMobileBackup(value, name, f.deps)
  assert.deepEqual(f.of('delete').map(([, options]) => options.path), [old])
  assert.ok(!f.stored.has(old)); assert.ok(f.stored.has(recent)); assert.ok(f.stored.has('Data/astaria-v1.sqlite'))
  assert.ok(f.stored.has('other-feature/old.json')); assert.ok(f.stored.has(`${CACHE}/keep.json`)); assert.ok(f.stored.has(`${CACHE}/subdirectory`))
})

test('share cancellation rejects without a success receipt and deletes only its temporary Cache file', async () => {
  const f = fixture({ files: [{ path: 'Data/astaria-v1.sqlite', mtime: 0 }] })
  f.deps.share.share = async options => { f.calls.push(['share', options]); throw Error('Share canceled') }
  await assert.rejects(exportMobileBackup(value, name, f.deps), /取消.*尚未确认保存/u)
  const path = f.of('write')[0][1].path
  assert.ok(!f.stored.has(path)); assert.ok(f.stored.has('Data/astaria-v1.sqlite'))
  assert.deepEqual(f.of('delete').map(([, options]) => [options.directory, options.path]), [[Directory.Cache, path]])
})

test('write, read, URI and share failures reject and leave user Data alone', async () => {
  for (const kind of ['write', 'read', 'uri', 'share']) {
    const f = fixture({ files: [{ path: 'Data/astaria-v1.sqlite', mtime: 0 }] }); f.control.fail = kind
    await assert.rejects(exportMobileBackup(value, name, f.deps), /未能完成/u)
    assert.ok(f.stored.has('Data/astaria-v1.sqlite'), kind)
    assert.equal([...f.stored.keys()].filter(path => path.startsWith(`${CACHE}/`)).length, 0, kind)
    if (kind !== 'share') assert.equal(f.of('share').length, 0, kind)
  }
})

test('incomplete files and nonlocal URIs are never offered to the share sheet', async () => {
  for (const patch of [{ mismatch: true }, { uri: 'https://example.org/backup.json' }]) {
    const f = fixture(); Object.assign(f.control, patch)
    await assert.rejects(exportMobileBackup(value, name, f.deps), /备份/u)
    assert.equal(f.of('share').length, 0); assert.equal(f.stored.size, 0)
  }
})

test('failed cache cleanup or inaccessible cache reports failure rather than claiming export success', async () => {
  const f = fixture({ files: [{ path: `${CACHE}/backup-${NOW - 2 * 86400000}-old.json`, mtime: 0 }] })
  f.control.fail = 'delete'
  await assert.rejects(exportMobileBackup(value, name, f.deps)); assert.equal(f.of('share').length, 0)
  f.control.fail = 'readdir'
  await assert.rejects(exportMobileBackup(value, name, f.deps)); assert.equal(f.of('write').length, 0)
})

test('credentials, oversized UTF-8 payloads, invalid JSON and path traversal fail before cache writes', async () => {
  for (const input of [{ ...value, apiKey: 'synthetic-secret' }, { ...value, nested: { API_KEY: 'synthetic-secret' } }, { ...value, tables: { state: [{ key: 'deepseekApiKey', value: 'synthetic-secret' }] } }, undefined]) {
    const f = fixture()
    await assert.rejects(exportMobileBackup(input, name, f.deps))
    assert.equal(f.of('write').length, 0); assert.equal(f.of('share').length, 0)
  }
  const f = fixture()
  await assert.rejects(exportMobileBackup({ body: '界'.repeat(Math.ceil(BACKUP_MAX_BYTES / 3)) }, name, f.deps), /32 MiB/u)
  await assert.rejects(exportMobileBackup(value, '../backup.json', f.deps), /文件名/u)
  assert.equal(f.of('write').length, 0)
})

test('an empty native activity result is not turned into an external save receipt', async () => {
  const f = fixture(); f.control.result = { activityType: '' }
  assert.equal(await exportMobileBackup(value, name, f.deps), undefined)
  assert.equal(f.of('share').length, 1)
})

test('bounded cleanup preserves a currently shared cache file even across a long-open share sheet', async () => {
  const f = fixture(); let resume
  f.control.gate = new Promise(resolve => { resume = resolve })
  const first = exportMobileBackup(value, name, f.deps)
  for (let step = 0; step < 30 && !f.of('share').length; step++) await new Promise(resolve => setImmediate(resolve))
  assert.equal(f.of('share').length, 1)
  const active = f.of('write')[0][1].path
  f.control.time += 2 * 86400000; f.control.gate = null
  await exportMobileBackup(value, name, f.deps)
  assert.ok(f.stored.has(active)); assert.ok(!f.of('delete').some(([, options]) => options.path === active))
  resume(); await first
})
