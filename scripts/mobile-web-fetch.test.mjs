import test from 'node:test'
import assert from 'node:assert/strict'
import { createCapacitorSourceExecutor, createMobilePageFetcher, fetchPublicSource } from '../mobile/runtime/webFetch.ts'
import { createWebSearch } from '../server/webSearchCore.mjs'

const REPO_URL = 'https://github.com/octocat/Hello-World'
const BASE = 'https://api.github.com/repos/octocat/Hello-World'
const FETCHED_AT = '2026-10-12T01:02:03.000Z'
const now = () => new Date(FETCHED_AT)

// Offline fixtures use the documented GitHub REST repository, contents and
// release response formats, including fields the adapter must never follow.
// They do not assert the current live state of any repository.
const repository = {
  id: 1296269, node_id: 'MDEwOlJlcG9zaXRvcnkxMjk2MjY5', name: 'Hello-World',
  full_name: 'octocat/Hello-World', private: false, visibility: 'public',
  owner: { login: 'octocat', html_url: 'https://github.com/octocat' },
  html_url: REPO_URL, description: 'My first repository on GitHub!',
  url: BASE, default_branch: 'master', language: 'JavaScript', stargazers_count: 80, forks_count: 9,
  license: { key: 'mit', name: 'MIT License', spdx_id: 'MIT' },
}
const readme = content => ({
  type: 'file', name: 'README.md', path: 'README.md', sha: 'a'.repeat(40),
  size: Buffer.byteLength(content), encoding: 'base64',
  content: `${Buffer.from(content).toString('base64').match(/.{1,60}/gu)?.join('\n') ?? ''}\n`,
  url: `${BASE}/contents/README.md`, html_url: `${REPO_URL}/blob/master/README.md`,
  // Even a malicious download_url must never become a native request.
  download_url: 'http://169.254.169.254/latest/meta-data/',
  _links: { self: `${BASE}/contents/README.md`, html: `${REPO_URL}/blob/master/README.md` },
})
const release = {
  url: `${BASE}/releases/1`, assets_url: `${BASE}/releases/1/assets`,
  upload_url: 'https://uploads.github.com/repos/octocat/Hello-World/releases/1/assets{?name,label}',
  html_url: `${REPO_URL}/releases/tag/v1.0.0`, id: 1, node_id: 'MDc6UmVsZWFzZTE=',
  author: { login: 'octocat' }, tag_name: 'v1.0.0', target_commitish: 'master',
  name: 'v1.0.0', draft: false, prerelease: false,
  created_at: '2013-02-27T19:35:32Z', published_at: '2013-02-27T19:35:32Z',
  assets: [{ name: 'example.zip', browser_download_url: 'http://127.0.0.1/private' }],
  tarball_url: 'https://api.github.com/repos/octocat/Hello-World/tarball/v1.0.0',
  zipball_url: 'https://api.github.com/repos/octocat/Hello-World/zipball/v1.0.0',
  body: 'Description of the release\n\n## Changes\n- Fix the calendar.\n- 中文 🌌',
}

const response = (url, data, { status = 200, headers = {} } = {}) => ({
  url, data, status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
})
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const tick = () => new Promise(resolve => setImmediate(resolve))
const promptly = async promise => {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('abort did not release the page request')), 500) })]) }
  finally { clearTimeout(timer) }
}
function adapter(routes = {}, options = {}) {
  const calls = []
  const execute = async (request, { signal }) => {
    calls.push({ request, signal })
    const route = routes[request.url]
    if (typeof route === 'function') return route(request, signal)
    assert.ok(route, `unexpected native request: ${request.url}`)
    return route
  }
  return { calls, fetchPage: createMobilePageFetcher({ execute, now, ...options }) }
}
function assertFailed(value) {
  assert.deepEqual(value, { content: '', fetchedAt: FETCHED_AT, fetchStatus: 'failed' })
}

