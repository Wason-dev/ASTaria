import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createCompletion, discoverLocalModels, ProviderError, testLocalCompletion } from '../server/provider.mjs'
import { getModelSettings, localEndpoint, saveModelSettings, validateModelSettings } from '../server/modelSettings.mjs'
import { ValidationError } from '../server/validation.mjs'

const localSettings = () => ({ provider: 'local', cloudModel: 'deepseek-v4-pro',
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3:8b' } })
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const toolReply = (name, args, id = 'test-tool-call') => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const chatInput = (text = '你好', conversationId = 'main') => ({ requestId: randomUUID(), conversationId, text,
  context: { timezone: 'Asia/Shanghai', page: 'home' } })
const sign = backup => { backup.checksum = createHash('sha256').update(JSON.stringify(backup.tables)).digest('hex'); return backup }
const probeReply = payload => {
  const token = payload.messages[0].content.match(/token "([^"]+)"/u)?.[1]
  assert.ok(token)
  return toolReply('astaria_connection_check', { token }, 'probe-call')
}

function fixture(t, { settings = localSettings(), vault } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-local-model-test-'))
  const filename = join(directory, 'test.sqlite')
  const requests = [], responses = [], callbackErrors = [], vaultCalls = []
  const isolatedVault = vault ?? Object.fromEntries(['status', 'read', 'save', 'remove'].map(method => [method, async () => {
    vaultCalls.push(method)
    throw new Error(`local model must not call vault.${method}`)
  }]))
  const fetcher = async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : undefined
    requests.push({ url, options, payload })
    if (!responses.length) {
      const error = new Error('every local model request needs an explicit mock response')
      callbackErrors.push(error); throw error
    }
    const response = responses.shift()
    if (response instanceof Error) throw response
    try { return typeof response === 'function' ? await response({ url, options, payload }) : response }
    catch (error) { callbackErrors.push(error); throw error }
  }
  let db, service
  const open = () => {
    db = createDatabase(filename)
    service = createLocalService({ db, vault: isolatedVault, fetcher, dataDirectory: directory })
  }
  open(); saveModelSettings(db, settings)
  t.after(() => { service.close(); rmSync(directory, { recursive: true, force: true }) })
  const request = async (path, payload) => {
    const result = await new Promise(resolve => {
      const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
      req.url = `/api${path}`; req.method = payload === undefined ? 'GET' : 'POST'
      req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
      req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1',
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }
      const res = { statusCode: 200, setHeader() {}, end(raw) { resolve({ status: this.statusCode, value: JSON.parse(raw), raw }) } }
      service.middleware(req, res, () => resolve({ status: 404, value: null }))
    })
    assert.deepEqual(callbackErrors, [], 'mock assertions must not be mistaken for provider failures')
    return result
  }
  const ok = async (path, payload) => {
    const result = await request(path, payload)
    assert.equal(result.status, 200, `${path}: ${result.raw}`)
    return result.value
  }
  return { requests, responses, vaultCalls, request, ok, get db() { return db }, restart() { service.close(); open() } }
}

test('local endpoint accepts and pins loopback addresses while rejecting remote, credentialed and non-API URLs', () => {
  for (const [input, expected] of [
    ['http://localhost:11434', 'http://127.0.0.1:11434/v1'],
    ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234/v1'],
    ['http://127.0.0.1:1234/v1/', 'http://127.0.0.1:1234/v1'],
    ['https://localhost/v1', 'https://127.0.0.1/v1'],
    ['http://[::1]:1234/v1', 'http://[::1]:1234/v1'],
  ]) assert.equal(localEndpoint(input), expected)
  for (const input of [null, '', 'not a URL', 'file:///tmp/model', 'ftp://localhost/v1',
    'http://192.168.1.10:1234/v1', 'http://169.254.169.254/v1', 'https://api.deepseek.com/v1',
    'http://localhost.evil.example/v1', 'http://127.0.0.1.evil.example/v1', 'http://[::ffff:192.168.1.1]/v1',
    'http://key:secret@localhost:1234/v1', 'http://localhost/v1?api_key=secret', 'http://localhost/v1#secret',
    'http://localhost/api/chat', 'http://localhost/v1/chat/completions', 'http://localhost:65536/v1',
  ]) assert.throws(() => localEndpoint(input), ValidationError, String(input))
})

