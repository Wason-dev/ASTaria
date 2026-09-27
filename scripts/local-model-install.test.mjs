import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { createServer } from 'node:http'
import { createLocalModelInstaller } from '../server/localModelInstall.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDatabase } from '../server/database.mjs'
import { ValidationError } from '../server/validation.mjs'

const baseUrl = 'http://127.0.0.1:11434/v1'
const input = { baseUrl, model: 'qwen3:8b', confirmed: true }
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } })
const version = () => json({ version: '0.11.6' })
const tags = (models = []) => json({ models: models.map(name => ({ name })) })
const stream = rows => new Response(rows.map(row => typeof row === 'string' ? row : JSON.stringify(row)).join('\n'))
const done = () => stream([{ status: 'success' }])
const next = () => new Promise(resolve => setImmediate(resolve))
async function terminal(installer, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const job = installer.get(id)
    if (!['checking', 'downloading'].includes(job.status)) { await next(); return job }
    await next()
  }
  throw new Error('job did not settle')
}
function fixture(t, memoryGB = 16) {
  const requests = [], responses = [], callbackErrors = []
  const fetcher = async (url, options = {}) => {
    requests.push({ url, options })
    if (!responses.length) { callbackErrors.push('unexpected fetch'); throw new Error('unexpected fetch') }
    const response = responses.shift()
    if (response instanceof Error) throw response
    try { return typeof response === 'function' ? await response(url, options) : response }
    catch (error) { callbackErrors.push(error); throw error }
  }
  const installer = createLocalModelInstaller({ fetcher, memoryGB })
  t.after(() => { installer.close(); assert.deepEqual(callbackErrors, [], 'mock assertions must not be hidden as provider failures') })
  return { installer, requests, responses, fetcher }
}

test('Ollama setup detects its version and installed curated models, pins loopback and recommends by memory', async t => {
  const f = fixture(t, 24)
  f.responses.push(version(), tags(['qwen3:8b', 'not-curated:tag']))
  const options = await f.installer.options({ baseUrl: 'http://localhost:11434/' })
  assert.equal(options.baseUrl, baseUrl)
  assert.equal(options.runtimeAvailable, true)
  assert.equal(options.runtimeVersion, '0.11.6')
  assert.equal(options.options.length, 4)
  assert.equal(options.options.find(model => model.recommended).id, 'qwen3:14b')
  assert.equal(options.options.find(model => model.installed).id, 'qwen3:8b')
  for (const model of options.options) {
    assert.ok(model.downloadGB > 0 && model.diskGB > model.downloadGB && model.minMemoryGB >= 8)
  }
  assert.equal(options.activeJob, null)
  assert.equal(options.latestJob, null)
  assert.deepEqual(f.requests.map(call => call.url), ['http://127.0.0.1:11434/api/version', 'http://127.0.0.1:11434/api/tags'])
  assert.ok(f.requests.every(call => call.options.redirect === 'error' && !call.options.headers?.Authorization))
})

test('devices below the smallest model memory recommendation are not told a model fits', async t => {
  for (const memoryGB of [4, 6]) {
    const f = fixture(t, memoryGB)
    f.responses.push(version(), tags())
    const options = await f.installer.options()
    assert.equal(options.options.some(model => model.recommended), false)
    assert.match(options.message, /内存低于/u)
  }
  for (const [memoryGB, id] of [[8, 'qwen3:4b'], [16, 'qwen3:8b'], [24, 'qwen3:14b'], [48, 'qwen3:32b']]) {
    const f = fixture(t, memoryGB)
    f.responses.push(version(), tags())
    const options = await f.installer.options()
    assert.deepEqual(options.options.filter(model => model.recommended).map(model => model.id), [id])
    assert.ok(options.options.filter(model => model.recommended).every(model => model.minMemoryGB <= memoryGB))
  }
})

test('an already installed model succeeds without a registry pull even from a stale settings page', async t => {
  const f = fixture(t)
  f.responses.push(version(), tags(['qwen3:8b']))
  const job = f.installer.start(input)
  const installed = await terminal(f.installer, job.id)
  assert.equal(installed.status, 'succeeded')
  assert.equal(installed.percent, 100)
  assert.match(installed.message, /无需重复下载/u)
  assert.ok(f.requests.every(call => call.options.method !== 'POST'))
})

