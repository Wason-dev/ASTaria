/**
 * 下载模块（desktop/updateDownload.mjs）的行为契约。
 *
 * 全部使用临时目录与内存 Response / fake fetch：不联网、不读用户数据、不启动浏览器。
 * 每一项失败都必须同时满足「拒绝」与「目录里既没有 .part 也没有可安装的 .dmg」，
 * 这样未校验的字节永远不可能成为安装候选。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { downloadVerifiedAsset, validateAsset, verifyAsset } from '../desktop/updateDownload.mjs'

const DMG_URL = 'https://github.com/Wason-dev/ASTaria/releases/download/v1.0.0-beta.3/ASTaria-1.0.0-beta.3-mac-arm64-adhoc.dmg'
const ASSET_URL = 'https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=abc'
const OBJECT_URL = 'https://objects.githubusercontent.com/asset/1'
const MESSAGES = {
  manifest: '安装包清单无效',
  size: '安装包大小校验失败，请重新下载',
  hash: '安装包校验失败，请重新下载',
  declaredSize: '安装包大小校验失败',
  oversize: '安装包体积超过清单',
  url: '安装包地址无效',
  redirect: '安装包重定向无效',
  unavailable: '暂时无法下载安装包，请稍后重试',
  directory: '更新目录不可用',
}

const payloadOf = size => {
  const value = Buffer.alloc(size)
  for (let index = 0; index < size; index++) value[index] = (index * 31 + 7) % 251
  return value
}
const sha256 = value => createHash('sha256').update(value).digest('hex')
const manifestFor = value => ({ sizeBytes: value.length, sha256: sha256(value) })
const bytes = (...parts) => parts.map(part => new Uint8Array(part))
const bodyResponse = (chunks, headers = {}) => new Response(Readable.toWeb(Readable.from(chunks)), { status: 200, headers })
const redirectResponse = (location, status = 302) => location === undefined
  ? new Response(null, { status })
  : new Response(null, { status, headers: { location } })

/** 记录每一次真实外发请求，供重定向与「不带凭据」断言使用。 */
function recorder(handler) {
  const calls = []
  return { calls, fetcher: async (url, options = {}) => { calls.push({ url: String(url), options }); return handler(String(url), options, calls.length) } }
}

/** 每个测试独占一个临时下载目录；核心不变式是「失败后目录为空」。 */
async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-update-download-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
const listing = async dir => (await readdir(dir)).sort()
async function rejectsCleanly(promise, message, dir) {
  await assert.rejects(promise, { message })
  assert.deepEqual(await listing(dir), [], '失败后不得残留 .part 或可安装的 dmg')
}

test('分块下载完成后 SHA-256 与体积匹配、进度单调到齐，且不留 .part', async t => {
  const dir = await workspace(t)
  const payload = payloadOf(64 * 1024 + 37), manifest = manifestFor(payload)
  const chunks = bytes(payload.subarray(0, 1), payload.subarray(1, 5000), payload.subarray(5000, 40000), payload.subarray(40000))
  const progress = []
  const { calls, fetcher } = recorder(() => bodyResponse(chunks, { 'content-length': String(payload.length) }))
  const destination = await downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher, onProgress: (done, total) => progress.push([done, total]) })
  assert.equal(destination, join(dir, `${manifest.sha256}.dmg`), '安装包以清单哈希命名')
  assert.deepEqual(await listing(dir), [`${manifest.sha256}.dmg`], '成功后目录里只有安装包，没有 .part')
  assert.equal((await readFile(destination)).equals(payload), true, '落盘字节与响应字节完全一致')
  assert.deepEqual(progress, [[1, payload.length], [5000, payload.length], [40000, payload.length], [payload.length, payload.length]], '进度按块累加并停在清单体积')
  assert.equal(calls.length, 1)
  await verifyAsset(destination, manifest)
})

test('下载目录创建成功，并在 POSIX 上以私有权限落盘', async t => {
  const dir = await workspace(t), nested = join(dir, 'updates', 'v1')
  const payload = payloadOf(2048), manifest = manifestFor(payload)
  const { fetcher } = recorder(() => bodyResponse(bytes(payload)))
  const destination = await downloadVerifiedAsset({ url: DMG_URL, manifest, directory: nested, fetcher })
  assert.equal((await lstat(nested)).isDirectory(), true)
  assert.equal((await lstat(destination)).isFile(), true)
  if (process.platform !== 'win32') {
    assert.equal((await lstat(nested)).mode & 0o077, 0, '更新目录不对同组或其他用户开放')
    assert.equal((await lstat(destination)).mode & 0o077, 0, '安装包只对所有者可读')
  }
})