test('repository fixtures preserve actual README and repository facts for both native JSON representations', async () => {
  for (const stringJSON of [false, true]) {
    const encode = value => stringJSON ? JSON.stringify(value) : value
    const { calls, fetchPage } = adapter({
      [BASE]: response(BASE, encode(repository)),
      [`${BASE}/readme`]: response(`${BASE}/readme`, encode(readme('# Hello-World\n\nRead, plan and undo.\n中文 🌌'))),
    })
    const result = await fetchPage(`${REPO_URL}/#readme`)
    assert.equal(result.fetchStatus, 'ok')
    assert.equal(result.fetchedAt, FETCHED_AT)
    for (const fact of ['octocat/Hello-World', '# Hello-World', 'Read, plan and undo.', '中文 🌌', repository.description, 'master', 'JavaScript', 'MIT License', '80', '9']) assert.ok(result.content.includes(fact), fact)
    assert.deepEqual(calls.map(call => call.request.url), [BASE, `${BASE}/readme`])
    assert.doesNotMatch(result.content, /download_url|meta-data|node_id|MDEw/u)
    for (const { request, signal } of calls) {
      assert.equal(request.method, 'GET')
      assert.equal(request.disableRedirects, true)
      assert.equal(new URL(request.url).hostname, 'api.github.com')
      assert.equal(request.headers['Accept-Encoding'], 'identity')
      assert.equal(request.headers.Authorization, undefined)
      assert.equal(request.headers.Cookie, undefined)
      assert.equal(signal.aborted, false)
    }
  }
})

test('a missing or empty README retains only the repository information actually returned', async () => {
  for (const readmeResponse of [response(`${BASE}/readme`, { message: 'Not Found' }, { status: 404 }), response(`${BASE}/readme`, readme(''))]) {
    const { fetchPage } = adapter({ [BASE]: response(BASE, repository), [`${BASE}/readme`]: readmeResponse })
    const result = await fetchPage(REPO_URL)
    assert.equal(result.fetchStatus, 'ok')
    assert.ok(result.content.includes(repository.description))
    assert.doesNotMatch(result.content, /README|Not Found|已核验|已读取/u)
  }
})

test('releases, latest and tag direct links map to fixed API endpoints without fetching assets or pagination', async () => {
  for (const [input, endpoint, payload] of [
    [`${REPO_URL}/releases`, `${BASE}/releases?per_page=5`, [release]],
    [`${REPO_URL}/releases/latest`, `${BASE}/releases/latest`, release],
    [`${REPO_URL}/releases/tag/v1.0.0`, `${BASE}/releases/tags/v1.0.0`, release],
    [`${REPO_URL}/releases/tag/release%2Fv1.0%2Bpatch`, `${BASE}/releases/tags/release%2Fv1.0%2Bpatch`, { ...release, tag_name: 'release/v1.0+patch' }],
  ]) {
    const { calls, fetchPage } = adapter({
      [BASE]: response(BASE, repository),
      [endpoint]: response(endpoint, payload, { headers: { Link: '<http://127.0.0.1/private>; rel="next"' } }),
    })
    const result = await fetchPage(input)
    assert.equal(result.fetchStatus, 'ok')
    assert.equal(result.fetchedAt, FETCHED_AT)
    for (const fact of [release.published_at, 'Description of the release', 'Fix the calendar.', '中文 🌌']) assert.ok(result.content.includes(fact), fact)
    assert.deepEqual(calls.map(call => call.request.url), [BASE, endpoint])
    assert.doesNotMatch(result.content, /127\.0\.0\.1|example\.zip|uploads\.github|tarball|zipball/u)
  }
})

