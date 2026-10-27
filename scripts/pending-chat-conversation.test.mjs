import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Execute the real conversation hook with deterministic hook scheduling, mocked
// HTTP and an injected pending-chat store backed by the real durable helper and
// an in-memory adapter. No provider calls, user storage or browser dependencies.
const runtimeKey = '__astariaPendingChatTestHooks'
const reactStub = `export const ${['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect', 'useLayoutEffect'].map(name => `${name} = (...args) => globalThis.${runtimeKey}.${name}(...args)`).join(', ')};`
const root = new URL('../src/xixi/', import.meta.url).href
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(root)) {
      if (specifier === 'react') return { url: `data:text/javascript,${encodeURIComponent(reactStub)}`, shortCircuit: true }
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) return next(`${specifier}.ts`, context)
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    return url.startsWith(root) && url.endsWith('.ts')
      ? { ...result, format: 'module', source: stripTypeScriptTypes(String(result.source), { mode: 'transform' }) }
      : result
  },
})
const { useXixiConversation, useChatDraftCompletion } = await import('../src/xixi/useXixiConversation.ts')
const { createPendingChatRequestStore } = await import('../src/xixi/pendingChatRequest.ts')
loader.deregister()

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const context = { page: 'home', timezone: 'Asia/Shanghai' }
const disconnected = { provider: 'local', model: 'local-test-model', configured: false, cloudConfigured: null }
const connected = { provider: 'deepseek', model: 'deepseek-chat', configured: true, cloudConfigured: true }
// A real 2 × 3 PNG, kept as the original bytes and its data URL.
const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAIAAAA2iEnWAAAAFElEQVR4nGOMatrCwMDAxAAGUAoAHaoBllxQ+i0AAAAASUVORK5CYII='
const attachment = { name: '原图.png', mime: 'image/png', size: Buffer.from(pngBase64, 'base64').length, data: `data:image/png;base64,${pngBase64}` }
const pendingRecord = (requestId, conversationId, text, extra = {}) => ({ requestId, conversationId, text, context, createdAt: '2026-10-12T09:00:00.000Z', seq: 1, ...extra })

function memoryAdapter() {
  const buckets = new Map()
  const bucket = scope => { if (!buckets.has(scope)) buckets.set(scope, new Map()); return buckets.get(scope) }
  return {
    ids: () => [...buckets.values()].flatMap(records => [...records.keys()]),
    async list(scope) { return [...bucket(scope).values()].map(value => structuredClone(value)) },
    async find(conversationId, requestId) { return [...buckets.values()].flatMap(records => [...records.values()]).filter(item => item.conversationId === conversationId && item.requestId === requestId).map(value => structuredClone(value)) },
    async put(scope, value) { bucket(scope).set(value.requestId, structuredClone(value)) },
    async remove(scope, ids) { for (const id of ids) bucket(scope).delete(id) },
  }
}

function pendingStoreFixture(scopeId = 'scope-1', adapter = memoryAdapter()) {
  const session = new Map()
  const base = createPendingChatRequestStore({
    session: { getItem: key => session.get(key) ?? null, setItem: (key, value) => session.set(key, value) },
    adapter,
    createId: () => scopeId,
  })
  const saves = [], removed = [], removedConversations = []
  const api = {
    saves,
    removed,
    removedConversations,
    beforeSave: null,
    failAfterCommit: false,
    ids: () => adapter.ids(),
    list() { return base.list() },
    find: (conversationId, requestId) => base.find(conversationId, requestId),
    async save(request) {
      saves.push(structuredClone(request))
      if (api.beforeSave) await api.beforeSave(request, saves.length)
      if (api.failAfterCommit) {
        // The adapter commit succeeds, then the light index write fails.
        api.failAfterCommit = false
        await base.save(request)
        throw new Error('索引写入失败')
      }
      return base.save(request)
    },
    async remove(requestIds) { const ids = [...requestIds]; removed.push(ids); return base.remove(ids) },
    async removeConversation(conversationId) { removedConversations.push(conversationId); return base.removeConversation(conversationId) },
  }
  return api
}

