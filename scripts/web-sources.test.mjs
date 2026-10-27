import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createServiceCore } from '../server/serviceCore.mjs'
import { createWebSearch } from '../server/webSearch.mjs'
import { saveModelSettings } from '../server/modelSettings.mjs'
import { ProviderError } from '../server/provider.mjs'
import { isSourceMetadataList } from '../src/xixi/sourceMetadata.ts'

const at = '2026-10-12T01:02:03.000Z'
const page = (fetchStatus = 'ok', overrides = {}) => ({ title: 'Fixture repository', url: 'https://github.com/fixture/repo',
  fetchStatus, fetchedAt: at, content: fetchStatus === 'ok' ? 'README fixture body, never public source metadata.' : '', ...overrides })
const metadata = source => ({ url: source.url, title: source.title, fetchStatus: source.fetchStatus, fetchedAt: source.fetchedAt })
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const searchCall = (id = 'search', query = 'https://github.com/fixture/repo') => ({ choices: [{ message: { role: 'assistant', content: '',
  tool_calls: [{ id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] } }] })
const input = () => ({ requestId: randomUUID(), conversationId: 'main', text: '请读这个仓库并说明本地运行方法 https://github.com/fixture/repo', context: { page: 'home', timezone: 'Asia/Shanghai' } })
const settings = { provider: 'local', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: true,
  contextBudget: { mode: 'custom', maxUnits: 24000 }, webSearch: { enabled: true, maxUses: 2 },
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture-model' } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-source-fixture-'))
  const filename = join(directory, 'fixture.sqlite')
  let db = createDatabase(filename)
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  saveModelSettings(db, settings)
  return { get db() { return db }, reopen() { db.close(); db = createDatabase(filename); return db } }
}
function service(db, options = {}) {
  return createServiceCore({ db, vault: { status: async () => false }, complete: async () => reply('unused'),
    xixiFactory: createXixi, completionScope: new AsyncLocalStorage(), ...options })
}
function failureContext(payload) {
  return payload.messages.find(message => message.role === 'system' && message.content.startsWith('本轮网页读取的结构化状态：'))?.content ?? ''
}

for (const status of ['failed', 'empty']) test(`contextual ${status} model reply is preserved alongside independent source status`, async t => {
  const { db } = fixture(t)
  const prose = status === 'failed' ? '这个仓库页面没能打开，所以暂时无法确认它的本地运行命令。你可以贴出 README，我再帮你核对。'
    : '页面没有返回可用的 README 正文，目前还不能确认依赖和启动方式。可以贴出安装部分继续看。'
  const events = [], payloads = []
  const xixi = createXixi({ db, webSearch: { search: async () => ({ sources: [page(status)], notice: '外部资料' }) }, complete: async payload => {
    payloads.push(payload)
    return payloads.length === 1 ? searchCall() : reply(prose)
  } })
  const result = await xixi.chat(input(), { onEvent: event => events.push(event) })
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.messages.at(-1).content, prose)
  assert.deepEqual(result.messages.at(-1).sources, [metadata(page(status))])
  assert.match(failureContext(payloads[1]), /"status":"unverified"/u)
  assert.match(failureContext(payloads[1]), /结合用户正在问的内容自然说明/u)
  assert.match(failureContext(payloads[1]), /不能编造已访问、已核验或阅读全文/u)
  assert.deepEqual(events.filter(event => event.type === 'sources').at(-1), { type: 'sources', sources: [metadata(page(status))] })
  assert.doesNotMatch(JSON.stringify(events.filter(event => event.type === 'sources')), /content|snippet|README fixture body/u)
})

test('a search service failure reaches generation as structured failure and keeps its natural reply', async t => {
  const { db } = fixture(t)
  const payloads = [], events = []
  const prose = '查询没有成功，这次还没能读到仓库说明。可以稍后重试，或者把 README 发给我。'
  const xixi = createXixi({ db, webSearch: { search: async () => { throw new ProviderError('搜索服务暂时不可用') } },
    complete: async payload => { payloads.push(payload); return payloads.length === 1 ? searchCall() : reply(prose) } })
  const result = await xixi.chat(input(), { onEvent: event => events.push(event) })
  assert.equal(result.messages.at(-1).content, prose)
  assert.deepEqual(result.messages.at(-1).sources, [])
  assert.match(failureContext(payloads[1]), /"status":"failed"/u)
  assert.match(failureContext(payloads[1]), /搜索服务暂时不可用/u)
  assert.deepEqual(events.find(event => event.type === 'sources'), { type: 'sources', sources: [] })
})

