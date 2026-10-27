import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'
import { createWebSearch, readJSON } from '../server/webSearchCore.mjs'

const LIMIT = 4 * 1024 * 1024
const encoder = new TextEncoder()
const networkSource = stripTypeScriptTypes(await readFile(new URL('../mobile/runtime/network.ts', import.meta.url), 'utf8'))
  .replace(/^import .+$/gm, '').replace(/^export /gm, '')
const requestWithBody = body => compileFunction(`${networkSource}\nreturn nativeRequest`, ['Capacitor', 'CapacitorHttp'])(
  { isNativePlatform: () => true },
  { request: async () => ({ status: 200, data: body, headers: {} }) })
const nativeInput = { url: 'https://api.deepseek.com/v1/tools/search', method: 'POST', body: '{}' }
const searchWith = fetcher => createWebSearch({
  getSettings: () => ({ webSearch: { enabled: true } }),
  keychain: { read: async () => 'synthetic-test-key' }, fetcher,
})
function streamed(text, length) {
  const data = encoder.encode(text)
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === data.length) { controller.close(); return }
      const end = Math.min(offset + 8191, data.length)
      controller.enqueue(data.subarray(offset, end)); offset = end
    },
  }), { headers: length === undefined ? {} : { 'content-length': String(length) } })
}
function sizedJSON(size) {
  const overhead = encoder.encode(JSON.stringify({ content: '' })).length
  return JSON.stringify({ content: 'x'.repeat(size - overhead) })
}

for (const content of ['x'.repeat(100 * 1024), '文'.repeat(100 * 1024)]) {
  test(`R10 accepts eight ${content[0] === '文' ? 'UTF-8 Chinese' : 'ASCII'} long pages through core and synthetic native transport`, async () => {
    const payload = { results: Array.from({ length: 8 }, (_, i) => ({
      title: `Page ${i}`, url: `https://example.com/${i}`, content,
    })) }
    const body = JSON.stringify(payload), size = encoder.encode(body).length
    assert.ok(size > 768 * 1024 && size < LIMIT)
    for (const native of [false, true]) {
      const result = await searchWith(async (_url, input) => {
        assert.deepEqual(JSON.parse(input.body), { query: 'fixture', count: 8, need_content: true })
        const value = native ? (await requestWithBody(body)(nativeInput)).body : body
        return streamed(value, native ? size : undefined)
      }).search('fixture')
      assert.equal(result.sources.length, 8)
      assert.equal(result.truncated, false)
      for (const source of result.sources) {
        assert.equal(source.fetchStatus, 'ok')
        assert.equal(source.content, content.slice(0, 6000))
      }
    }
  })
}

test('R10 core and native transport accept exactly 4 MiB and reject one byte more', async () => {
  for (const size of [LIMIT, LIMIT + 1]) {
    const body = sizedJSON(size)
    assert.equal(encoder.encode(body).length, size)
    if (size === LIMIT) {
      for (const header of [undefined, size]) assert.equal((await readJSON(streamed(body, header))).content.length, size - 14)
      assert.equal((await requestWithBody(body)(nativeInput)).body, body)
    } else {
      // A missing or dishonest Content-Length cannot bypass byte counting.
      for (const header of [undefined, 1, size]) await assert.rejects(readJSON(streamed(body, header)), /内容过大.*4 MiB/u)
      await assert.rejects(requestWithBody(body)(nativeInput), /内容过多/u)
    }
  }
})

test('R10 oversized declared length cancels the body before acquiring a reader', async () => {
  let cancelled = 0
  await assert.rejects(readJSON({
    headers: new Headers({ 'content-length': String(LIMIT + 1) }),
    body: { getReader() { assert.fail('oversized header must be checked first') }, async cancel() { cancelled += 1 } },
  }), /内容过大.*4 MiB/u)
  assert.equal(cancelled, 1)
})

test('R10 UTF-8 bytes, rather than JS string length, enforce the streaming cap', async () => {
  const body = JSON.stringify({ content: '文'.repeat(Math.floor(LIMIT / 3)) })
  assert.ok(body.length < LIMIT && encoder.encode(body).length > LIMIT)
  await assert.rejects(readJSON(streamed(body)), /内容过大/u)
})

test('R10 direct Fetch shares the larger cap and retains its 6000-character output bound', async () => {
  const body = sizedJSON(1024 * 1024)
  const result = await searchWith(async url => {
    assert.ok(url.endsWith('/v1/tools/fetch'))
    return streamed(body)
  }).search('https://example.com/long-page')
  assert.equal(result.sources[0].content.length, 6000)
  await assert.rejects(searchWith(async () => streamed(sizedJSON(LIMIT + 1))).search('fixture'), /内容过大.*4 MiB/u)
})

test('R10 malformed JSON remains distinct from an oversized response', async () => {
  for (const text of ['{broken', '[]', 'null']) {
    await assert.rejects(readJSON(streamed(text)), error => {
      assert.match(error.message, /无法读取/u)
      assert.doesNotMatch(error.message, /内容过大/u)
      return true
    })
  }
})

test('R10 a native transport size rejection survives the bridge as a clear search/fetch error', async () => {
  const nativeRequest = requestWithBody(sizedJSON(LIMIT + 1))
  const search = searchWith(async () => {
    try { await nativeRequest(nativeInput) }
    catch (error) { throw new Error(error.message) } // The worker bridge preserves only the message.
    assert.fail('native transport must reject this body')
  })
  for (const query of ['fixture', 'https://example.com/long-page']) {
    await assert.rejects(search.search(query), /内容过大.*4 MiB/u)
  }
  await assert.rejects(searchWith(async () => { throw Error('synthetic offline') }).search('fixture'), /无法连接/u)
})
