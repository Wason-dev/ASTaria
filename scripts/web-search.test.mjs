import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createWebSearch, WEB_SEARCH_ENDPOINT, WEB_FETCH_ENDPOINT } from '../server/webSearch.mjs'
import { saveModelSettings, validateModelSettings, getModelSettings } from '../server/modelSettings.mjs'
import { ProviderError } from '../server/provider.mjs'

const local = (webSearch = { enabled: false, maxUses: 2 }) => ({
  provider: 'local', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: false,
  contextBudget: { mode: 'auto', maxUnits: 48_000 }, webSearch,
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
})
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const searchResponse = value => Response.json(value)
const resultBlock = rows => ({ results: rows })
const searchRows = count => Array.from({ length: count }, (_, index) => ({ title: `来源 ${index}`, url: `https://example.com/${index}`, content: '网页正文' }))
// No test touches the real keychain or opens a socket.
const cloudSearch = (fetcher, { webSearch = { enabled: true, maxUses: 2 }, keychain = { read: async () => 'fake-search-key' } } = {}) =>
  createWebSearch({ keychain, getSettings: () => local(webSearch), fetcher })

test('联网搜索配置默认关闭且旧设置迁移为关闭', () => {
  const saved = validateModelSettings(local())
  assert.deepEqual(saved.webSearch, { enabled: false, maxUses: 2 })
  assert.deepEqual(validateModelSettings({ ...local(), webSearch: { enabled: true } }).webSearch, { enabled: true, maxUses: 2 })
  assert.throws(() => validateModelSettings({ ...local(), webSearch: { enabled: 'yes' } }), /开关/u)
  assert.throws(() => validateModelSettings({ ...local(), webSearch: { enabled: true, maxUses: 5 } }), /次数/u)
})

test('official Search sends only the query, requests content and reuses the saved Key', async () => {
  const requests = []
  const search = cloudSearch(async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    return searchResponse({ results: [
      { title: '来源 A', url: 'https://example.com/a', snippet: '摘要 A', summary: '长摘要', content: '真实正文', date: '2026-10-23T00:00:00Z' },
      { title: '重复来源', url: 'https://example.com/a' },
      { title: '来源 B', url: 'https://example.com/b', summary: '有摘要，无正文', content: '' },
    ] })
  })
  const result = await search.search('ASTaria 最新版本')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, WEB_SEARCH_ENDPOINT)
  assert.deepEqual(requests[0].body, { query: 'ASTaria 最新版本', count: 8, need_content: true })
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fake-search-key')
  assert.equal(requests[0].options.headers['x-api-key'], undefined)
  assert.equal(requests[0].options.redirect, 'error')
  assert.deepEqual(result.sources.map(({ fetchedAt, ...row }) => row), [
    { title: '来源 A', url: 'https://example.com/a', snippet: '摘要 A', publishedAt: '2026-10-23T00:00:00Z', source: 'example.com', content: '真实正文', fetchStatus: 'ok' },
    { title: '来源 B', url: 'https://example.com/b', snippet: '有摘要，无正文', publishedAt: null, source: 'example.com', content: '', fetchStatus: 'empty' },
  ])
  assert.ok(result.sources.every(row => Number.isFinite(Date.parse(row.fetchedAt))))
  assert.equal(result.truncated, false)
})

test('direct URL uses official Fetch and the same Key, without another model or local page request', async () => {
  const requests = []
  const search = cloudSearch(async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    return searchResponse({ title: '仓库', content: '# ASTaria\n公开正文' })
  })
  const result = await search.search('https://github.com/Wason-dev/ASTaria')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, WEB_FETCH_ENDPOINT)
  assert.deepEqual(requests[0].body, { url: 'https://github.com/Wason-dev/ASTaria' })
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fake-search-key')
  assert.equal(result.sources[0].content, '# ASTaria\n公开正文')
  assert.equal(result.sources[0].fetchStatus, 'ok')
  assert.equal(result.sources[0].title, '仓库')
})

