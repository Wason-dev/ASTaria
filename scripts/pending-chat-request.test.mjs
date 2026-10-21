import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { deflateSync, inflateSync } from 'node:zlib'
import { createIndexedDBPendingChatAdapter, createPendingChatRequestStore, PENDING_CHAT_INDEX_KEY, PENDING_CHAT_SCOPE_KEY } from '../src/xixi/pendingChatRequest.ts'
import { CHAT_IMAGE_MAX_BYTES, inspectChatImage } from '../src/xixi/chatImagePolicy.ts'

// The pending-chat store is the only durable owner of an unsent message. These
// tests use real PNG bytes, a real serialized session store and a real adapter
// contract: no browser, no IndexedDB and no user data.

const context = { page: 'home', timezone: 'Asia/Shanghai' }
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0)
  return value >>> 0
})
const crc32 = bytes => {
  let crc = 0xffffffff
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255]
  return (crc ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const chunk = Buffer.alloc(data.length + 12)
  chunk.writeUInt32BE(data.length); chunk.write(type, 4); data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return chunk
}
// A real 2 × 3 truecolour PNG with deflated scanlines.
function realPng() {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(2); header.writeUInt32BE(3, 4); header[8] = 8; header[9] = 2
  const rows = Buffer.alloc((2 * 3 + 1) * 3)
  for (let index = 0; index < rows.length; index++) rows[index] = (index * 7) % 251
  for (let row = 0; row < 3; row++) rows[row * 7] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0))])
}
const png = realPng()
const rawScanlines = (2 * 3 + 1) * 3
function paddedPng(size) {
  const text = Buffer.alloc(size - png.length - 12, 'p')
  Buffer.from('Padding\0').copy(text)
  return Buffer.concat([png.subarray(0, -12), pngChunk('tEXt', text), png.subarray(-12)])
}
const attachmentFor = (bytes, name = '原图.png') => ({ name, mime: 'image/png', size: bytes.length, data: `data:image/png;base64,${Buffer.from(bytes).toString('base64')}` })
const storedBytes = attachment => Buffer.from(attachment.data.split(',')[1], 'base64')
const request = (overrides = {}) => ({ requestId: 'req-1', conversationId: 'main', text: '把今天的安排整理一下', context, createdAt: '2026-10-12T09:00:00.000Z', seq: 3, ...overrides })
const indexRecord = value => ({ version: 2, requestId: value.requestId, conversationId: value.conversationId, ...(value.createdAt !== undefined ? { createdAt: value.createdAt } : {}), ...(value.seq !== undefined ? { seq: value.seq } : {}) })

function sessionFixture(seed = {}) {
  const values = new Map(Object.entries(seed))
  let failure = null
  return {
    values,
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem(key, value) {
      if (failure?.(key)) throw new Error('session storage is full')
      values.set(key, value)
    },
    failSetItem(predicate) { failure = predicate },
    allowSetItem() { failure = null },
    raw: key => values.get(key) ?? null,
  }
}
function memoryAdapter() {
  const buckets = new Map()
  const calls = { list: [], put: [], remove: [] }
  const hooks = { list: null, put: null, remove: null }
  const bucket = scope => { if (!buckets.has(scope)) buckets.set(scope, new Map()); return buckets.get(scope) }
  const gate = async kind => { const hook = hooks[kind]; if (!hook) return; hooks[kind] = null; await hook() }
  return {
    calls,
    buckets,
    onNextList: hook => { hooks.list = hook },
    onNextPut: hook => { hooks.put = hook },
    onNextRemove: hook => { hooks.remove = hook },
    total: () => [...buckets.values()].reduce((count, records) => count + records.size, 0),
    records: scope => Object.fromEntries([...bucket(scope)].map(([id, value]) => [id, structuredClone(value)])),
    seed(scope, record) { bucket(scope).set(record.requestId, structuredClone(record)) },
    async list(scope) { calls.list.push(scope); await gate('list'); return [...bucket(scope).values()].map(value => structuredClone(value)) },
    async put(scope, value) { calls.put.push({ scope, requestId: value.requestId }); await gate('put'); bucket(scope).set(value.requestId, structuredClone(value)) },
    async remove(scope, ids) { calls.remove.push({ scope, ids: [...ids] }); await gate('remove'); for (const id of ids) bucket(scope).delete(id) },
  }
}
const fixture = (options = {}) => {
  const session = options.session ?? sessionFixture()
  const adapter = options.adapter ?? memoryAdapter()
  const store = createPendingChatRequestStore({ session, adapter, createId: options.createId ?? (() => 'scope-1') })
  return { session, adapter, store }
}

