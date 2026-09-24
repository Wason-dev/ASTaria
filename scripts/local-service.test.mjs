import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createLocalService, validateRequest } from '../server/index.mjs'
import { createCompletion, ProviderError } from '../server/provider.mjs'
import { localDay } from '../src/home/agenda.ts'

const SECRET = 'sk-fake-TEST-ONLY-not-a-real-provider-secret'
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const toolCall = (name, args, id = randomUUID()) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const chatInput = (text = '记下物理报告') => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', page: 'home' } })

async function fixture(t, { responses = [], configured = true, filename } = {}) {
  const directory = filename ? null : mkdtempSync(join(tmpdir(), 'astaria-http-test-'))
  const location = filename ?? join(directory, 'test.sqlite')
  const db = createDatabase(location)
  let key = configured ? SECRET : ''
  const vault = { status: async () => Boolean(key), save: async value => { key = value }, read: async () => key, remove: async () => { key = '' } }
  const requests = []
  const complete = async payload => {
    requests.push(payload)
    const response = responses.shift()
    if (response instanceof Error) throw response
    return typeof response === 'function' ? response(payload) : response ?? reply('嗯，记好了')
  }
  const service = createLocalService({ db, vault, complete, dataDirectory: directory ?? tmpdir() })
  const server = createServer((req, res) => service.middleware(req, res, () => { res.statusCode = 404; res.end('not found') }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    service.close()
  }
  t.after(async () => {
    await close()
    if (directory) rmSync(directory, { recursive: true, force: true })
  })
  const request = async (path, body, options = {}) => {
    const response = await fetch(`${base}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Astaria-Local': '1', Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...options,
    })
    const raw = await response.text()
    return { status: response.status, value: JSON.parse(raw), raw, headers: response.headers }
  }
  return { db, vault, requests, responses, request, base, close, filename: location, directory }
}

test('request guard rejects remote access, rebound hosts, hostile origins and missing custom header', () => {
  const valid = { socket: { remoteAddress: '127.0.0.1', localPort: 5188 }, headers: { host: '127.0.0.1:5188', 'x-astaria-local': '1', origin: 'http://127.0.0.1:5188' }, method: 'GET' }
  assert.doesNotThrow(() => validateRequest(valid))
  const rejected = [
    { ...valid, socket: { ...valid.socket, remoteAddress: '192.168.1.3' } },
    ...['evil.example:5188', '127.0.0.1:5187', 'localhost.evil.example:5188', '127.0.0.1:5188/anything', '127.0.0.1:5188@evil.example', '127.0.0.1:5188?x'].map(host => ({ ...valid, headers: { ...valid.headers, host } })),
    { ...valid, headers: { ...valid.headers, origin: 'https://evil.example' } },
    { ...valid, headers: { ...valid.headers, origin: 'null' } },
    { ...valid, headers: { ...valid.headers, 'x-astaria-local': undefined } },
    { ...valid, headers: { ...valid.headers, 'sec-fetch-site': 'cross-site' } },
  ]
  for (const request of rejected) assert.throws(() => validateRequest(request), error => error.status === 403)
  assert.throws(() => validateRequest({ ...valid, method: 'DELETE' }), error => error.status === 405)
  assert.throws(() => validateRequest({ ...valid, method: 'POST' }), error => error.status === 415)
  assert.doesNotThrow(() => validateRequest({ socket: { remoteAddress: '::1', localPort: 5188 }, headers: { host: '[::1]:5188', 'x-astaria-local': '1', origin: 'http://[::1]:5188' }, method: 'GET' }))
})

test('HTTP exposes no CORS permission and rejects browser form or cross-origin writes', async t => {
  const f = await fixture(t)
  const status = await f.request('/status')
  assert.equal(status.status, 200)
  assert.equal(status.headers.get('cache-control'), 'no-store')
  assert.equal(status.headers.get('access-control-allow-origin'), null)
  assert.equal(status.headers.get('x-content-type-options'), 'nosniff')
  const hostile = await fetch(`${f.base}/api/tasks/create`, { method: 'POST', headers: { 'X-Astaria-Local': '1', Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: '{"title":"bad"}' })
  assert.equal(hostile.status, 403)
  const form = await fetch(`${f.base}/api/tasks/create`, { method: 'POST', headers: { 'X-Astaria-Local': '1', Origin: f.base, 'Content-Type': 'text/plain' }, body: '{"title":"bad"}' })
  assert.equal(form.status, 415)
  const missing = await fetch(`${f.base}/api/tasks`)
  assert.equal(missing.status, 403)
  assert.equal(f.db.listTasks().length, 0)
})

test('decision HTTP endpoint returns persisted draft metadata and applies through the existing receipt route', async t => {
  const f = await fixture(t)
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
  const date = localDay(tomorrow)
  const task = f.db.createTask({ title: 'HTTP decision fixture', estimateMin: 30 })
  const before = f.db.getPlanner()
  const response = await f.request('/companion/decision', { date, taskId: task.id, strategy: 'split', recurrence: 'weekly', todayMin: 15 })
  assert.equal(response.status, 200)
  assert.equal(response.value.decision.taskId, task.id)
  assert.equal(response.value.decision.todayMin, 15)
  assert.equal(response.value.decision.recurrence, 'weekly')
  assert.deepEqual(f.db.getPlanner(), before)
  const loaded = await f.request('/companion')
  assert.deepEqual(loaded.value.scenarios.find(item => item.id === response.value.id).decision, response.value.decision)
  const applied = await f.request('/companion/scenario/apply', { id: response.value.id, expectedVersion: 1 })
  assert.equal(applied.status, 200)
  assert.equal(applied.value.scenario.status, 'applied')
  assert.ok(applied.value.operation.details.length > 0)
  const invalid = await f.request('/companion/decision', { date, taskId: '', strategy: 'split', recurrence: 'weekly' })
  assert.equal(invalid.status, 400)
  assert.equal(f.requests.length, 0)
})

test('separate clients share task edits and persisted history across service restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-http-shared-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const filename = join(directory, 'shared.sqlite')
  const first = await fixture(t, { filename })
  const created = await first.request('/tasks/create', { title: '跨浏览器报告', due: '2026-09-25' })
  assert.equal(created.status, 200)
  const second = await fixture(t, { filename })
  const found = await second.request('/tasks')
  assert.equal(found.value[0].id, created.value.id)
  await second.request('/tasks/update', { id: created.value.id, patch: { due: '2026-09-27' } })
  assert.equal((await first.request('/tasks')).value[0].due, '2026-09-27')
  await first.request('/chat', chatInput('早'))
  assert.equal((await second.request('/conversation?id=main')).value.messages.length, 2)
  await first.close(); await second.close()
  const restarted = await fixture(t, { filename })
  assert.equal((await restarted.request('/tasks')).value[0].due, '2026-09-27')
  assert.equal((await restarted.request('/conversation?id=main')).value.messages.length, 2)
})

test('history pagination returns newest by default and traverses all older raw records without duplication', async t => {
  const f = await fixture(t)
  const first = f.db.appendMessage({ conversationId: 'main', role: 'user', content: '最早的原话' })
  for (let index = 0; index < 200; index++) f.db.appendMessage({ conversationId: 'main', role: 'tool', toolCallId: `tool-${index}`, content: JSON.stringify({ internal: index }) })
  const last = f.db.appendMessage({ conversationId: 'main', role: 'assistant', content: '最新回复' })
  const latest = (await f.request('/conversation?id=main')).value
  assert.deepEqual(latest.messages.map(message => message.id), [last.id])
  assert.equal(latest.hasOlder, true)
  assert.equal(latest.oldestSeq, first.seq + 2)
  const older = (await f.request(`/conversation?id=main&before=${latest.oldestSeq}`)).value
  assert.deepEqual(older.messages.map(message => message.id), [first.id])
  assert.equal(older.hasOlder, false)
  assert.equal(older.oldestSeq, first.seq)
  const combined = [...older.messages, ...latest.messages]
  assert.equal(new Set(combined.map(message => message.id)).size, combined.length)
  const toolOnly = (await f.request(`/conversation?id=main&before=${last.seq}`)).value
  assert.deepEqual(toolOnly.messages, [])
  assert.equal(toolOnly.hasOlder, true)
  assert.equal(toolOnly.oldestSeq, first.seq + 1)
  const beyond = (await f.request(`/conversation?id=main&before=${first.seq}`)).value
  assert.deepEqual(beyond.messages, [])
  assert.equal(beyond.oldestSeq, null)
  assert.equal(beyond.hasOlder, false)
  for (const before of ['0', '-1', '1.2', '', 'NaN', '9007199254740993', '2e2', '01']) {
    assert.equal((await f.request(`/conversation?id=main&before=${encodeURIComponent(before)}`)).status, 400)
  }
})

test('chat receipts close after a committed write and undo restores state', async t => {
  const args = { tasks: [{ title: '物理报告', due: '2026-09-25', estimateMin: 120 }] }
  const f = await fixture(t, { responses: [toolCall('create_tasks', args), new Error(`provider dumped ${SECRET}`), toolCall('create_tasks', args), reply('记好了')] })
  const input = chatInput()
  const first = await f.request('/chat', input)
  assert.equal(first.status, 200)
  assert.equal(first.value.status, 'completed')
  assert.equal(first.value.operations.length, 1)
  assert.equal(first.value.operations[0].undoLabel, '撤销创建与安排')
  assert.doesNotMatch(first.raw, new RegExp(SECRET))
  assert.equal(first.value.operations[0].changes, undefined)
  assert.equal(first.value.messages.some(message => message.role === 'tool' || message.toolCalls), false)
  const retried = await f.request('/chat', input)
  assert.equal(retried.value.status, 'completed')
  assert.equal(retried.value.messages.filter(message => message.role === 'user').length, 1)
  assert.equal((await f.request('/tasks')).value.length, 1)
  assert.equal(retried.value.operations.length, 1)
  const completedAgain = await f.request('/chat', input)
  assert.deepEqual(completedAgain.value, retried.value)
  assert.equal(f.requests.length, 2)
  const operationId = retried.value.operations.find(operation => operation.createdTasks?.length).id
  const undone = await f.request(`/operations/${operationId}/undo`, {})
  assert.equal(undone.status, 200)
  assert.ok(undone.value.undoneAt)
  assert.equal((await f.request('/tasks')).value.length, 0)
  assert.equal((await f.request('/planner')).value.blocks.length, 0)
})

test('keys remain only in the injected vault and never enter database, responses or model payloads', async t => {
  const logs = []
  for (const method of ['log', 'info', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args))
  const f = await fixture(t, { configured: false })
  assert.equal((await f.request('/status')).value.configured, false)
  assert.equal((await f.request('/chat', chatInput())).status, 400)
  const saved = await f.request('/settings/key', { key: SECRET })
  assert.equal(saved.status, 200)
  assert.equal(saved.value.configured, true)
  assert.doesNotMatch(saved.raw, new RegExp(SECRET))
  assert.equal(await f.vault.read(), SECRET)
  await f.request('/settings/test', {})
  await f.request('/chat', chatInput('晚安'))
  assert.doesNotMatch(JSON.stringify(f.requests), new RegExp(SECRET))
  assert.doesNotMatch(JSON.stringify((await f.request('/conversation?id=main')).value), new RegExp(SECRET))
  assert.doesNotMatch(JSON.stringify(logs), new RegExp(SECRET))
  for (const name of readdirSync(f.directory)) {
    const bytes = readFileSync(join(f.directory, name))
    assert.equal(bytes.includes(Buffer.from(SECRET)), false, `${name} must not store API keys`)
  }
  await f.request('/settings/key/remove', {})
  assert.equal((await f.request('/status')).value.configured, false)
})

test('vault failures expose a fixed message without leaking process error text', async t => {
  const f = await fixture(t)
  f.vault.save = async () => { throw new Error(`helper-error ${SECRET}`) }
  const response = await f.request('/settings/key', { key: SECRET })
  assert.equal(response.status, 503)
  assert.doesNotMatch(response.raw, new RegExp(SECRET))
  assert.doesNotMatch(response.raw, /helper-error/u)
})

test('API rejects invalid dates, unknown fields, invalid filters and malformed identifiers', async t => {
  const f = await fixture(t)
  const invalid = [
    ['/tasks/create', { title: '错误日期', due: '2026-02-30' }],
    ['/tasks/create', { title: '无时区', due: '2026-09-18T09:00' }],
    ['/tasks/create', { title: '陌生字段', apiKey: SECRET }],
    ['/events/create', { title: '活动', startDate: '2026-09-18', endDate: '2026-09-19', extra: true }],
    ['/availability', { date: '2026-09-18', until: '25:00' }],
    ['/areas/create', { name: '新类', unexpected: true }],
    ['/settings/key', { key: SECRET, endpoint: 'https://evil.example' }],
    ['/settings/key', { key: '' }],
    ['/chat', { ...chatInput(), context: { timezone: 'Mars/Crater' } }],
    ['/chat', { ...chatInput(), context: { timezone: 'Asia/Shanghai', apiKey: SECRET } }],
    ['/chat', { ...chatInput(), externalUrl: 'https://evil.example' }],
  ]
  for (const [path, input] of invalid) {
    const result = await f.request(path, input)
    assert.equal(result.status, 400, `${path}: ${result.raw}`)
    assert.doesNotMatch(result.raw, new RegExp(SECRET))
  }
  for (const filter of [null, [], { includeDeleted: 'true' }, { status: 'wrong' }, { area: {} }, { invalid: true }]) {
    assert.equal((await f.request(`/tasks?filter=${encodeURIComponent(JSON.stringify(filter))}`)).status, 400)
  }
  assert.equal((await f.request('/tasks/%EA')).status, 400)
  assert.equal(f.db.listTasks().length, 0)
})

test('migration is atomic, excludes settings and never overwrites cross-client edits', async t => {
  const f = await fixture(t)
  const task = { id: 'legacy-task', title: '旧报告', source: 'manual', inbox: false, area: null, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo', deletedAt: null, createdAt: '2026-09-18T00:00:00Z', updatedAt: '2026-09-18T00:00:00Z' }
  const first = await f.request('/migration', { tasks: [task] })
  assert.equal(first.value.tasks, 1)
  await f.request('/tasks/update', { id: task.id, patch: { title: '已经修改' } })
  assert.equal((await f.request('/migration', { tasks: [task] })).value.tasks, 0)
  assert.equal((await f.request('/tasks')).value[0].title, '已经修改')
  assert.equal((await f.request('/migration', { settings: { apiKey: SECRET } })).status, 400)
  const failed = await f.request('/migration', { tasks: [{ ...task, id: 'new-good' }, { ...task, id: 'new-bad', due: 'tomorrow' }] })
  assert.equal(failed.status, 400)
  assert.equal((await f.request('/tasks')).value.length, 1)
})

test('memory inspection, source-linked forget, and non-reversible receipt agree across API', async t => {
  const f = await fixture(t, { responses: [toolCall('remember', { content: '喜欢温柔语气', evidence: '温柔点', scope: 'global', kind: 'preference' }), reply('嗯，我记得了')] })
  const remembered = await f.request('/chat', chatInput('温柔点'))
  assert.equal(remembered.value.status, 'completed')
  const memories = await f.request('/memories')
  const memory = memories.value[0]
  assert.equal(memory.source, '温柔点')
  f.responses.push(toolCall('forget_memory', { memoryId: memory.id, evidence: '忘记语气偏好' }), reply('已经忘记了'))
  const forgotten = await f.request('/chat', chatInput('忘记语气偏好'))
  const receipt = forgotten.value.operations.find(operation => operation.undoable === false)
  assert.ok(receipt)
  assert.equal((await f.request(`/operations/${receipt.id}/undo`, {})).status, 409)
  assert.deepEqual((await f.request('/memories')).value, [])
  assert.ok((await f.request('/conversation?id=main')).value.messages.some(message => message.excludeFromContext))
})

test('provider pins the endpoint and model and keeps secrets out of bodies and errors', async () => {
  const calls = []
  const complete = createCompletion({ read: async () => SECRET }, async (url, options) => {
    calls.push({ url, options })
    return new Response(JSON.stringify(reply('你好')), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  await complete({ model: 'attacker-model', stream: true, messages: [{ role: 'user', content: '早' }] })
  assert.equal(calls[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(calls[0].options.redirect, 'error')
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${SECRET}`)
  const payload = JSON.parse(calls[0].options.body)
  assert.equal(payload.model, 'deepseek-flash')
  assert.deepEqual(payload.thinking, { type: 'enabled' })
  assert.equal(payload.reasoning_effort, 'max')
  assert.equal(payload.stream, false)
  assert.doesNotMatch(calls[0].options.body, new RegExp(SECRET))
  for (const status of [401, 429, 500, 302]) {
    const failing = createCompletion({ read: async () => SECRET }, async () => new Response(`debug secret ${SECRET}`, { status }))
    await assert.rejects(failing({ messages: [] }), error => error instanceof ProviderError && !error.message.includes(SECRET))
  }
  const network = createCompletion({ read: async () => SECRET }, async () => { throw new Error(`network ${SECRET}`) })
  await assert.rejects(network({ messages: [] }), error => error instanceof ProviderError && !error.message.includes(SECRET))
})

test('provider uses the current saved model on each request and rejects unsupported choices before reading the key', async () => {
  const db = createDatabase(':memory:')
  const models = []
  let keyReads = 0
  const vault = { read: async () => { keyReads += 1; return SECRET } }
  const fetcher = async (_url, options) => {
    models.push(JSON.parse(options.body).model)
    return new Response(JSON.stringify(reply('嗯')))
  }
  try {
    const complete = createCompletion(vault, fetcher, () => db.getModel())
    await complete({ messages: [] })
    db.setModel('deepseek-v4-pro')
    await complete({ messages: [], model: 'deepseek-flash' })
    assert.deepEqual(models, ['deepseek-flash', 'deepseek-v4-pro'])
    await assert.rejects(createCompletion(vault, fetcher, () => 'unknown')({ messages: [] }), ProviderError)
    assert.equal(keyReads, 2)
    assert.equal(models.length, 2)
  } finally { db.close() }
})

test('provider bounds successful response bodies and sanitizes malformed data', async () => {
  for (const content of [SECRET, JSON.stringify(reply('x'.repeat(4 * 1024 * 1024 + 1)))]) {
    const complete = createCompletion({ read: async () => SECRET }, async () => new Response(content, { status: 200 }))
    await assert.rejects(complete({ messages: [] }), error => error instanceof ProviderError && !error.message.includes(SECRET))
  }
})