test('query limits count Unicode characters while URLs have their own length limit', async () => {
  let calls = 0
  const search = cloudSearch(async url => { calls += 1; return searchResponse(url === WEB_SEARCH_ENDPOINT ? { results: [] } : { content: '正文' }) })
  await search.search('🌌'.repeat(128))
  await assert.rejects(search.search('🌌'.repeat(129)), /简短/u)
  await search.search('https://example.com/' + 'a'.repeat(200))
  await assert.rejects(search.search('https://example.com/' + 'a'.repeat(2048)), /网页地址/u)
  assert.equal(calls, 2)
})

test('an empty page stays unverified even when the model invents a date, without replacing its prose', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  saveModelSettings(db, local({ enabled: true, maxUses: 2 }))
  let calls = 0
  const xixi = createXixi({ db,
    webSearch: { search: async () => ({ sources: [{ title: '10月5日开始', url: 'https://example.com/a', content: '', fetchStatus: 'empty', fetchedAt: '2026-10-03T01:00:00.000Z' }], truncated: false, notice: '外部资料' }) },
    complete: async payload => {
      calls += 1
      if (calls === 2) {
        const state = payload.messages.find(message => message.role === 'system' && message.content.startsWith('本轮网页读取的结构化状态：'))
        assert.match(state.content, /"status":"unverified"/u)
        assert.match(state.content, /"fetchStatus":"empty"/u)
        assert.match(state.content, /不能编造已访问、已核验或阅读全文/u)
      }
      return calls === 1 ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'search', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '日期' }) } }] } }] }
        : reply('日期确定是10月5日')
    },
  })
  const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '查日期', context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(result.messages.at(-1).content, '日期确定是10月5日', 'model mistakes must not be hidden by replacing every response')
  assert.deepEqual(result.messages.at(-1).sources, [{ title: '10月5日开始', url: 'https://example.com/a', fetchStatus: 'empty', fetchedAt: '2026-10-03T01:00:00.000Z' }])
  assert.doesNotMatch(result.messages.at(-1).content, /来源核验/u)
})

test('search refuses disabled or unconfigured cloud channels without a request', async () => {
  let calls = 0
  const search = createWebSearch({ keychain: { read: async () => { calls += 1; return 'key' } }, getSettings: () => local() , fetcher: async () => { calls += 1 } })
  await assert.rejects(search.search('anything'), error => error instanceof ProviderError && /尚未开启/u.test(error.message))
  assert.equal(calls, 0)
  const missing = createWebSearch({ keychain: { read: async () => { throw new Error('locked') } }, getSettings: () => local({ enabled: true, maxUses: 2 }), fetcher: async () => { throw new Error('must not fetch') } })
  await assert.rejects(missing.search('anything'), /先保存 DeepSeek API Key/u)
})

test('local model receives web_search only after explicit opt-in and keeps the search result local', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const requests = [], queries = []
  saveModelSettings(db, local({ enabled: true, maxUses: 2 }))
  const xixi = createXixi({ db, webSearch: { search: async query => {
    queries.push(query)
    return { sources: [{ title: '外部来源', url: 'https://example.com', snippet: '外部摘要', publishedAt: null }], truncated: false, notice: '外部资料' }
  } }, complete: async request => {
    requests.push(request)
    if (requests.length === 1) return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'web-call', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'ASTaria beta7' }) } }] } }] }
    return reply('已整理来源')
  } })
  const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '请查 ASTaria beta7 的最新信息', context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(result.status, 'completed')
  assert.deepEqual(queries, ['ASTaria beta7'])
  assert.ok(requests[0].tools.some(item => item.function.name === 'web_search'))
  const toolResult = requests[1].messages.find(message => message.role === 'tool')
  assert.match(toolResult.content, /外部来源/u)
  assert.doesNotMatch(toolResult.content, /课表|事项|聊天|记忆/u)
})

test('local model does not receive the search tool by default', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const requests = []
  saveModelSettings(db, local())
  const xixi = createXixi({ db, complete: async request => { requests.push(request); return reply('不用联网') } })
  await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '你好', context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(requests[0].tools.some(item => item.function.name === 'web_search'), false)
})