test('a real 10 MiB PNG stays byte-identical in the durable store while the session index keeps no image or body', async () => {
  const bytes = paddedPng(CHAT_IMAGE_MAX_BYTES)
  assert.equal(bytes.length, CHAT_IMAGE_MAX_BYTES)
  assert.deepEqual(inspectChatImage(bytes), { mime: 'image/png', width: 2, height: 3 })
  const scanlines = inflateSync(bytes.subarray(bytes.indexOf('IDAT') + 4, bytes.indexOf('IDAT') + 4 + bytes.readUInt32BE(bytes.indexOf('IDAT') - 4)))
  assert.equal(scanlines.length, rawScanlines)
  assert.ok([0, 7, 14].every(offset => scanlines[offset] === 0), 'every real PNG scanline uses a valid filter')
  const digest = sha256(bytes)
  const { session, adapter, store } = fixture()
  const record = request({ requestId: 'req-big', text: '看这张原图', seq: 1, attachments: [attachmentFor(bytes)] })
  await store.save(record)
  const [restored] = await store.list()
  assert.equal(restored.requestId, 'req-big')
  assert.equal(restored.attachments.length, 1)
  assert.equal(restored.attachments[0].size, CHAT_IMAGE_MAX_BYTES)
  assert.equal(createHash('sha256').update(storedBytes(restored.attachments[0])).digest('hex'), digest)
  assert.equal(Buffer.compare(storedBytes(restored.attachments[0]), bytes), 0)
  // The session index is a version 2 light index: no text, no Base64, no bytes.
  const index = session.raw(PENDING_CHAT_INDEX_KEY)
  assert.deepEqual(JSON.parse(index), [indexRecord(record)])
  assert.equal(index.includes('base64'), false)
  assert.equal(index.includes('看这张原图'), false)
  assert.equal(index.includes(bytes.subarray(0, 48).toString('base64').slice(0, 32)), false)
  assert.ok(index.length < 512, `index kept ${index.length} bytes`)
  assert.equal(adapter.total(), 1)
})

test('a fresh store over the same window restores the same ID, time, sequence and bytes without a new scope', async () => {
  const bytes = paddedPng(64 * 1024)
  const session = sessionFixture()
  const adapter = memoryAdapter()
  let created = 0
  const first = createPendingChatRequestStore({ session, adapter, createId: () => { created++; return 'scope-1' } })
  const record = request({ requestId: 'req-refresh', text: '刷新后还要能重试', seq: 5, attachments: [attachmentFor(bytes)] })
  await first.save(record)
  const refreshed = createPendingChatRequestStore({ session, adapter, createId: () => { throw new Error('a refresh must reuse the saved scope') } })
  const [restored] = await refreshed.list()
  assert.deepEqual(restored, record)
  assert.equal(Buffer.compare(storedBytes(restored.attachments[0]), bytes), 0)
  assert.equal(session.raw(PENDING_CHAT_SCOPE_KEY), 'scope-1')
  assert.equal(created, 1)
})

test('a version 1 session index migrates into the adapter with its original ID, time, sequence and bytes', async () => {
  const bytes = paddedPng(8 * 1024)
  const legacy = request({ requestId: 'legacy-1', text: '旧版本留下的消息', createdAt: '2026-10-01T01:00:00.000Z', seq: 7, attachments: [attachmentFor(bytes)] })
  const session = sessionFixture({ [PENDING_CHAT_INDEX_KEY]: JSON.stringify([legacy]) })
  const adapter = memoryAdapter()
  const store = createPendingChatRequestStore({ session, adapter, createId: () => 'scope-9' })
  const items = await store.list()
  assert.deepEqual(items, [legacy])
  assert.deepEqual(adapter.records('scope-9'), { 'legacy-1': legacy })
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)), [indexRecord(legacy)])
  assert.equal(session.raw(PENDING_CHAT_INDEX_KEY).includes('base64'), false)
})