test('哈希不匹配时拒绝下载且不留任何可用文件', async t => {
  const dir = await workspace(t), payload = payloadOf(8192)
  const manifest = { sizeBytes: payload.length, sha256: 'f'.repeat(64) }
  const { calls, fetcher } = recorder(() => bodyResponse(bytes(payload), { 'content-length': String(payload.length) }))
  await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher }), MESSAGES.hash, dir)
  assert.equal(calls.length, 1)
})

test('截断的响应（含谎报 Content-Length）被拒绝并清理临时文件', async t => {
  const dir = await workspace(t), payload = payloadOf(4096)
  const manifest = { sizeBytes: 8192, sha256: sha256(Buffer.concat([payload, payload])) }
  const silent = recorder(() => bodyResponse(bytes(payload)))
  await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: silent.fetcher }), MESSAGES.hash, dir)
  const lying = recorder(() => bodyResponse(bytes(payload), { 'content-length': '8192' }))
  await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: lying.fetcher }), MESSAGES.hash, dir)
})

test('超出清单体积的响应被拒绝，并且不在校验后才报告', async t => {
  const dir = await workspace(t), payload = payloadOf(4096)
  const manifest = { sizeBytes: 1024, sha256: sha256(payload.subarray(0, 1024)) }
  const silent = recorder(() => bodyResponse(bytes(payload)))
  await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: silent.fetcher }), MESSAGES.oversize, dir)
  const declared = recorder(() => bodyResponse(bytes(payload), { 'content-length': '4096' }))
  await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: declared.fetcher }), MESSAGES.declaredSize, dir)
})

test('Content-Length 与清单不一致时在写入任何字节前就拒绝', async t => {
  const dir = await workspace(t), payload = payloadOf(2048), manifest = manifestFor(payload)
  for (const declared of ['1', String(payload.length + 1), 'not-a-number']) {
    const { calls, fetcher } = recorder(() => bodyResponse(bytes(payload), { 'content-length': declared }))
    await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher }), MESSAGES.declaredSize, dir)
    assert.equal(calls.length, 1)
  }
  // 没有 Content-Length 属于正常情况，必须以真实字节数校验而不是直接失败。
  const absent = recorder(() => bodyResponse(bytes(payload)))
  const destination = await downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: absent.fetcher })
  await verifyAsset(destination, manifest)
})

test('无效或外部的重定向被拒绝且不产生文件', async t => {
  const dir = await workspace(t), payload = payloadOf(2048), manifest = manifestFor(payload)
  const cases = [
    ['缺少 Location', () => redirectResponse(undefined), MESSAGES.redirect, 1],
    ['外部主机', () => redirectResponse('https://evil.example.com/a.dmg'), MESSAGES.url, 1],
    ['协议相对的外部主机', () => redirectResponse('//evil.example.com/a.dmg'), MESSAGES.url, 1],
    ['明文 HTTP', () => redirectResponse('http://github.com/a.dmg'), MESSAGES.url, 1],
    ['携带端口', () => redirectResponse('https://github.com:8443/a.dmg'), MESSAGES.url, 1],
    ['携带凭据', () => redirectResponse('https://user:secret@github.com/a.dmg'), MESSAGES.url, 1],
    ['超过五次重定向', () => redirectResponse('https://github.com/loop'), MESSAGES.redirect, 5],
  ]
  for (const [label, reply, message, expectedCalls] of cases) {
    const { calls, fetcher } = recorder(reply)
    await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher }), message, dir)
    assert.equal(calls.length, expectedCalls, label)
  }
})

test('初始地址本身也必须在白名单主机上，非法地址不会发起请求', async t => {
  const dir = await workspace(t), payload = payloadOf(1024), manifest = manifestFor(payload)
  for (const url of ['http://github.com/a.dmg', 'https://github.com:8443/a.dmg', 'https://cdn.example.com/a.dmg', 'https://user:pw@github.com/a.dmg']) {
    const { calls, fetcher } = recorder(() => bodyResponse(bytes(payload)))
    await rejectsCleanly(downloadVerifiedAsset({ url, manifest, directory: dir, fetcher }), MESSAGES.url, dir)
    assert.equal(calls.length, 0, url)
  }
})

test('跟随 GitHub 到 release-assets / objects 的合法重定向并完成校验', async t => {
  const payload = payloadOf(32 * 1024), manifest = manifestFor(payload)
  const chunks = bytes(payload.subarray(0, 4096), payload.subarray(4096))
  for (const [status, target] of [[302, ASSET_URL], [307, OBJECT_URL]]) {
    const dir = await workspace(t)
    const { calls, fetcher } = recorder(url => {
      if (url === DMG_URL) return redirectResponse(target, status)
      if (url === target) return bodyResponse(chunks, { 'content-length': String(payload.length) })
      throw new Error(`未预期的请求：${url}`)
    })
    const destination = await downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher })
    assert.deepEqual(calls.map(call => call.url), [DMG_URL, target], `${status} 只跟随一跳`)
    assert.deepEqual(await listing(dir), [`${manifest.sha256}.dmg`])
    await verifyAsset(destination, manifest)
  }
})