test('SQLite disk persistence, reopen, restore and public messages keep metadata without copying page bodies', async t => {
  const f = fixture(t)
  const request = input(), source = page()
  let calls = 0
  const xixi = createXixi({ db: f.db, webSearch: { search: async () => ({ sources: [source] }) },
    complete: async () => ++calls === 1 ? searchCall() : reply('README 描述了本地运行方式。') })
  const result = await xixi.chat(request)
  const message = result.messages.at(-1), savedSources = [metadata(source)]
  assert.deepEqual(message.sources, savedSources)
  assert.doesNotMatch(message.content, /来源核验|README fixture body|2026-10-12T/u)
  assert.deepEqual(f.reopen().getMessage(message.id).sources, savedSources)
  const exported = f.db.exportData()
  const assistantRow = exported.tables.messages.find(row => row.id === message.id)
  assert.deepEqual(JSON.parse(assistantRow.document).sources, savedSources)
  assert.deepEqual(Object.keys(JSON.parse(assistantRow.document).sources[0]).sort(), ['fetchStatus', 'fetchedAt', 'title', 'url'])
  f.db.importData(exported)
  const core = service(f.db)
  const publicState = await core.dispatch('/conversation?conversationId=main')
  assert.deepEqual(publicState.messages.at(-1).sources, savedSources)
  assert.doesNotMatch(JSON.stringify(publicState), /README fixture body|"toolCalls"|"snippet"/u)
  assert.deepEqual(f.db.listOperations(), [])
  assert.deepEqual(f.db.listMemories(), [])
  assert.deepEqual(f.db.listTasks(), [])
})

test('public chat result and stream source event both carry the same bounded metadata', async t => {
  const { db } = fixture(t)
  const events = [], source = page()
  let calls = 0
  const core = service(db, { webSearch: { search: async () => ({ sources: [source] }) },
    complete: async () => ++calls === 1 ? searchCall() : reply('仓库说明已读取。') })
  const result = await core.dispatch('/chat', input(), { headers: { accept: 'text/event-stream' }, startStream: () => event => events.push(event) })
  assert.deepEqual(result.messages.at(-1).sources, [metadata(source)])
  assert.deepEqual(events.find(event => event.type === 'sources').sources, result.messages.at(-1).sources)
  assert.doesNotMatch(JSON.stringify(result.messages), /README fixture body|"toolCallId"/u)
})

test('retraction hides source metadata publicly and restoring an older fixture cannot resurrect it', async t => {
  const { db } = fixture(t)
  let calls = 0
  const request = input()
  const xixi = createXixi({ db, webSearch: { search: async () => ({ sources: [page()] }) },
    complete: async () => ++calls === 1 ? searchCall() : reply('已读到仓库说明。') })
  const result = await xixi.chat(request)
  const assistant = result.messages.at(-1), original = db.exportData()
  const core = service(db)
  const retracted = await core.dispatch('/messages/retract', { requestId: request.requestId, conversationId: 'main' })
  assert.ok(db.getMessage(assistant.id).retractedAt)
  assert.deepEqual(db.getMessage(assistant.id).sources, [metadata(page())], 'the original archive remains source-linked')
  assert.doesNotMatch(JSON.stringify(retracted), /github\.com|"sources"/u)
  db.importData(original)
  const restored = await core.dispatch('/conversation?conversationId=main')
  assert.doesNotMatch(JSON.stringify(restored), /"sources"/u)
  assert.ok(db.getMessage(assistant.id).excludeFromContext)
  assert.deepEqual(db.listMessages('main', { forContext: true }), [])
  let replays = 0
  const resumed = createXixi({ db, complete: async () => { replays += 1; return reply('must not run') } })
  assert.equal((await resumed.chat(request)).status, 'failed')
  assert.equal(replays, 0)
})

test('replay after a failed generation reuses persisted source states instead of fetching again', async t => {
  const { db } = fixture(t)
  const request = input(), payloads = []
  let searches = 0, calls = 0
  const xixi = createXixi({ db, webSearch: { search: async () => { searches += 1; return { sources: [page('failed')] } } },
    complete: async payload => {
      payloads.push(payload)
      if (++calls === 1) return searchCall()
      if (calls === 2) throw new ProviderError('model temporarily offline')
      return reply('上一次没能打开仓库，尚无法确认其运行方式。')
    } })
  assert.equal((await xixi.chat(request)).status, 'failed')
  const result = await xixi.chat(request)
  assert.equal(result.status, 'completed')
  assert.equal(searches, 1)
  assert.match(failureContext(payloads.at(-1)), /"fetchStatus":"failed"/u)
  assert.deepEqual(result.messages.at(-1).sources, [metadata(page('failed'))])
})