test('missing runtime is a setup state, and unrelated or oversized local responses never authorize a download', async t => {
  const f = fixture(t)
  for (const response of [new Error('private connection details'), json({ version: 'not ollama' }),
    new Response(null, { status: 302, headers: { Location: 'https://remote.invalid/' } }),
    json({ version: '0.11.6', blob: 'x'.repeat(513 * 1024) })]) {
    f.responses.push(response)
    const result = await f.installer.options()
    assert.equal(result.runtimeAvailable, false)
    assert.equal(result.runtimeVersion, null)
    assert.match(result.message, /安装并打开 Ollama/u)
    assert.doesNotMatch(JSON.stringify(result), /private connection/u)
  }
  f.responses.push(json({ data: [] }))
  const job = f.installer.start(input)
  assert.equal((await terminal(f.installer, job.id)).status, 'failed')
  assert.ok(f.requests.every(call => call.url.endsWith('/api/version')))
})

test('installation requires explicit confirmation, a curated exact tag and a loopback-only address before any request', async t => {
  const f = fixture(t)
  for (const bad of [{ ...input, confirmed: false }, { ...input, confirmed: undefined },
    { ...input, model: 'qwen3:latest' }, { ...input, model: 'remote.example/qwen3:8b' },
    { ...input, model: '../model' }, { ...input, insecure: true }, { ...input, token: 'secret' },
    { ...input, baseUrl: 'http://192.168.1.1:11434/v1' }, { ...input, baseUrl: 'https://api.deepseek.com' },
    { ...input, baseUrl: 'http://user:password@localhost:11434' },
    { ...input, baseUrl: 'http://localhost:11434/api/pull' }]) {
    assert.throws(() => f.installer.start(bad), ValidationError)
  }
  await assert.rejects(f.installer.options({ baseUrl: 'https://external.invalid/v1' }), ValidationError)
  await assert.rejects(f.installer.options({ baseUrl, arbitrary: true }), ValidationError)
  assert.equal(f.requests.length, 0)
})

test('a pull is streamed with progress, survives reopening settings, verifies installation, and never changes provider settings', async t => {
  const f = fixture(t)
  let controller
  const body = new ReadableStream({ start(value) { controller = value } })
  f.responses.push(version(), tags(), new Response(body))
  const created = f.installer.start({ ...input, baseUrl: 'http://localhost:11434' })
  assert.equal(created.status, 'checking')
  assert.equal(created.controller, undefined)
  assert.throws(() => f.installer.start(input), error => error instanceof ValidationError && error.status === 409)
  await next()
  controller.enqueue(new TextEncoder().encode('{"status":"pulling file","digest":"sha256:one","total":1000,"completed":250}\n'))
  await next()
  const progress = f.installer.get(created.id)
  assert.equal(progress.status, 'downloading')
  assert.equal(progress.percent, 25)
  assert.equal(progress.completedBytes, 250)
  assert.equal(progress.totalBytes, 1000)
  f.responses.push(version(), tags())
  const reopened = await f.installer.options({ baseUrl })
  assert.deepEqual(reopened.activeJob, progress)
  assert.deepEqual(reopened.latestJob, progress)
  f.responses.push(tags(['qwen3:8b']))
  // A JSONL packet may split in the middle of a field and finish without a newline.
  controller.enqueue(new TextEncoder().encode('{"status":"verifying sha256 digest"}\n{"sta'))
  controller.enqueue(new TextEncoder().encode('tus":"success"}'))
  controller.close()
  const finished = await terminal(f.installer, created.id)
  assert.equal(finished.status, 'succeeded')
  assert.equal(finished.percent, 100)
  assert.equal(finished.completedBytes, 1000)
  assert.equal(finished.error, null)
  assert.equal(f.requests[2].url, 'http://127.0.0.1:11434/api/pull')
  assert.deepEqual(JSON.parse(f.requests[2].options.body), { model: input.model, stream: true, insecure: false })
  assert.deepEqual(f.requests[2].options.headers, { 'Content-Type': 'application/json' })
  assert.equal(f.requests[2].options.redirect, 'error')
  assert.equal(f.requests.at(-1).url, 'http://127.0.0.1:11434/api/tags')
  f.responses.push(version(), tags(['qwen3:8b']))
  const after = await f.installer.options({ baseUrl })
  assert.equal(after.activeJob, null)
  assert.equal(after.latestJob.status, 'succeeded')
  assert.equal(after.options.find(model => model.id === input.model).installed, true)
})

test('cancel aborts the local fetch and keeps cancellation distinct from failure; a subsequent pull may resume', async t => {
  const f = fixture(t)
  let signal
  f.responses.push(version(), tags(), (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true })
    } }))
  })
  const job = f.installer.start(input)
  await next()
  const cancelled = f.installer.cancel(job.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(signal.aborted, true)
  assert.equal(cancelled.error, null)
  assert.match(cancelled.message, /缓存/u)
  assert.deepEqual(f.installer.cancel(job.id), cancelled)
  await next()
  assert.equal(f.installer.get(job.id).status, 'cancelled')
  f.responses.push(version(), tags(), done(), tags(['qwen3:8b']))
  const retry = f.installer.start(input)
  assert.notEqual(retry.id, job.id)
  assert.equal((await terminal(f.installer, retry.id)).status, 'succeeded')
})