test('a failed migration keeps the full retry record and recovers it with the same ID and bytes', async () => {
  const bytes = paddedPng(4096)
  const legacy = request({ requestId: 'legacy-2', text: '迁移失败的原文', seq: 2, attachments: [attachmentFor(bytes)] })
  const session = sessionFixture({ [PENDING_CHAT_INDEX_KEY]: JSON.stringify([legacy]) })
  const adapter = memoryAdapter()
  const store = createPendingChatRequestStore({ session, adapter, createId: () => 'scope-2' })
  adapter.onNextPut(() => { throw new Error('本机存储空间不足') })
  await assert.rejects(store.list(), /本机存储空间不足/)
  // The old record survives untouched; nothing was upgraded or lost.
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)), [legacy])
  assert.equal(adapter.total(), 0)
  const [restored] = await store.list()
  assert.deepEqual(restored, legacy)
  assert.equal(sha256(storedBytes(restored.attachments[0])), sha256(bytes))
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)), [indexRecord(legacy)])
})

test('a failed index write blocks the save but keeps the committed request recoverable under the same ID', async () => {
  const { session, adapter, store } = fixture()
  const record = request({ requestId: 'req-index', text: '索引写失败也要保住' })
  session.failSetItem(key => key === PENDING_CHAT_INDEX_KEY)
  await assert.rejects(store.save(record), /session storage is full/)
  // The request is committed in the adapter; only the light index is missing.
  assert.equal(adapter.total(), 1)
  assert.equal(session.raw(PENDING_CHAT_INDEX_KEY), null)
  session.allowSetItem()
  await store.save(record)
  assert.equal(adapter.calls.put.length, 1)
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)), [indexRecord(record)])
  const refreshed = createPendingChatRequestStore({ session, adapter, createId: () => { throw new Error('must reuse the window scope') } })
  assert.deepEqual(await refreshed.list(), [record])
  assert.equal(adapter.total(), 1)
})

test('a delayed adapter commit is only visible after it resolves', async () => {
  const { session, adapter, store } = fixture()
  const commit = deferred()
  adapter.onNextPut(() => commit.promise)
  let settled = false
  const saving = store.save(request({ requestId: 'req-slow' })).then(() => { settled = true })
  await tick()
  assert.equal(settled, false)
  assert.equal(adapter.total(), 0)
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)), [])
  commit.resolve()
  await saving
  assert.equal(adapter.total(), 1)
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)).map(item => item.requestId), ['req-slow'])
})

test('a failed adapter commit rejects the save and leaves the index and adapter unchanged', async () => {
  const { session, adapter, store } = fixture()
  await store.save(request({ requestId: 'req-keep' }))
  const index = session.raw(PENDING_CHAT_INDEX_KEY)
  adapter.onNextPut(() => { throw new Error('提交失败') })
  await assert.rejects(store.save(request({ requestId: 'req-drop', text: '这次没有提交' })), /提交失败/)
  assert.equal(session.raw(PENDING_CHAT_INDEX_KEY), index)
  assert.equal(adapter.total(), 1)
  assert.deepEqual((await store.list()).map(item => item.requestId), ['req-keep'])
})

test('a repeated request ID with different content is rejected and the committed record is kept', async () => {
  const { session, adapter, store } = fixture()
  const record = request({ requestId: 'req-fixed', text: '第一次的内容' })
  await store.save(record)
  const index = session.raw(PENDING_CHAT_INDEX_KEY)
  await assert.rejects(store.save({ ...record, text: '换了内容' }), /发送标识已用于不同内容/)
  await assert.rejects(store.save({ ...record, attachments: [attachmentFor(paddedPng(2048))] }), /发送标识已用于不同内容/)
  assert.equal(session.raw(PENDING_CHAT_INDEX_KEY), index)
  assert.deepEqual(await store.list(), [record])
  assert.equal(adapter.calls.put.length, 1)
  await store.save(record)
  assert.equal(adapter.calls.put.length, 1)
})

