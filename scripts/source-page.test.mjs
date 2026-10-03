import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { fetchSourcePage, pageText, publicIPv4 } from '../server/sourcePage.mjs'

function responseClient({ statusCode = 200, contentType = 'text/html', body = '<body><main><p>核验正文</p></main></body>' } = {}) {
  const calls = []
  const request = (url, options, callback) => {
    calls.push({ url: String(url), options })
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => {
      const res = new EventEmitter()
      res.statusCode = statusCode
      res.headers = { 'content-type': contentType }
      res.destroy = () => {}
      callback(res)
      if (statusCode === 200 && /^text\//u.test(contentType)) {
        res.emit('data', Buffer.from(body))
        res.emit('end')
      }
    })
    return req
  }
  return { request, calls }
}

test('extracts body text without scripts, navigation, or markup', () => {
  assert.equal(pageText('<html><head><title>标题</title></head><body><nav>菜单</nav><main><h1>日期</h1><p>10月5日 &amp; 10月6日</p></main><script>secret()</script></body></html>'), '日期\n10月5日 & 10月6日')
})

test('blocks private, loopback, metadata and reserved IPv4 addresses', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.88.99.1', '198.51.100.1', '224.0.0.1', '203.0.113.1']) assert.equal(publicIPv4(ip), false, ip)
  assert.equal(publicIPv4('93.184.215.14'), true)
})

test('public page lookup is pinned and includes body, time and status', async () => {
  const client = responseClient()
  const result = await fetchSourcePage('https://source.example/article', {
    lookup: async () => ['93.184.215.14'], request: client.request, now: () => new Date('2026-10-03T01:00:00Z'),
  })
  assert.deepEqual(result, { content: '核验正文', fetchedAt: '2026-10-03T01:00:00.000Z', fetchStatus: 'ok' })
  assert.equal(client.calls.length, 1)
  assert.equal(client.calls[0].options.headers['Accept-Encoding'], 'identity')
  assert.equal(client.calls[0].options.lookup('source.example', {}, (error, address) => assert.equal(address, '93.184.215.14')), undefined)
  client.calls[0].options.lookup('source.example', { all: true }, (error, addresses) => {
    assert.equal(error, null)
    assert.deepEqual(addresses, [{ address: '93.184.215.14', family: 4 }])
  })
})

test('rejects local destinations, redirects, oversized and empty pages', async () => {
  const client = responseClient()
  for (const url of ['http://127.0.0.1/secret', 'http://localhost/', 'https://user:pass@source.example/', 'file:///tmp/key']) {
    assert.equal((await fetchSourcePage(url, { lookup: async () => ['93.184.215.14'], request: client.request })).fetchStatus, 'failed')
  }
  assert.equal(client.calls.length, 0)
  assert.equal((await fetchSourcePage('https://source.example/', { lookup: async () => ['169.254.169.254'], request: client.request })).fetchStatus, 'failed')
  assert.equal(client.calls.length, 0)
  const redirect = responseClient({ statusCode: 302 })
  assert.equal((await fetchSourcePage('https://source.example/', { lookup: async () => ['93.184.215.14'], request: redirect.request })).fetchStatus, 'failed')
  const empty = responseClient({ body: '<body><script>only script</script></body>' })
  assert.equal((await fetchSourcePage('https://source.example/', { lookup: async () => ['93.184.215.14'], request: empty.request })).fetchStatus, 'empty')
  const large = responseClient({ body: 'x'.repeat(512 * 1024 + 1) })
  assert.equal((await fetchSourcePage('https://source.example/', { lookup: async () => ['93.184.215.14'], request: large.request })).fetchStatus, 'failed')
})

test('DNS resolution is bounded by the same deadline as the page request', async () => {
  const client = responseClient()
  const result = await fetchSourcePage('https://source.example/', {
    lookup: () => new Promise(() => {}), request: client.request, timeoutMs: 10,
  })
  assert.equal(result.fetchStatus, 'failed')
  assert.equal(client.calls.length, 0)
})

test('a caller cancellation stops page lookup before any request is made', async () => {
  const controller = new AbortController()
  const client = responseClient()
  controller.abort()
  const result = await fetchSourcePage('https://source.example/', {
    signal: controller.signal, lookup: () => { throw new Error('unexpected lookup') }, request: client.request,
  })
  assert.equal(result.fetchStatus, 'failed')
  assert.equal(client.calls.length, 0)
})
