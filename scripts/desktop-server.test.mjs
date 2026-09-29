import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { once } from 'node:events'
import { assetPath, authorizedRequest, createDesktopHandler } from '../desktop/server.mjs'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createKeychain } from '../server/keychain.mjs'
import { createReminderService } from '../desktop/reminders.mjs'
import { getPreferences } from '../server/preferences.mjs'

const token = 'a'.repeat(64)

test('desktop writes refresh real reminder data, and quit flushes before closing SQLite', async t => {
  const { createDesktopServer } = await import('../desktop/server.mjs')
  const dir = await mkdtemp(join(tmpdir(), 'astaria-reminder-integration-')), db = createDatabase(':memory:')
  const native = [], now = new Date(), due = new Date(now.getTime() + 2 * 60 * 60_000).toISOString()
  const preferences = getPreferences(db)
  db.setPreference('app', { ...preferences, notifications: { ...preferences.notifications, quietStart: '00:00', quietEnd: '00:00' } })
  const task = db.createTask({ title: '提醒集成检查', due })
  let reminders, mutations = 0
  const service = createLocalService({ db, dataDirectory: dir, vault: { status: async () => false },
    onMutation: () => { mutations++; reminders.schedule() } })
  reminders = createReminderService({ stateFile: join(dir, 'reminders.json'), snapshot: service.reminderSnapshot, now: () => now,
    run: async (command, entries) => { native.push({ command, entries }); return { authorization: 2 } } })
  const server = createDesktopServer({ root: dir, service, token, reminders, port: 0 })
  t.after(async () => { await server.close(); await rm(dir, { recursive: true, force: true }) })
  const origin = (await server.listen()).replace(/\/$/u, '')
  const post = (path, input) => fetch(origin + path, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'x-astaria-local': '1', 'x-astaria-desktop': token, origin,
  }, body: JSON.stringify(input) })
  assert.equal((await post('/api/desktop/reminders/enabled', { enabled: true })).status, 200)
  assert.equal(native.findLast(call => call.command === 'replace').entries.length, 1)
  assert.equal((await post('/api/tasks/update', { id: task.id, patch: { status: 'done' }, expectedUpdatedAt: task.updatedAt })).status, 200)
  await service.whenIdle()
  assert.equal(mutations, 1, 'saved API mutation reaches notification scheduler')
  await server.close()
  assert.deepEqual(native.findLast(call => call.command === 'replace').entries, [], 'quit flush sees saved completion before SQLite closes')
})
function request(url, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  Object.assign(req, {
    url, method: body === undefined ? 'GET' : 'POST',
    socket: { remoteAddress: '127.0.0.1', localPort: 5199 },
    headers: { host: '127.0.0.1:5199', 'x-astaria-desktop': token, 'x-astaria-local': '1',
      origin: 'http://127.0.0.1:5199', 'content-type': 'application/json', ...headers },
  })
  return req
}
async function response(handler, req) {
  const chunks = [], headers = {}
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
  res.statusCode = 200
  res.setHeader = (key, value) => { headers[key.toLowerCase()] = value }
  res.flushHeaders = () => {}
  const finished = once(res, 'finish')
  await handler(req, res)
  await finished
  return { status: res.statusCode, headers, text: Buffer.concat(chunks).toString() }
}
async function fixture(t, updates) {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-desktop-test-'))
  const root = join(dir, 'dist')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<main>ASTaria</main>')
  await writeFile(join(root, 'assets', 'app.js'), 'export default 1')
  await writeFile(join(dir, 'private.json'), '{"private":true}')
  await symlink(join(dir, 'private.json'), join(root, 'escape.json'))
  const db = createDatabase(':memory:')
  const service = createLocalService({ db, dataDirectory: dir, vault: { status: async () => false } })
  const handler = createDesktopHandler({ root, service, token, updates })
  t.after(async () => { await service.whenIdle(); service.close(); await rm(dir, { recursive: true, force: true }) })
  return { handler, service, db }
}

test('desktop static asset resolver stays within the built frontend', () => {
  const root = '/tmp/astaria-dist'
  assert.equal(assetPath(root, '/'), '/tmp/astaria-dist/index.html')
  assert.equal(assetPath(root, '/assets/app.js?v=1'), '/tmp/astaria-dist/assets/app.js')
  for (const path of ['/../secret', '/%2e%2e/secret', '/.env', '/%5csecret', '/%00secret', '//remote/file', 'http://remote/file', '/%zz']) {
    assert.equal(assetPath(root, path), null, path)
  }
})

