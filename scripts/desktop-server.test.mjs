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

const token = 'a'.repeat(64)
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
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-desktop-test-'))
  const root = join(dir, 'dist')
  await mkdir(join(root, 'assets'), { recursive: true })
  await writeFile(join(root, 'index.html'), '<main>ASTaria</main>')
  await writeFile(join(root, 'assets', 'app.js'), 'export default 1')
  await writeFile(join(dir, 'private.json'), '{"private":true}')
  await symlink(join(dir, 'private.json'), join(root, 'escape.json'))
  const db = createDatabase(':memory:')
  const service = createLocalService({ db, dataDirectory: dir, vault: { status: async () => false } })
  const handler = createDesktopHandler({ root, service, token })
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