test('README and release HTML discard the GitHub shell, prioritize the article and keep actual documentation examples', async () => {
  const html = `<html><body><a class="skip-to-content">Skip to content</a>
    <header>${'Navigation '.repeat(1000)}<a href="/login">Sign in</a></header>
    <div class="js-flash-container">You signed in with another tab or window. Reload to refresh your session.</div>
    <main><nav>Issues Actions Pull requests</nav><button>Sign out</button>
      <div class="flash">You switched accounts on another tab or window. Reload to refresh your session.</div>
      <article class="markdown-body"><h1>Actual documentation</h1><p>Plan &amp; undo.</p><p>Sign in</p><p>Sign out</p></article>
      <p>Repository file listing</p><div hidden>Hidden</div><div aria-hidden="true">Decoration</div>
    </main><footer>GitHub footer</footer><script>secret()</script></body></html>`
  for (const releases of [false, true]) {
    const endpoint = releases ? `${BASE}/releases/latest` : `${BASE}/readme`
    const payload = releases ? { ...release, body: html } : readme(html)
    const { calls, fetchPage } = adapter({ [BASE]: response(BASE, repository), [endpoint]: response(endpoint, payload) })
    const result = await fetchPage(releases ? `${REPO_URL}/releases/latest` : REPO_URL)
    assert.equal(result.fetchStatus, 'ok')
    assert.match(result.content, /Actual documentation\nPlan & undo\.\nSign in\nSign out/u)
    assert.doesNotMatch(result.content, /Skip to content|Reload|session|Navigation|Issues|Hidden|Decoration|GitHub footer|secret|Repository file listing/u)
    assert.equal(result.content.split('Actual documentation').length - 1, 1)
    assert.equal(calls.length, 2)
  }
})

test('shell-only README HTML contributes no page content or login/session text', async () => {
  const shell = '<body><a href="/login">Sign in</a><div class="flash">Reload to refresh your session.</div><script>secret()</script></body>'
  const { fetchPage } = adapter({ [BASE]: response(BASE, repository), [`${BASE}/readme`]: response(`${BASE}/readme`, readme(shell)) })
  const result = await fetchPage(REPO_URL)
  assert.equal(result.fetchStatus, 'ok', 'public repository facts remain available independently of README')
  assert.ok(result.content.includes(repository.description))
  assert.doesNotMatch(result.content, /Sign in|Reload|session|secret|README/u)
})

test('empty release responses are empty, while HTTP errors never become read content', async () => {
  for (const data of [[], '', ' \n\t ']) {
    const endpoint = `${BASE}/releases?per_page=5`
    const { fetchPage } = adapter({ [BASE]: response(BASE, repository), [endpoint]: response(endpoint, data) })
    assert.deepEqual(await fetchPage(`${REPO_URL}/releases`), { content: '', fetchedAt: FETCHED_AT, fetchStatus: 'empty' })
  }
  for (const status of [404, 403, 429, 500, 204]) {
    const endpoint = `${BASE}/releases/latest`
    const { fetchPage } = adapter({ [BASE]: response(BASE, repository), [endpoint]: response(endpoint, { message: 'Not Found' }, { status }) })
    assertFailed(await fetchPage(`${REPO_URL}/releases/latest`))
  }
  const missing = adapter({ [BASE]: response(BASE, { message: 'Not Found' }, { status: 404 }) })
  assertFailed(await missing.fetchPage(REPO_URL))
  assert.equal(missing.calls.length, 1)
})

test('empty, private, unconfirmed and mismatched repository responses never trigger a second request', async () => {
  for (const repo of ['', {}, { ...repository, private: true }, { ...repository, private: undefined },
    { ...repository, visibility: 'private' }, { ...repository, full_name: 'somebody/another-repo' }]) {
    const { calls, fetchPage } = adapter({ [BASE]: response(BASE, repo) })
    assertFailed(await fetchPage(`${REPO_URL}/releases/latest`))
    assert.equal(calls.length, 1)
  }
})

test('draft releases are excluded and malformed releases cannot pretend to be public page content', async () => {
  const endpoint = `${BASE}/releases?per_page=5`
  const draft = adapter({ [BASE]: response(BASE, repository), [endpoint]: response(endpoint, [{ ...release, draft: true }]) })
  assert.deepEqual(await draft.fetchPage(`${REPO_URL}/releases`), { content: '', fetchedAt: FETCHED_AT, fetchStatus: 'empty' })
  for (const data of [{ message: 'unrelated' }, { ...release, draft: undefined }, { ...release, tag_name: '' }]) {
    const { fetchPage } = adapter({ [BASE]: response(BASE, repository), [endpoint]: response(endpoint, data) })
    assertFailed(await fetchPage(`${REPO_URL}/releases`))
  }
})