test('windows and conversations stay isolated and removeConversation clears only its records', async () => {
  const adapter = memoryAdapter()
  const first = fixture({ adapter, createId: () => 'scope-a' })
  const second = fixture({ adapter, createId: () => 'scope-b' })
  await first.store.save(request({ requestId: 'a-1', conversationId: 'main', text: '窗口 A 的主对话' }))
  await first.store.save(request({ requestId: 'a-2', conversationId: 'other', text: '窗口 A 的另一个对话' }))
  await second.store.save(request({ requestId: 'b-1', conversationId: 'main', text: '窗口 B 的主对话' }))
  assert.deepEqual((await first.store.list()).map(item => item.requestId), ['a-1', 'a-2'])
  assert.deepEqual((await second.store.list()).map(item => item.requestId), ['b-1'])
  await first.store.removeConversation('main')
  assert.deepEqual((await first.store.list()).map(item => item.requestId), ['a-2'])
  assert.deepEqual((await second.store.list()).map(item => item.requestId), ['b-1'])
  assert.deepEqual(adapter.calls.remove, [{ scope: 'scope-a', ids: ['a-1'] }])
  assert.equal(second.session.raw(PENDING_CHAT_INDEX_KEY).includes('a-1'), false)
})

test('remove and removeConversation delete records from the adapter and the lightweight index', async () => {
  const { session, adapter, store } = fixture()
  await store.save(request({ requestId: 'r-1', conversationId: 'main' }))
  await store.save(request({ requestId: 'r-2', conversationId: 'main', text: '第二条' }))
  await store.save(request({ requestId: 'r-3', conversationId: 'other', text: '另一个对话' }))
  await store.remove(['r-1'])
  assert.deepEqual((await store.list()).map(item => item.requestId), ['r-2', 'r-3'])
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)).map(item => item.requestId), ['r-2', 'r-3'])
  assert.equal(adapter.calls.remove.length, 1)
  await store.remove(['missing'])
  assert.equal(adapter.calls.remove.length, 1)
  await store.removeConversation('main')
  assert.deepEqual((await store.list()).map(item => item.requestId), ['r-3'])
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)).map(item => item.requestId), ['r-3'])
  assert.deepEqual(adapter.calls.remove.at(-1), { scope: 'scope-1', ids: ['r-2'] })
})

test('an empty window lists nothing without creating a scope or opening the adapter', async () => {
  const { session, adapter, store } = fixture()
  assert.deepEqual(await store.list(), [])
  assert.equal(adapter.calls.list.length, 0)
  assert.equal(session.raw(PENDING_CHAT_SCOPE_KEY), null)
  assert.equal(session.raw(PENDING_CHAT_INDEX_KEY), null)
})

test('unknown settings and API key fields never enter the adapter or the session index', async () => {
  const secret = 'sk-live-never-store-this'
  const legacy = {
    ...request({ requestId: 'legacy-secret' }),
    apiKey: secret,
    provider: { name: 'deepseek', apiKey: secret },
    model: 'deepseek-chat',
    settings: { temperature: 0.7 },
    context: { ...context, apiKey: secret, model: 'deepseek-reasoner' },
    extra: true,
  }
  const session = sessionFixture({ [PENDING_CHAT_INDEX_KEY]: JSON.stringify([legacy]) })
  const adapter = memoryAdapter()
  const store = createPendingChatRequestStore({ session, adapter, createId: () => 'scope-1' })
  const [item] = await store.list()
  assert.deepEqual(item, request({ requestId: 'legacy-secret' }))
  assert.deepEqual(Object.keys(item.context).sort(), ['page', 'timezone'])
  const persisted = JSON.stringify(adapter.records('scope-1')) + session.raw(PENDING_CHAT_INDEX_KEY)
  for (const leaked of [secret, 'apiKey', 'provider', 'settings', 'model', 'deepseek']) assert.equal(persisted.includes(leaked), false, `leaked ${leaked}`)
})

test('corrupt session caches and corrupt adapter records surface an error instead of dropping data', async () => {
  const broken = createPendingChatRequestStore({ session: sessionFixture({ [PENDING_CHAT_INDEX_KEY]: '{not json' }), adapter: memoryAdapter(), createId: () => 'scope-1' })
  await assert.rejects(broken.list())
  await assert.rejects(broken.save(request({ requestId: 'req-x' })))
  const notAList = createPendingChatRequestStore({ session: sessionFixture({ [PENDING_CHAT_INDEX_KEY]: JSON.stringify({ version: 2 }) }), adapter: memoryAdapter(), createId: () => 'scope-1' })
  await assert.rejects(notAList.list(), /无法读取发送记录/)
  const adapter = memoryAdapter()
  adapter.seed('scope-3', { requestId: 'broken-1', conversationId: 'main', context })
  const corruptRecord = createPendingChatRequestStore({ session: sessionFixture({ [PENDING_CHAT_SCOPE_KEY]: 'scope-3' }), adapter, createId: () => { throw new Error('must reuse the saved scope') } })
  await assert.rejects(corruptRecord.list(), /无法读取发送记录/)
})