test('local settings validate before changing the provider, model or saved connection', () => {
  const db = createDatabase(':memory:')
  try {
    const input = localSettings(); input.local.baseUrl = 'http://localhost:1234/'; input.local.model = '  qwen3:8b  '
    const saved = saveModelSettings(db, input)
    assert.equal(saved.local.baseUrl, 'http://127.0.0.1:1234/v1')
    assert.equal(saved.local.model, 'qwen3:8b')
    assert.deepEqual(getModelSettings(db), saved)
    const invalid = [
      { ...saved, provider: 'unknown' }, { ...saved, cloudModel: 'unknown' }, { ...saved, apiKey: 'forbidden' },
      ...[{ baseUrl: 'https://external.example/v1' }, { engine: 'unknown' }, { model: 'bad\nmodel' },
        { model: 'x'.repeat(201) }, { apiKey: 'forbidden' }].map(patch => ({ ...saved, local: { ...saved.local, ...patch } })),
    ]
    for (const value of invalid) {
      assert.throws(() => validateModelSettings(value), ValidationError)
      assert.throws(() => saveModelSettings(db, value), ValidationError)
      assert.deepEqual(getModelSettings(db), saved)
    }
  } finally { db.close() }
})

test('model discovery deduplicates valid IDs, bounds the list, pins localhost and refuses redirects or remote endpoints', async () => {
  const calls = []
  const fetcher = async (url, options) => {
    calls.push({ url, options })
    return json({ data: [{ id: 'qwen3:8b' }, { id: 'qwen3:8b' }, { id: 'lmstudio/model' }, {}, null,
      { id: 3 }, { id: '' }, { id: 'bad\nname' }, { id: 'x'.repeat(201) }] })
  }
  assert.deepEqual(await discoverLocalModels({ engine: 'ollama', baseUrl: 'http://localhost:11434' }, fetcher), {
    models: [{ id: 'qwen3:8b', label: 'qwen3:8b' }, { id: 'lmstudio/model', label: 'lmstudio/model' }],
  })
  assert.equal(calls[0].url, 'http://127.0.0.1:11434/v1/models')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers?.Authorization, undefined)
  assert.equal(calls[0].options.body, undefined)
  await assert.rejects(discoverLocalModels({ engine: 'openai', baseUrl: 'https://external.example/v1' }, fetcher), ValidationError)
  assert.equal(calls.length, 1)
  const bounded = await discoverLocalModels({ engine: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1' },
    async () => json({ data: Array.from({ length: 250 }, (_, i) => ({ id: `model-${i}` })) }))
  assert.equal(bounded.models.length, 200)
  for (const response of [new Response(null, { status: 302, headers: { Location: 'https://external.example/models' } }),
    json({ models: [] }), new Response('private malformed upstream text'), json({ data: [{ id: 'x'.repeat(513 * 1024) }] }),
  ]) await assert.rejects(discoverLocalModels({ engine: 'openai', baseUrl: 'http://127.0.0.1:1234' }, async () => response),
    error => error instanceof ProviderError && !error.message.includes('private malformed'))
})

