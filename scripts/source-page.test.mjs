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

test('a GitHub repository direct link keeps README and repository facts while dropping the shell', async () => {
  const body = `<html><head><title>GitHub page</title></head><body>
    <a class="skip-to-content" href="#start-of-content">Skip to content</a>
    <header><nav>Platform Solutions Resources</nav><a href="/login">Sign in</a></header>
    <div id="repository-container-header"><h1>fixture-owner / fixture-repo</h1><span>Public</span><a href="/login">Sign in</a></div>
    <div class="js-flash-container">You signed in with another tab or window. Reload to refresh your session.</div>
    <main id="start-of-content"><nav>Issues Pull requests Actions</nav>
      <button>Sign out</button><a href="/signup">Sign up</a>
      <div class="flash">You switched accounts on another tab or window. Reload to refresh your session.</div>
      <section><p>A local-first calendar</p><div>src/ server/ README.md</div><p>Apache-2.0 license · TypeScript · 17 stars</p></section>
      <article class="markdown-body"><h1>Fixture README</h1><p>Read, plan and undo saved operations.</p><h2>Quick start</h2><p>npm run dev</p></article>
      <div hidden>Hidden menu</div><div aria-hidden="true">Screen decoration</div>
    </main><footer>GitHub footer</footer></body></html>`
  const client = responseClient({ body })
  const result = await fetchSourcePage('https://github.com/fixture-owner/fixture-repo', {
    lookup: async () => ['93.184.215.14'], request: client.request,
  })
  assert.equal(result.fetchStatus, 'ok')
  for (const fact of ['fixture-owner / fixture-repo', 'Public', 'A local-first calendar', 'README.md', 'Apache-2.0', 'TypeScript', '17 stars', 'Fixture README', 'Quick start', 'npm run dev']) assert.ok(result.content.includes(fact), fact)
  assert.doesNotMatch(result.content, /Skip to content|Sign in|Sign out|Sign up|Reload|session|Platform|GitHub footer|Hidden menu|Screen decoration/u)
  assert.equal(client.calls[0].url, 'https://github.com/fixture-owner/fixture-repo')
})

test('GitHub shell-only HTML is empty, and shell keywords in actual README examples stay intact', () => {
  assert.equal(pageText('<body><a href="/login">Sign in</a><div class="flash">Reload to refresh your session.</div></body>', 'https://github.com/fixture/repo'), '')
  assert.equal(pageText('<main><article><h1>Authentication examples</h1><p>Sign in</p><p>Sign out</p></article></main>', 'https://github.com/fixture/repo'), 'Authentication examples\nSign in\nSign out')
})

test('generic pages prefer main or article and retain the body and plain-text fallback', () => {
  assert.equal(pageText('<body><div>page shell</div><main><p>main text</p></main></body>'), 'main text')
  assert.equal(pageText('<body><div>shell</div><article><p>article text</p></article></body>'), 'article text')
  assert.equal(pageText('<body><div>fallback text</div></body>'), 'fallback text')
  assert.equal(pageText('plain public document'), 'plain public document')
})

test('a large GitHub navigation shell cannot consume the README extraction limit', () => {
  const html = `<body><header>${'navigation '.repeat(1000)}</header><main><article><h1>Useful README</h1><p>Actual project facts.</p></article></main></body>`
  assert.equal(pageText(html, 'https://github.com/fixture/repo'), 'Useful README\nActual project facts.')
})

test('README is extracted before a long repository file listing and is not duplicated', () => {
  const html = `<main><div>${'package-file '.repeat(800)}</div><article><h1>Fixture README</h1><p>Run the app locally.</p></article><p>TypeScript repository</p></main>`
  const content = pageText(html, 'https://github.com/fixture/repo')
  assert.ok(content.startsWith('Fixture README\nRun the app locally.'))
  assert.equal(content.split('Fixture README').length - 1, 1)
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

test('follows up to three safe redirects and resolves every target separately', async () => {
  const calls = []
  const request = (url, options, callback) => {
    calls.push(String(url))
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.destroy = () => {}
      response.headers = calls.length < 3
        ? { location: calls.length === 1 ? 'https://redirect.example/step-2' : '/final', 'content-type': 'text/html' }
        : { 'content-type': 'text/html' }
      response.statusCode = calls.length < 3 ? 302 : 200
      callback(response)
      if (response.statusCode === 200) { response.emit('data', Buffer.from('<main><p>最终正文</p></main>')); response.emit('end') }
    })
    return req
  }
  const result = await fetchSourcePage('https://source.example/start', {
    lookup: async hostname => hostname === 'source.example' || hostname === 'redirect.example' ? ['93.184.215.14'] : [],
    request,
  })
  assert.equal(result.fetchStatus, 'ok')
  assert.equal(result.content, '最终正文')
  assert.deepEqual(calls, ['https://source.example/start', 'https://redirect.example/step-2', 'https://redirect.example/final'])
})

test('rejects a redirect to a private host before opening it', async () => {
  const client = responseClient({ statusCode: 302 })
  client.request = (url, options, callback) => {
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => {
      const response = new EventEmitter()
      response.statusCode = 302; response.headers = { location: 'http://127.0.0.1/secret' }; response.destroy = () => {}
      callback(response)
    })
    return req
  }
  const result = await fetchSourcePage('https://source.example/', { lookup: async () => ['93.184.215.14'], request: client.request })
  assert.equal(result.fetchStatus, 'failed')
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

test('caller cancellation while DNS resolves never opens a later request', async () => {
  const controller = new AbortController(), client = responseClient()
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const lookup = () => { entered(); return new Promise(resolve => { release = resolve }) }
  const pending = fetchSourcePage('https://source.example/', { lookup, request: client.request, signal: controller.signal })
  await started
  controller.abort()
  assert.equal((await pending).fetchStatus, 'failed')
  release(['93.184.215.14'])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(client.calls.length, 0)
})

test('caller cancellation destroys a page body stream and cannot later report ok', async () => {
  const controller = new AbortController()
  let release, response, destroyed = false, requestSignal
  const started = new Promise(resolve => { release = resolve })
  const request = (_url, { signal }, callback) => {
    requestSignal = signal
    const req = new EventEmitter()
    req.end = () => queueMicrotask(() => {
      response = new EventEmitter()
      response.statusCode = 200; response.headers = { 'content-type': 'text/html' }
      response.destroy = () => { destroyed = true }
      callback(response)
      response.emit('data', Buffer.from('<main><p>partial page'))
      release()
    })
    return req
  }
  const pending = fetchSourcePage('https://source.example/', { lookup: async () => ['93.184.215.14'], request, signal: controller.signal })
  await started
  controller.abort()
  const result = await pending
  assert.equal(result.fetchStatus, 'failed')
  assert.equal(result.content, '')
  assert.equal(destroyed, true)
  assert.equal(requestSignal.aborted, true)
  response.emit('end')
})