async function fixture(t, options = {}) {
  const originals = new Map(['window', 'document', 'sessionStorage', runtimeKey].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const storage = new Map()
  const timers = new Map()
  let timerId = 0
  globalThis.window = { setInterval: () => 0, setTimeout: callback => { timers.set(++timerId, callback); return timerId }, clearTimeout: id => timers.delete(id) }
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }
  const slots = [], effects = []
  let cursor = 0
  const memo = (factory, deps) => {
    const index = cursor++
    const prior = slots[index]
    if (!prior || !deps || deps.some((value, i) => !Object.is(value, prior.deps[i]))) slots[index] = { value: factory(), deps }
    return slots[index].value
  }
  const effect = (callback, deps) => {
    const index = cursor++, previous = slots[index]
    if (previous && deps && previous.deps && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return
    const slot = slots[index] = { deps }
    effects.push(() => { previous?.cleanup?.(); slot.cleanup = callback() })
  }
  globalThis[runtimeKey] = {
    useState(initial) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next }]
    },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo: memo,
    useCallback: (callback, deps) => memo(() => callback, deps),
    useEffect: effect,
    useLayoutEffect: effect,
  }
  const store = options.store ?? pendingStoreFixture()
  const injected = options.injected !== false
  let status = options.status ?? connected
  let chatError = null
  let chatResult = options.chatResult ?? null
  const conversationFor = id => (typeof conversation === 'function' ? conversation(id) : conversation)
  let conversation = options.conversation ?? (id => ({ conversationId: id, messages: [], operations: [] }))
  const reads = [], sent = [], durableAtSend = [], requestReads = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/status') {
      const result = reads.length ? await reads.shift().promise : status
      return Response.json(result)
    }
    if (url.startsWith('/api/conversation/reasoning')) return Response.json({ reasoningContent: '', rounds: [] })
    if (url.startsWith('/api/conversation/retry?')) {
      requestReads.push(url)
      return options.recoveredRequest ? Response.json(options.recoveredRequest) : Response.json({ error: '原发送记录不可用' }, { status: 404 })
    }
    if (url === '/api/conversation' || url.startsWith('/api/conversation?')) return Response.json(conversationFor(new URL(url, 'http://local').searchParams.get('id') || 'main'))
    if (url === '/api/chat') {
      const request = JSON.parse(init.body)
      sent.push(request)
      durableAtSend.push(injected ? store.ids() : [])
      if (options.chatResponse) return options.chatResponse(request)
      if (chatError) return Response.json({ error: chatError }, { status: 502 })
      return Response.json(chatResult ? chatResult(request) : { ...request, status: 'completed', messages: [], operations: [] })
    }
    if (url === '/api/conversations') return Response.json([])
    if (url === '/api/conversations/select') return Response.json(conversationFor(JSON.parse(init.body).id))
    if (url === '/api/conversations/delete') return Response.json(conversationFor('main'))
    if (url === '/api/messages/retract') return Response.json(conversationFor(JSON.parse(init.body).conversationId))
    throw new Error(`Unexpected API: ${url}`)
  })
  const composer = { key: `draft-${crypto.randomUUID()}`, text: options.draft ?? '', attachment: options.attachment ?? null, revision: 0, clears: 0 }
  const composerRevision = { get current() { return composer.revision } }
  let captureCompletion, composerStart, composerMounted = true
  const render = () => {
    cursor = 0
    const value = injected ? useXixiConversation(() => {}, () => {}, store) : useXixiConversation(() => {}, () => {})
    composerStart = cursor
    if (composerMounted) captureCompletion = useChatDraftCompletion(composer.key, composer.text, composer.attachment, composerRevision, () => {
      composer.text = ''; composer.attachment = null; composer.clears++
    })
    for (const effect of effects.splice(0)) effect()
    return value
  }
  const unmount = () => { for (const slot of slots) { slot?.cleanup?.(); if (slot?.cleanup) slot.cleanup = undefined } }
  t.after(() => {
    unmount()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  const settle = async predicate => {
    for (let index = 0; index < 500; index++) {
      const value = render()
      if (predicate(value)) return value
      await tick()
    }
    assert.fail('the hook state did not settle')
  }
  render(); await tick()
  for (let index = 0; index < 50 && !render().conversation; index++) await tick()
  return {
    render,
    unmount,
    settle,
    store,
    reads,
    sent,
    durableAtSend,
    composer,
    storage,
    requestReads,
    captureCompletion: () => captureCompletion(),
    hideComposer: () => { for (const slot of slots.splice(composerStart)) slot?.cleanup?.(); composerMounted = false },
    showComposer: () => { composerMounted = true; composer.revision = 0; return render() },
    fireProgressTimer: () => { for (const callback of timers.values()) callback() },
    setStatus: value => { status = value },
    setConversation: value => { conversation = value },
    failChat: value => { chatError = value },
    succeedChat: value => { chatError = null; chatResult = value },
  }
}
const messageFor = (chat, requestId) => chat.conversation?.messages.find(item => item.requestId === requestId)

test('a chat request only reaches the API after the durable store save succeeds', async t => {
  const gate = deferred()
  const store = pendingStoreFixture()
  store.beforeSave = () => gate.promise
  const f = await fixture(t, { store })
  let settled = false
  const sending = f.render().send('先保存再发送', context).then(value => { settled = true; return value })
  await tick()
  assert.equal(settled, false)
  assert.equal(f.sent.length, 0)
  const preparing = f.render()
  assert.equal(preparing.preparingSend, true)
  assert.equal(preparing.sending, false)
  assert.equal(preparing.conversation.messages.some(item => item.delivery === 'sending'), false)
  gate.resolve()
  assert.equal(await sending, true)
  assert.equal(f.sent.length, 1)
  assert.equal(store.saves.length, 1)
  assert.equal(f.sent[0].requestId, store.saves[0].requestId)
  assert.deepEqual(f.durableAtSend, [[store.saves[0].requestId]])
  assert.deepEqual(store.ids(), [])
})

test('a failed store save blocks the API, shows no optimistic send and can be retried with the original content', async t => {
  const store = pendingStoreFixture()
  store.beforeSave = () => { throw new Error('本机存储不可用') }
  const f = await fixture(t, { store })
  assert.equal(await f.render().send('这段原文不能丢', context, [attachment]), false)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(store.ids(), [])
  const failed = f.render()
  assert.match(failed.error, /发送记录/)
  assert.equal(failed.sending, false)
  assert.equal(failed.preparingSend, false)
  assert.equal(failed.busy, false)
  const optimistic = failed.conversation.messages.filter(item => item.content === '这段原文不能丢')
  assert.equal(optimistic.some(item => item.delivery === 'sending'), false)
  store.beforeSave = null
  assert.equal(await failed.send('这段原文不能丢', context, [attachment]), true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].text, '这段原文不能丢')
  assert.deepEqual(f.sent[0].attachments, [attachment])
  assert.deepEqual(store.ids(), [])
})