test('a no-body ok adapter claim becomes empty, partial results stay distinct, and public sources cap at six', async t => {
  const { db } = fixture(t)
  const sources = [page('ok', { content: '   ' }), page('failed', { url: 'https://example.com/fail', content: 'failed-body' }),
    ...Array.from({ length: 8 }, (_, i) => page('ok', { title: 'same title', url: `https://example.com/${i}` })),
    page('ok', { content: '', title: 'repeated repo URL' })]
  let calls = 0
  const payloads = []
  const xixi = createXixi({ db, webSearch: { search: async () => ({ sources }) },
    complete: async payload => { payloads.push(payload); return ++calls === 1 ? searchCall() : reply('这里是模型原文。') } })
  const result = await xixi.chat(input())
  assert.equal(result.messages.at(-1).sources.length, 6)
  assert.equal(new Set(result.messages.at(-1).sources.map(source => source.url)).size, 6)
  assert.deepEqual(result.messages.at(-1).sources.slice(0, 2).map(source => source.fetchStatus), ['empty', 'failed'])
  const tool = payloads[1].messages.find(message => message.role === 'tool')
  assert.doesNotMatch(tool.content, /failed-body/u)
  assert.match(failureContext(payloads[1]), /"status":"readable"/u)
  assert.equal(result.messages.at(-1).content, '这里是模型原文。')
})

test('database append and restore reject malformed metadata atomically and accept duplicate titles or URLs', t => {
  const { db } = fixture(t)
  const user = db.appendMessage({ conversationId: 'main', role: 'user', content: 'fixture user' })
  const source = metadata(page()), valid = [source, { ...source, title: source.url }]
  const saved = db.appendMessage({ conversationId: 'main', role: 'assistant', content: 'fixture reply', sources: valid, sourceMessageIds: [user.id] })
  assert.equal(saved.sources.length, 2)
  const malformed = [null, {}, [source, ...Array(6).fill(source)], [{ ...source, content: 'forbidden body' }],
    [{ ...source, snippet: 'forbidden snippet' }], [{ ...source, fetchStatus: 'verified' }], [{ ...source, fetchedAt: 'yesterday' }],
    [{ ...source, fetchedAt: '2026-10-12' }], [{ ...source, fetchedAt: '2026-02-30T00:00:00.000Z' }], [{ ...source, fetchedAt: '2026-10-12T24:00:00.000Z' }],
    [{ ...source, url: 'javascript:alert(1)' }], [{ ...source, url: 'https://secret:password@example.com/' }],
    [{ ...source, title: '' }], [{ ...source, title: 'bad\u0000title' }]]
  const original = db.exportData()
  for (const sources of malformed) {
    assert.equal(isSourceMetadataList(sources), false)
    assert.throws(() => db.appendMessage({ conversationId: 'main', role: 'assistant', content: 'invalid', sources }), /来源/u)
    const candidate = structuredClone(original)
    const row = candidate.tables.messages.find(row => row.id === saved.id)
    row.document = JSON.stringify({ ...JSON.parse(row.document), sources })
    candidate.checksum = createHash('sha256').update(JSON.stringify(candidate.tables)).digest('hex')
    assert.throws(() => db.importData(candidate), /来源/u)
    assert.deepEqual(db.getMessage(saved.id).sources, valid)
  }
  assert.throws(() => db.appendMessage({ conversationId: 'main', role: 'user', content: 'invalid role', sources: valid }), /来源/u)
  assert.throws(() => db.appendMessage({ conversationId: 'main', role: 'assistant', content: '', toolCalls: [{}], sources: valid }), /来源/u)
  db.importData(original)
  assert.deepEqual(db.getMessage(saved.id).sources, valid)
})

