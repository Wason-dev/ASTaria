import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createNetFetch } from '../desktop/net-fetch.cjs'

function fixture() {
  const request = new EventEmitter(), options = [], headers = {}, calls = []
  request.end = () => calls.push('end')
  request.abort = () => { calls.push('abort'); request.emit('error', new Error('Request aborted')) }
  request.setHeader = (key, value) => { headers[key] = value }
  const fetcher = createNetFetch({ request: value => { options.push(value); return request } })
  const respond = (statusCode = 200, responseHeaders = {}) => {
    const response = Object.assign(new EventEmitter(), { statusCode, headers: responseHeaders })
    request.emit('response', response)
    return response
  }
  return { request, options, headers, calls, fetcher, respond }
}

test('Electron manual redirect becomes a response for host validation; never follows it', async () => {
  const f = fixture(), promise = f.fetcher('https://github.com/file', { redirect: 'manual' })
  f.request.emit('redirect', 302, 'GET', 'https://evil.example/secret', { location: ['https://evil.example/secret'] })
  const response = await promise
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://evil.example/secret')
  assert.equal(await response.text(), '')
  assert.deepEqual(f.calls, ['end', 'abort'])
  assert.equal(f.options.length, 1)
  assert.deepEqual(f.options[0], { url: 'https://github.com/file', method: 'GET', redirect: 'manual', credentials: 'omit', useSessionCookies: false })
})

test('streams response bytes and headers without buffering the whole asset', async () => {
  const f = fixture(), pending = f.fetcher('https://api.github.com/releases', { headers: { Accept: 'application/json', 'If-None-Match': 'old' } })
  const incoming = f.respond(200, { 'content-type': ['application/json'], etag: ['new'] })
  const result = await pending, reader = result.body.getReader()
  incoming.emit('data', Buffer.from('['))
  assert.equal(Buffer.from((await reader.read()).value).toString(), '[')
  incoming.emit('data', Buffer.from(']')); incoming.emit('end')
  assert.equal(Buffer.from((await reader.read()).value).toString(), ']')
  assert.equal((await reader.read()).done, true)
  assert.equal(result.headers.get('etag'), 'new')
  assert.equal(f.headers['if-none-match'], 'old')
})

test('304 responses retain cache headers and have no body', async () => {
  const f = fixture(), promise = f.fetcher('https://api.github.com/releases')
  f.respond(304, { etag: ['cached'] }).emit('end')
  const response = await promise
  assert.equal(response.status, 304)
  assert.equal(response.body, null)
  assert.equal(response.headers.get('etag'), 'cached')
})

test('abort before and after headers stops native request and rejects pending work', async () => {
  const f = fixture(), signal = new AbortController()
  const request = f.fetcher('https://github.com/file', { signal: signal.signal })
  signal.abort()
  await assert.rejects(request, { name: 'AbortError' })
  assert.ok(f.calls.includes('abort'))
  const early = fixture()
  await assert.rejects(early.fetcher('https://github.com/file', { signal: signal.signal }), { name: 'AbortError' })
  assert.equal(early.options.length, 0)
  const g = fixture(), controller = new AbortController(), pending = g.fetcher('https://github.com/file', { signal: controller.signal })
  g.respond()
  const response = await pending, body = response.text()
  controller.abort()
  await assert.rejects(body, { name: 'AbortError' })
})

test('body cancellation and interrupted streams do not pretend a complete download', async () => {
  const f = fixture(), pending = f.fetcher('https://github.com/file')
  f.respond()
  await (await pending).body.cancel()
  assert.ok(f.calls.includes('abort'))
  const g = fixture(), waiting = g.fetcher('https://github.com/file'), incoming = g.respond()
  const bytes = (await waiting).text()
  incoming.emit('data', Buffer.from('partial')); incoming.emit('aborted')
  await assert.rejects(bytes, /interrupted/)
})