test('a save that fails after the durable commit is retried under the same request ID', async t => {
  const store = pendingStoreFixture()
  store.failAfterCommit = true
  const f = await fixture(t, { store })
  assert.equal(await f.render().send('索引失败但已提交', context), false)
  assert.equal(f.sent.length, 0)
  assert.match(f.render().error, /发送记录/)
  assert.deepEqual(store.ids(), [store.saves[0].requestId])
  assert.equal(await f.render().send('索引失败但已提交', context), true)
  assert.equal(store.saves.length, 2)
  assert.equal(store.saves[1].requestId, store.saves[0].requestId)
  assert.equal(f.sent[0].requestId, store.saves[0].requestId)
  assert.equal(f.sent[0].text, '索引失败但已提交')
  assert.deepEqual(store.ids(), [])
})

test('a double click or Enter never sends the same request twice', async t => {
  const gate = deferred()
  const store = pendingStoreFixture()
  store.beforeSave = () => gate.promise
  const f = await fixture(t, { store })
  const chat = f.render()
  const first = chat.send('只发一次', context)
  assert.equal(await chat.send('只发一次', context), false)
  assert.equal(await f.render().send('只发一次', context), false)
  gate.resolve()
  assert.equal(await first, true)
  assert.equal(f.sent.length, 1)
  assert.equal(store.saves.length, 1)
})

test('a refresh restores a failed outgoing request with the same ID and attachments', async t => {
  const store = pendingStoreFixture()
  const record = pendingRecord('req-restored', 'main', '刷新前的图片', { seq: 2, attachments: [attachment] })
  await store.save(record)
  const f = await fixture(t, { store })
  await f.settle(value => Boolean(messageFor(value, 'req-restored')))
  const restored = messageFor(f.render(), 'req-restored')
  assert.equal(restored.delivery, 'failed')
  assert.equal(restored.content, '刷新前的图片')
  assert.deepEqual(restored.attachments, [attachment])
  assert.equal(await f.render().retryMessage('req-restored'), true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].requestId, 'req-restored')
  assert.deepEqual(f.sent[0].attachments, [attachment])
  assert.deepEqual(store.saves.map(item => item.requestId), ['req-restored', 'req-restored'])
  assert.deepEqual(store.ids(), [])
})

test('a failed chat request keeps its retry record and resends under the same ID', async t => {
  const store = pendingStoreFixture()
  const f = await fixture(t, { store })
  f.failChat('模型暂时限流，请稍后重试')
  assert.equal(await f.render().send('失败后重试', context), false)
  const requestId = f.sent[0].requestId
  assert.deepEqual(store.ids(), [requestId])
  assert.equal(messageFor(f.render(), requestId).delivery, 'failed')
  assert.equal(f.render().error, '模型暂时限流，请稍后重试')
  // Retrying while the model still fails resends the same durable ID.
  assert.equal(await f.render().retryMessage(requestId), false)
  assert.equal(f.sent.length, 2)
  assert.equal(f.sent[1].requestId, requestId)
  assert.deepEqual(store.ids(), [requestId])
  f.succeedChat()
  assert.equal(await f.render().retryMessage(requestId), true)
  assert.equal(f.sent.length, 3)
  assert.equal(f.sent[2].requestId, requestId)
  assert.deepEqual(store.saves.map(item => item.requestId), [requestId, requestId, requestId])
  assert.deepEqual(store.ids(), [])
})

test('pending requests are filtered by the selected conversation', async t => {
  const store = pendingStoreFixture()
  await store.save(pendingRecord('p-main', 'main', '主对话的草稿'))
  await store.save(pendingRecord('p-other', 'other', '另一个对话的草稿'))
  const f = await fixture(t, { store })
  await f.settle(value => Boolean(messageFor(value, 'p-main')))
  assert.deepEqual(f.render().conversation.messages.map(item => item.requestId), ['p-main'])
  assert.equal(await f.render().selectTopic('other'), true)
  await f.settle(value => value.conversation.conversationId === 'other')
  assert.deepEqual(f.render().conversation.messages.map(item => item.requestId), ['p-other'])
  assert.deepEqual(store.ids().sort(), ['p-main', 'p-other'])
})

