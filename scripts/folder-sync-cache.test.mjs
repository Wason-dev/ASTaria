import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, rename, unlink, symlink, utimes, chmod, cp, realpath } from 'node:fs/promises'
import { renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createFolderSync, handleSyncRequest } from '../desktop/folderSync.mjs'
import { encryptSyncOperation, MAX_OPERATION_BYTES } from '../server/syncProtocol.mjs'

const operationName = op => `${String(op.sequence).padStart(12, '0')}-${op.operationId}.op`
const tamperTag = bytes => {
  const envelope = JSON.parse(bytes.toString('utf8')), tag = Buffer.from(envelope.tag, 'base64')
  tag[0] ^= 1
  envelope.tag = tag.toString('base64')
  return Buffer.from(`${JSON.stringify(envelope)}\n`)
}
const deferred = () => {
  let resolve
  const promise = new Promise(finish => { resolve = finish })
  return { promise, resolve }
}
const readGate = t => {
  const entered = deferred(), release = deferred()
  t.signal.addEventListener('abort', release.resolve, { once: true })
  t.after(() => t.signal.removeEventListener('abort', release.resolve))
  return { entered, release }
}

async function pair(t, dependencies = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'astaria-folder-cache-')))
  const ad = join(root, 'a'), bd = join(root, 'b'), folder = join(root, 'shared')
  for (const path of [ad, bd, folder]) await mkdir(path)
  const a = createDatabase(join(ad, 'isolated.sqlite')), b = createDatabase(join(bd, 'isolated.sqlite'))
  const vault = () => {
    const values = new Map()
    return { available: () => true, read: key => values.get(key), write: (key, value) => values.set(key, value), remove: key => values.delete(key) }
  }
  const av = vault(), bv = vault(), reads = new Map(), receives = new Map(), io = {}, syncs = []
  let applied = 0
  const store = { ...b.sync, receive(op, choice) {
    receives.set(op.operationId, (receives.get(op.operationId) ?? 0) + 1)
    return io.receive ? io.receive(op, choice) : b.sync.receive(op, choice)
  } }
  const newReceiver = () => {
    const sync = createFolderSync({ store, secrets: bv, dataDirectory: bd, onApplied: () => { applied++ } }, {
      ...dependencies,
      readOperation(handle, path) {
        reads.set(path, (reads.get(path) ?? 0) + 1)
        return io.read ? io.read(handle, path) : handle.readFile()
      },
    })
    syncs.push(sync)
    return sync
  }
  const as = createFolderSync({ store: a.sync, secrets: av, dataDirectory: ad }), bs = newReceiver()
  syncs.push(as)
  t.after(async () => {
    await Promise.all(syncs.map(sync => sync.close()))
    a.close(); b.close()
    await rm(root, { recursive: true, force: true })
  })
  for (const db of [a, b]) { db.listAreas(); db.getPlanner() }
  await as.configure({ mode: 'shared', create: true, directory: folder })
  await bs.configure({ mode: 'shared', joinKey: av.read('sync-key'), directory: folder })
  await as.run(); await bs.run()
  assert.equal(bs.status().conflicts.length, 0)
  const operations = join(folder, '.astaria-sync', 'devices', a.sync.config().deviceId, 'operations')
  const pathFor = op => join(operations, operationName(op))
  return {
    root, ad, bd, folder, a, b, av, bv, as, bs, operations, pathFor, io, newReceiver,
    reads: path => reads.get(path) ?? 0, receives: op => receives.get(op.operationId) ?? 0, applied: () => applied,
    async publish(title = 'synthetic task') {
      const task = a.createTask({ title }), op = a.sync.outbox().at(-1)
      await as.run()
      return { task, op, path: pathFor(op), bytes: await readFile(pathFor(op)) }
    },
    write: op => writeFile(pathFor(op), encryptSyncOperation(op, Buffer.from(av.read('sync-key'), 'hex'))),
  }
}

async function manualCheck(sync) {
  const req = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST', url: '/api/sync/check', headers: { 'content-type': 'application/json' },
  })
  const res = { statusCode: 200, setHeader() {}, end(value) { this.value = JSON.parse(value) } }
  assert.equal(await handleSyncRequest(sync, req, res), true)
  assert.equal(res.statusCode, 200)
  return res.value
}