test('private destinations, credentials, ports and unsupported URL shapes are rejected before native access', async () => {
  const { calls, fetchPage } = adapter()
  for (const url of [
    'http://github.com/octocat/Hello-World', 'https://github.com:443/octocat/Hello-World',
    'https://github.com:8443/octocat/Hello-World', 'https://user:password@github.com/octocat/Hello-World',
    'https://@github.com/octocat/Hello-World', 'https://github.com.evil.example/octocat/Hello-World',
    'https://github.com./octocat/Hello-World', 'https://www.github.com/octocat/Hello-World',
    'https://127.0.0.1/private', 'https://[::1]/private', 'https://10.0.0.1/private',
    'https://169.254.169.254/latest/meta-data/', 'https://localhost/private', 'https://example.com/public',
    'https://api.github.com/repos/octocat/Hello-World', 'https://raw.githubusercontent.com/octocat/Hello-World/master/README.md',
    'file:///etc/passwd', 'https://github.com/octocat/Hello-World/tree/master', `${REPO_URL}?tab=readme`,
    'https://github.com/octocat/%2e%2e', 'https://github.com/octocat/Hello-World/../Hello-World',
    'https://github.com/octocat/Hello-World/../../secret', 'https://github.com/octocat\\Hello-World',
    `${REPO_URL}/releases/tag/%00bad`, `${REPO_URL}/releases/tag/..`, `${REPO_URL}/releases/tag/a%3Fb`,
    `${REPO_URL}/releases/tag/%invalid`, `${REPO_URL}/releases/tag/%2F..%2Fprivate`, `${REPO_URL}\n`,
  ]) assertFailed(await fetchPage(url))
  assert.equal(calls.length, 0)
})

test('all redirects are refused, including redirects between official hosts, without opening Location', async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    for (const location of ['http://127.0.0.1/private', 'https://raw.githubusercontent.com/octocat/Hello-World/master/README.md', `${BASE}/readme`, '']) {
      const { calls, fetchPage } = adapter({ [BASE]: response(BASE, repository, { status, headers: { Location: location } }) })
      assertFailed(await fetchPage(REPO_URL))
      assert.equal(calls.length, 1)
    }
  }
  for (const endpoint of [`${BASE}/readme`, `${BASE}/releases/latest`]) {
    const { calls, fetchPage } = adapter({
      [BASE]: response(BASE, repository),
      [endpoint]: response(endpoint, '', { status: 302, headers: { Location: 'http://10.0.0.1/private' } }),
    })
    assertFailed(await fetchPage(endpoint.endsWith('readme') ? REPO_URL : `${REPO_URL}/releases/latest`))
    assert.equal(calls.length, 2)
  }
})

test('a changed response URL or Location on a 200 response also fails the consistency check', async () => {
  for (const wire of [response('http://127.0.0.1/private', repository), response(`${BASE}/readme`, repository), response(BASE, repository, { headers: { location: `${BASE}/readme` } })]) {
    const { calls, fetchPage } = adapter({ [BASE]: wire })
    assertFailed(await fetchPage(REPO_URL))
    assert.equal(calls.length, 1)
  }
})

test('unexpected MIME, malformed JSON, invalid base64, binary README and oversized responses fail closed', async () => {
  const tooManyBytes = JSON.stringify({ ...repository, description: '界'.repeat(190_000) })
  for (const wire of [
    response(BASE, '<html>Sign in</html>', { headers: { 'Content-Type': 'text/html' } }),
    response(BASE, '{invalid-json'), response(BASE, tooManyBytes),
    response(BASE, repository, { headers: { 'Content-Length': String(512 * 1024 + 1) } }),
  ]) {
    const { calls, fetchPage } = adapter({ [BASE]: wire })
    assertFailed(await fetchPage(REPO_URL))
    assert.equal(calls.length, 1)
  }
  for (const file of [
    { ...readme('README'), content: '!!not-base64!!' },
    { ...readme('README'), encoding: 'none' },
    { ...readme('README'), content: '/w==' },
    readme('x'.repeat(512 * 1024 + 1)),
  ]) {
    const { fetchPage } = adapter({ [BASE]: response(BASE, repository), [`${BASE}/readme`]: response(`${BASE}/readme`, file) })
    assertFailed(await fetchPage(REPO_URL))
  }
})