test('retracting an optimistic message clears its durable record', async t => {
  const store = pendingStoreFixture()
  await store.save(pendingRecord('req-retract', 'main', '撤回这条'))
  const f = await fixture(t, { store })
  await f.settle(value => Boolean(messageFor(value, 'req-retract')))
  const entry = messageFor(f.render(), 'req-retract')
  assert.equal(entry.id, 'optimistic:req-retract')
  assert.equal(await f.render().retractMessage(entry), true)
  await f.settle(() => store.ids().length === 0)
  assert.deepEqual(store.removed, [['req-retract']])
  assert.equal(messageFor(f.render(), 'req-retract'), undefined)
})

test('a remote retraction received on refresh clears the durable record', async t => {
  const store = pendingStoreFixture()
  await store.save(pendingRecord('req-remote', 'main', '远端已撤回'))
  let state = { conversationId: 'main', messages: [], operations: [] }
  const f = await fixture(t, { store, conversation: () => state })
  await f.settle(value => Boolean(messageFor(value, 'req-remote')))
  state = { conversationId: 'main', messages: [{ id: 'm-1', seq: 1, role: 'user', content: '远端已撤回', createdAt: '2026-10-12T09:00:00.000Z', requestId: 'req-remote', retractedAt: '2026-10-12T09:10:00.000Z' }], operations: [] }
  await f.render().refresh()
  await f.settle(() => store.ids().length === 0)
  const withdrawn = f.render().conversation.messages.find(item => item.requestId === 'req-remote')
  assert.equal(withdrawn?.retractedAt, '2026-10-12T09:10:00.000Z')
  assert.equal(withdrawn?.delivery, undefined)
})

test('deleting a topic clears only that conversation durable records', async t => {
  const store = pendingStoreFixture()
  await store.save(pendingRecord('p-main', 'main', '主对话的草稿'))
  await store.save(pendingRecord('p-other', 'other', '要删除的对话'))
  const f = await fixture(t, { store })
  await f.settle(value => Boolean(value.conversation))
  assert.equal(await f.render().deleteTopic('other'), true)
  await f.settle(() => store.ids().length === 1)
  assert.deepEqual(store.ids(), ['p-main'])
  assert.deepEqual(store.removedConversations, ['other'])
})

test('a failed result and unrelated existing receipts never clear the durable record', async t => {
  const store = pendingStoreFixture()
  const f = await fixture(t, { store, chatResult: request => ({ ...request, status: 'failed', error: '刚才没有完成，原文还在，可以重试', messages: [], operations: [] }) })
  assert.equal(await f.render().send('失败结果也要保住', context), false)
  const requestId = f.sent[0].requestId
  assert.deepEqual(store.ids(), [requestId])
  assert.equal(messageFor(f.render(), requestId).delivery, 'failed')
  f.setConversation(id => ({
    conversationId: id,
    messages: [],
    operations: [{ id: 'op-1', requestId: 'earlier-request', summary: '已创建 1 个事项', createdAt: '2026-10-12T09:05:00.000Z', readAt: null, undoneAt: null }],
  }))
  await f.render().refresh()
  await tick()
  assert.equal(f.render().conversation.operations.length, 1)
  assert.deepEqual(store.ids(), [requestId])
  assert.equal(messageFor(f.render(), requestId).delivery, 'failed')
})

test('a disconnected model blocks the send and keeps the same retry ID until it reconnects', async t => {
  const store = pendingStoreFixture()
  await store.save(pendingRecord('req-offline', 'main', '断线也要留着'))
  const f = await fixture(t, { store, status: disconnected })
  await f.settle(value => Boolean(messageFor(value, 'req-offline')))
  assert.equal(await f.render().send('断线也要留着', context), false)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(store.saves.map(item => item.requestId), ['req-offline'])
  assert.match(f.render().error, /先在设置里连接/)
  assert.deepEqual(store.ids(), ['req-offline'])
  assert.equal(messageFor(f.render(), 'req-offline').delivery, 'failed')
  f.setStatus(connected)
  assert.equal(await f.render().retryMessage('req-offline'), true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.sent[0].requestId, 'req-offline')
})

test('the hook keeps its first two parameters and treats the store as an optional third', async t => {
  const f = await fixture(t, { injected: false, status: disconnected })
  assert.equal(f.render().conversation.conversationId, 'main')
  assert.equal(f.render().status.configured, false)
  assert.equal(await f.render().send('没有注入存储也要能用', context), false)
  assert.match(f.render().error, /先在设置里连接/)
  assert.equal(f.sent.length, 0)
})

test('switching back to configured API clears the old connection prompt without restarting or losing the draft', async t => {
  const store = pendingStoreFixture()
  const f = await fixture(t, { store, status: disconnected })
  assert.equal(await f.render().send('保留这条草稿', context), false)
  assert.match(f.render().error, /先在设置里连接/)
  assert.equal(f.sent.length, 0)
  assert.equal(store.saves.length, 0)
  f.setStatus(connected)
  await f.render().refreshStatus()
  assert.equal(f.render().error, '')
  assert.equal(f.render().status.provider, 'deepseek')
  assert.equal(await f.render().send('保留这条草稿', context), true)
  assert.equal(f.sent[0].text, '保留这条草稿')
})