test('accepted unchanged operations skip both read and receive, while new files are authenticated', async t => {
  const f = await pair(t), first = await f.publish()
  await f.bs.run()
  const info = await lstat(first.path, { bigint: true })
  assert.equal(typeof info.mtimeNs, 'bigint')
  assert.equal(typeof info.ctimeNs, 'bigint')
  assert.equal(f.reads(first.path), 1)
  assert.equal(f.receives(first.op), 1)
  assert.equal(f.b.getTask(first.task.id).title, first.task.title)
  const before = f.applied()
  await f.bs.run(); await f.bs.run(true)
  assert.equal(f.reads(first.path), 1)
  assert.equal(f.receives(first.op), 1)
  assert.equal(f.applied(), before)
  const second = await f.publish('new file')
  await f.bs.run()
  assert.equal(f.reads(first.path), 1)
  assert.equal(f.reads(second.path), 1)
  assert.equal(f.b.getTask(second.task.id).title, 'new file')
  assert.equal(f.bs.status().pendingExports, 0)
})

for (const [kind, change, reason] of [
  ['GCM tag tamper', tamperTag, /篡改/],
  ['append', bytes => Buffer.concat([bytes, Buffer.from('unexpected')]), /无法解析/],
  ['truncate', bytes => bytes.subarray(0, Math.floor(bytes.length / 2)), /无法解析/],
]) test(`${kind} invalidates an accepted fingerprint and is never cached as an error`, async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  await writeFile(item.path, change(item.bytes))
  await f.bs.run()
  assert.match(f.bs.status().message, /同步未完成/)
  assert.match(f.bs.status().message, reason)
  assert.equal(f.reads(item.path), 2)
  assert.equal(f.receives(item.op), 1)
  assert.equal(f.b.getTask(item.task.id).title, item.task.title)
  await f.bs.run()
  assert.equal(f.reads(item.path), 3)
  await writeFile(item.path, item.bytes)
  await f.bs.run(); await f.bs.run()
  assert.equal(f.reads(item.path), 4)
  assert.doesNotMatch(f.bs.status().message, /未完成/)
})

test('candidate size and symlink checks still run on every cache-hit attempt', async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  await writeFile(item.path, Buffer.alloc(MAX_OPERATION_BYTES * 2 + 1))
  await f.bs.run()
  assert.match(f.bs.status().message, /过大/)
  assert.equal(f.reads(item.path), 1)
  await writeFile(item.path, item.bytes)
  await f.bs.run()
  assert.equal(f.reads(item.path), 2)
  const saved = join(f.root, 'saved.op')
  await rename(item.path, saved); await symlink(saved, item.path)
  await f.bs.run(); await f.bs.run()
  assert.match(f.bs.status().message, /文件无效/)
  assert.equal(f.reads(item.path), 2)
  await unlink(item.path); await rename(saved, item.path)
  await f.bs.run()
  assert.equal(f.reads(item.path), 3)
})

test('inode replacement with equal bytes and mtime still requires authentication', async t => {
  const f = await pair(t), item = await f.publish()
  await utimes(item.path, 1700000000, 1700000000)
  await f.bs.run()
  const before = await lstat(item.path, { bigint: true }), replacement = join(f.root, 'replacement.op')
  await writeFile(replacement, item.bytes); await utimes(replacement, 1700000000, 1700000000)
  await rename(replacement, item.path)
  const after = await lstat(item.path, { bigint: true })
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.notEqual(after.ino, before.ino)
  await f.bs.run(); await f.bs.run()
  assert.equal(f.reads(item.path), 2)
  assert.equal(f.receives(item.op), 2)
})

test('restoring size and mtime after tampering cannot hide ctime changes', async t => {
  const f = await pair(t), item = await f.publish()
  await utimes(item.path, 1700000000, 1700000000)
  await f.bs.run()
  const before = await lstat(item.path, { bigint: true })
  await writeFile(item.path, tamperTag(item.bytes)); await utimes(item.path, 1700000000, 1700000000)
  const after = await lstat(item.path, { bigint: true })
  assert.equal(after.size, before.size)
  assert.equal(after.mtimeNs, before.mtimeNs)
  assert.notEqual(after.ctimeNs, before.ctimeNs)
  await f.bs.run()
  assert.equal(f.reads(item.path), 2)
  assert.match(f.bs.status().message, /篡改/)
})

test('a valid encrypted replacement with conflicting content cannot reuse an old accepted identity', async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  const replacement = { ...item.op, createdAt: '2026-10-01T00:00:00.000Z' }
  await f.write(replacement)
  await f.bs.run(); await f.bs.run()
  assert.match(f.bs.status().message, /同一操作或序号的内容发生变化/)
  assert.equal(f.reads(item.path), 3)
  assert.equal(f.b.getTask(item.task.id).title, item.task.title)
  const collision = { ...replacement, operationId: 'e'.repeat(32), entityId: 'e'.repeat(32) }
  await f.write(collision)
  await f.bs.run()
  assert.equal(f.reads(f.pathFor(collision)), 1)
  assert.match(f.bs.status().message, /内容发生变化/)
})

