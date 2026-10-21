import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createWebSearch, readJSON } from '../server/webSearchCore.mjs'

const settings = () => ({ webSearch: { enabled: true, maxUses: 2 } })
const rows = { content: [{ type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: 'Fixture', url: 'https://example.com/fixture' }] }] }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const bytes = text => new TextEncoder().encode(text)

test('portable search has no Node page dependency, Buffer, or eager desktop page access', async () => {
  const code = readFileSync(new URL('../server/webSearchCore.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(code, /\bBuffer\b|node:|sourcePage\.mjs|\.arrayBuffer\(/u)
  const search = createWebSearch({ getSettings: settings, keychain: { read: async () => 'fake-key' }, fetcher: async () => Response.json(rows) })
  const direct = await search.search('https://github.com/fixture/repo')
  assert.equal(direct.sources[0].fetchStatus, 'failed')
  assert.equal(direct.sources[0].content, '')
  const queried = await search.search('fixture')
  assert.equal(queried.sources[0].fetchStatus, 'failed')
  assert.equal(queried.sources[0].content, '')
})

test('mobile-compatible adapter injection receives cancellation and requires a nonempty body for ok', async () => {
  const observed = [], controller = new AbortController()
  const search = createWebSearch({ getSettings: settings, pageFetcher: async (_url, { signal }) => {
    observed.push(signal)
    return { fetchStatus: 'ok', fetchedAt: '2026-10-12T00:00:00.000Z', content: '  ' }
  } })
  const result = await search.search('https://example.com/fixture', { signal: controller.signal })
  assert.equal(result.sources[0].fetchStatus, 'empty')
  assert.equal(result.sources[0].content, '')
  controller.abort()
  assert.equal(observed[0].aborted, true)
})

test('bounded JSON reader keeps split UTF-8 intact without using arrayBuffer', async () => {
  const encoded = bytes(JSON.stringify({ content: '仓库 🌌' }))
  const body = new ReadableStream({ start(controller) { for (const byte of encoded) controller.enqueue(Uint8Array.of(byte)); controller.close() } })
  assert.deepEqual(await readJSON({ body, arrayBuffer() { throw new Error('must not buffer the whole response first') } }), { content: '仓库 🌌' })
})

test('bounded JSON reader cancels at the byte limit before reading the unbounded remainder', async () => {
  let cancelled = false, pulls = 0
  const body = new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(bytes('x'.repeat(200 * 1024))) }, cancel() { cancelled = true } })
  await assert.rejects(readJSON({ body }), /无法读取/u)
  assert.equal(cancelled, true)
  assert.ok(pulls <= 5, `must stop at the byte limit, observed ${pulls} chunks`)
})

test('cancellation while reading JSON releases the idle stream before page access', async () => {
  const controller = new AbortController(), entered = deferred()
  let cancelled = false, pages = 0
  const search = createWebSearch({ getSettings: settings, keychain: { read: async () => 'fake-key' },
    fetcher: async () => { entered.resolve(); return new Response(new ReadableStream({ cancel() { cancelled = true } })) },
    pageFetcher: async () => { pages += 1; throw new Error('must not fetch after abort') } })
  const running = search.search('fixture', { signal: controller.signal })
  await entered.promise
  // Let the response reader start before cancelling it.
  await new Promise(resolve => setImmediate(resolve))
  controller.abort()
  await assert.rejects(running, /已取消/u)
  assert.equal(cancelled, true)
  assert.equal(pages, 0)
})

test('already-aborted search never reads a secret, requests the provider, or starts a page', async () => {
  const controller = new AbortController()
  controller.abort()
  const unexpected = () => { throw new Error('must not run') }
  const search = createWebSearch({ getSettings: settings, keychain: { read: unexpected }, fetcher: unexpected, pageFetcher: unexpected })
  await assert.rejects(search.search('fixture', { signal: controller.signal }), /已取消/u)
  await assert.rejects(search.search('https://example.com/', { signal: controller.signal }), /已取消/u)
})

test('caller abort reaches cloud search and stops a late response before page fetching', async () => {
  const controller = new AbortController(), entered = deferred(), response = deferred()
  let cloudSignal, pages = 0
  const search = createWebSearch({ getSettings: settings, keychain: { read: async () => 'fake-key' },
    fetcher: async (_url, { signal }) => { cloudSignal = signal; entered.resolve(); return response.promise },
    pageFetcher: async () => { pages += 1; throw new Error('must not start a page') } })
  const running = search.search('fixture', { signal: controller.signal })
  await entered.promise
  controller.abort()
  await assert.rejects(running, /已取消/u)
  assert.ok(cloudSignal.aborted)
  response.resolve(Response.json(rows))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(pages, 0)
})

test('failed adapter bodies and snippets cannot become read page content', async () => {
  const search = createWebSearch({ getSettings: settings, pageFetcher: async () => ({ content: 'must not be treated as read', fetchStatus: 'failed' }) })
  const result = await search.search('https://example.com/fixture')
  assert.equal(result.sources[0].content, '')
  assert.equal(result.sources[0].fetchStatus, 'failed')
  assert.ok(Number.isFinite(Date.parse(result.sources[0].fetchedAt)))
})

test('an unsafe or malformed complete URL never falls through to a credentialed search query', async () => {
  let calls = 0
  const unexpected = () => { calls += 1; throw new Error('must not contact any adapter') }
  const search = createWebSearch({ getSettings: settings, keychain: { read: unexpected }, fetcher: unexpected, pageFetcher: unexpected })
  for (const query of ['https://username:password@example.com/private', 'https://%invalid']) await assert.rejects(search.search(query), /网页地址无效/u)
  assert.equal(calls, 0)
})