test('a delayed local-mode status response cannot replace the newly saved API status', async t => {
  const f = await fixture(t)
  const old = deferred(), recent = deferred()
  f.reads.push(old, recent)
  const first = f.render().refreshStatus(), second = f.render().refreshStatus()
  recent.resolve(connected); await second
  old.resolve(disconnected); await first
  assert.deepEqual(f.render().status, connected)
})

test('a delayed status failure cannot clear the newly saved API status', async t => {
  const f = await fixture(t)
  const old = deferred(), recent = deferred()
  f.reads.push(old, recent)
  const first = f.render().refreshStatus(), second = f.render().refreshStatus()
  recent.resolve(connected); await second
  old.reject(new Error('old connection failed')); await first
  assert.deepEqual(f.render().status, connected)
})

test('send rechecks stale disconnected status and prevents duplicate sends while checking', async t => {
  const store = pendingStoreFixture()
  const f = await fixture(t, { store, status: disconnected })
  const pending = deferred()
  f.reads.push(pending)
  const chat = f.render()
  const sending = chat.send('切换后直接发送', context)
  assert.equal(await chat.send('切换后直接发送', context), false)
  assert.equal(f.sent.length, 0)
  assert.equal(store.saves.length, 0)
  pending.resolve(connected)
  assert.equal(await sending, true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.render().error, '')
  assert.equal(store.saves.length, 1)
})

test('connection refresh preserves unrelated send errors and failed messages', async t => {
  const store = pendingStoreFixture()
  const f = await fixture(t, { store })
  f.failChat('模型暂时限流，请稍后重试')
  assert.equal(await f.render().send('重试内容', context), false)
  const before = f.render()
  assert.equal(before.error, '模型暂时限流，请稍后重试')
  const requestId = f.sent[0].requestId
  assert.deepEqual(store.ids(), [requestId])
  await before.refreshStatus()
  assert.equal(f.render().error, before.error)
  assert.deepEqual(f.render().conversation.messages, before.conversation.messages)
  assert.deepEqual(store.ids(), [requestId])
})

test('an unconfigured model remains blocked after a fresh status check', async t => {
  const store = pendingStoreFixture()
  const f = await fixture(t, { store, status: disconnected })
  assert.equal(await f.render().send('不要误发', context), false)
  assert.match(f.render().error, /先在设置里连接/)
  assert.equal(f.sent.length, 0)
  assert.deepEqual(store.ids(), [])
})

test('unmount during persistence leaves a recoverable request without starting the API', async t => {
  const gate = deferred(), store = pendingStoreFixture()
  store.beforeSave = () => gate.promise
  const f = await fixture(t, { store })
  const sending = f.render().send('关闭页面前正在保存', context, [attachment])
  await tick()
  assert.equal(store.saves.length, 1)
  f.unmount()
  gate.resolve()
  assert.equal(await sending, false)
  assert.equal(f.sent.length, 0)
  const [saved] = await store.list()
  assert.equal(saved.requestId, store.saves[0].requestId)
  assert.deepEqual(saved.attachments, [attachment])
})

test('late restoration cannot revive a remotely retracted pending request', async t => {
  const gate = deferred(), store = pendingStoreFixture()
  await store.save(pendingRecord('late-withdrawn', 'main', '已经撤回的图片', { attachments: [attachment] }))
  const list = store.list.bind(store)
  let restoring = true
  store.list = async () => {
    const records = await list()
    if (restoring) { restoring = false; await gate.promise }
    return records
  }
  const f = await fixture(t, { store, conversation: () => ({ conversationId: 'main', messages: [
    { id: 'withdrawn-message', role: 'user', seq: 1, content: '已经撤回的图片', requestId: 'late-withdrawn', createdAt: '2026-10-12T09:00:00.000Z', retractedAt: '2026-10-12T09:10:00.000Z' },
  ], operations: [] }) })
  await f.settle(() => store.ids().length === 0)
  gate.resolve()
  await tick()
  const message = messageFor(f.render(), 'late-withdrawn')
  assert.equal(message.id, 'withdrawn-message')
  assert.equal(message.delivery, undefined)
  assert.equal(message.attachments, undefined)
  assert.equal(await f.render().retryMessage('late-withdrawn'), false)
  assert.equal(f.sent.length, 0)
})

test('retry targets its own request ID even when another pending request has identical content', async t => {
  const store = pendingStoreFixture()
  await store.save(pendingRecord('same-a', 'main', '相同正文', { attachments: [attachment] }))
  await store.save(pendingRecord('same-b', 'main', '相同正文', { attachments: [attachment], seq: 2 }))
  const f = await fixture(t, { store })
  await f.settle(value => Boolean(messageFor(value, 'same-b')))
  assert.equal(await f.render().retryMessage('same-b'), true)
  assert.equal(f.sent[0].requestId, 'same-b')
  assert.deepEqual(store.ids(), ['same-a'])
  await store.remove(['same-a'])
  assert.equal(await f.render().retryMessage('same-a'), false)
  assert.equal(f.sent.length, 1)
  assert.match(f.render().error, /发送记录已更新/)
})