// This contract checks a confirmed write; scheduling capacity is covered separately.
test('a search in one turn does not block a confirmed local write in the next turn', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  saveModelSettings(db, local({ enabled: true, maxUses: 2 }))
  const requests = []
  const xixi = createXixi({
    db,
    webSearch: { search: async query => ({
      sources: [{ title: '外部来源', url: 'https://example.com', snippet: query, publishedAt: null }],
      truncated: false,
      notice: '外部资料',
    }) },
    complete: async request => {
      requests.push(request)
      if (requests.length === 1) return { choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'search-once', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'ASTaria beta7' }) } }],
      } }] }
      if (requests.length === 2) return reply('查到了')
      if (requests.length === 3) return { choices: [{ message: {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'write-after-search', type: 'function', function: { name: 'create_tasks', arguments: JSON.stringify({ tasks: [{ title: '搜索后确认事项', scheduleMode: 'record-only' }] }) } }],
      } }] }
      return reply('已保存')
    },
  })
  const first = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '请查 ASTaria beta7', context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(first.status, 'completed')
  const second = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '请保存一条事项：搜索后确认事项', context: { page: 'home', timezone: 'Asia/Shanghai' } })
  assert.equal(second.status, 'completed')
  assert.equal(db.listTasks().some(task => task.title === '搜索后确认事项'), true)
  assert.equal(requests.length, 4)
})

test('settings that never stored webSearch stay off and issue no request', async t => {
  const { webSearch, ...legacy } = local()
  assert.deepEqual(validateModelSettings(legacy).webSearch, { enabled: false, maxUses: 2 })
  assert.deepEqual(validateModelSettings({ ...legacy, webSearch: undefined }).webSearch, { enabled: false, maxUses: 2 })
  assert.deepEqual(validateModelSettings({ ...legacy, webSearch: { maxUses: 3 } }).webSearch, { enabled: false, maxUses: 3 }, '只写了次数的旧设置同样默认关闭')
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  db.setPreference('model-connection', legacy)
  assert.deepEqual(getModelSettings(db).webSearch, { enabled: false, maxUses: 2 }, '旧连接缺少字段时按关闭迁移')
  let calls = 0
  const search = createWebSearch({
    keychain: { read: async () => { calls += 1; return 'fake-search-key' } },
    getSettings: () => getModelSettings(db),
    fetcher: async () => { calls += 1 },
  })
  await assert.rejects(search.search('ASTaria beta7'),
    error => error instanceof ProviderError && error.message === '联网搜索尚未开启，请先在设置中明确打开')
  assert.equal(calls, 0, '默认关闭时既不读取钥匙串也不发起请求')
})

test('an empty structured result block returns no sources instead of inventing any', async () => {
  let requests = 0
  const search = cloudSearch(async () => {
    requests += 1
    return searchResponse({ results: [] })
  })
  const result = await search.search('一个不存在的主题')
  assert.deepEqual(result.sources, [])
  assert.equal(result.truncated, false)
  assert.match(result.notice, /外部资料/u)
  assert.equal(requests, 1)
})

test('a response without a structured result block is rejected instead of reporting success', async () => {
  const payloads = [
    {},
    { content: [] },
    { content: [{ type: 'text', text: '我直接回答' }] },
    { content: [{ type: 'text', text: '只有引用没有结果块', citations: [{ url: 'https://example.com/a', cited_text: '摘要 A' }] }] },
  ]
  for (const payload of payloads) {
    await assert.rejects(cloudSearch(async () => searchResponse(payload)).search('ASTaria beta7'),
      error => error instanceof ProviderError && error.message === 'DeepSeek 没有返回结构化搜索结果，请重试',
      JSON.stringify(payload))
  }
})

test('a structured search error block is rejected with the service reason', async () => {
  const payload = { error: { type: 'invalid_request_error', message: 'external text must not be forwarded' } }
  await assert.rejects(cloudSearch(async () => searchResponse(payload)).search('ASTaria beta7'),
    error => error instanceof ProviderError && error.message === 'DeepSeek 搜索服务返回错误，请稍后重试')
})