test('a long README and release list are clipped without letting navigation consume the output', async () => {
  const { fetchPage } = adapter({ [BASE]: response(BASE, repository), [`${BASE}/readme`]: response(`${BASE}/readme`, readme(`Useful README\n${'actual facts '.repeat(1000)}`)) })
  const result = await fetchPage(REPO_URL)
  assert.equal(result.fetchStatus, 'ok')
  assert.ok(result.content.startsWith('仓库：octocat/Hello-World\n\nUseful README'))
  assert.equal(result.content.length, 6000)
  const endpoint = `${BASE}/releases?per_page=5`
  const list = adapter({ [BASE]: response(BASE, repository), [endpoint]: response(endpoint, Array.from({ length: 6 }, (_, i) => ({ ...release, tag_name: `v${i}`, name: `v${i}` }))) })
  const releases = await list.fetchPage(`${REPO_URL}/releases`)
  assert.match(releases.content, /v4/u)
  assert.doesNotMatch(releases.content, /v5/u)
})

test('the native executor uses redirect rejection on iOS and Android and reconstructs anonymous GET options', async () => {
  for (const platform of ['ios', 'android']) {
    const requests = [], controller = new AbortController()
    const execute = createCapacitorSourceExecutor({
      capacitor: { getPlatform: () => platform, isNativePlatform: () => true, isPluginAvailable: () => true },
      http: { request: async options => { requests.push(options); return response(options.url, repository) } },
    })
    await execute({ url: BASE, method: 'GET', disableRedirects: true,
      headers: { Authorization: 'must-not-be-forwarded', Cookie: 'must-not-be-forwarded' }, data: 'must-not-be-forwarded',
      params: { url: 'http://127.0.0.1/private' }, responseType: 'json', connectTimeout: 100_000, readTimeout: 100_000,
    }, { signal: controller.signal })
    assert.equal(requests.length, 1)
    assert.equal(requests[0].disableRedirects, true)
    assert.equal(requests[0].responseType, 'text')
    assert.equal(requests[0].method, 'GET')
    assert.equal(requests[0].headers.Authorization, undefined)
    assert.equal(requests[0].headers.Cookie, undefined)
    assert.equal(requests[0].params, undefined)
    assert.equal(requests[0].data, undefined)
    assert.equal(requests[0].connectTimeout, 8000)
    assert.equal(requests[0].readTimeout, 8000)
  }
})

test('the native executor cannot become an arbitrary URL proxy or use a web/unknown/missing-plugin fallback', async () => {
  let requests = 0
  const http = { request: async () => { requests++; throw Error('unexpected native request') } }
  const native = { getPlatform: () => 'ios', isNativePlatform: () => true, isPluginAvailable: () => true }
  const request = { url: BASE, method: 'GET', headers: {}, disableRedirects: true, responseType: 'text', connectTimeout: 100, readTimeout: 100 }
  const controller = new AbortController()
  for (const capacitor of [
    { ...native, isNativePlatform: () => false }, { ...native, getPlatform: () => 'web' },
    { ...native, getPlatform: () => 'unknown' }, { ...native, isPluginAvailable: () => false },
  ]) await assert.rejects(createCapacitorSourceExecutor({ capacitor, http })(request, { signal: controller.signal }), /UNSUPPORTED/u)
  const execute = createCapacitorSourceExecutor({ capacitor: native, http })
  for (const url of ['http://api.github.com/repos/octocat/Hello-World', 'https://api.github.com:443/repos/octocat/Hello-World',
    'https://api.github.com/repos/octocat/Hello-World?other=1', `${BASE}/../../private`, `${BASE}/contents/secret`,
    `${BASE}/releases/tags/%2E%2E`, 'https://127.0.0.1/private', 'https://example.com/public']) {
    await assert.rejects(execute({ ...request, url }, { signal: controller.signal }), /UNSUPPORTED/u)
  }
  await assert.rejects(execute({ ...request, disableRedirects: false }, { signal: controller.signal }), /UNSUPPORTED/u)
  await assert.rejects(execute({ ...request, method: 'POST' }, { signal: controller.signal }), /UNSUPPORTED/u)
  assert.equal(requests, 0)
  assert.equal((await fetchPublicSource(REPO_URL)).fetchStatus, 'failed', 'Node/web never falls back to external fetch')
})