test('desktop session capability rejects other origins, hosts, sockets and absent or wrong tokens', () => {
  assert.equal(authorizedRequest(request('/'), token), true)
  for (const headers of [
    { 'x-astaria-desktop': undefined }, { 'x-astaria-desktop': 'wrong' }, { 'x-astaria-desktop': 'b'.repeat(64) },
    { host: 'evil.example:5199' }, { host: '127.0.0.1:5000' }, { origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' },
  ]) assert.equal(authorizedRequest(request('/', undefined, headers), token), false)
  const req = request('/'); req.socket.remoteAddress = '192.168.1.2'
  assert.equal(authorizedRequest(req, token), false)
})

test('desktop serves only built assets with isolation headers and no API fallback', async t => {
  const { handler } = await fixture(t)
  const home = await response(handler, request('/'))
  assert.equal(home.status, 200)
  assert.equal(home.text, '<main>ASTaria</main>')
  assert.match(home.headers['content-security-policy'], /object-src 'none'/)
  assert.equal(home.headers['cache-control'], 'no-store')
  assert.equal((await response(handler, request('/assets/app.js'))).status, 200)
  assert.equal((await response(handler, request('/api/missing'))).status, 404)
  assert.equal((await response(handler, request('/missing'))).status, 404)
  assert.equal((await response(handler, request('/escape.json'))).status, 404)
  assert.equal((await response(handler, request('/../private.json'))).status, 404)
  assert.equal((await response(handler, request('/server/index.mjs'))).status, 404)
  assert.equal((await response(handler, request('/', {}))).status, 405)
  assert.equal((await response(handler, request('/api/status', undefined, { 'x-astaria-desktop': undefined }))).status, 403)
})

test('desktop connects real API and SQLite without exposing data in the static tree', async t => {
  const { handler } = await fixture(t)
  const status = JSON.parse((await response(handler, request('/api/status'))).text)
  assert.equal(status.storage, 'SQLite')
  const created = await response(handler, request('/api/tasks/create', { title: '桌面测试事项' }))
  assert.equal(created.status, 200, created.text)
  const backup = JSON.parse((await response(handler, request('/api/data/export'))).text)
  assert.ok(JSON.stringify(backup).includes('桌面测试事项'))
  assert.equal((await response(handler, request('/api/tasks/create', { title: '不应创建' }, { 'x-astaria-local': undefined }))).status, 403)
})

test('service drain waits for asynchronous operations before closing its database', async t => {
  const db = createDatabase(':memory:')
  let release
  const barrier = new Promise(resolve => { release = resolve })
  const service = createLocalService({ db, vault: { status: async () => { await barrier; return false } } })
  t.after(() => service.close())
  const handler = createDesktopHandler({ root: tmpdir(), service, token })
  const pending = response(handler, request('/api/status'))
  let idle = false
  const drained = service.whenIdle().then(() => { idle = true })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(idle, false)
  release()
  assert.equal((await pending).status, 200)
  await drained
  assert.equal(idle, true)
})

test('bundled keychain preparation validates a shipped executable without compiling into user data', async t => {
  const root = await mkdtemp(join(tmpdir(), 'astaria-keychain-prep-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const helper = join(root, 'helper')
  await writeFile(helper, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  await createKeychain(join(root, 'nonexistent-profile'), { binaryPath: helper }).prepare()
  await assert.rejects(createKeychain(root, { binaryPath: join(root, 'missing') }).prepare())
})

test('desktop update endpoints inherit the session gate and still require the local marker', async t => {
  const calls = []
  const updates = {
    getStatus: async () => { calls.push('status'); return { status: 'idle', automatic: true } },
    check: async options => { calls.push(['check', options]); return { status: 'up-to-date' } },
    setAutomatic: async enabled => { calls.push(['automatic', enabled]); return { automatic: enabled } },
  }
  const { handler } = await fixture(t, updates)
  for (const headers of [
    { 'x-astaria-desktop': undefined }, { 'x-astaria-desktop': 'b'.repeat(64) },
    { origin: 'http://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { host: 'evil.example:5199' },
  ]) {
    const denied = await response(handler, request('/api/desktop/updates', undefined, headers))
    assert.equal(denied.status, 403, JSON.stringify(headers))
    assert.equal(denied.text, 'Forbidden')
  }
  const remote = request('/api/desktop/updates')
  remote.socket.remoteAddress = '192.168.1.2'
  assert.equal((await response(handler, remote)).status, 403)
  assert.deepEqual(calls, [], '未通过会话校验的请求不得触达更新服务')

  const status = await response(handler, request('/api/desktop/updates'))
  assert.equal(status.status, 200)
  assert.equal(status.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(status.text), { status: 'idle', automatic: true })

  const noMarker = await response(handler, request('/api/desktop/updates/check', {}, { 'x-astaria-local': undefined }))
  assert.equal(noMarker.status, 403)
  assert.equal(noMarker.headers['content-type'], 'application/json; charset=utf-8')
  assert.deepEqual(JSON.parse(noMarker.text), { error: 'Forbidden' })
  assert.deepEqual(calls.filter(call => Array.isArray(call)), [], '缺少本地标记时不得触发检查')

  assert.equal((await response(handler, request('/api/desktop/updates/check', {}))).status, 200)
  assert.deepEqual(calls.at(-1), ['check', { force: true }])
  assert.equal((await response(handler, request('/api/desktop/updates/automatic', { enabled: false }))).status, 200)
  assert.deepEqual(calls.at(-1), ['automatic', false])
})