for (const retracted of [false, true]) test(`${retracted ? 'retraction' : 'explicit cancel'} aborts direct page access and discards a late adapter result`, async t => {
  const { db } = fixture(t)
  const entered = deferred(), pendingPage = deferred(), controller = new AbortController()
  let pageSignal, calls = 0
  const search = createWebSearch({ getSettings: () => settings,
    keychain: { read: async () => 'fixture-key' },
    fetcher: async (_url, { signal }) => { pageSignal = signal; entered.resolve(); return pendingPage.promise } })
  const xixi = createXixi({ db, webSearch: search, complete: async (_payload, { signal }) => {
    assert.ok(signal instanceof AbortSignal)
    calls += 1
    return searchCall()
  } })
  const request = input(), running = xixi.chat(request, { signal: controller.signal })
  await entered.promise
  const before = db.listMessages('main').length
  if (retracted) db.retractRequest(request)
  else controller.abort()
  const result = await running
  assert.equal(result.status, 'failed')
  assert.ok(pageSignal.aborted)
  pendingPage.resolve(Response.json({ content: 'late page' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(db.listMessages('main').length, before)
  assert.equal(db.listMessages('main').some(message => message.sources), false)
  assert.equal(calls, 1)
  assert.deepEqual(db.listTasks(), [])
})

for (const retracted of [false, true]) test(`${retracted ? 'retraction' : 'explicit cancel'} aborts completion and discards its late prose and tools`, async t => {
  const { db } = fixture(t)
  const entered = deferred(), model = deferred(), controller = new AbortController()
  let modelSignal
  const xixi = createXixi({ db, complete: async (_payload, { signal }) => { modelSignal = signal; entered.resolve(); return model.promise } })
  const request = input(), running = xixi.chat(request, { signal: controller.signal })
  await entered.promise
  if (retracted) db.retractRequest(request)
  else controller.abort()
  assert.equal((await running).status, 'failed')
  assert.ok(modelSignal.aborted)
  model.resolve(searchCall())
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(db.listMessages('main').length, 1)
  assert.equal(db.listMessages('main')[0].role, 'user')
})

test('an already-cancelled queued request never begins a turn or calls a provider', async t => {
  const { db } = fixture(t)
  const controller = new AbortController()
  controller.abort()
  let calls = 0
  const xixi = createXixi({ db, complete: async () => { calls += 1; return reply('must not run') } })
  await assert.rejects(xixi.chat(input(), { signal: controller.signal }), error => error.name === 'AbortError')
  assert.equal(calls, 0)
  assert.deepEqual(db.listMessages('main'), [])
})

test('a disconnected desktop observer does not cancel a source turn or lose its durable reply', async t => {
  const { db } = fixture(t)
  const signals = []
  let calls = 0
  const xixi = createXixi({ db, webSearch: { search: async (_query, { signal }) => { signals.push(signal); return { sources: [page()] } } },
    complete: async (_payload, { signal }) => { signals.push(signal); return ++calls === 1 ? searchCall() : reply('观察者断开后仍保存的回复。') } })
  const result = await xixi.chat(input(), { onEvent: () => { throw new Error('observer disconnected') } })
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.at(-1).content, '观察者断开后仍保存的回复。')
  assert.deepEqual(result.messages.at(-1).sources, [metadata(page())])
  assert.ok(signals.every(signal => !signal.aborted))
})

test('service core forwards explicit cancellation without writing a final assistant message', async t => {
  const { db } = fixture(t)
  const entered = deferred(), controller = new AbortController()
  let observed
  const core = service(db, { complete: async (_payload, { signal }) => { observed = signal; entered.resolve(); return new Promise(() => {}) } })
  const running = core.dispatch('/chat', input(), { signal: controller.signal })
  await entered.promise
  controller.abort()
  assert.equal((await running).status, 'failed')
  assert.ok(observed.aborted)
  assert.equal(db.listMessages('main').length, 1)
})

test('cancelling from a tool completion observer stops before journaling external content', async t => {
  const { db } = fixture(t)
  const controller = new AbortController()
  let calls = 0
  const xixi = createXixi({ db, webSearch: { search: async () => ({ sources: [page()] }) },
    complete: async () => { calls += 1; return searchCall() } })
  const result = await xixi.chat(input(), { signal: controller.signal, onEvent: event => {
    if (event.type === 'activity' && event.activity.id === 'tool:search' && event.activity.state === 'done') controller.abort()
  } })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 1)
  assert.equal(db.listMessages('main').length, 2)
  assert.equal(db.listMessages('main').some(message => message.role === 'tool' || message.sources), false)
  assert.doesNotMatch(JSON.stringify(db.listMessages('main')), /README fixture body/u)
})