test('sequence-gap pending files are reread until their predecessor arrives and they are applied', async t => {
  const f = await pair(t), task = f.a.createTask({ title: 'before gap' })
  f.a.updateTask(task.id, { title: 'after gap' })
  const [first, second] = f.a.sync.outbox(), path = f.pathFor(second)
  await f.write(second)
  await f.bs.run(); await f.bs.run()
  assert.equal(f.reads(path), 2)
  assert.equal(f.b.getTask(task.id), null)
  assert.equal(f.b.sync.pending().length, 1)
  assert.match(f.b.sync.pending()[0].reason, /等待/)
  await f.write(first)
  await f.bs.run()
  assert.equal(f.b.getTask(task.id).title, 'after gap')
  assert.equal(f.b.sync.pending().length, 0)
  assert.equal(f.reads(path), 3)
  await f.bs.run()
  assert.equal(f.reads(path), 3)
})

test('same-field conflicts are never cached; changed pending documents fail and explicit local choice survives', async t => {
  const f = await pair(t), item = await f.publish('base title')
  await f.bs.run()
  f.b.updateTask(item.task.id, { title: 'local title' })
  f.a.updateTask(item.task.id, { title: 'remote title' })
  const op = f.a.sync.outbox().at(-1), path = f.pathFor(op)
  await f.as.run()
  const bytes = await readFile(path)
  await f.bs.run(); await f.bs.run()
  assert.equal(f.reads(path), 2)
  assert.match(f.b.sync.pending()[0].reason, /标题/)
  assert.equal(f.b.getTask(item.task.id).title, 'local title')
  await f.write({ ...op, createdAt: '2026-10-01T00:00:00.000Z' })
  await f.bs.run()
  assert.match(f.bs.status().message, /待处理操作的内容发生变化/)
  assert.equal(f.b.getTask(item.task.id).title, 'local title')
  await writeFile(path, bytes)
  await f.bs.resolve(op.operationId, 'local')
  assert.equal(f.b.sync.pending().length, 0)
  assert.ok(f.b.sync.status().receipts.some(row => row.operationId === op.operationId && row.outcome === 'kept-local'))
  const before = f.reads(path)
  await f.bs.run()
  assert.equal(f.reads(path), before)
  assert.equal(f.b.getTask(item.task.id).title, 'local title')
})

for (const kind of ['read', 'receive']) test(`${kind} failure retries the unchanged file instead of storing success`, async t => {
  const f = await pair(t), item = await f.publish()
  let handle
  if (kind === 'read') f.io.read = (value, path) => {
    if (path !== item.path) return value.readFile()
    handle = value; throw new Error('synthetic read failure')
  }
  else f.io.receive = (op, choice) => {
    if (op.operationId === item.op.operationId) throw new Error('synthetic receive failure')
    return f.b.sync.receive(op, choice)
  }
  await f.bs.run()
  assert.match(f.bs.status().message, /synthetic .* failure/)
  assert.equal(f.b.getTask(item.task.id), null)
  if (handle) await assert.rejects(handle.stat(), { code: 'EBADF' })
  delete f.io.read; delete f.io.receive
  await f.bs.run(); await f.bs.run()
  assert.equal(f.reads(item.path), 2)
  assert.equal(f.b.getTask(item.task.id).title, item.task.title)
})

for (const kind of ['write', 'replace']) test(`${kind} during read cannot apply or cache a fingerprint for different bytes`, async t => {
  const f = await pair(t), item = await f.publish(), saved = join(f.root, 'racing.op')
  f.io.read = async (handle, path) => {
    const bytes = await handle.readFile()
    if (path === item.path) {
      if (kind === 'write') await writeFile(path, Buffer.concat([bytes, Buffer.from('racing write')]))
      else { await writeFile(saved, bytes); await rename(saved, path) }
    }
    return bytes
  }
  await f.bs.run()
  assert.match(f.bs.status().message, /检查期间发生变化/)
  assert.equal(f.receives(item.op), 0)
  assert.equal(f.b.getTask(item.task.id), null)
  delete f.io.read
  await writeFile(item.path, item.bytes)
  await f.bs.run(); await f.bs.run()
  assert.equal(f.reads(item.path), 2)
  assert.equal(f.b.getTask(item.task.id).title, item.task.title)
})