test('a partially saved operation survives failed delivery and the same-ID retry without duplicate receipts', async t => {
  const store = pendingStoreFixture()
  const operation = requestId => ({ id: 'already-saved-op', requestId, summary: '已更新事项备注', createdAt: '2026-10-12T09:05:00.000Z', readAt: null, undoneAt: null })
  const user = request => ({ id: 'saved-user', role: 'user', requestId: request.requestId, seq: 1, content: request.text, createdAt: request.createdAt ?? '2026-10-12T09:00:00.000Z' })
  const f = await fixture(t, { store, chatResult: request => ({ ...request, status: 'failed', error: '第二轮未完成', messages: [user(request)], operations: [operation(request.requestId)] }) })
  assert.equal(await f.render().send('保存之后继续重试', context, [attachment]), false)
  const requestId = f.sent[0].requestId, savedOperation = operation(requestId)
  assert.deepEqual(f.render().conversation.operations, [savedOperation])
  assert.equal(messageFor(f.render(), requestId).delivery, 'failed')
  assert.deepEqual(store.ids(), [requestId])
  f.succeedChat(request => ({ ...request, status: 'completed', messages: [user(request), { id: 'saved-reply', role: 'assistant', requestId, seq: 2, content: '后续已完成', createdAt: '2026-10-12T09:06:00.000Z' }], operations: [savedOperation] }))
  assert.equal(await f.render().retryMessage(requestId), true)
  assert.equal(f.sent[1].requestId, requestId)
  assert.deepEqual(f.sent[1].attachments, [attachment])
  assert.deepEqual(f.render().conversation.operations, [savedOperation])
  assert.equal(f.render().conversation.messages.filter(item => item.role === 'user' && item.requestId === requestId).length, 1)
  assert.deepEqual(store.ids(), [])
})


const savedTurn = (request, status = 'completed') => ({ conversationId: request.conversationId, operations: [], messages: [
  { id: request.requestId + ':user', requestId: request.requestId, seq: 1, role: 'user', content: request.text, createdAt: request.createdAt ?? '', requestStatus: status },
  { id: request.requestId + ':reply', requestId: request.requestId, seq: 2, role: 'assistant', content: '已保存的回答', createdAt: request.createdAt ?? '', requestStatus: status },
] })
const lostTerminal = () => new Response(new ReadableStream({ start(controller) {
  const encoder = new TextEncoder()
  controller.enqueue(encoder.encode('data: '+JSON.stringify({type:'content',round:1,delta:'已保存的回答'})+'\n\n'))
  controller.close()
} }), { headers: { 'Content-Type':'text/event-stream' } })

test('lost terminal stream frame reconciles durable completion and returns success to the composer without retrying', async t => {
  let saved = {conversationId:'main',messages:[],operations:[]}
  const f = await fixture(t,{ conversation:()=>saved,chatResponse:request=>{saved=savedTurn(request);return lostTerminal()} })
  assert.equal(await f.render().send('讲b',context),true)
  await f.settle(()=>f.store.ids().length===0)
  const chat=f.render()
  assert.equal(chat.error,'')
  assert.equal(chat.sending,false)
  assert.equal(chat.busy,false)
  assert.equal(chat.conversation.messages.find(m=>m.role==='user').delivery,undefined)
  assert.equal(chat.conversation.messages.find(m=>m.role==='assistant').content,'已保存的回答')
  assert.equal(f.sent.length,1)
})

test('later refresh retires an uncertain send only after the durable turn is completed', async t => {
  let saved={conversationId:'main',messages:[],operations:[]},request
  const f=await fixture(t,{conversation:()=>saved,chatResponse:value=>{request=value;saved=savedTurn(value,'running');return lostTerminal()} })
  assert.equal(await f.render().send('继续这轮',context),false)
  assert.match(f.render().error,/中断/)
  assert.equal(messageFor(f.render(),request.requestId).delivery,'failed')
  saved=savedTurn(request,'completed')
  await f.render().refresh();await f.settle(()=>f.store.ids().length===0)
  assert.equal(f.render().error,'')
  assert.equal(messageFor(f.render(),request.requestId).delivery,undefined)
  assert.equal(f.sent.length,1,'reconciliation must never repeat the model request')
})

for(const status of ['running','failed',undefined]) test(`saved prose with ${status??'unknown'} status must keep a real interruption retryable`,async t=>{
  let saved={conversationId:'main',messages:[],operations:[]}
  const f=await fixture(t,{conversation:()=>saved,chatResponse:request=>{saved=savedTurn(request,status);if(status===undefined)saved.messages.forEach(m=>delete m.requestStatus);return lostTerminal()} })
  assert.equal(await f.render().send('先解释再记忆',context),false)
  await f.render().refresh();await tick()
  assert.equal(f.store.ids().length,1)
  assert.equal(messageFor(f.render(),f.sent[0].requestId).delivery,'failed')
  assert.match(f.render().error,/中断/)
})

