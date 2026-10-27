import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'
import { encodeSnapshot, validateSnapshotBase64 } from '../mobile/runtime/snapshotCodec.mjs'

const DATA = 'astaria-v1.sqlite'
const UUID = '12345678-1234-4abc-8123-123456789abc'
const temporary = uuid => `${DATA}.${uuid}.next`
const orphan = temporary(UUID)
const source = stripTypeScriptTypes(await readFile(new URL('../mobile/runtime/nativeSnapshots.ts', import.meta.url), 'utf8'))
  .replace(/^import .+$/gm, '').replace(/^export /gm, '')
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
function snapshot(length = 100) {
  const bytes = new Uint8Array(length)
  bytes.set(new TextEncoder().encode('SQLite format 3\0'))
  return encodeSnapshot(bytes)
}
function fixture(files = new Map()) {
  const calls = [], state = { deleteFailures: new Set(), types: new Map() }
  const record = (operation, path, directory) => {
    assert.equal(directory, 'DATA'); calls.push([operation, path])
  }
  const fs = {
    async readdir({ directory, path }) {
      record('readdir', path, directory); assert.equal(path, '')
      state.listEntered?.resolve(); await state.listGate?.promise
      if (state.failList) throw Error('synthetic list permission failure')
      return { files: [...files.keys()].map(name => ({ name, type: state.types.get(name) ?? 'file' })) }
    },
    async deleteFile({ directory, path }) {
      record('delete', path, directory); assert.notEqual(path, DATA)
      state.deleteEntered?.resolve(); await state.deleteGate?.promise
      if (state.deleteFailures.has(path)) throw Error('synthetic deletion failure')
      files.delete(path)
    },
    async readFile({ directory, path }) {
      record('read', path, directory)
      if (!files.has(path)) throw Object.assign(Error('missing'), { code: 'OS-PLUG-FILE-0008' })
      return { data: files.get(path) }
    },
    async writeFile({ directory, path, data }) {
      record('write', path, directory); files.set(path, data)
      state.writeEntered?.resolve(path); await state.writeGate?.promise
    },
    async rename({ directory, from, to }) {
      record('rename', from, directory); assert.equal(to, DATA)
      assert.ok(files.has(from), 'an active snapshot must survive until rename')
      if (state.failRename) throw Error('synthetic rename failure')
      files.set(to, files.get(from)); files.delete(from)
    },
  }
  const create = compileFunction(`${source}\nreturn nativeSnapshots`, ['Filesystem', 'Directory', 'validateSnapshotBase64'])(
    fs, { Data: 'DATA' }, validateSnapshotBase64)
  return { create, storage: create(), files, state, calls }
}

test('R11 startup deletes only exact app UUID-v4 file basenames and preserves the main snapshot', async () => {
  const original = snapshot()
  const valid = ['8', '9', 'a', 'b'].map(variant => temporary(UUID.replace('-8123-', `-${variant}123-`)))
  const directory = temporary('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee')
  const preserved = [DATA, 'other.sqlite', 'unrelated.next', `${DATA}.next`, `${DATA}.backup`,
    `${DATA}-wal`, `${DATA}-shm`, `${DATA}.not-a-uuid.next`, temporary(UUID.toUpperCase()),
    temporary(UUID.replace('-4abc-', '-1abc-')), temporary(UUID.replace('-8123-', '-c123-')),
    temporary('00000000-0000-0000-0000-000000000000'), `${orphan}.bak`, `${orphan}\n`, `${orphan}\r`,
    `${orphan}\u0000`, `prefix-${orphan}`, `nested/${orphan}`, `../${orphan}`, `nested\\${orphan}`, directory]
  const fs = fixture(new Map([...valid, ...preserved].map(name => [name, name === DATA ? original : 'synthetic orphan bytes'])))
  fs.state.types.set(directory, 'directory')
  assert.equal(await fs.storage.load(), original)
  assert.deepEqual(fs.calls.filter(([op]) => op === 'delete').map(([, path]) => path).sort(), valid.sort())
  assert.deepEqual([...fs.files.keys()].sort(), preserved.sort())
  assert.deepEqual(fs.calls.filter(([op]) => op === 'read'), [['read', DATA]], 'never open orphan contents')
})