test('401, 429 and 5xx responses keep distinct reasons without retrying', async () => {
  const cases = [
    [401, 'DeepSeek 搜索 API Key 未通过验证，请在设置中重新保存'],
    [429, 'DeepSeek 搜索暂时限流，请稍后重试'],
    [400, 'DeepSeek 搜索请求无效，请缩短查询词或检查网页地址'],
    [402, 'DeepSeek 账户余额不足，请充值后重试'],
    [404, '这个网页暂时无法读取可用正文，请换一个来源'],
    [408, 'DeepSeek 搜索请求超时，请稍后重试'],
    [413, 'DeepSeek 搜索请求过长，请缩短查询词或网页地址'],
    [500, 'DeepSeek 搜索暂时不可用，请稍后重试'],
    [503, 'DeepSeek 搜索暂时不可用，请稍后重试'],
    [403, 'DeepSeek 拒绝读取这个网页，请换一个公开来源'],
  ]
  for (const [status, message] of cases) {
    let calls = 0
    const search = cloudSearch(async () => { calls += 1; return new Response('denied', { status }) })
    await assert.rejects(search.search('ASTaria beta7'), error => error instanceof ProviderError && error.message === message, String(status))
    assert.equal(calls, 1, `${status} 失败后不得重试`)
  }
  const cancelled = []
  const released = cloudSearch(async () => ({ ok: false, status: 503, body: { cancel: async () => { cancelled.push('cancelled') } } }))
  await assert.rejects(released.search('ASTaria beta7'),
    error => error instanceof ProviderError && error.message === 'DeepSeek 搜索暂时不可用，请稍后重试')
  assert.deepEqual(cancelled, ['cancelled'], '失败响应必须被释放')
})

test('malformed and oversized responses are rejected while a large valid one still succeeds', async () => {
  const invalid = [['截断的 JSON', '{'], ['数组', '[]'], ['标量', '"text"'], ['空值', 'null'], ['HTML 错误页', '<html>502 bad gateway</html>']]
  for (const [label, body] of invalid) {
    await assert.rejects(cloudSearch(async () => new Response(body)).search('ASTaria beta7'),
      error => error instanceof ProviderError && error.message === 'DeepSeek 搜索返回了无法读取的结果，请重试', label)
  }
  const padded = bytes => searchResponse({ results: [{ title: '大响应', url: 'https://example.com/big', content: 'x'.repeat(bytes) }] })
  const underLimit = await cloudSearch(async () => padded(700 * 1024)).search('ASTaria beta7')
  assert.deepEqual(underLimit.sources.map(source => source.url), ['https://example.com/big'])
  assert.equal((await cloudSearch(async () => padded(800 * 1024)).search('ASTaria beta7')).sources[0].content.length, 6000)
  await assert.rejects(cloudSearch(async () => padded(4 * 1024 * 1024)).search('ASTaria beta7'),
    error => error instanceof ProviderError && /内容过大.*4 MiB/u.test(error.message), '超限响应')
})

test('results beyond the cap are truncated to eight with the truncated flag', async () => {
  const many = await cloudSearch(async () => searchResponse(resultBlock(searchRows(12)))).search('ASTaria beta7')
  assert.deepEqual(many.sources.map(source => source.url), Array.from({ length: 8 }, (_, index) => `https://example.com/${index}`))
  assert.equal(many.truncated, true)
  const few = await cloudSearch(async () => searchResponse(resultBlock(searchRows(3)))).search('ASTaria beta7')
  assert.equal(few.sources.length, 3)
  assert.equal(few.truncated, false)
})

test('invalid source URLs are discarded and unavailable body stays unverified', async () => {
  const urls = ['javascript:alert(1)', 'file:///etc/passwd', 'ftp://example.com/pub', '/local/path', 'example.com/no-scheme', 'https://user:pass@example.com/private', 'https://safe.example/a']
  const result = await cloudSearch(async () => searchResponse({ results: urls.map(url => ({ url, summary: '摘要' })) })).search('ASTaria')
  assert.deepEqual(result.sources.map(row => row.url), ['https://safe.example/a'])
  assert.equal(result.sources[0].content, '')
  assert.equal(result.sources[0].fetchStatus, 'empty')
})