test('the Capacitor executor feeds both repository and release fixtures through the full page adapter', async () => {
  for (const platform of ['ios', 'android']) {
    const calls = []
    const execute = createCapacitorSourceExecutor({
      capacitor: { getPlatform: () => platform, isNativePlatform: () => true, isPluginAvailable: () => true },
      http: { request: async request => {
        calls.push(request)
        const data = request.url === BASE ? repository : request.url.endsWith('/readme') ? readme('README from native bridge') : release
        return response(request.url, data)
      } },
    })
    const fetchPage = createMobilePageFetcher({ execute, now })
    const repo = await fetchPage(REPO_URL)
    assert.equal(repo.fetchStatus, 'ok')
    assert.match(repo.content, /README from native bridge/u)
    const latest = await fetchPage(`${REPO_URL}/releases/latest`)
    assert.equal(latest.fetchStatus, 'ok')
    assert.match(latest.content, /Description of the release/u)
    assert.deepEqual(calls.map(call => call.url), [BASE, `${BASE}/readme`, BASE, `${BASE}/releases/latest`])
    assert.ok(calls.every(call => call.disableRedirects === true))
  }
})

test('standalone native executor cancellation rejects promptly and ignores a late Capacitor reply', async () => {
  const controller = new AbortController(), entered = deferred(), late = deferred()
  let calls = 0
  const execute = createCapacitorSourceExecutor({
    capacitor: { getPlatform: () => 'ios', isNativePlatform: () => true, isPluginAvailable: () => true },
    http: { request: () => { calls++; entered.resolve(); return late.promise } },
  })
  const request = { url: BASE, method: 'GET', headers: {}, disableRedirects: true, responseType: 'text', connectTimeout: 100, readTimeout: 100 }
  const pending = execute(request, { signal: controller.signal })
  await entered.promise
  controller.abort()
  await assert.rejects(promptly(pending), /SOURCE_ABORTED/u)
  late.resolve(response(BASE, repository))
  await tick()
  await assert.rejects(execute(request, { signal: controller.signal }), /SOURCE_ABORTED/u)
  assert.equal(calls, 1)
})

test('already-aborted page access makes no network request', async () => {
  const controller = new AbortController(), { calls, fetchPage } = adapter()
  controller.abort()
  assertFailed(await fetchPage(REPO_URL, { signal: controller.signal }))
  assert.equal(calls.length, 0)
})

test('abort during the repository request releases immediately and ignores a late response before follow-up access', async () => {
  const controller = new AbortController(), entered = deferred(), late = deferred()
  let parsed = 0
  const { calls, fetchPage } = adapter({ [BASE]: (_request, signal) => { assert.equal(signal.aborted, false); entered.resolve(); return late.promise } })
  const pending = fetchPage(REPO_URL, { signal: controller.signal })
  await entered.promise
  controller.abort()
  assertFailed(await promptly(pending))
  assert.equal(calls[0].signal.aborted, true)
  late.resolve(response(BASE, { toJSON() { parsed++; return repository } }))
  await tick()
  assert.equal(parsed, 0)
  assert.equal(calls.length, 1)
})