test('预先取消与中途取消都拒绝，已写入的字节不会留下 .part 或 dmg', async t => {
  const dir = await workspace(t), payload = payloadOf(8192), manifest = manifestFor(payload)
  // 预先取消：即使传输层忽略信号并返回完整合法字节，模块也不得发布文件。
  const pre = new AbortController(); pre.abort()
  let abortedSeen = null
  const preRun = recorder((_url, options) => { abortedSeen = options.signal.aborted; return bodyResponse(bytes(payload)) })
  await assert.rejects(
    downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: preRun.fetcher, signal: pre.signal }),
    error => { assert.equal(error.name, 'AbortError'); return true },
  )
  assert.equal(abortedSeen, true, '取消信号必须透传给 fetch')
  assert.deepEqual(await listing(dir), [], '预先取消后目录必须为空')

  // 中途取消：第一块已经写盘之后才取消，临时文件必须被删除。
  const mid = new AbortController(), progress = []
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1
      if (pulls === 1) controller.enqueue(new Uint8Array(payload.subarray(0, 1000)))
      else if (pulls === 2) { mid.abort(); controller.enqueue(new Uint8Array(payload.subarray(1000))) }
      else controller.close()
    },
  }, { highWaterMark: 0 })
  const midRun = recorder(() => new Response(body, { status: 200 }))
  await assert.rejects(
    downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: midRun.fetcher, signal: mid.signal, onProgress: done => progress.push(done) }),
    error => { assert.equal(error.name, 'AbortError'); return true },
  )
  assert.deepEqual(progress, [1000], '取消确实发生在部分字节写盘之后')
  assert.deepEqual(await listing(dir), [], '被取消的 .part 必须删除')
})

test('传输中断不会留下半成品', async t => {
  const dir = await workspace(t), payload = payloadOf(4096), manifest = manifestFor(payload)
  let pulls = 0
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1
      if (pulls === 1) controller.enqueue(new Uint8Array(payload.subarray(0, 512)))
      else controller.error(new Error('socket hang up'))
    },
  }, { highWaterMark: 0 })
  const { fetcher } = recorder(() => new Response(body, { status: 200 }))
  await assert.rejects(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher }), /socket hang up/u)
  assert.deepEqual(await listing(dir), [])
})

test('非 2xx 或没有响应体的下载被拒绝', async t => {
  const dir = await workspace(t), payload = payloadOf(1024), manifest = manifestFor(payload)
  for (const reply of [() => new Response('no', { status: 404 }), () => new Response('no', { status: 500 }), () => new Response(null, { status: 200 })]) {
    await rejectsCleanly(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: recorder(reply).fetcher }), MESSAGES.unavailable, dir)
  }
})

test('verifyAsset 拒绝符号链接、被改动的文件与错误体积', async t => {
  const dir = await workspace(t), payload = payloadOf(4096), manifest = manifestFor(payload)
  const good = join(dir, 'good.dmg')
  await writeFile(good, payload, { mode: 0o600 })
  await verifyAsset(good, manifest)
  const link = join(dir, 'link.dmg')
  await symlink(good, link)
  await assert.rejects(verifyAsset(link, manifest), { message: MESSAGES.size }, '符号链接不是安装包')
  const dangling = join(dir, 'dangling.dmg')
  await symlink(join(dir, 'missing.dmg'), dangling)
  await assert.rejects(verifyAsset(dangling, manifest), { message: MESSAGES.size }, '悬空符号链接同样被拒绝')
  const modified = join(dir, 'modified.dmg'), tampered = Buffer.from(payload)
  tampered[0] ^= 0xff
  await writeFile(modified, tampered)
  await assert.rejects(verifyAsset(modified, manifest), { message: MESSAGES.hash }, '体积相同但内容被改动')
  const short = join(dir, 'short.dmg')
  await writeFile(short, payload.subarray(0, 100))
  await assert.rejects(verifyAsset(short, manifest), { message: MESSAGES.size }, '体积不足')
  await assert.rejects(verifyAsset(dir, manifest), { message: MESSAGES.size }, '目录不是安装包')
  await assert.rejects(verifyAsset(join(dir, 'absent.dmg'), manifest), { code: 'ENOENT' })
})