test('a symlink swapped in between lstat and open is rejected before reading', async t => {
  let target, saved, swapped = false
  const f = await pair(t, { fingerprintOperation(path) {
    if (path === target && !swapped) { swapped = true; renameSync(path, saved); symlinkSync(saved, path) }
    return path
  } })
  const item = await f.publish()
  target = item.path; saved = join(f.root, 'symlink-race.op')
  await f.bs.run()
  assert.match(f.bs.status().message, /未完成/)
  assert.equal(f.reads(item.path), 0)
  assert.equal(f.receives(item.op), 0)
  assert.equal(f.b.getTask(item.task.id), null)
  await unlink(target); await rename(saved, target)
  await f.bs.run()
  assert.equal(f.reads(item.path), 1)
})

test('manual full recheck detects tampering even when a filesystem reports retained fingerprints', async t => {
  // Simulate metadata retention without pretending utimes can restore ctime.
  // The files, SQLite stores, size/symlink guards and authenticated reads are real.
  const f = await pair(t, { fingerprintOperation: path => path }), item = await f.publish()
  await f.bs.run()
  await writeFile(item.path, tamperTag(item.bytes))
  await f.bs.run()
  assert.equal(f.reads(item.path), 1)
  assert.doesNotMatch(f.bs.status().message, /未完成/)
  const status = await manualCheck(f.bs)
  assert.match(status.message, /篡改/)
  assert.equal(f.reads(item.path), 2)
  await f.bs.run()
  assert.equal(f.reads(item.path), 3)
})

test('manual full recheck requested during a background scan runs after that scan', { timeout: 10000 }, async t => {
  const f = await pair(t), first = await f.publish('cached task')
  await f.bs.run()
  const second = await f.publish('gated task'), { entered, release } = readGate(t)
  let gated = false
  f.io.read = async (handle, path) => {
    if (path === second.path && !gated) { gated = true; entered.resolve(); await release.promise }
    return handle.readFile()
  }
  const background = f.bs.run()
  await entered.promise
  const checking = manualCheck(f.bs)
  // Wait for the request body to be consumed and full recheck to be queued.
  await new Promise(resolve => setImmediate(resolve))
  release.resolve()
  await Promise.all([background, checking])
  assert.equal(f.reads(first.path), 2)
  assert.equal(f.reads(second.path), 2)
  assert.equal(f.b.getTask(second.task.id).title, 'gated task')
})

test('manual full recheck waits for an exclusive action and preserves run(true) semantics', { timeout: 10000 }, async t => {
  const f = await pair(t), item = await f.publish(), { entered, release } = readGate(t)
  let gated = false
  f.io.read = async (handle, path) => {
    if (path === item.path && !gated) { gated = true; entered.resolve(); await release.promise }
    return handle.readFile()
  }
  const action = f.bs.pause(false)
  await entered.promise
  const checking = f.bs.run({ fullRecheck: true })
  assert.equal(f.bs.status().busy, true)
  await assert.rejects(f.bs.disconnect(), /正在处理/)
  release.resolve()
  await Promise.all([action, checking])
  assert.equal(f.reads(item.path), 2)
  assert.equal(f.bs.status().paused, false)
  assert.equal(f.b.getTask(item.task.id).title, item.task.title)
})

test('disconnect and configure discard successes even when rejoining the same group and directory', async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run(); await f.bs.run()
  assert.equal(f.reads(item.path), 1)
  await f.bs.disconnect()
  await f.bs.configure({ mode: 'shared', directory: f.folder, joinKey: f.av.read('sync-key') })
  assert.equal(f.reads(item.path), 2)
  await f.bs.run()
  assert.equal(f.reads(item.path), 2)
})

test('close waits for current work, starts no queued full scan, and a new instance has no cache', { timeout: 10000 }, async t => {
  const f = await pair(t), item = await f.publish(), { entered, release } = readGate(t)
  f.io.read = async (handle, path) => {
    if (path === item.path) { entered.resolve(); await release.promise }
    return handle.readFile()
  }
  const running = f.bs.run()
  await entered.promise
  const queued = f.bs.run({ fullRecheck: true }), closing = f.bs.close()
  release.resolve()
  await Promise.all([running, queued, closing])
  assert.equal(f.reads(item.path), 1)
  await f.bs.run({ fullRecheck: true })
  assert.equal(f.reads(item.path), 1)
  delete f.io.read
  const reopened = f.newReceiver()
  await reopened.run()
  assert.equal(f.reads(item.path), 2)
  assert.equal(f.receives(item.op), 2)
})