test('abort during README or release fetching discards late bodies and cannot return ok', async () => {
  for (const releases of [false, true]) {
    const controller = new AbortController(), entered = deferred(), late = deferred()
    const endpoint = releases ? `${BASE}/releases/latest` : `${BASE}/readme`
    let parsed = 0
    const { calls, fetchPage } = adapter({ [BASE]: response(BASE, repository), [endpoint]: () => { entered.resolve(); return late.promise } })
    const pending = fetchPage(releases ? `${REPO_URL}/releases/latest` : REPO_URL, { signal: controller.signal })
    await entered.promise
    controller.abort()
    assertFailed(await promptly(pending))
    assert.equal(calls[1].signal.aborted, true)
    late.resolve(response(endpoint, { toJSON() { parsed++; return releases ? release : readme('Late README') } }))
    await tick()
    assert.equal(parsed, 0)
    assert.equal(calls.length, 2)
  }
})

test('the same deadline bounds a hanging native request and prevents a late second request', async () => {
  const entered = deferred(), late = deferred()
  const { calls, fetchPage } = adapter({ [BASE]: () => { entered.resolve(); return late.promise } }, { timeoutMs: 15 })
  const pending = fetchPage(REPO_URL)
  await entered.promise
  assertFailed(await promptly(pending))
  assert.equal(calls[0].signal.aborted, true)
  late.resolve(response(BASE, repository))
  await tick()
  assert.equal(calls.length, 1)
})

test('a synchronous native response parse cannot escape the deadline before its timer can fire', async () => {
  const data = { toJSON() {
    // The native bridge delivers an already buffered value. Parsing can occupy
    // the JS thread past the deadline, preventing the abort timer from running.
    const until = performance.now() + 30
    while (performance.now() < until) { /* Simulate a busy bridge/parse. */ }
    return repository
  } }
  const { calls, fetchPage } = adapter({ [BASE]: response(BASE, data) }, { timeoutMs: 15 })
  assertFailed(await fetchPage(REPO_URL))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].signal.aborted, true)
})

test('portable search accepts the mobile pageFetcher without an index/key and keeps failed/empty status truthful', async () => {
  const { calls, fetchPage } = adapter({ [BASE]: response(BASE, repository), [`${BASE}/readme`]: response(`${BASE}/readme`, readme('Actual README')) })
  const search = createWebSearch({ pageFetcher: fetchPage, getSettings: () => ({ webSearch: { enabled: true } }),
    keychain: { read: () => { throw Error('must not read a key') } }, fetcher: () => { throw Error('must not use an index') } })
  const result = await search.search(REPO_URL)
  assert.equal(result.sources[0].fetchStatus, 'ok')
  assert.equal(result.sources[0].fetchedAt, FETCHED_AT)
  assert.match(result.sources[0].content, /Actual README/u)
  assert.equal(calls.length, 2)
  const failed = await search.search('https://example.com/public')
  assert.equal(failed.sources[0].fetchStatus, 'failed')
  assert.equal(failed.sources[0].content, '')
  assert.equal(calls.length, 2)
  const endpoint = `${BASE}/releases?per_page=5`
  const empty = adapter({ [BASE]: response(BASE, repository), [endpoint]: response(endpoint, []) })
  const emptySearch = createWebSearch({ pageFetcher: empty.fetchPage, getSettings: () => ({ webSearch: { enabled: true } }) })
  const noBody = await emptySearch.search(`${REPO_URL}/releases`)
  assert.equal(noBody.sources[0].fetchStatus, 'empty')
  assert.equal(noBody.sources[0].content, '')
})

test('portable search cancellation reaches the native executor and rejects despite a late page reply', async () => {
  const controller = new AbortController(), entered = deferred(), late = deferred()
  const { calls, fetchPage } = adapter({ [BASE]: () => { entered.resolve(); return late.promise } })
  const search = createWebSearch({ pageFetcher: fetchPage, getSettings: () => ({ webSearch: { enabled: true } }) })
  const pending = search.search(REPO_URL, { signal: controller.signal })
  await entered.promise
  controller.abort()
  await assert.rejects(promptly(pending), /已取消/u)
  assert.equal(calls[0].signal.aborted, true)
  late.resolve(response(BASE, repository))
  await tick()
  assert.equal(calls.length, 1)
})