test('malformed, unbounded, incomplete and rejected streams fail without exposing upstream contents', async t => {
  const f = fixture(t)
  const badResponses = [
    () => new Response('private bad json'),
    () => new Response('x'.repeat(17 * 1024)),
    () => new Response(new Uint8Array(16 * 1024 * 1024 + 1)),
    () => new Response(null, { status: 302, headers: { Location: 'https://remote.invalid' } }),
    () => new Response('private upstream error', { status: 500 }),
    () => stream([{ error: 'private disk details' }]),
    () => stream([{ status: 'pulling', total: -1, completed: 0 }]),
    () => stream([{ status: 'pulling', total: 10, completed: 11 }]),
    () => stream([{ status: 'pulling', total: 10, completed: 4 }]),
    () => stream([null]),
    () => stream(Array.from({ length: 65 }, (_, i) => ({ status: 'pulling', total: 10, completed: 4, digest: `digest-${i}` }))),
  ]
  for (const response of badResponses) {
    f.responses.push(version(), tags(), response())
    const job = f.installer.start(input)
    const failed = await terminal(f.installer, job.id)
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /未完成/u)
    assert.doesNotMatch(JSON.stringify(failed), /private|upstream|disk details/u)
  }
  f.responses.push(version(), tags(), done(), tags())
  const falseSuccess = f.installer.start(input)
  assert.equal((await terminal(f.installer, falseSuccess.id)).status, 'failed', 'success without an installed model must not be reported as complete')
})

test('stream failures cancel the reader, and closing the service aborts its active download', async t => {
  const f = fixture(t)
  let cancelled = false
  f.responses.push(version(), tags(), new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('bad json\n')) },
    cancel() { cancelled = true },
  })))
  const bad = f.installer.start(input)
  assert.equal((await terminal(f.installer, bad.id)).status, 'failed')
  assert.equal(cancelled, true)
  let signal
  f.responses.push(version(), tags(), (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(new Error('closed')), { once: true })
    } }))
  })
  const job = f.installer.start(input)
  await next()
  f.installer.close()
  assert.equal(signal.aborted, true)
  assert.equal((await terminal(f.installer, job.id)).status, 'cancelled')
})

test('real loopback HTTP cancellation releases stalled headers and body reads, then allows retry', { timeout: 5000 }, async t => {
  let stage = 'version-headers', seen = false, disconnected = false, present = false
  const server = createServer((req, res) => {
    req.resume()
    const stall = stage === 'version-headers' && req.url === '/api/version' ||
      stage === 'pull-headers' && req.url === '/api/pull' || stage === 'pull-body' && req.url === '/api/pull'
    if (stall) {
      seen = true
      res.on('close', () => { if (!res.writableEnded) disconnected = true })
      if (stage === 'pull-body') { res.setHeader('Content-Type', 'application/x-ndjson'); res.write('{"status":"pulling","total":100,"completed":25}\n') }
      return
    }
    res.setHeader('Content-Type', 'application/json')
    if (req.url === '/api/version') return res.end('{"version":"0.11.6"}')
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: present ? [{ name: 'qwen3:8b' }] : [] }))
    if (req.url === '/api/pull') { present = true; return res.end('{"status":"success"}\n') }
    res.statusCode = 404; res.end('{}')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const installer = createLocalModelInstaller()
  t.after(() => { installer.close(); server.closeAllConnections(); server.close() })
  const localInput = { ...input, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }
  const until = async predicate => {
    for (let attempt = 0; attempt < 200; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.fail('local HTTP condition did not settle')
  }
  for (const nextStage of ['version-headers', 'pull-headers', 'pull-body']) {
    stage = nextStage; seen = false; disconnected = false
    const job = installer.start(localInput)
    await until(() => seen)
    if (stage === 'pull-body') await until(() => installer.get(job.id).percent === 25)
    installer.cancel(job.id)
    await until(() => disconnected)
    const stable = installer.get(job.id)
    assert.equal(stable.status, 'cancelled')
    assert.match(stable.message, /停止/u)
  }
  stage = 'success'
  const retry = installer.start(localInput)
  await until(() => installer.get(retry.id).status === 'succeeded')
  assert.equal(installer.get(retry.id).percent, 100)
})

