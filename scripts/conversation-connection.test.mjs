import assert from 'node:assert/strict'
import test from 'node:test'
import { registerHooks, stripTypeScriptTypes } from 'node:module'

// Execute the real conversation hook with deterministic hook scheduling and
// mocked HTTP. No provider calls, user storage or browser dependencies.
const runtimeKey = '__astariaConnectionTestHooks'
const reactStub = `export const ${['useState', 'useRef', 'useMemo', 'useCallback', 'useEffect'].map(name => `${name} = (...args) => globalThis.${runtimeKey}.${name}(...args)`).join(', ')};`
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
const { useXixiConversation } = await import('../src/xixi/useXixiConversation.ts')
loader.deregister()
const tick = () => new Promise(resolve => setImmediate(resolve))
const context = { page: 'home', timezone: 'Asia/Shanghai' }
const disconnected = { provider: 'local', model: 'local-test-model', configured: false, cloudConfigured: null }
const connected = { provider: 'deepseek', model: 'deepseek-chat', configured: true, cloudConfigured: true }
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }

async function fixture(t) {
  const originals = new Map(['window', 'document', 'sessionStorage', runtimeKey].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const storage = new Map()
  globalThis.window = { setInterval: () => 0 }
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  const slots = [], effects = []
  let cursor = 0
  const memo = (factory, deps) => {
    const index = cursor++
    const prior = slots[index]
    if (!prior || deps.some((value, i) => !Object.is(value, prior.deps[i]))) slots[index] = { value: factory(), deps }
    return slots[index].value
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
    useEffect(callback, deps) { memo(() => { effects.push(callback); return null }, deps) },
  }
  let status = disconnected
  const reads = [], sent = [], cleanups = []
  let chatError = null
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url === '/api/status') {
      const result = reads.length ? await reads.shift().promise : status
      return Response.json(result)
    }
    if (url.startsWith('/api/conversation')) return Response.json({ conversationId: 'main', messages: [], operations: [] })
    if (url === '/api/chat') {
      const request = JSON.parse(init.body)
      sent.push(request)
      if (chatError) return Response.json({ error: chatError }, { status: 502 })
      return Response.json({ ...request, status: 'completed', messages: [], operations: [] })
    }
    throw new Error(`Unexpected API: ${url}`)
  })
  const render = () => {
    cursor = 0
    const value = useXixiConversation(() => {}, () => {})
    for (const effect of effects.splice(0)) { const cleanup = effect(); if (cleanup) cleanups.push(cleanup) }
    return value
  }
  t.after(() => {
    for (const cleanup of cleanups) cleanup()
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  })
  render(); await tick()
  return { render, reads, sent, setStatus: value => { status = value }, failChat: value => { chatError = value } }
}

test('switching back to configured API clears the old connection prompt without restarting or losing the draft', async t => {
  const f = await fixture(t)
  assert.equal(await f.render().send('保留这条草稿', context), false)
  assert.match(f.render().error, /先在设置里连接/)
  assert.equal(f.sent.length, 0)
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
  const f = await fixture(t)
  const pending = deferred()
  f.reads.push(pending)
  const chat = f.render()
  const sending = chat.send('切换后直接发送', context)
  assert.equal(await chat.send('切换后直接发送', context), false)
  pending.resolve(connected)
  assert.equal(await sending, true)
  assert.equal(f.sent.length, 1)
  assert.equal(f.render().error, '')
})

test('connection refresh preserves unrelated send errors and failed messages', async t => {
  const f = await fixture(t)
  f.setStatus(connected); await f.render().refreshStatus()
  f.failChat('模型暂时限流，请稍后重试')
  assert.equal(await f.render().send('重试内容', context), false)
  const before = f.render()
  assert.equal(before.error, '模型暂时限流，请稍后重试')
  await before.refreshStatus()
  assert.equal(f.render().error, before.error)
  assert.deepEqual(f.render().conversation.messages, before.conversation.messages)
})

test('an unconfigured model remains blocked after a fresh status check', async t => {
  const f = await fixture(t)
  assert.equal(await f.render().send('不要误发', context), false)
  assert.match(f.render().error, /先在设置里连接/)
  assert.equal(f.sent.length, 0)
})
