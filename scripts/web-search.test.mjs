import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createWebSearch, WEB_SEARCH_ENDPOINT, WEB_SEARCH_MODEL } from '../server/webSearch.mjs'
import { saveModelSettings, validateModelSettings, getModelSettings } from '../server/modelSettings.mjs'
import { ProviderError } from '../server/provider.mjs'

const local = (webSearch = { enabled: false, maxUses: 2 }) => ({
  provider: 'local', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: false,
  contextBudget: { mode: 'auto', maxUnits: 48_000 }, webSearch,
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' },
})
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const searchReply = () => ({
  content: [
    { type: 'text', text: '来源', citations: [{ url: 'https://example.com/a', cited_text: '摘要 A' }] },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: '来源 A', url: 'https://example.com/a', page_age: '今天' },
      { type: 'web_search_result', title: '来源 B', url: 'https://example.com/b' },
      { type: 'web_search_result', title: '重复来源', url: 'https://example.com/a' },
    ] },
  ],
})

const searchResponse = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const resultBlock = rows => ({ content: [{ type: 'web_search_tool_result', content: rows }] })
const searchRows = count => Array.from({ length: count }, (_, index) => ({ type: 'web_search_result', title: `来源 ${index}`, url: `https://example.com/${index}` }))
// Every search test injects both the keychain and fetch; no test touches the
// real keychain and none opens a socket.
const cloudSearch = (fetcher, { webSearch = { enabled: true, maxUses: 2 }, keychain = { read: async () => 'fake-search-key' } } = {}) =>
  createWebSearch({ keychain, getSettings: () => local(webSearch), fetcher })

test('联网搜索配置默认关闭且旧设置迁移为关闭', () => {
  const saved = validateModelSettings(local())
  assert.deepEqual(saved.webSearch, { enabled: false, maxUses: 2 })
  assert.deepEqual(validateModelSettings({ ...local(), webSearch: { enabled: true } }).webSearch, { enabled: true, maxUses: 2 })
  assert.throws(() => validateModelSettings({ ...local(), webSearch: { enabled: 'yes' } }), /开关/u)
  assert.throws(() => validateModelSettings({ ...local(), webSearch: { enabled: true, maxUses: 5 } }), /次数/u)
})

test('DeepSeek Anthropic search sends only the query and returns structured sources', async () => {
  const requests = []
  const search = createWebSearch({
    keychain: { read: async () => 'fake-search-key' },
    getSettings: () => local({ enabled: true, maxUses: 2 }),
    fetcher: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) })
      return new Response(JSON.stringify(searchReply()), { headers: { 'Content-Type': 'application/json' } })
    },
  })
  const result = await search.search('ASTaria 最新版本')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, WEB_SEARCH_ENDPOINT)
  assert.equal(requests[0].body.model, WEB_SEARCH_MODEL)
  assert.deepEqual(requests[0].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }])
  assert.equal(requests[0].body.messages[0].content[0].text, 'Perform a web search for the query: ASTaria 最新版本')
  assert.equal(requests[0].body.messages[0].content[0].text.includes('课表'), false)
  assert.equal(requests[0].options.headers['x-api-key'], 'fake-search-key')
  assert.equal(requests[0].options.headers.Authorization, 'Bearer fake-search-key')
  assert.deepEqual(result.sources, [
    { title: '来源 A', url: 'https://example.com/a', snippet: '摘要 A', publishedAt: '今天' },
    { title: '来源 B', url: 'https://example.com/b', snippet: '', publishedAt: null },
  ])
  assert.equal(result.truncated, false)
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
        tool_calls: [{ id: 'write-after-search', type: 'function', function: { name: 'create_tasks', arguments: JSON.stringify({ tasks: [{ title: '搜索后确认事项' }] }) } }],
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
    return searchResponse({ content: [{ type: 'web_search_tool_result', content: [] }, { type: 'text', text: '没有找到可用来源' }] })
  })
  const result = await search.search('一个不存在的主题')
  assert.deepEqual(result.sources, [])
  assert.equal(result.truncated, false)
  assert.match(result.notice, /外部来源/u)
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
  const payload = { content: [{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }] }
  await assert.rejects(cloudSearch(async () => searchResponse(payload)).search('ASTaria beta7'),
    error => error instanceof ProviderError && error.message === 'DeepSeek 搜索服务返回错误，请稍后重试')
})

test('401, 429 and 5xx responses keep distinct reasons without retrying', async () => {
  const cases = [
    [401, 'DeepSeek 搜索 API Key 未通过验证，请在设置中重新保存'],
    [429, 'DeepSeek 搜索暂时限流或额度不足，请稍后重试'],
    [500, 'DeepSeek 搜索暂时不可用，请稍后重试'],
    [503, 'DeepSeek 搜索暂时不可用，请稍后重试'],
    [403, 'DeepSeek 搜索暂时不可用，请稍后重试'],
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
  const padded = bytes => searchResponse({ content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', title: '大响应', url: 'https://example.com/big' }] },
    { type: 'text', text: 'x'.repeat(bytes) },
  ] })
  const underLimit = await cloudSearch(async () => padded(700 * 1024)).search('ASTaria beta7')
  assert.deepEqual(underLimit.sources.map(source => source.url), ['https://example.com/big'])
  await assert.rejects(cloudSearch(async () => padded(800 * 1024)).search('ASTaria beta7'),
    error => error instanceof ProviderError && error.message === 'DeepSeek 搜索返回了无法读取的结果，请重试', '超限响应')
})

test('results beyond the cap are truncated to eight with the truncated flag', async () => {
  const many = await cloudSearch(async () => searchResponse(resultBlock(searchRows(12)))).search('ASTaria beta7')
  assert.deepEqual(many.sources.map(source => source.url), Array.from({ length: 8 }, (_, index) => `https://example.com/${index}`))
  assert.equal(many.truncated, true)
  const few = await cloudSearch(async () => searchResponse(resultBlock(searchRows(3)))).search('ASTaria beta7')
  assert.equal(few.sources.length, 3)
  assert.equal(few.truncated, false)
})

test('sources that are not http(s) never reach the caller', async () => {
  const payload = { content: [
    { type: 'text', text: '引用', citations: [
      { url: 'javascript:alert(1)', cited_text: '脚本摘要' },
      { url: 'data:text/html,<b>x</b>', cited_text: '数据摘要' },
      { url: 'https://safe.example/a', cited_text: '安全摘要' },
    ] },
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', title: '脚本', url: 'javascript:alert(1)' },
      { type: 'web_search_result', title: '文件', url: 'file:///etc/passwd' },
      { type: 'web_search_result', title: '协议', url: 'ftp://example.com/pub' },
      { type: 'web_search_result', title: '相对路径', url: '/local/path' },
      { type: 'web_search_result', title: '缺少协议', url: 'example.com/no-scheme' },
      { type: 'web_search_result', title: '安全来源', url: 'https://safe.example/a' },
      { type: 'web_search_result', title: '', url: 'https://safe.example/b' },
    ] },
  ] }
  const result = await cloudSearch(async () => searchResponse(payload)).search('ASTaria beta7')
  assert.deepEqual(result.sources, [
    { title: '安全来源', url: 'https://safe.example/a', snippet: '安全摘要', publishedAt: null },
    { title: 'https://safe.example/b', url: 'https://safe.example/b', snippet: '', publishedAt: null },
  ])
  assert.ok(result.sources.every(source => /^https?:/u.test(source.url)))
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