test('local completions never read or send a key and failures never fall back to cloud', async () => {
  const requests = [], settings = localSettings()
  const vault = { read: async () => { throw new Error('must not read credentials') } }
  const complete = createCompletion(vault, async (url, options) => {
    requests.push({ url, options }); return json(reply('本机回复'))
  }, () => { throw new Error('must not select a cloud model') }, () => settings)
  assert.deepEqual(await complete({ messages: [{ role: 'user', content: 'hello' }], model: 'injected-model', stream: true }), reply('本机回复'))
  assert.equal(requests[0].url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(requests[0].options.redirect, 'error')
  assert.deepEqual(requests[0].options.headers, { 'Content-Type': 'application/json' })
  const body = JSON.parse(requests[0].options.body)
  assert.equal(body.model, settings.local.model)
  assert.equal(body.stream, false)
  assert.equal(body.thinking, undefined)
  const failureFactories = [
    () => { throw new Error('private socket failure') },
    () => new Response('private rejection', { status: 500 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://api.deepseek.com/chat/completions' } }),
    () => json({ choices: [] }), () => new Response('private malformed JSON'),
  ]
  for (const fail of failureFactories) {
    const calls = []
    const failed = createCompletion(vault, async (url, options) => { calls.push({ url, options }); return fail() },
      () => 'deepseek-flash', () => settings)
    await assert.rejects(failed({ messages: [] }), error => error instanceof ProviderError && /本地模型/u.test(error.message) && !/private/u.test(error.message))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, requests[0].url)
    assert.equal(calls[0].options.headers.Authorization, undefined)
  }
})

test('local tool compatibility probe requires the echoed token and a complete tool-result round trip', async () => {
  const calls = []
  const complete = async payload => {
    calls.push(payload)
    if (calls.length === 1) return probeReply(payload)
    assert.equal(payload.messages[1].tool_calls[0].id, 'probe-call')
    assert.deepEqual(payload.messages[2], { role: 'tool', tool_call_id: 'probe-call', content: '{"ok":true}' })
    assert.equal(payload.tools[0].function.name, 'astaria_connection_check')
    return reply(' OK ')
  }
  const result = await testLocalCompletion(complete)
  assert.equal(result.ok, true)
  assert.equal(result.toolCalling, true)
  assert.equal(calls.length, 2)
  assert.equal(calls[0].tools.length, 1)
  assert.equal(calls[0].tools[0].function.parameters.additionalProperties, false)
  const badFirst = [() => reply('OK'), () => toolReply('wrong_tool', { token: 'wrong' }),
    () => toolReply('astaria_connection_check', { token: 'wrong' }), payload => {
      const value = probeReply(payload); value.choices[0].message.tool_calls[0].function.arguments = '{bad'; return value
    }, payload => {
      const value = probeReply(payload); value.choices[0].message.tool_calls.push(value.choices[0].message.tool_calls[0]); return value
    }]
  for (const first of badFirst) {
    let count = 0
    const unsupported = await testLocalCompletion(async payload => { count++; return first(payload) })
    assert.equal(unsupported.ok, true)
    assert.equal(unsupported.toolCalling, false)
    assert.equal(count, 1)
  }
  for (const second of [reply('不是OK'), toolReply('astaria_connection_check', { token: 'again' })]) {
    let count = 0
    assert.equal((await testLocalCompletion(async payload => ++count === 1 ? probeReply(payload) : second)).toolCalling, false)
    assert.equal(count, 2)
  }
  for (const failureAt of [1, 2]) {
    let count = 0
    await assert.rejects(testLocalCompletion(async payload => {
      if (++count === failureAt) throw new ProviderError('本地连接中断')
      return probeReply(payload)
    }), ProviderError)
    assert.equal(count, failureAt)
  }
})

test('local status, discovery, test and chat run with every vault method unavailable', async t => {
  const f = fixture(t)
  const status = await f.ok('/status')
  assert.equal(status.provider, 'local')
  assert.equal(status.configured, true)
  assert.equal(status.cloudConfigured, null)
  f.responses.push(json({ data: [{ id: 'qwen3:8b' }] }))
  assert.deepEqual((await f.ok('/settings/local/models', { engine: 'ollama', baseUrl: 'http://localhost:11434' })).models,
    [{ id: 'qwen3:8b', label: 'qwen3:8b' }])
  f.responses.push(({ payload }) => json(probeReply(payload)), json(reply('OK')))
  assert.equal((await f.ok('/settings/test', {})).toolCalling, true)
  f.responses.push(json(toolReply('read_current_time', {})), json(reply('你好，我在本机运行。')))
  const chatted = await f.ok('/chat', chatInput())
  assert.equal(chatted.status, 'completed')
  assert.equal(chatted.messages.at(-1).content, '你好，我在本机运行。')
  assert.deepEqual((await f.ok('/conversation?id=main')).messages, chatted.messages)
  assert.ok(f.requests.every(request => request.url.startsWith('http://127.0.0.1:11434/v1/')))
  assert.ok(f.requests.every(request => !request.options.headers?.Authorization))
  assert.deepEqual(f.vaultCalls, [])
  assert.equal(f.responses.length, 0)
})

test('local connection API distinguishes replies without tools, outages and an unloaded model', async t => {
  const f = fixture(t)
  f.responses.push(json(reply('OK')))
  const textOnly = await f.ok('/settings/test', {})
  assert.equal(textOnly.ok, true)
  assert.equal(textOnly.toolCalling, false)
  for (const at of [1, 2]) {
    if (at === 2) f.responses.push(({ payload }) => json(probeReply(payload)))
    f.responses.push(new Error('private local socket error'))
    const failed = await f.request('/settings/test', {})
    assert.equal(failed.status, 503)
    assert.match(failed.value.error, /本地模型/u)
    assert.doesNotMatch(failed.raw, /private|socket/u)
  }
  const input = chatInput('这条消息在本地断线后也应保留')
  const beforeFailure = f.requests.length
  f.responses.push(new Error('private local model outage'))
  const interrupted = await f.ok('/chat', input)
  assert.equal(interrupted.status, 'failed')
  assert.match(interrupted.error, /本地模型/u)
  assert.doesNotMatch(interrupted.error, /private|outage/u)
  assert.equal(f.requests.length, beforeFailure + 1)
  assert.equal(f.requests.at(-1).url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.deepEqual((await f.ok('/conversation?id=main')).messages, interrupted.messages)
  assert.equal(interrupted.messages.filter(message => message.requestId === input.requestId && message.role === 'user').length, 1)
  const unloaded = localSettings(); unloaded.local.model = ''
  assert.equal((await f.ok('/settings/provider', unloaded)).configured, false)
  const count = f.requests.length
  assert.equal((await f.request('/settings/test', {})).status, 400)
  assert.equal((await f.request('/chat', chatInput())).status, 400)
  assert.equal(f.requests.length, count)
  assert.deepEqual(f.vaultCalls, [])
})

test('local settings persist across service restart and backup restore while hostile backup endpoints are rejected atomically', async t => {
  const f = fixture(t)
  const saved = { ...localSettings(), local: { engine: 'lmstudio', baseUrl: 'http://localhost:1234/', model: 'local/model-14b' } }
  const result = await f.ok('/settings/provider', saved)
  assert.equal(result.providerSettings.local.baseUrl, 'http://127.0.0.1:1234/v1')
  const task = await f.ok('/tasks/create', { title: '备份必须保留' })
  f.restart()
  assert.deepEqual((await f.ok('/status')).providerSettings, result.providerSettings)
  const backup = await f.ok('/data/export')
  assert.deepEqual(JSON.parse(backup.tables.state.find(row => row.key === 'preferences:model-connection').value), result.providerSettings)
  await f.ok('/settings/provider', localSettings())
  await f.ok('/tasks/update', { id: task.id, patch: { title: '备份之后的修改' } })
  assert.equal((await f.ok('/data/import', { backup, confirmed: true })).restored, true)
  f.restart()
  assert.deepEqual((await f.ok('/status')).providerSettings, result.providerSettings)
  assert.equal((await f.ok(`/tasks/${task.id}`)).title, task.title)
  const beforeTasks = await f.ok('/tasks'), beforePlanner = await f.ok('/planner')
  for (const baseUrl of ['https://remote.example/v1', 'http://169.254.169.254/v1', 'http://secret@localhost:1234/v1']) {
    const hostile = structuredClone(backup)
    const record = hostile.tables.state.find(row => row.key === 'preferences:model-connection')
    const config = JSON.parse(record.value); config.local.baseUrl = baseUrl; record.value = JSON.stringify(config)
    const rejected = await f.request('/data/import', { backup: sign(hostile), confirmed: true })
    assert.equal(rejected.status, 400)
    assert.deepEqual((await f.ok('/status')).providerSettings, result.providerSettings)
    assert.deepEqual(await f.ok('/tasks'), beforeTasks)
    assert.deepEqual(await f.ok('/planner'), beforePlanner)
  }
  assert.equal(f.requests.length, 0)
  assert.deepEqual(f.vaultCalls, [])
})

for (const startProvider of ['local', 'deepseek']) test(`an in-flight ${startProvider} chat keeps its provider through tools while the next turn uses changed settings`, async t => {
  const keyReads = [], secret = 'fake-test-key-not-a-real-secret'
  const initial = { ...localSettings(), provider: startProvider }
  const f = fixture(t, { settings: initial, vault: { status: async () => true, read: async () => { keyReads.push('read'); return secret },
    save: async () => { throw new Error('not used') }, remove: async () => { throw new Error('not used') } } })
  let entered, release
  const started = new Promise(resolve => { entered = resolve })
  const gate = new Promise(resolve => { release = resolve })
  f.responses.push(async () => { entered(); await gate; return json(toolReply('read_current_time', {})) }, json(reply('本轮完成')))
  const input = chatInput('你好，先看看时间再聊')
  const inFlight = f.ok('/chat', input)
  await started
  const nextProvider = startProvider === 'local' ? 'deepseek' : 'local'
  const changed = { ...localSettings(), provider: nextProvider, cloudModel: 'deepseek-flash',
    local: { engine: 'lmstudio', baseUrl: 'http://localhost:1234/v1', model: 'replacement-local-model' } }
  assert.equal((await f.ok('/settings/provider', changed)).provider, nextProvider)
  release()
  assert.equal((await inFlight).status, 'completed')
  assert.equal(f.requests.length, 2)
  const initialUrl = startProvider === 'local' ? 'http://127.0.0.1:11434/v1/chat/completions' : 'https://api.deepseek.com/chat/completions'
  for (const request of f.requests) {
    assert.equal(request.url, initialUrl)
    assert.equal(request.payload.model, startProvider === 'local' ? initial.local.model : initial.cloudModel)
    assert.equal(request.options.headers.Authorization, startProvider === 'local' ? undefined : `Bearer ${secret}`)
  }
  assert.equal(keyReads.length, startProvider === 'local' ? 0 : 2)
  f.responses.push(json(reply('下一轮完成')))
  assert.equal((await f.ok('/chat', chatInput('继续聊'))).status, 'completed')
  assert.equal(f.requests[2].url, nextProvider === 'local' ? 'http://127.0.0.1:1234/v1/chat/completions' : 'https://api.deepseek.com/chat/completions')
  assert.equal(f.requests[2].payload.model, nextProvider === 'local' ? changed.local.model : changed.cloudModel)
  assert.equal(f.requests[2].options.headers.Authorization, nextProvider === 'local' ? undefined : `Bearer ${secret}`)
  assert.equal(keyReads.length, startProvider === 'local' ? 1 : 2)
  assert.equal(f.responses.length, 0)
})