test('下载目录必须是真实目录，符号链接目录不会被写入', async t => {
  const dir = await workspace(t), payload = payloadOf(1024), manifest = manifestFor(payload)
  const real = join(dir, 'real')
  await mkdir(real)
  const link = join(dir, 'link')
  await symlink(real, link, 'dir')
  const { calls, fetcher } = recorder(() => bodyResponse(bytes(payload)))
  await assert.rejects(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: link, fetcher }), { message: MESSAGES.directory })
  assert.deepEqual(await listing(real), [], '符号链接目录不得被写入')
  const file = join(dir, 'not-a-directory')
  await writeFile(file, 'existing')
  await assert.rejects(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: file, fetcher }), error => {
    assert.ok(['EEXIST', 'ENOTDIR'].includes(error.code), `预期 EEXIST/ENOTDIR，实际 ${error.code}`)
    return true
  })
  assert.equal(await readFile(file, 'utf8'), 'existing', '同名普通文件不会被覆盖')
  assert.equal(calls.length, 0, '目录不可用时不应发起请求')
})

test('清单校验的边界：2GiB 上限被接受，越界或非法哈希被拒绝', () => {
  assert.doesNotThrow(() => validateAsset({ sizeBytes: 2 * 1024 ** 3, sha256: 'a'.repeat(64) }))
  const rejected = [
    ['非对象', null], ['空对象', {}],
    ['体积为零', { sizeBytes: 0, sha256: 'a'.repeat(64) }],
    ['负体积', { sizeBytes: -1, sha256: 'a'.repeat(64) }],
    ['非整数体积', { sizeBytes: 1.5, sha256: 'a'.repeat(64) }],
    ['字符串体积', { sizeBytes: '1024', sha256: 'a'.repeat(64) }],
    ['超过 2GiB', { sizeBytes: 2 * 1024 ** 3 + 1, sha256: 'a'.repeat(64) }],
    ['非安全整数', { sizeBytes: Number.MAX_SAFE_INTEGER, sha256: 'a'.repeat(64) }],
    ['缺少哈希', { sizeBytes: 1024 }],
    ['大写哈希', { sizeBytes: 1024, sha256: 'A'.repeat(64) }],
    ['哈希过短', { sizeBytes: 1024, sha256: 'a'.repeat(63) }],
    ['哈希过长', { sizeBytes: 1024, sha256: 'a'.repeat(65) }],
    ['非十六进制哈希', { sizeBytes: 1024, sha256: 'g'.repeat(64) }],
  ]
  for (const [label, manifest] of rejected) assert.throws(() => validateAsset(manifest), { message: MESSAGES.manifest }, label)
})

test('清单无效时既不联网也不创建任何文件', async t => {
  const dir = await workspace(t)
  const { calls, fetcher } = recorder(() => bodyResponse(bytes(Buffer.from('x'))))
  for (const manifest of [null, {}, { sizeBytes: 10 }, { sizeBytes: 10, sha256: 'A'.repeat(64) }]) {
    await assert.rejects(downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher }), { message: MESSAGES.manifest })
  }
  assert.equal(calls.length, 0)
  assert.deepEqual(await listing(dir), [])
})

test('外发请求只带自述标头，token 与 cookie 都不会随请求发出', async t => {
  const dir = await workspace(t), payload = payloadOf(4096), manifest = manifestFor(payload)
  const accepted = recorder(url => url === DMG_URL ? redirectResponse(ASSET_URL) : bodyResponse(bytes(payload), { 'content-length': String(payload.length) }))
  await downloadVerifiedAsset({
    url: DMG_URL, manifest, directory: dir, fetcher: accepted.fetcher,
    token: 'ghp_secret_token', credentials: 'include',
    headers: { authorization: 'Bearer ghp_secret_token', cookie: 'session=secret' },
  })
  const rejected = recorder(() => redirectResponse('https://evil.example.com/a.dmg'))
  await assert.rejects(
    downloadVerifiedAsset({ url: DMG_URL, manifest, directory: dir, fetcher: rejected.fetcher, token: 'ghp_secret_token' }),
    { message: MESSAGES.url },
  )
  const observed = [...accepted.calls, ...rejected.calls]
  assert.equal(observed.length, 3, '一次成功重定向加一次被拒绝的重定向共三次外发')
  for (const { url, options } of observed) {
    assert.deepEqual(Object.keys(options).sort(), ['headers', 'redirect', 'signal'], '外发请求只允许这三个选项')
    assert.equal(options.redirect, 'manual', '重定向必须由模块自行校验')
    assert.equal(new URL(url).username, '')
    assert.equal(new URL(url).password, '')
    const names = Object.keys(options.headers).map(name => name.toLowerCase())
    assert.deepEqual(names.filter(name => ['authorization', 'cookie', 'proxy-authorization', 'x-machine-id', 'x-api-key'].includes(name)), [])
    assert.deepEqual([...names].sort(), ['accept', 'user-agent'])
    for (const value of Object.values(options.headers)) {
      assert.equal(`${value}`.includes('ghp_secret_token'), false)
      assert.equal(`${value}`.includes('secret'), false)
    }
  }
})