test('real local HTTP disconnect after partial progress is a retryable failure, not success', { timeout: 5000 }, async t => {
  const server = createServer((req, res) => {
    req.resume()
    if (req.url === '/api/version') return res.end('{"version":"0.11.6"}')
    if (req.url === '/api/tags') return res.end('{"models":[]}')
    res.write('{"status":"pulling","total":100,"completed":25}\n')
    setImmediate(() => res.destroy())
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const installer = createLocalModelInstaller()
  t.after(() => { installer.close(); server.closeAllConnections(); server.close() })
  const job = installer.start({ ...input, baseUrl: `http://127.0.0.1:${server.address().port}/v1` })
  for (let attempt = 0; attempt < 200 && installer.get(job.id).status !== 'failed'; attempt++) await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(installer.get(job.id).status, 'failed')
  assert.match(installer.get(job.id).error, /重试/u)
})

test('installer history is bounded, and only a single active job can run across local endpoints', async t => {
  const f = fixture(t)
  let first
  for (let count = 0; count < 21; count++) {
    f.responses.push(version(), tags(), done(), tags(['qwen3:8b']))
    const job = f.installer.start(input)
    first ??= job.id
    assert.throws(() => f.installer.start({ ...input, baseUrl: 'http://localhost:11435/v1' }), error => error.status === 409)
    assert.equal((await terminal(f.installer, job.id)).status, 'succeeded')
  }
  assert.throws(() => f.installer.get(first), error => error.status === 404)
})

test('service restart loses only in-memory jobs, returning an honest recovery message', async t => {
  const f = fixture(t)
  f.responses.push(version(), tags(), done(), tags(['qwen3:8b']))
  const job = f.installer.start(input)
  await terminal(f.installer, job.id)
  f.installer.close()
  assert.throws(() => f.installer.start(input), /关闭/u)
  const restarted = createLocalModelInstaller({ fetcher: f.fetcher })
  t.after(() => restarted.close())
  assert.throws(() => restarted.get(job.id), error => error instanceof ValidationError && error.status === 404 && /重启/u.test(error.message))
  f.responses.push(version(), tags(['qwen3:8b']))
  const restored = await restarted.options({ baseUrl })
  assert.equal(restored.activeJob, null)
  assert.equal(restored.latestJob, null)
  assert.equal(restored.options.find(model => model.id === input.model).installed, true)
})

test('install HTTP endpoints preserve local-origin checks, known fields, cancellation and no-Keychain boundaries', async t => {
  const f = fixture(t)
  const db = createDatabase(':memory:')
  let vaultCalls = 0
  const vault = Object.fromEntries(['read', 'status', 'save', 'remove'].map(key => [key, async () => { vaultCalls++; throw new Error('must not use keychain') }]))
  const service = createLocalService({ db, vault, fetcher: f.fetcher })
  t.after(() => service.close())
  const request = (path, payload, headers = {}) => new Promise(resolve => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
    req.url = `/api${path}`; req.method = payload === undefined ? 'GET' : 'POST'
    req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1',
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers }
    const res = { statusCode: 200, setHeader() {}, end(raw) { resolve({ status: this.statusCode, value: JSON.parse(raw) }) } }
    service.middleware(req, res, () => resolve({ status: 404 }))
  })
  assert.equal((await request('/settings/local/install', input, { origin: 'https://remote.invalid' })).status, 403)
  assert.equal((await request('/settings/local/install', { ...input, arbitrary: true })).status, 400)
  assert.equal((await request('/settings/local/install', { ...input, confirmed: false })).status, 400)
  assert.equal((await request('/settings/local/install-options?arbitrary=1')).status, 400)
  assert.equal(f.requests.length, 0)
  f.responses.push(version(), tags())
  assert.equal((await request(`/settings/local/install-options?baseUrl=${encodeURIComponent(baseUrl)}`)).value.runtimeAvailable, true)
  let signal
  f.responses.push(version(), tags(), (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ start(controller) { signal.addEventListener('abort', () => controller.error(new Error('cancelled')), { once: true }) } }))
  })
  const created = await request('/settings/local/install', input)
  assert.equal(created.status, 200)
  await next()
  const id = created.value.id
  assert.equal((await request(`/settings/local/install/${id}`)).value.status, 'downloading')
  assert.equal((await request(`/settings/local/install/${id}/cancel`, { other: true })).status, 400)
  assert.equal((await request(`/settings/local/install/${id}/cancel`, {})).value.status, 'cancelled')
  assert.equal(signal.aborted, true)
  assert.equal((await request('/settings/local/install/nonexistent')).status, 404)
  assert.equal(vaultCalls, 0)
  assert.equal(db.getPreference('model-connection'), null, 'install must not select or alter a provider')
})