test('restart restores completed messages without resurrecting a stale failed send',async t=>{
  const store=pendingStoreFixture(),request=pendingRecord('stale-complete','main','已经完成的原文')
  await store.save(request)
  const f=await fixture(t,{store,conversation:()=>savedTurn(request)})
  await f.settle(chat=>chat.conversation?.messages.length===2&&store.ids().length===0)
  assert.equal(messageFor(f.render(),request.requestId).delivery,undefined)
  assert.equal(f.sent.length,0)
})

for (const edit of ['none', 'text', 'attachment', 'edit-back']) test(`R5 background completion respects composer ownership: ${edit}`, async t => {
  let saved = { conversationId: 'main', messages: [], operations: [] }, request
  const f = await fixture(t, { draft: '记下这件事', attachment, conversation: () => saved, chatResponse: value => {
    request = value; saved = savedTurn(value, 'running'); return lostTerminal()
  } })
  f.storage.set(f.composer.key, f.composer.text)
  const completed = f.captureCompletion()
  assert.equal(await f.render().send(f.composer.text, context, [attachment], undefined, completed), false)
  if (edit === 'text') { f.composer.text = '我后来编辑的新草稿'; f.composer.revision++ }
  if (edit === 'attachment') f.composer.attachment = { ...attachment, name: '另一张图.png' }
  if (edit === 'edit-back') { f.composer.revision += 2 /* Even if batching hides the intermediate text. */ }
  f.render()
  f.storage.set(f.composer.key, f.composer.text)
  saved = savedTurn(request)
  await f.render().refresh()
  await f.settle(() => f.store.ids().length === 0)
  assert.equal(f.composer.clears, edit === 'none' ? 1 : 0)
  assert.equal(f.composer.text, edit === 'none' ? '' : edit === 'text' ? '我后来编辑的新草稿' : '记下这件事')
  assert.equal(f.composer.attachment === null, edit === 'none')
  if (edit === 'none') assert.equal(f.storage.has(f.composer.key), false)
  // A completed request must not permanently deduplicate a legitimate new
  // message, even if local record cleanup temporarily fails.
  const previousId = request.requestId
  await f.store.save(pendingRecord(previousId, 'main', '记下这件事', { attachments: [attachment] }))
  await f.render().send('记下这件事', context, [attachment])
  assert.notEqual(f.sent.at(-1).requestId, previousId)
  completed()
  assert.equal(f.composer.clears, edit === 'none' ? 1 : 0, 'a completion is consumed only once')
})

test('R5 completion clears an unmounted composer storage without updating its old React owner', async t => {
  const f = await fixture(t, { draft: '关闭专注面板前发出的内容' })
  f.storage.set(f.composer.key, f.composer.text)
  const complete = f.captureCompletion()
  f.unmount()
  complete()
  assert.equal(f.storage.has(f.composer.key), false)
  assert.equal(f.composer.clears, 0)
})

test('R5 background completion reaches the reopened owner of the same workbench draft', async t => {
  let saved = { conversationId: 'main', messages: [], operations: [] }, request
  const f = await fixture(t, { draft: '专注草稿', conversation: () => saved, chatResponse: value => { request = value; saved = savedTurn(value, 'running'); return lostTerminal() } })
  f.storage.set(f.composer.key, f.composer.text)
  await f.render().send(f.composer.text, context, undefined, undefined, f.captureCompletion())
  f.hideComposer(); f.render(); f.showComposer()
  saved = savedTurn(request)
  await f.render().refresh()
  assert.equal(f.composer.text, '')
  assert.equal(f.composer.clears, 1)
  assert.equal(f.storage.has(f.composer.key), false)
})

test('R5 completion after changing draft context leaves the visible composer alone', async t => {
  const f = await fixture(t, { draft: '上一事项的草稿' })
  const oldKey = f.composer.key
  f.storage.set(oldKey, f.composer.text)
  const complete = f.captureCompletion()
  f.composer.key = 'a-different-task-draft'; f.composer.text = '另一个事项'; f.composer.revision++
  f.render(); complete()
  assert.equal(f.composer.text, '另一个事项')
  assert.equal(f.composer.clears, 0)
  assert.equal(f.storage.has(oldKey), false)
})

test('R5 old completion does not clear another draft key or a newly edited identical draft', async t => {
  const f = await fixture(t, { draft: '原稿' })
  const complete = f.captureCompletion()
  f.composer.text = '编辑过'; f.composer.revision++; f.render()
  f.composer.text = '原稿'; f.composer.revision++; f.render()
  complete()
  assert.equal(f.composer.text, '原稿')
  assert.equal(f.composer.clears, 0)
})

test('R5 an edit before the next React commit invalidates the captured draft immediately', async t => {
  const f = await fixture(t, { draft: '原稿' })
  const complete = f.captureCompletion()
  f.composer.text = '尚未提交的新输入'; f.composer.revision++
  complete()
  assert.equal(f.composer.text, '尚未提交的新输入')
  assert.equal(f.composer.clears, 0)
})