test('object-valued page and MIME cannot smuggle settings through the record whitelist', async () => {
  const { store, adapter } = fixture()
  const masquerade = text => ({ apiKey: 'synthetic-key-must-not-persist', toString: () => text })
  await assert.rejects(store.save(request({ context: { ...context, page: masquerade('home') } })), /无法读取发送记录/)
  const image = attachmentFor(png)
  await assert.rejects(store.save(request({ attachments: [{ ...image, mime: masquerade('image/png') }] })), /无法读取发送记录/)
  assert.equal(adapter.total(), 0)
  assert.equal(adapter.calls.put.length, 0)
})

test('a failed delete keeps the original record and a stale session index cannot resurrect a committed delete', async () => {
  const { session, adapter, store } = fixture()
  const record = request({ attachments: [attachmentFor(paddedPng(4096))] })
  await store.save(record)
  const oldIndex = session.raw(PENDING_CHAT_INDEX_KEY)
  adapter.onNextRemove(() => { throw new Error('delete transaction aborted') })
  await assert.rejects(store.remove([record.requestId]), /delete transaction aborted/)
  assert.deepEqual(await store.list(), [record])
  assert.equal(session.raw(PENDING_CHAT_INDEX_KEY), oldIndex)
  session.failSetItem(key => key === PENDING_CHAT_INDEX_KEY)
  await store.remove([record.requestId])
  assert.equal(session.raw(PENDING_CHAT_INDEX_KEY), oldIndex)
  const refreshed = createPendingChatRequestStore({ session, adapter, createId: () => { throw new Error('must reuse scope') } })
  assert.deepEqual(await refreshed.list(), [])
  session.allowSetItem()
  assert.deepEqual(await refreshed.list(), [])
  assert.deepEqual(JSON.parse(session.raw(PENDING_CHAT_INDEX_KEY)), [])
})

test('the native adapter waits for transaction completion and rejects an abort after put success', async () => {
  const transactions = []
  let closed = 0
  const db = {
    close() { closed++ },
    transaction(name, mode) {
      const tx = { mode, request: {}, objectStore: () => ({ put: value => { tx.value = value; return tx.request } }) }
      transactions.push(tx)
      return tx
    },
  }
  const adapter = createIndexedDBPendingChatAdapter(() => ({ open() {
    const opening = { result: db }
    queueMicrotask(() => opening.onsuccess())
    return opening
  } }))
  let settled = false
  const failed = adapter.put('native-scope', request()).finally(() => { settled = true })
  // Attach the rejection handler before the test triggers the native abort.
  const rejects = assert.rejects(failed, /commit failed/)
  await tick()
  const aborted = transactions[0]
  assert.equal(aborted.mode, 'readwrite')
  assert.equal(aborted.value.scopeId, 'native-scope')
  aborted.request.onsuccess()
  await tick()
  assert.equal(settled, false, 'put success alone must never authorize the API')
  aborted.error = new Error('commit failed')
  aborted.onabort()
  await rejects
  assert.equal(closed, 1)
  settled = false
  const successful = adapter.put('native-scope', request()).then(() => { settled = true })
  await tick()
  const committed = transactions[1]
  committed.request.onsuccess()
  await tick()
  assert.equal(settled, false)
  committed.oncomplete()
  await successful
  assert.equal(settled, true)
  assert.equal(closed, 2, 'both successful and aborted connections must close')
})

test('unavailable or blocked native IndexedDB rejects and closes a late opened connection', async () => {
  const unavailable = createIndexedDBPendingChatAdapter(() => { throw new Error('IndexedDB unavailable') })
  await assert.rejects(unavailable.put('scope', request()), /IndexedDB unavailable/)
  const opening = {}
  let closed = false
  const blocked = createIndexedDBPendingChatAdapter(() => ({ open: () => opening }))
  const saving = blocked.put('scope', request())
  const rejects = assert.rejects(saving, /本机发送记录暂时被占用/)
  opening.onblocked()
  await rejects
  opening.result = { close: () => { closed = true } }
  opening.onsuccess()
  assert.equal(closed, true)
})