test('a failed search only ever reads the keychain and sends at most one request', async () => {
  const keychainCalls = []
  const keychain = {
    read: async () => { keychainCalls.push('read'); return 'fake-search-key' },
    write: async () => { keychainCalls.push('write') },
    delete: async () => { keychainCalls.push('delete') },
    save: async () => { keychainCalls.push('save') },
    clear: async () => { keychainCalls.push('clear') },
  }
  const failures = [
    [new Response('denied', { status: 401 }), /API Key 未通过验证/u],
    [new Response('slow down', { status: 429 }), /限流/u],
    [new Response('boom', { status: 500 }), /暂时不可用/u],
    [new Response('{"content":[{"type":"web_search_result","title":"外部","url":"https://leak.example/secret"}'), /无法读取的结果/u],
    [searchResponse({}), /没有返回结构化搜索结果/u],
  ]
  for (const [response, expected] of failures) {
    await assert.rejects(cloudSearch(async () => response, { keychain }).search('ASTaria beta7'),
      error => error instanceof ProviderError && expected.test(error.message))
  }
  assert.deepEqual([...new Set(keychainCalls)], ['read'], `失败的搜索不得改动钥匙串：${keychainCalls.join(',')}`)
  assert.equal(keychainCalls.length, failures.length, '每次失败恰好读取一次钥匙串')
  let fetches = 0
  const offline = createWebSearch({ keychain, getSettings: () => local({ enabled: true, maxUses: 2 }),
    fetcher: async () => { fetches += 1; throw new Error('offline') } })
  for (const query of ['', 'x'.repeat(401), 'bad\u0000query']) {
    await assert.rejects(offline.search(query), error => error instanceof ProviderError && error.message === '联网搜索需要一条简短的查询词')
  }
  await assert.rejects(offline.search('ASTaria beta7'), error => error instanceof ProviderError && error.message === '暂时无法连接 DeepSeek 搜索，请稍后重试')
  assert.equal(fetches, 1, '非法查询不发起请求，网络失败也不重试')
})

test('a search failure stores no external content and leaves local data untouched', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  saveModelSettings(db, local({ enabled: true, maxUses: 2 }))
  const keychainCalls = []
  const search = createWebSearch({
    keychain: { read: async () => { keychainCalls.push('read'); return 'fake-search-key' } },
    getSettings: () => local({ enabled: true, maxUses: 2 }),
    // Malformed JSON carrying a marker URL: a failure must never persist any of it.
    fetcher: async () => new Response('{"content":[{"type":"web_search_result","title":"外部泄漏","url":"https://leak.example/secret"}'),
  })
  const requests = []
  const xixi = createXixi({ db, webSearch: search, complete: async request => {
    requests.push(request)
    if (requests.length === 1) return reply('好的')
    if (requests.length === 2) return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: 'web-call', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: 'ASTaria beta7' }) } }] } }] }
    return reply('搜索没有成功，稍后再试')
  } })
  // The first turn settles one-time defaults so the comparison only sees the failed search.
  await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '你好', context: { page: 'home', timezone: 'Asia/Shanghai' } })
  const before = db.exportData().tables
  const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '请查 ASTaria beta7 的最新信息', context: { page: 'home', timezone: 'Asia/Shanghai' } })
  const after = db.exportData().tables
  assert.equal(result.status, 'completed')
  for (const table of ['tasks', 'events', 'memories', 'areas', 'availability', 'assignments', 'task_completion_history']) {
    assert.deepEqual(after[table], before[table], `失败的搜索不得写入 ${table}`)
  }
  const localState = tables => tables.state.filter(row => /^(planner|preferences)/u.test(row.key))
  assert.deepEqual(localState(after), localState(before), '失败的搜索不得改写本机设置或安排')
  const tool = after.messages.map(row => JSON.parse(row.document)).find(message => message.role === 'tool')
  assert.equal(JSON.parse(tool.content).ok, false)
  assert.doesNotMatch(tool.content, /leak\.example|外部泄漏|https?:/u, '失败结果不得保存任何外部内容')
  assert.deepEqual(keychainCalls, ['read'])
})
