import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { randomFillSync } from 'node:crypto'
import { MAX_MOBILE_DATABASE_BYTES } from '../mobile/runtime/snapshots.mjs'
import { decodeSnapshot, encodeSnapshot, MAX_SNAPSHOT_BASE64_LENGTH, validateSnapshotBase64 } from '../mobile/runtime/snapshotCodec.mjs'

const runtime = new URL('../mobile/runtime/', import.meta.url)
const dataFile = 'astaria-v1.sqlite'
const sources = Object.fromEntries(await Promise.all(['nativeSnapshots', 'worker', 'bootstrap'].map(async name => {
  const source = await readFile(new URL(`${name}.ts`, runtime), 'utf8')
  return [name, stripTypeScriptTypes(source).replace(/^import .+$/gm, '')]
})))
function factory(name, exported, dependencies) {
  const source = sources[name].replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify(new URL(`${name}.ts`, runtime).href))
  return compileFunction(`${source}\nreturn ${exported}`, Object.keys(dependencies))(...Object.values(dependencies))
}
function snapshot(size = 100) {
  const bytes = new Uint8Array(size)
  bytes.set(new TextEncoder().encode('SQLite format 3\0'))
  for (let index = 16; index < size; index++) bytes[index] = index % 256
  return bytes
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))

test('codec preserves Uint8Array views, all byte values and every padding length without detaching', () => {
  for (const length of [100, 101, 102, 16385]) {
    const buffer = new Uint8Array(length + 20)
    const bytes = buffer.subarray(10, length + 10)
    bytes.set(snapshot(length))
    const before = bytes.slice(), encoded = encodeSnapshot(bytes)
    assert.equal(encoded, Buffer.from(before).toString('base64'))
    assert.equal(validateSnapshotBase64(encoded), encoded)
    assert.deepEqual(decodeSnapshot(encoded), before)
    assert.deepEqual(bytes, before)
    assert.equal(buffer.byteLength, length + 20)
  }
  for (const invalid of [null, undefined, 'bytes', [], new ArrayBuffer(100), new Uint16Array(100), new DataView(new ArrayBuffer(100))]) {
    assert.throws(() => encodeSnapshot(invalid), /校验失败/u)
    assert.throws(() => decodeSnapshot(invalid), /校验失败/u)
  }
})

test('lookup encoder matches Buffer for random bytes, offset views and all padding cases', () => {
  for (const length of [100, 101, 102, 255, 256, 257, 8191, 8192, 8193, 65535, 65536, 65537, 1048576, 1048577, 1048578]) {
    const backing = randomFillSync(new Uint8Array(length + 38))
    const bytes = backing.subarray(17, 17 + length)
    bytes.set(new TextEncoder().encode('SQLite format 3\0'))
    const before = backing.slice()
    const encoded = encodeSnapshot(bytes)
    assert.equal(encoded, Buffer.from(bytes).toString('base64'), `length ${length}`)
    assert.equal(encoded.length, 4 * Math.ceil(length / 3))
    assert.deepEqual(decodeSnapshot(encoded), bytes)
    assert.deepEqual(backing, before, 'encoding never mutates or detaches the source view or its backing bytes')
  }
})

test('codec accepts exactly 64 MiB and rejects encoded and decoded lengths above the limit', () => {
  const bytes = snapshot(MAX_MOBILE_DATABASE_BYTES)
  const base64 = encodeSnapshot(bytes)
  assert.equal(base64.length, MAX_SNAPSHOT_BASE64_LENGTH)
  assert.deepEqual(decodeSnapshot(base64), bytes)
  assert.throws(() => encodeSnapshot(new Uint8Array(MAX_MOBILE_DATABASE_BYTES + 1)), /校验失败/u)
  // Same encoded length can represent one or two extra bytes without padding.
  for (const value of [base64.slice(0, -2) + 'AA', base64.slice(0, -1) + 'A', base64 + 'AAAA']) {
    assert.throws(() => validateSnapshotBase64(value), /校验失败/u)
    assert.throws(() => decodeSnapshot(value), /校验失败/u)
  }
})