function controlledStream() {
  let controller
  const response = new Response(new ReadableStream({ start(value) { controller = value } }), { headers: { 'Content-Type': 'text/event-stream' } })
  return { response, emit: event => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)), close: () => controller.close() }
}

for (const progress of ['none', 'content', 'reasoning']) test(`R7 waiting notice clears on success; progress=${progress}`, async t => {
  const stream = controlledStream()
  const f = await fixture(t, { chatResponse: () => stream.response })
  const sending = f.render().send('需要思考的问题', context)
  await f.settle(() => f.sent.length === 1)
  if (progress !== 'none') { stream.emit({ type: progress, round: 0, delta: '有进展' }); await tick() }
  f.fireProgressTimer()
  assert.equal(Boolean(f.render().waitingNotice), progress === 'none')
  assert.equal(f.render().error, '')
  stream.emit({ type: 'result', result: { ...savedTurn(f.sent[0]), requestId: f.sent[0].requestId, status: 'completed' } })
  stream.close()
  assert.equal(await sending, true)
  assert.equal(f.render().waitingNotice, '')
  assert.equal(f.render().error, '')
})

test('R7 a late progress event clears waiting before completion and failure keeps its real error', async t => {
  const stream = controlledStream()
  const f = await fixture(t, { chatResponse: () => stream.response })
  const sending = f.render().send('等候进展', context)
  await f.settle(() => f.sent.length === 1)
  f.fireProgressTimer()
  assert.ok(f.render().waitingNotice)
  stream.emit({ type: 'content', round: 0, delta: '开始回答' }); await tick()
  assert.equal(f.render().waitingNotice, '')
  stream.emit({ type: 'result', result: { ...savedTurn(f.sent[0], 'failed'), requestId: f.sent[0].requestId, status: 'failed', error: '实际执行失败' } }); stream.close()
  assert.equal(await sending, false)
  assert.equal(f.render().error, '实际执行失败')
  assert.equal(f.render().waitingNotice, '')
})

test('R7 background completion must not clear an unrelated validation error', async t => {
  let saved = { conversationId: 'main', messages: [], operations: [] }, request
  const f = await fixture(t, { conversation: () => saved, chatResponse: value => { request = value; saved = savedTurn(value, 'running'); return lostTerminal() } })
  await f.render().send('已经写入', context)
  await f.store.remove([request.requestId])
  assert.equal(await f.render().retryMessage(request.requestId), false)
  const unrelated = f.render().error
  assert.match(unrelated, /发送记录已更新/)
  saved = savedTurn(request)
  await f.render().refresh()
  assert.equal(f.render().error, unrelated)
})

for (const source of ['other-window', 'server']) test(`R15 failed transcript retries persisted identity from ${source}`, async t => {
  const adapter = memoryAdapter(), oldStore = pendingStoreFixture('old-window', adapter), store = pendingStoreFixture('new-window', adapter)
  const original = pendingRecord('persisted-failure', 'main', '原始请求', { attachments: [attachment], context: { page: 'calendar', date: '2026-10-25', timezone: 'Europe/Paris', taskId: 'task-original', wishId: 'wish-original', freeTimeGoalId: 'goal-original' } })
  const other = pendingRecord('another-active-request', 'other-conversation', '不能清扫的窗口')
  await oldStore.save(other)
  if (source === 'other-window') await oldStore.save(original)
  const f = await fixture(t, { store, conversation: () => savedTurn(original, 'failed'), recoveredRequest: source === 'server' ? original : undefined })
  assert.equal(messageFor(f.render(), original.requestId).delivery, 'failed')
  assert.equal(await f.render().retryMessage(original.requestId), true)
  assert.deepEqual(f.sent[0], { requestId: original.requestId, conversationId: original.conversationId, text: original.text, attachments: original.attachments, context: original.context })
  assert.ok(f.durableAtSend[0].includes(original.requestId))
  assert.deepEqual(await store.list(), [])
  assert.deepEqual(await oldStore.list(), source === 'other-window' ? [other, original] : [other])
  assert.equal(f.requestReads.length, source === 'server' ? 1 : 0)
})

for (const defect of ['missing', 'wrong-request', 'wrong-conversation', 'missing-context']) test(`R15 recovery ${defect} never invents a new request`, async t => {
  const original = pendingRecord('failed-id', 'main', '保留原始身份')
  const recoveredRequest = defect === 'missing' ? undefined : { ...original, ...(defect === 'wrong-request' ? { requestId: 'different' } : defect === 'wrong-conversation' ? { conversationId: 'different' } : { context: undefined }) }
  const f = await fixture(t, { conversation: () => savedTurn(original, 'failed'), recoveredRequest })
  assert.equal(await f.render().retryMessage(original.requestId), false)
  assert.equal(f.sent.length, 0)
  assert.ok(f.render().error)
  assert.deepEqual(f.store.ids(), [])
})