for (const field of ['groupId', 'keyId']) test(`${field} is revalidated even when all operation files are cached`, async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  const path = join(f.folder, '.astaria-sync', 'group.json'), marker = JSON.parse(await readFile(path, 'utf8'))
  marker[field] = '0'.repeat(field === 'groupId' ? 32 : 64)
  await writeFile(path, JSON.stringify(marker))
  await f.bs.run()
  assert.match(f.bs.status().message, /目录或密钥发生变化/)
  assert.equal(f.reads(item.path), 1)
})

test('new group identity cannot inherit successes for identical old paths and stats', async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  const path = join(f.folder, '.astaria-sync', 'group.json'), marker = JSON.parse(await readFile(path, 'utf8'))
  const info = await lstat(item.path, { bigint: true })
  marker.groupId = 'f'.repeat(32)
  await writeFile(path, JSON.stringify(marker))
  // Also exercise the scope guard when config is changed outside the wrapper.
  f.b.sync.disconnect()
  f.b.sync.configure({ groupId: marker.groupId, directory: f.folder, mode: 'shared' })
  await f.bs.run()
  const after = await lstat(item.path, { bigint: true })
  assert.equal(after.ino, info.ino)
  assert.equal(after.mtimeNs, info.mtimeNs)
  assert.equal(after.ctimeNs, info.ctimeNs)
  assert.equal(f.reads(item.path), 2)
  assert.match(f.bs.status().message, /同步组不匹配/)
})

test('a different directory in the same group requires new authenticated reads', async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  const other = join(f.root, 'other-shared')
  await cp(f.folder, other, { recursive: true })
  f.b.sync.disconnect()
  f.b.sync.configure({ groupId: f.a.sync.config().groupId, directory: other, mode: 'shared' })
  await f.bs.run()
  const newPath = join(other, '.astaria-sync', 'devices', item.op.deviceId, 'operations', operationName(item.op))
  assert.equal(f.reads(newPath), 1)
  assert.equal(f.reads(item.path), 1)
  assert.equal(f.b.getTask(item.task.id).title, item.task.title)
})

for (const kind of ['root', 'marker', 'devices', 'device', 'operations']) test(`${kind} directory symlinks are rejected on a cached round`, async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  const paths = {
    root: f.folder, marker: join(f.folder, '.astaria-sync'), devices: join(f.folder, '.astaria-sync', 'devices'),
    device: join(f.folder, '.astaria-sync', 'devices', item.op.deviceId), operations: f.operations,
  }
  const path = paths[kind], saved = join(f.root, `moved-${kind}`)
  await rename(path, saved); await symlink(saved, path, 'dir')
  try {
    await f.bs.run()
    assert.match(f.bs.status().message, /符号链接/)
    assert.equal(f.reads(item.path), 1)
  } finally { await unlink(path); await rename(saved, path) }
})

test('root permissions are rechecked on cached rounds', { skip: process.getuid?.() === 0 }, async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  await chmod(f.folder, 0)
  try {
    await f.bs.run()
    assert.match(f.bs.status().message, /权限不足/)
    assert.equal(f.reads(item.path), 1)
  } finally { await chmod(f.folder, 0o700) }
})

test('unexpected filenames and incomplete files are reported after cache warmup', async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  await writeFile(join(f.operations, 'conflict-copy.op'), 'untrusted')
  await writeFile(join(f.operations, 'upload.partial'), 'incomplete')
  await f.bs.run()
  assert.match(f.bs.status().message, /无法识别/)
  assert.match(f.bs.status().message, /尚未完整落地/)
  assert.equal(f.reads(item.path), 1)
})

test('candidate count limit remains enforced after accepted-file cache warmup', async t => {
  const f = await pair(t), item = await f.publish()
  await f.bs.run()
  // Use real symlink candidates so checking 20k entries needs no ciphertext reads.
  for (let start = 0; start < 20000; start += 128) {
    await Promise.all(Array.from({ length: Math.min(128, 20000 - start) }, (_, offset) => {
      const index = start + offset + 100000
      return symlink(item.path, join(f.operations, `${String(index).padStart(12, '0')}-${'d'.repeat(32)}.op`))
    }))
  }
  await f.bs.run()
  assert.match(f.bs.status().message, /同步文件超过单轮检查上限/)
  assert.equal(f.reads(item.path), 1)
})