test('codec rejects illegal Base64, noncanonical pad bits, truncated data and wrong SQLite headers', () => {
  const valid = encodeSnapshot(snapshot())
  const malformed = ['', valid.slice(0, -1), valid + '\n', ' ' + valid, `data:application/octet-stream;base64,${valid}`,
    '=' + valid.slice(1), valid.slice(0, -4) + 'A===', valid.slice(0, -4) + 'AA=A',
    valid.slice(0, -4) + 'AB==', valid.slice(0, -4) + 'AAB=', '-' + valid.slice(1), '_' + valid.slice(1), '中' + valid.slice(1)]
  for (const value of malformed) assert.throws(() => decodeSnapshot(value), /校验失败/u, value)
  for (const bytes of [snapshot().subarray(0, 99), new Uint8Array(100), snapshot()]) {
    if (bytes[0]) bytes[15] = 1
    assert.throws(() => encodeSnapshot(bytes), /校验失败/u)
    assert.throws(() => decodeSnapshot(Buffer.from(bytes).toString('base64')), /校验失败/u)
  }
})

function filesystem() {
  const files = new Map(), calls = []
  const state = { fault: undefined, failCleanup: false, renameGate: undefined, renameStarted: undefined }
  const native = {
    async writeFile({ directory, path, data }) {
      assert.equal(directory, 'DATA'); assert.equal(typeof data, 'string')
      calls.push(['write', path])
      if (state.fault === 'write') throw Error('disk full')
      files.set(path, data)
    },
    async readFile({ directory, path }) {
      assert.equal(directory, 'DATA'); calls.push(['read', path])
      if (!files.has(path)) throw Object.assign(Error('missing'), { code: 'OS-PLUG-FILE-0008' })
      if (path !== dataFile) {
        if (state.fault === 'read') throw Error('read failed')
        if (state.fault === 'different') return { data: (files.get(path)[0] === 'A' ? 'B' : 'A') + files.get(path).slice(1) }
        if (state.fault === 'equivalent') return { data: files.get(path) + '\n' }
        if (state.fault === 'blob') return { data: new Blob(['invalid native result']) }
      }
      return { data: files.get(path) }
    },
    async rename({ directory, from, to }) {
      assert.equal(directory, 'DATA'); assert.equal(to, dataFile); calls.push(['rename', from])
      state.renameStarted?.resolve()
      if (state.renameGate) await state.renameGate.promise
      if (state.fault === 'rename') throw Error('rename failed')
      files.set(to, files.get(from)); files.delete(from)
    },
    async deleteFile({ directory, path }) {
      assert.equal(directory, 'DATA'); assert.notEqual(path, dataFile); calls.push(['delete', path])
      if (state.failCleanup) throw Error('temp cleanup failed')
      files.delete(path)
    },
  }
  const storage = factory('nativeSnapshots', 'nativeSnapshots', {
    Directory: { Data: 'DATA' }, Filesystem: native, validateSnapshotBase64,
    atob: () => assert.fail('UI must not decode'), btoa: () => assert.fail('UI must not encode'),
  })()
  return { files, calls, state, storage }
}

test('native storage validates bounded strings before I/O and returns the unchanged Base64 string', async () => {
  const fs = filesystem(), base64 = encodeSnapshot(snapshot())
  assert.equal(await fs.storage.load(), undefined)
  for (const invalid of [snapshot(), null, '', base64 + '\n', 'A'.repeat(MAX_SNAPSHOT_BASE64_LENGTH + 4)]) {
    const before = fs.calls.length
    await assert.rejects(fs.storage.save(invalid), /校验失败/u)
    assert.equal(fs.calls.length, before)
  }
  await fs.storage.save(base64)
  assert.equal(await fs.storage.load(), base64)
  assert.deepEqual(fs.calls.slice(1, 5).map(([kind]) => kind), ['write', 'read', 'rename', 'delete'])
  assert.deepEqual([...fs.files.keys()], [dataFile])
  fs.files.set(dataFile, new Blob(['not Base64']))
  await assert.rejects(fs.storage.load(), /原文件已保留/u)
  fs.files.set(dataFile, '!'.repeat(136))
  await assert.rejects(fs.storage.load(), /原文件已保留/u)
})