test('R11 cleanup runs when the main snapshot is missing or malformed without promoting an orphan', async () => {
  for (const main of [undefined, 'malformed-base64']) {
    const fs = fixture(new Map([[orphan, snapshot()]]))
    if (main !== undefined) fs.files.set(DATA, main)
    if (main === undefined) assert.equal(await fs.storage.load(), undefined)
    else await assert.rejects(fs.storage.load(), /原文件已保留/u)
    assert.equal(fs.files.has(orphan), false)
    assert.equal(fs.files.get(DATA), main)
    assert.equal(fs.calls.some(([op]) => ['write', 'rename'].includes(op)), false)
  }
})

test('R11 listing failure does not block the main snapshot and is retried by a fresh runtime', async () => {
  const original = snapshot(), fs = fixture(new Map([[DATA, original], [orphan, 'orphan']]))
  fs.state.failList = true
  assert.equal(await fs.storage.load(), original)
  assert.equal(fs.files.get(orphan), 'orphan')
  await fs.storage.save(snapshot(101))
  assert.equal(fs.files.get(DATA), snapshot(101))
  const restarted = fixture(fs.files)
  assert.equal(await restarted.storage.load(), snapshot(101))
  assert.equal(fs.files.has(orphan), false)
})

test('R11 one failed deletion does not skip other orphans or mask a later save failure', async () => {
  const other = temporary(UUID.replace('-8123-', '-9123-')), original = snapshot()
  const fs = fixture(new Map([[DATA, original], [orphan, 'orphan'], [other, 'orphan']]))
  fs.state.deleteFailures.add(orphan)
  assert.equal(await fs.storage.load(), original)
  assert.equal(fs.files.has(orphan), true)
  assert.equal(fs.files.has(other), false)
  fs.state.failRename = true
  await assert.rejects(fs.storage.save(snapshot(101)), /原文件已保留/u)
  assert.equal(fs.files.get(DATA), original)
  assert.deepEqual([...fs.files.keys()].sort(), [DATA, orphan].sort())
})

test('R11 saves and loads across adapters share the startup barrier until orphan deletion finishes', { timeout: 2000 }, async () => {
  const fs = fixture(new Map([[DATA, snapshot()], [orphan, 'orphan']]))
  fs.state.listGate = deferred(); fs.state.listEntered = deferred()
  fs.state.deleteGate = deferred(); fs.state.deleteEntered = deferred()
  const saving = fs.storage.save(snapshot(101)), loading = fs.create().load()
  await fs.state.listEntered.promise; await tick()
  assert.deepEqual(fs.calls, [['readdir', '']])
  fs.state.listGate.resolve(); await fs.state.deleteEntered.promise; await tick()
  assert.equal(fs.calls.some(([op]) => ['write', 'read', 'rename'].includes(op)), false)
  fs.state.deleteGate.resolve(); await Promise.all([saving, loading])
  assert.equal(fs.files.get(DATA), snapshot(101))
  assert.equal(fs.calls.filter(([op]) => op === 'readdir').length, 1)
})

test('R11 repeated loads and new adapters cannot delete a live temporary file', { timeout: 2000 }, async () => {
  const original = snapshot(), fs = fixture(new Map([[DATA, original]]))
  fs.state.writeGate = deferred(); fs.state.writeEntered = deferred()
  // Deliberately save before any load: startup safety cannot depend on call order.
  const saving = fs.storage.save(snapshot(101))
  const active = await fs.state.writeEntered.promise
  for (const storage of [fs.storage, fs.create(), fs.storage]) assert.equal(await storage.load(), original)
  assert.equal(fs.files.get(active), snapshot(101))
  assert.equal(fs.calls.some(([op, path]) => op === 'delete' && path === active), false)
  assert.equal(fs.calls.filter(([op]) => op === 'readdir').length, 1)
  fs.state.writeGate.resolve(); await saving
  assert.equal(fs.files.get(DATA), snapshot(101))
  assert.deepEqual([...fs.files.keys()], [DATA])
})

test('R11 invalid saves perform no cleanup or filesystem I/O', async () => {
  const fs = fixture(new Map([[orphan, 'orphan']]))
  await assert.rejects(fs.storage.save('invalid'), /校验失败/u)
  assert.deepEqual(fs.calls, [])
  assert.equal(fs.files.has(orphan), true)
})