for (const fault of ['write', 'read', 'different', 'equivalent', 'blob', 'rename']) {
  test(`native ${fault} failure preserves the previous file and cleans temp before rejecting`, async () => {
    const fs = filesystem(), original = encodeSnapshot(snapshot()), next = encodeSnapshot(snapshot(101))
    fs.files.set(dataFile, original); fs.state.fault = fault
    await assert.rejects(fs.storage.save(next), /原文件已保留/u)
    assert.equal(fs.files.get(dataFile), original)
    assert.deepEqual([...fs.files.keys()], [dataFile])
    assert.equal(fs.calls.at(-1)[0], 'delete')
    assert.equal(fs.calls.some(([kind]) => kind === 'rename'), fault === 'rename')
  })
}

test('cleanup failure cannot turn a failed write into success or mask a committed rename', async () => {
  const fs = filesystem(), base64 = encodeSnapshot(snapshot())
  fs.state.failCleanup = true
  await fs.storage.save(base64)
  assert.equal(fs.files.get(dataFile), base64)
  assert.equal(fs.calls.at(-1)[0], 'delete')
  fs.state.fault = 'different'
  await assert.rejects(fs.storage.save(encodeSnapshot(snapshot(101))), /原文件已保留/u)
  assert.equal(fs.files.get(dataFile), base64)
  assert.equal(fs.calls.at(-1)[0], 'delete')
})

// Execute the actual Worker message handler in a real Node worker, and the
// actual bootstrap/native bridge against an in-memory Capacitor filesystem.
// Only unrelated platform services are stubs; all snapshot/session code is real.
const workerSource = `
import { parentPort } from 'node:worker_threads'
import initSQLJs from ${JSON.stringify(import.meta.resolve('sql.js'))}
import { createMobileSession } from ${JSON.stringify(new URL('session.mjs', runtime).href)}
import { indexedSnapshots } from ${JSON.stringify(new URL('snapshots.mjs', runtime).href)}
import { decodeSnapshot, encodeSnapshot } from ${JSON.stringify(new URL('snapshotCodec.mjs', runtime).href)}
const wasmUrl = ${JSON.stringify(fileURLToPath(import.meta.resolve('sql.js/dist/sql-wasm.wasm')))}
const persona = '', working = ''
const createMobilePageFetcher = () => async () => { throw Error('network forbidden in snapshot test') }
const self = { postMessage: (...args) => parentPort.postMessage(...args) }
${sources.worker}
parentPort.on('message', data => self.onmessage({ data }))
`
async function start(t, fs, platform = 'ios') {
  let worker, onStateChange
  const messages = [], sent = [], window = { fetch: async () => { throw Error('network forbidden') }, location: { origin: 'http://fixture.invalid' } }
  class RuntimeWorker {
    constructor() {
      worker = new Worker(new URL(`data:text/javascript;base64,${Buffer.from(workerSource).toString('base64')}`))
      worker.on('message', data => { messages.push(data); void this.onmessage?.({ data }) })
      worker.on('error', error => this.onerror?.(error))
      t.after(() => worker.terminate())
    }
    postMessage(message, transfer) { sent.push(structuredClone(message)); worker.postMessage(message, transfer) }
  }
  const bootstrap = factory('bootstrap', 'startMobileRuntime', {
    Worker: RuntimeWorker, Capacitor: { isNativePlatform: () => true, getPlatform: () => platform },
    App: { addListener: async (_name, callback) => { onStateChange = callback } },
    nativeSnapshots: () => fs.storage,
    nativeSecrets: () => ({ status: async () => false, read: async () => { throw Error('no credentials in snapshot test') } }),
    nativeRequest: () => { throw Error('network forbidden') }, createCapacitorSourceExecutor: () => () => { throw Error('network forbidden') },
    createMobileReminders: () => ({ scheduleRefresh: async () => {} }), packageInfo: { version: 'test' },
    mobilePlatformRequests: ({ call }) => call, mobileTransport: ({ request }) => request,
    PAGE_ACTIVITY_EVENT: 'astaria-app-activity',
    // The native viewport has independent reducer/bridge tests. Snapshot tests
    // exercise the actual Worker/filesystem without an Android UI surface.
    initializeMobileViewport: async () => () => {},
    window, document: Object.assign(new EventTarget(), { documentElement: { dataset: {}, style: { setProperty() {}, getPropertyValue() { return '' } } } }),
  })
  await bootstrap()
  return { call: (...args) => window.fetch(...args), messages, sent, background: () => onStateChange({ isActive: false }), stop: () => worker.terminate() }
}

for (const platform of ['ios', 'android']) {
  test(`${platform} real Worker bridge waits for rename acknowledgement and reloads the same SQLite file`, { timeout: 15000 }, async t => {
    const fs = filesystem(), app = await start(t, fs, platform)
    fs.state.renameGate = deferred(); fs.state.renameStarted = deferred()
    let acknowledged = false
    const pending = app.call('/api/tasks/create', { title: '等待原生持久化确认' }).then(value => { acknowledged = true; return value })
    await fs.state.renameStarted.promise
    await tick()
    assert.equal(acknowledged, false)
    fs.state.renameGate.resolve()
    const task = await pending
    const saved = fs.files.get(dataFile)
    assert.equal(typeof saved, 'string')
    assert.equal((await app.call('/api/tasks'))[0].id, task.id)
    const writes = fs.calls.filter(([kind]) => kind === 'write').length
    app.background(); await app.call('/api/tasks')
    assert.equal(fs.calls.filter(([kind]) => kind === 'write').length, writes, 'unchanged snapshot retains its hash/dirty check')
    for (const message of app.messages.filter(message => message.operation === 'storage.save')) assert.equal(typeof message.input, 'string')
    await app.stop()
    fs.state.renameGate = undefined
    const restored = await start(t, fs, platform)
    assert.equal((await restored.call('/api/tasks'))[0].id, task.id)
    const load = restored.messages.find(message => message.operation === 'storage.load')
    assert.ok(restored.sent.find(message => message.id === load.id).result === saved, 'native load returns the exact prior file as Base64')
  })
}

for (const fault of ['write', 'read', 'different', 'equivalent', 'rename']) {
  test(`real Worker ${fault} bridge failure rejects success, freezes the session and restores only acknowledged data`, { timeout: 15000 }, async t => {
    const fs = filesystem(), app = await start(t, fs)
    const task = await app.call('/api/tasks/create', { title: '已确认快照' })
    const before = fs.files.get(dataFile)
    fs.state.fault = fault
    await assert.rejects(app.call('/api/tasks/create', { title: '不能确认的写入' }), /没有确认成功/u)
    assert.ok(fs.files.get(dataFile) === before, 'failed bridge must preserve the exact acknowledged file')
    assert.deepEqual([...fs.files.keys()], [dataFile])
    await assert.rejects(app.call('/api/tasks'), /存储尚未恢复/u)
    await app.stop(); fs.state.fault = undefined
    const restored = await start(t, fs)
    assert.deepEqual((await restored.call('/api/tasks')).map(value => value.id), [task.id])
  })
}

test('real Worker rejects a corrupt header returned by native load without replacing the file', { timeout: 15000 }, async t => {
  const fs = filesystem(), invalid = Buffer.from(new Uint8Array(100)).toString('base64')
  fs.files.set(dataFile, invalid)
  await assert.rejects(start(t, fs), /校验失败/u)
  assert.equal(fs.files.get(dataFile), invalid)
  assert.deepEqual(fs.calls.map(([kind]) => kind), ['read'])
})

test('real Worker rejects a truncated SQLite file even when its header and minimum length pass the codec', { timeout: 15000 }, async t => {
  const fs = filesystem(), app = await start(t, fs)
  await app.call('/api/tasks/create', { title: '截断测试夹具' })
  await app.stop()
  const truncated = Buffer.from(fs.files.get(dataFile), 'base64').subarray(0, 100).toString('base64')
  assert.equal(decodeSnapshot(truncated).length, 100, 'SQLite structural checks still belong to session startup')
  fs.files.set(dataFile, truncated); fs.calls.length = 0
  await assert.rejects(start(t, fs))
  assert.ok(fs.files.get(dataFile) === truncated, 'failed startup preserves the truncated file for recovery')
  assert.deepEqual(fs.calls.map(([kind]) => kind), ['read'])
})
