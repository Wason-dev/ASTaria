import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { RELEASES_URL, compareVersions, createUpdateService, handleUpdateRequest, selectRelease, validateManifest } from '../desktop/updates.mjs'

const RELEASE_API = 'https://api.github.com/repos/Wason-dev/ASTaria/releases?per_page=100'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const MANUAL_INTERVAL = 60 * 1000
const ETAG = '"releases-1"'
const T0 = Date.parse('2026-03-01T00:00:00.000Z')
const INSTALLED_COMMIT = 'a'.repeat(40)
const RELEASE_COMMIT = 'b'.repeat(40)

function downloadUrl(tag, name) {
  return `${RELEASES_URL}/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
}

function jsonResponse(status, body, headers = {}) {
  return new Response(body === null || body === undefined ? null : JSON.stringify(body),
    { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

/** 构造一个 GitHub release 与其配套构建清单，字段可按需破坏以覆盖异常分支。 */
function buildRelease(options = {}) {
  const {
    version, tag = `v${version}`, arch = 'arm64', platform = 'darwin', draft = false, releaseFlag = false,
    commit = RELEASE_COMMIT, builtAt = '2026-02-01T00:00:00.000Z', size = 4096, body = '发布说明',
    publishedAt = '2026-02-02T00:00:00.000Z', sha256 = 'd'.repeat(64),
    dmgState = 'uploaded', manifestState = 'uploaded', dmgUrl, manifestUrl, manifestPatch = {}, releasePatch = {},
  } = options
  const stem = `ASTaria-${version}-mac-${arch}-adhoc`
  const dmgName = `${stem}.dmg`
  const manifestName = `${stem}.manifest.json`
  const dmgAsset = { name: dmgName, state: dmgState, size, browser_download_url: dmgUrl ?? downloadUrl(tag, dmgName) }
  const manifestAsset = { name: manifestName, state: manifestState, size: 900, browser_download_url: manifestUrl ?? downloadUrl(tag, manifestName) }
  return {
    version, tag, dmgName, manifestName, manifestUrl: manifestAsset.browser_download_url,
    release: { tag_name: tag, name: `ASTaria ${version}`, draft, prerelease: releaseFlag, body,
      published_at: publishedAt, assets: [dmgAsset, manifestAsset], ...releasePatch },
    manifest: { schemaVersion: 1, name: 'ASTaria', bundleId: 'dev.wason.ASTaria', version, platform, arch,
      dmg: dmgName, sizeBytes: size, sha256, buildInfo: { version, builtAt, source: { commit } }, ...manifestPatch },
  }
}

/** mock fetch：按 URL 路由发布列表与清单请求，并记录全部调用。 */
function createBackend({ releases = [], builds = [], releaseReply, manifestReply } = {}) {
  const calls = []
  const manifests = new Map(builds.map(build => [build.manifestUrl, build.manifest]))
  let reply = releaseReply ?? (() => jsonResponse(200, releases, { etag: ETAG }))
  const fetcher = async (url, options = {}) => {
    const href = String(url)
    calls.push({ url: href, options })
    if (href === RELEASE_API) return reply(calls.filter(call => call.url === RELEASE_API).length)
    if (manifestReply) return manifestReply(href, options)
    if (manifests.has(href)) return jsonResponse(200, manifests.get(href))
    throw new Error(`未预期的请求：${href}`)
  }
  return {
    fetcher, calls,
    callsTo: url => calls.filter(call => call.url === url),
    count: url => calls.filter(call => call.url === url).length,
    reply: next => { reply = next },
  }
}

function textResponse(status, text, headers = {}) {
  return new Response(text, { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } })
}

function redirectResponse(location) {
  return location === undefined
    ? new Response(null, { status: 302 })
    : new Response(null, { status: 302, headers: { location } })
}

/** 生成恰好为 size 字节的 JSON 文本（填充字段参与计数），用于响应体上限测试。 */
function sizedJson(size, make) {
  let pad = ''
  for (let index = 0; index < 6; index++) {
    const text = JSON.stringify(make(pad))
    const delta = size - Buffer.byteLength(text, 'utf8')
    if (delta === 0) return text
    if (delta < 0) throw new Error(`种子 JSON 已超过 ${size} 字节`)
    pad += 'x'.repeat(delta)
  }
  throw new Error('JSON 填充未收敛')
}

async function withTimeout(promise, ms) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`操作在 ${ms}ms 内没有结束`)), ms)
    })])
  } finally { clearTimeout(timer) }
}

function createClock(start) {
  let current = start
  return { now: () => current, advance: ms => { current += ms }, iso: () => new Date(current).toISOString() }
}

function installed(patch = {}) {
  return { version: '1.0.0-beta.2', arch: 'arm64', platform: 'darwin',
    builtAt: '2026-01-01T00:00:00.000Z', source: { commit: INSTALLED_COMMIT }, ...patch }
}

function startService({ backend, current = installed(), clock = createClock(T0), stateFile = null, allowNetwork = true, ...extra }) {
  return { updates: createUpdateService({ current, stateFile, fetcher: backend.fetcher, now: clock.now, allowNetwork, ...extra }), clock }
}

function httpRequest(url, { method = 'GET', body, headers = {} } = {}) {
  const payload = body === undefined ? []
    : [Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const req = Readable.from(payload)
  Object.assign(req, { url, method, headers: { 'x-astaria-local': '1', 'content-type': 'application/json', ...headers } })
  return req
}

async function httpResponse(handle, req, updates) {
  const chunks = [], headers = {}
  const res = new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done() } })
  res.statusCode = 200
  res.setHeader = (key, value) => { headers[key.toLowerCase()] = value }
  const finished = once(res, 'finish')
  await handle(updates, req, res)
  await finished
  return { status: res.statusCode, headers, text: Buffer.concat(chunks).toString() }
}

test('compareVersions 按数值比较数字预发布标识，而不是字典序', () => {
  assert.equal(compareVersions('1.0.0-alpha.2', '1.0.0-alpha.10'), -1)
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.9'), 1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.2'), 0)
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1)
  // 超出 Number 安全整数的标识也必须精确比较
  assert.equal(compareVersions('1.0.0-alpha.9007199254740993', '1.0.0-alpha.9007199254740992'), 1)
  // 数字标识的优先级低于字母数字标识
  assert.equal(compareVersions('1.0.0-1', '1.0.0-alpha'), -1)
  // 标识段更少者更小
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1)
  // 主版本号同样按数值比较
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1)
})

test('compareVersions 让稳定版高于同版本预发布，构建元数据不参与比较', () => {
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1)
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1)
  assert.equal(compareVersions('1.0.0-0', '1.0.0'), -1)
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0)
  assert.equal(compareVersions('1.0.0+build.9', '1.0.0+build.1'), 0)
  assert.equal(compareVersions('1.0.0-rc.1+build.9', '1.0.0-rc.1+build.1'), 0)
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1)
  assert.equal(compareVersions('1.9.9', '2.0.0'), -1)
})

test('compareVersions 与 selectRelease 拒绝非法版本输入', () => {
  for (const value of ['1.0', 'v1', '1.0.0.0', '01.0.0', '1.0.0-01', '1.0.0-alpha.01', '1.0.0-', 'latest',
    '', ' 1.0.0', '1.0.0 ', 'a'.repeat(121), 1, null, undefined, {}]) {
    assert.throws(() => compareVersions(value, '1.0.0'), /Invalid version/u, String(value))
    assert.throws(() => compareVersions('1.0.0', value), /Invalid version/u, String(value))
  }
  assert.throws(() => selectRelease('nope', { version: '1.0.0' }), /Invalid release data/u)
  assert.throws(() => selectRelease([], { version: 'bad' }), /Invalid release data/u)
  assert.throws(() => selectRelease([], {}), /Invalid release data/u)
})

test('selectRelease 跳过 draft 版本，即使它是最高版本', () => {
  const current = { version: '1.0.0', arch: 'arm64', platform: 'darwin' }
  const draft = buildRelease({ version: '1.1.0', draft: true })
  const published = buildRelease({ version: '1.0.5' })
  assert.equal(selectRelease([draft.release, published.release], current).version, '1.0.5')
  assert.equal(selectRelease([published.release, draft.release], current).tag, 'v1.0.5')
  assert.equal(selectRelease([draft.release], current), null)
  // 非法 tag 与非对象条目被忽略，而不是让整次检查失败
  assert.equal(selectRelease([null, { tag_name: 'not-a-version' }, published.release], current).version, '1.0.5')
  assert.equal(selectRelease([undefined, { tag_name: 'v2.0.0', draft: true }], current), null)
})

test('selectRelease 让稳定版只匹配稳定发布，测试版可以接收预览版', () => {
  const stable = { version: '1.0.0', arch: 'arm64', platform: 'darwin' }
  const flagged = buildRelease({ version: '1.1.0-beta.1', releaseFlag: true })
  const unflagged = buildRelease({ version: '1.1.0-beta.1', releaseFlag: false })
  assert.equal(selectRelease([flagged.release], stable), null)
  assert.equal(selectRelease([unflagged.release], stable), null, 'tag 里的预发布后缀足以排除')
  const beta = { version: '1.0.0-beta.2', arch: 'arm64', platform: 'darwin' }
  const preview = selectRelease([flagged.release], beta)
  assert.equal(preview.version, '1.1.0-beta.1')
  assert.equal(preview.prerelease, true)
  // 测试版可以升级到稳定版
  const final = buildRelease({ version: '1.0.0' })
  const promoted = selectRelease([final.release], beta)
  assert.equal(promoted.version, '1.0.0')
  assert.equal(promoted.prerelease, false)
})

test('selectRelease 只接受与设备架构、tag、状态和大小完全匹配的附件', () => {
  const stable = { version: '1.0.0', arch: 'arm64', platform: 'darwin' }
  const good = buildRelease({ version: '1.1.0' })
  const picked = selectRelease([good.release], stable)
  assert.equal(picked.downloadUrl, downloadUrl('v1.1.0', good.dmgName))
  assert.equal(picked.assetName, good.dmgName)
  assert.equal(picked.manifestUrl, downloadUrl('v1.1.0', good.manifestName))
  assert.equal(picked.size, 4096)
  // 只有其它架构时给出该版本但没有下载地址，而不是退回旧版本
  const wrongArch = buildRelease({ version: '1.2.0', arch: 'x64' })
  const newer = selectRelease([wrongArch.release], stable)
  assert.equal(newer.version, '1.2.0')
  assert.equal(newer.downloadUrl, null)
  assert.equal(newer.manifestUrl, null)
  // 状态、大小或下载地址任一不符即视为没有可用附件
  for (const patch of [{ dmgState: 'pending' }, { size: 0 }, { size: 1.5 },
    { dmgUrl: `${RELEASES_URL}/download/v9.9.9/${good.dmgName}` }]) {
    assert.equal(selectRelease([buildRelease({ version: '1.1.0', ...patch }).release], stable).downloadUrl, null,
      JSON.stringify(patch))
  }
  // 只有安装包没有清单时同样无法完成校验
  const noManifest = selectRelease([buildRelease({ version: '1.1.0', manifestState: 'pending' }).release], stable)
  assert.equal(noManifest.downloadUrl, downloadUrl('v1.1.0', good.dmgName))
  assert.equal(noManifest.manifestUrl, null)
  // 目前只有 macOS 产物，其它平台不提供下载
  assert.equal(selectRelease([good.release], { ...stable, platform: 'win32' }).downloadUrl, null)
})

test('selectRelease 取满足条件的最高版本并裁剪发布说明', () => {
  const stable = { version: '1.0.0', arch: 'arm64', platform: 'darwin' }
  const older = buildRelease({ version: '1.0.1' })
  const newest = buildRelease({ version: '1.1.0', body: 'x'.repeat(13000), releasePatch: { published_at: undefined } })
  const picked = selectRelease([older.release, newest.release], stable)
  assert.equal(picked.version, '1.1.0')
  assert.equal(picked.notes.length, 12000)
  assert.equal(picked.publishedAt, null)
  assert.equal(picked.releaseUrl, `${RELEASES_URL}/tag/v1.1.0`)
  // 没有不低于当前版本的发布时返回 null
  assert.equal(selectRelease([older.release], { version: '2.0.0', arch: 'arm64', platform: 'darwin' }), null)
  // 同版本发布仍是候选，供“同版本新构建”判断使用
  assert.equal(selectRelease([older.release], { version: '1.0.1', arch: 'arm64', platform: 'darwin' }).version, '1.0.1')
})

test('validateManifest 拒绝平台、版本与哈希长度不一致的清单', () => {
  const current = { version: '1.0.0-beta.2', arch: 'arm64', platform: 'darwin' }
  const build = buildRelease({ version: '1.0.0-beta.3' })
  const selected = selectRelease([build.release], current)
  assert.deepEqual(validateManifest(build.manifest, selected, current), build.manifest.buildInfo)
  for (const [label, patch] of [
    ['平台不一致', { platform: 'win32' }],
    ['版本不一致', { version: '1.0.0-beta.4' }],
    ['哈希过短', { sha256: 'a'.repeat(63) }],
    ['哈希过长', { sha256: 'a'.repeat(65) }],
    ['哈希非十六进制', { sha256: 'g'.repeat(64) }],
    ['架构不一致', { arch: 'x64' }],
    ['附件名不一致', { dmg: 'other.dmg' }],
    ['大小不一致', { sizeBytes: 1 }],
    ['schema 不符', { schemaVersion: 2 }],
    ['bundleId 不符', { bundleId: 'dev.other.App' }],
    ['名称不符', { name: 'Other' }],
  ]) assert.throws(() => validateManifest({ ...build.manifest, ...patch }, selected, current), /Invalid build manifest/u, label)
  for (const [label, patch] of [
    ['缺少构建信息', { buildInfo: undefined }],
    ['构建版本不符', { buildInfo: { ...build.manifest.buildInfo, version: '1.0.0' } }],
    ['构建时间非法', { buildInfo: { ...build.manifest.buildInfo, builtAt: 'not-a-date' } }],
    ['缺少构建时间', { buildInfo: { ...build.manifest.buildInfo, builtAt: undefined } }],
  ]) assert.throws(() => validateManifest({ ...build.manifest, ...patch }, selected, current), /Invalid build information/u, label)
  assert.throws(() => validateManifest(null, selected, current), /Invalid build manifest/u)
})

test('createUpdateService 并发检查只访问一次发布接口', async () => {
  const latest = buildRelease({ version: '1.0.0-beta.3' })
  const backend = createBackend({ releases: [latest.release], builds: [latest] })
  const { updates } = startService({ backend })
  const results = await Promise.all([updates.check(), updates.check({ force: true }), updates.check()])
  assert.equal(backend.count(RELEASE_API), 1)
  assert.equal(backend.count(latest.manifestUrl), 1)
  for (const status of results) {
    assert.equal(status.status, 'available')
    assert.equal(status.latest.version, '1.0.0-beta.3')
    assert.equal(status.error, null)
  }
})

test('createUpdateService 只请求公开发布接口且不携带任何凭据', async () => {
  const latest = buildRelease({ version: '1.0.0-beta.3' })
  const backend = createBackend({ releases: [latest.release], builds: [latest] })
  const { updates } = startService({ backend })
  await updates.check()
  assert.deepEqual(backend.calls.map(call => call.url), [RELEASE_API, latest.manifestUrl])
  for (const call of backend.calls) {
    assert.equal(call.options.redirect, 'manual')
    const names = Object.keys(call.options.headers).map(name => name.toLowerCase())
    assert.deepEqual(names.filter(name => ['authorization', 'cookie', 'x-machine-id'].includes(name)), [])
  }
})

test('createUpdateService 下载时校验体积和 SHA-256，并只允许安装已校验文件', async t => {
  const payload = Buffer.from('verified-astaria-dmg-payload')
  const hash = createHash('sha256').update(payload).digest('hex')
  const latest = buildRelease({ version: '1.0.0-beta.3', size: payload.length, sha256: hash })
  const backend = createBackend({ releases: [latest.release], builds: [latest], manifestReply: (url, options) => {
    if (url === latest.manifestUrl) return jsonResponse(200, latest.manifest)
    if (url === latest.release.assets[0].browser_download_url) return new Response(Readable.toWeb(Readable.from([payload])), { status: 200, headers: { 'content-length': String(payload.length) } })
    throw new Error(`未预期的更新请求：${url}`)
  } })
  const dir = await mkdtemp(join(tmpdir(), 'astaria-update-download-')); t.after(() => rm(dir, { recursive: true, force: true }))
  let installed = null
  const { updates } = startService({ backend, downloadDirectory: dir, installer: async value => { installed = value } })
  await updates.check({ force: true })
  await updates.download()
  await updates.whenIdle()
  const ready = await updates.getStatus()
  assert.equal(ready.status, 'ready')
  assert.equal(ready.download.downloadedBytes, payload.length)
  assert.equal(ready.canInstall, true)
  const installedState = await updates.install()
  assert.equal(installedState.status, 'installing')
  await updates.whenIdle()
  assert.equal(installed.path, join(dir, `${hash}.dmg`))
  assert.equal(installed.version, '1.0.0-beta.3')
})

test('createUpdateService 在 403 限流时报告错误且不显示最新版本', async () => {
  const clock = createClock(T0)
  const backend = createBackend({ releaseReply: () => jsonResponse(403, { message: 'rate limited' }) })
  const { updates } = startService({ backend, clock })
  const status = await updates.check()
  assert.equal(status.status, 'error')
  assert.equal(status.latest, null)
  assert.equal(status.lastCheckedAt, null)
  assert.match(status.error, /限制/u)
  const retryAt = Date.parse(status.nextCheckAt)
  assert.ok(retryAt >= T0 + 15 * 60 * 1000, '至少等待 15 分钟再重试')
  assert.ok(retryAt <= T0 + 24 * 60 * 60 * 1000, '最多等待 24 小时')
  assert.equal(backend.count(RELEASE_API), 1)
  clock.advance(14 * 60 * 1000)
  await updates.check()
  assert.equal(backend.count(RELEASE_API), 1, '限流窗口内不再请求')
  clock.advance(2 * 60 * 1000)
  await updates.check()
  assert.equal(backend.count(RELEASE_API), 2, '限流窗口结束后重试')
})

test('createUpdateService 遵守 GitHub 给出的限流重置时间', async () => {
  const clock = createClock(T0)
  const reset = (T0 + 3600 * 1000) / 1000
  const backend = createBackend({ releaseReply: () => jsonResponse(429, {}, { 'x-ratelimit-reset': String(reset) }) })
  const { updates } = startService({ backend, clock })
  const status = await updates.check()
  assert.equal(status.status, 'error')
  assert.equal(status.latest, null)
  const retryAt = Date.parse(status.nextCheckAt)
  assert.ok(retryAt >= T0 + 3600 * 1000, '不早于服务端给出的重置时间')
  assert.ok(retryAt <= T0 + 24 * 60 * 60 * 1000)
})

test('createUpdateService 在网络失败时给出可读提示并延后重试', async () => {
  const clock = createClock(T0)
  const backend = createBackend({ releaseReply: () => { throw new Error('socket hang up') } })
  const { updates } = startService({ backend, clock })
  const status = await updates.check()
  assert.equal(status.status, 'error')
  assert.equal(status.latest, null)
  assert.equal(status.lastCheckedAt, null)
  assert.match(status.error, /[\u3400-\u9fff]/u)
  assert.ok(!status.error.includes('socket hang up'), '不把底层错误直接暴露给用户')
  const retryAt = Date.parse(status.nextCheckAt)
  assert.ok(retryAt > T0 && retryAt <= T0 + 60 * 60 * 1000)
  clock.advance(1000)
  await updates.check()
  assert.equal(backend.count(RELEASE_API), 1, '退避窗口内不重试')
  clock.advance(2 * 60 * 60 * 1000)
  await updates.check()
  assert.equal(backend.count(RELEASE_API), 2, '退避结束后自动重试')
})

test('createUpdateService 成功后六小时内不再自动请求，超时后按 ETag 重新校验', async () => {
  const clock = createClock(T0)
  const latest = buildRelease({ version: '1.0.0-beta.3' })
  const backend = createBackend({ releases: [latest.release], builds: [latest] })
  const { updates } = startService({ backend, clock })
  const first = await updates.check()
  assert.equal(first.status, 'available')
  assert.equal(first.lastCheckedAt, new Date(T0).toISOString())
  assert.equal(Date.parse(first.nextCheckAt), T0 + CHECK_INTERVAL)
  assert.equal(first.latest.builtAt, latest.manifest.buildInfo.builtAt)
  clock.advance(CHECK_INTERVAL - 1000)
  await updates.check()
  assert.equal(backend.count(RELEASE_API), 1, '缓存窗口内不再请求')
  clock.advance(2000)
  backend.reply(() => jsonResponse(304, null))
  const third = await updates.check()
  assert.equal(backend.count(RELEASE_API), 2, '缓存过期后重新校验')
  assert.equal(backend.callsTo(RELEASE_API)[1].options.headers['If-None-Match'], ETAG)
  assert.equal(third.status, 'available', '304 沿用缓存中的发布数据')
  assert.equal(third.latest.version, '1.0.0-beta.3')
  assert.equal(Date.parse(third.nextCheckAt), clock.now() + CHECK_INTERVAL)
})

test('createUpdateService 重启后沿用已保存的检查结果，未到时间不联网', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-updates-cache-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'updates.json')
  const clock = createClock(T0)
  const latest = buildRelease({ version: '1.0.0-beta.3' })
  const backend = createBackend({ releases: [latest.release], builds: [latest] })
  const first = startService({ backend, clock, stateFile })
  await first.updates.check()
  const saved = JSON.parse(await readFile(stateFile, 'utf8'))
  assert.equal(saved.schema, 1)
  assert.equal(saved.nextCheckAt, T0 + CHECK_INTERVAL)
  assert.equal(saved.releases.length, 1)
  // 一小时后重启：缓存仍然有效，检查时间不顺延
  const restarted = createClock(T0 + 60 * 60 * 1000)
  const idle = createBackend({})
  const second = startService({ backend: idle, clock: restarted, stateFile })
  const status = await second.updates.check()
  assert.equal(idle.calls.length, 0, '缓存有效期内重启不联网')
  assert.equal(Date.parse(status.nextCheckAt), T0 + CHECK_INTERVAL)
  assert.equal(status.lastCheckedAt, new Date(T0).toISOString())
})

test('createUpdateService 容忍缺失或损坏的缓存文件并继续工作', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-updates-broken-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const latest = buildRelease({ version: '1.0.0-beta.3' })
  const backend = createBackend({ releases: [latest.release], builds: [latest] })
  for (const raw of ['{not json', JSON.stringify({ schema: 99, automatic: false }), JSON.stringify(['wrong shape'])]) {
    const stateFile = join(dir, 'updates.json')
    await writeFile(stateFile, raw)
    const { updates } = startService({ backend, clock: createClock(T0), stateFile })
    const status = await updates.check()
    assert.equal(status.status, 'available', raw)
    assert.equal(status.automatic, true, '未知 schema 不被信任')
  }
})

test('createUpdateService 关闭自动检查后不再自动联网，手动检查仍然生效', async () => {
  const latest = buildRelease({ version: '1.0.0-beta.3' })
  const backend = createBackend({ releases: [latest.release], builds: [latest] })
  const { updates } = startService({ backend })
  const off = await updates.setAutomatic(false)
  assert.equal(off.automatic, false)
  await updates.check()
  assert.equal(backend.count(RELEASE_API), 0, '自动检查已关闭')
  const manual = await updates.check({ force: true })
  assert.equal(backend.count(RELEASE_API), 1, '手动检查不受开关影响')
  assert.equal(manual.status, 'available')
  await assert.rejects(() => updates.setAutomatic('yes'), /自动检查选项无效/u)
  assert.equal((await updates.getStatus()).automatic, false, '非法设置不改变开关状态')
})

test('createUpdateService 在不支持联网时任何检查都不发请求', async () => {
  const backend = createBackend({})
  const { updates } = startService({ backend, allowNetwork: false })
  const status = await updates.getStatus()
  assert.equal(status.supported, false)
  assert.equal(status.latest, null)
  assert.equal(status.error, null)
  await updates.check()
  await updates.check({ force: true })
  assert.equal(backend.calls.length, 0)
})

test('createUpdateService 对同版本但更晚构建且提交不同的版本提示可更新', async () => {
  const current = installed({ builtAt: '2026-01-01T00:00:00.000Z' })
  const rebuild = buildRelease({ version: '1.0.0-beta.2', builtAt: '2026-01-05T00:00:00.000Z' })
  const backend = createBackend({ releases: [rebuild.release], builds: [rebuild] })
  const { updates } = startService({ backend, current })
  const status = await updates.check()
  assert.equal(status.status, 'available')
  assert.equal(status.latest.sameVersion, true)
  assert.equal(status.latest.version, '1.0.0-beta.2')
  assert.equal(status.latest.builtAt, '2026-01-05T00:00:00.000Z')
})

test('createUpdateService 在同提交或未更晚但哈希有效时仍判定为已是最新', async () => {
  const current = installed({ builtAt: '2026-01-01T00:00:00.000Z' })
  assert.match(INSTALLED_COMMIT, /^[a-f0-9]{40}$/u, '前提：本机提交哈希有效')
  assert.match(RELEASE_COMMIT, /^[a-f0-9]{40}$/u, '前提：远端提交哈希有效')
  for (const [label, patch] of [
    ['同一个提交', { builtAt: '2026-02-01T00:00:00.000Z', commit: INSTALLED_COMMIT }],
    ['构建时间更早', { builtAt: '2025-12-01T00:00:00.000Z' }],
    ['构建时间相同', { builtAt: '2026-01-01T00:00:00.000Z' }],
  ]) {
    const rebuild = buildRelease({ version: '1.0.0-beta.2', ...patch })
    const backend = createBackend({ releases: [rebuild.release], builds: [rebuild] })
    const { updates } = startService({ backend, current })
    const status = await updates.check()
    assert.equal(backend.count(rebuild.manifestUrl), 1, label)
    assert.equal(status.status, 'up-to-date', label)
    assert.equal(status.error, null, label)
    assert.equal(status.latest.sameVersion, true, label)
  }
})

test('createUpdateService 在远端或本机构建信息不完整时报告不可用', async () => {
  const builtAt = '2026-01-05T00:00:00.000Z'
  const cases = [
    ['远端提交哈希非法', { commit: 'not-a-sha' }, {}],
    ['远端缺少提交信息', { manifestPatch: { buildInfo: { version: '1.0.0-beta.2', builtAt } } }, {}],
    ['本机提交哈希非法', {}, { source: { commit: 'not-a-sha' } }],
    ['本机缺少提交信息', {}, { source: {} }],
    ['本机缺少构建时间', {}, { builtAt: undefined }],
  ]
  for (const [label, releasePatch, currentPatch] of cases) {
    // 远端是合法的同版本重构建：唯一的问题只在提交/构建信息上
    const rebuild = buildRelease({ version: '1.0.0-beta.2', builtAt, ...releasePatch })
    const backend = createBackend({ releases: [rebuild.release], builds: [rebuild] })
    const { updates } = startService({ backend, current: installed(currentPatch) })
    const status = await updates.check()
    assert.equal(backend.count(rebuild.manifestUrl), 1, label)
    assert.equal(status.status, 'unavailable', label)
    assert.match(status.error, /构建信息不完整/u, label)
    assert.equal(status.latest.sameVersion, true, `${label}：同版本候选确实存在`)
    assert.equal(status.latest.downloadUrl, rebuild.release.assets[0].browser_download_url, label)
  }
})

test('createUpdateService 在已安装更高版本时不提示降级，也不向稳定版推荐预览版', async () => {
  const current = installed({ version: '1.2.0' })
  const older = buildRelease({ version: '1.1.0' })
  const preview = buildRelease({ version: '1.2.0-beta.9', releaseFlag: true })
  const backend = createBackend({ releases: [older.release, preview.release], builds: [older, preview] })
  const { updates } = startService({ backend, current })
  const status = await updates.check()
  assert.equal(backend.count(RELEASE_API), 1, '确实完成了检查')
  assert.equal(status.latest, null)
  assert.equal(status.status, 'up-to-date')
  assert.equal(status.error, null)
  assert.equal(status.current.version, '1.2.0')
  assert.equal(backend.count(preview.manifestUrl), 0, '不校验预览版清单')
})

test('createUpdateService 在新版本缺少本机架构安装包时报告暂不可用', async () => {
  const x64 = buildRelease({ version: '1.0.0-beta.3', arch: 'x64' })
  const backend = createBackend({ releases: [x64.release], builds: [x64] })
  const { updates } = startService({ backend })
  const status = await updates.check()
  assert.equal(status.status, 'unavailable')
  assert.match(status.error, /完整安装包/u)
  assert.equal(status.latest.version, '1.0.0-beta.3')
  assert.equal(status.latest.downloadUrl, null)
  assert.equal(backend.count(x64.manifestUrl), 0, '没有安装包就不校验清单')
})

test('createUpdateService 缓存重启后仍报告可更新，装上同标签新构建后立即转为已是最新', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-updates-install-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const stateFile = join(dir, 'updates.json')
  const rebuild = buildRelease({ version: '1.0.0-beta.2', builtAt: '2026-01-05T00:00:00.000Z' })
  const backend = createBackend({ releases: [rebuild.release], builds: [rebuild] })
  const first = startService({ backend, clock: createClock(T0), stateFile })
  const checked = await first.updates.check()
  assert.equal(checked.status, 'available')
  assert.equal(checked.latest.sameVersion, true)

  // 重启后沿用缓存：状态仍为可更新，且不需要联网
  const idle = createBackend({})
  const restarted = startService({ backend: idle, clock: createClock(T0 + 60_000), stateFile })
  const before = await restarted.updates.getStatus()
  assert.equal(before.status, 'available')
  assert.equal(before.latest.version, '1.0.0-beta.2')
  assert.equal(before.latest.sameVersion, true)
  assert.equal(idle.calls.length, 0)
  const again = await restarted.updates.check()
  assert.equal(again.status, 'available', '缓存有效期内沿用同一结论')
  assert.equal(idle.calls.length, 0)

  // 用户装上这次构建后，缓存必须立刻改判为已是最新，而不是等到缓存过期
  const upgraded = installed({ builtAt: '2026-01-05T00:00:00.000Z', source: { commit: RELEASE_COMMIT } })
  const after = startService({ backend: idle, current: upgraded, clock: createClock(T0 + 120_000), stateFile })
  const status = await after.updates.getStatus()
  assert.equal(status.status, 'up-to-date')
  assert.equal(status.error, null)
  assert.equal(status.latest.sameVersion, true)
  assert.equal(status.latest.builtAt, '2026-01-05T00:00:00.000Z')
  assert.equal(idle.calls.length, 0, '改判不需要重新联网')
  const afterCheck = await after.updates.check()
  assert.equal(afterCheck.status, 'up-to-date')
  assert.equal(idle.calls.length, 0)
})

test('createUpdateService 跟随白名单主机上的清单重定向', async () => {
  const release = buildRelease({ version: '1.0.0-beta.3' })
  for (const target of [
    'https://release-assets.githubusercontent.com/github-production-release-asset/1/asset?token=abc',
    'https://objects.githubusercontent.com/github-production-release-asset/2/asset',
  ]) {
    const backend = createBackend({ releases: [release.release],
      manifestReply: href => href === release.manifestUrl ? redirectResponse(target) : jsonResponse(200, release.manifest) })
    const { updates } = startService({ backend })
    const status = await updates.check()
    assert.equal(status.status, 'available', target)
    assert.deepEqual(backend.calls.map(call => call.url), [RELEASE_API, release.manifestUrl, target])
    assert.equal(status.latest.version, '1.0.0-beta.3')
    assert.equal(status.latest.builtAt, release.manifest.buildInfo.builtAt)
  }
})

test('createUpdateService 拒绝非白名单、明文或携带凭据的清单重定向', async () => {
  const release = buildRelease({ version: '1.0.0-beta.3' })
  const targets = [
    ['非白名单主机', 'https://evil.example/asset'],
    ['白名单后缀伪装', 'https://release-assets.githubusercontent.com.evil.example/asset'],
    ['明文 HTTP', 'http://release-assets.githubusercontent.com/asset'],
    ['携带凭据', 'https://user:secret@release-assets.githubusercontent.com/asset'],
    ['指定端口', 'https://release-assets.githubusercontent.com:8443/asset'],
    ['协议相对地址', '//evil.example/asset'],
    ['缺少 Location 头', undefined],
  ]
  for (const [label, target] of targets) {
    const backend = createBackend({ releases: [release.release],
      manifestReply: href => href === release.manifestUrl ? redirectResponse(target) : jsonResponse(200, release.manifest) })
    const { updates } = startService({ backend })
    const status = await updates.check()
    assert.equal(status.status, 'error', label)
    assert.equal(status.latest, null, label)
    assert.match(status.error, /[\u3400-\u9fff]/u, label)
    assert.deepEqual(backend.calls.map(call => call.url), [RELEASE_API, release.manifestUrl], `${label}：不跟随越权重定向`)
    assert.ok(backend.calls.every(call => call.url.startsWith('https://')), `${label}：不发生明文降级`)
    assert.ok(!status.error.includes('Invalid redirect'), `${label}：不把内部错误抛给用户`)
  }
})

test('createUpdateService 用 Content-Length 与真实体积把发布列表限制在 2MB', async () => {
  const release = buildRelease({ version: '1.0.0-beta.3' })
  const cases = [
    ['声明超限', () => textResponse(200, JSON.stringify([release.release]), { 'content-length': '2000001' }), false],
    ['真实超限', () => textResponse(200, sizedJson(2_000_001, pad => [{ ...release.release, body: pad }]), { 'content-length': '1' }), false],
    ['恰好 2MB', () => textResponse(200, sizedJson(2_000_000, pad => [{ ...release.release, body: pad }]), { 'content-length': '2000000' }), true],
  ]
  for (const [label, reply, accepted] of cases) {
    const backend = createBackend({ builds: [release], releaseReply: reply })
    const { updates } = startService({ backend })
    const status = await updates.check()
    if (accepted) {
      assert.equal(status.status, 'available', label)
      assert.equal(backend.count(release.manifestUrl), 1, label)
    } else {
      assert.equal(status.status, 'error', label)
      assert.equal(status.latest, null, label)
      assert.match(status.error, /[\u3400-\u9fff]/u, label)
      assert.equal(backend.count(release.manifestUrl), 0, `${label}：不在超限数据上继续解析`)
    }
  }
})

test('createUpdateService 用 Content-Length 与真实体积把清单限制在 128KB', async () => {
  const release = buildRelease({ version: '1.0.0-beta.3' })
  const cases = [
    ['声明超限', { text: JSON.stringify(release.manifest), headers: { 'content-length': '128001' } }, false],
    ['真实超限', { text: sizedJson(128_001, pad => ({ ...release.manifest, pad })), headers: { 'content-length': '1' } }, false],
    ['恰好 128KB', { text: sizedJson(128_000, pad => ({ ...release.manifest, pad })), headers: { 'content-length': '128000' } }, true],
  ]
  for (const [label, shape, accepted] of cases) {
    const backend = createBackend({ releases: [release.release],
      manifestReply: () => textResponse(200, shape.text, shape.headers) })
    const { updates } = startService({ backend })
    const status = await updates.check()
    if (accepted) {
      assert.equal(status.status, 'available', label)
      assert.equal(status.latest.builtAt, release.manifest.buildInfo.builtAt, label)
    } else {
      assert.equal(status.status, 'error', label)
      assert.equal(status.latest, null, label)
      assert.match(status.error, /[\u3400-\u9fff]/u, label)
    }
    assert.equal(backend.count(release.manifestUrl), 1, label)
  }
})

test('createUpdateService 关闭时中止在途请求，之后不再发起新请求', async () => {
  const calls = []
  let signal = null
  const fetcher = (url, options) => {
    calls.push(String(url))
    signal = options.signal
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
  }
  const updates = createUpdateService({ current: installed(), stateFile: null, fetcher, now: createClock(T0).now })
  const inFlight = updates.check()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 1)
  assert.equal(signal.aborted, false)
  updates.close()
  assert.equal(signal.aborted, true, '关闭时立即中止网络信号')
  const status = await withTimeout(inFlight, 2000)
  assert.equal(status.status, 'error')
  assert.match(status.error, /[\u3400-\u9fff]/u)
  assert.ok(!status.error.includes('abort'), '不把中止原因暴露给用户')
  await updates.check({ force: true })
  assert.equal(calls.length, 1, '关闭后不再发起新请求')
})

test('更新接口要求本地标记，并按请求体区分手动与自动检查', async () => {
  const calls = []
  const updates = {
    getStatus: async () => ({ automatic: true, status: 'idle' }),
    check: async options => { calls.push(['check', options]); return { status: 'up-to-date' } },
    setAutomatic: async enabled => {
      if (typeof enabled !== 'boolean') throw new Error('自动检查选项无效')
      calls.push(['automatic', enabled]); return { automatic: enabled }
    },
  }
  const status = await httpResponse(handleUpdateRequest, httpRequest('/api/desktop/updates'), updates)
  assert.equal(status.status, 200)
  assert.equal(status.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(status.headers['cache-control'], 'no-store')
  assert.deepEqual(JSON.parse(status.text), { automatic: true, status: 'idle' })

  const forbidden = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/check', { method: 'POST', body: {}, headers: { 'x-astaria-local': undefined } }), updates)
  assert.equal(forbidden.status, 403)
  assert.deepEqual(JSON.parse(forbidden.text), { error: 'Forbidden' })
  assert.deepEqual(calls, [], '缺少本地标记时不得触发检查')

  for (const [label, options] of [
    ['空对象', { method: 'POST', body: {} }],
    ['空请求体', { method: 'POST' }],
    ['automatic 为 false', { method: 'POST', body: { automatic: false } }],
  ]) {
    const manual = await httpResponse(handleUpdateRequest, httpRequest('/api/desktop/updates/check', options), updates)
    assert.equal(manual.status, 200, label)
    assert.deepEqual(calls.at(-1), ['check', { force: true }], label)
  }
  const automatic = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/check', { method: 'POST', body: { automatic: true } }), updates)
  assert.equal(automatic.status, 200)
  assert.deepEqual(calls.at(-1), ['check', { force: false }])

  const off = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/automatic', { method: 'POST', body: { enabled: false } }), updates)
  assert.equal(off.status, 200)
  assert.deepEqual(calls.at(-1), ['automatic', false])
  const invalid = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/automatic', { method: 'POST', body: { enabled: 'yes' } }), updates)
  assert.equal(invalid.status, 400)
  assert.deepEqual(JSON.parse(invalid.text), { error: '自动检查选项无效' })

  const wrongMethod = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates', { method: 'DELETE' }), updates)
  assert.equal(wrongMethod.status, 405)
  assert.equal(await handleUpdateRequest(updates, httpRequest('/api/status'), {}), false, '其它接口交给后续处理')
})

test('更新接口拒绝异常 JSON 与超大请求体', async () => {
  const calls = []
  const updates = {
    getStatus: async () => ({}),
    check: async options => { calls.push(options); return {} },
    setAutomatic: async enabled => { calls.push(enabled); return {} },
  }
  const malformed = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/check', { method: 'POST', body: Buffer.from('{') }), updates)
  assert.equal(malformed.status, 400)
  const oversized = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/check', { method: 'POST', body: Buffer.alloc(1025, 0x61) }), updates)
  assert.equal(oversized.status, 413)
  assert.deepEqual(JSON.parse(oversized.text), { error: '请求过大' })
  assert.deepEqual(calls, [], '被拒绝的请求不得触达更新服务')
  // 恰好 1024 字节仍然接受，边界只挡真正超限的请求
  const boundary = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/automatic', { method: 'POST', body: sizedJson(1024, pad => ({ enabled: true, pad })) }), updates)
  assert.equal(boundary.status, 200)
  assert.deepEqual(calls, [true])
})

test('更新接口把手动检查与自动检查分别落到 force 上', async () => {
  const latest = buildRelease({ version: '1.0.0-beta.3' })
  const backend = createBackend({ releases: [latest.release], builds: [latest] })
  const updates = createUpdateService({ current: installed(), stateFile: null, fetcher: backend.fetcher, now: createClock(T0).now })
  await updates.setAutomatic(false)
  const automatic = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/check', { method: 'POST', body: { automatic: true } }), updates)
  assert.equal(automatic.status, 200)
  assert.equal(backend.calls.length, 0, '开关关闭时自动检查不联网')
  assert.deepEqual(JSON.parse(automatic.text).automatic, false)
  const manual = await httpResponse(handleUpdateRequest,
    httpRequest('/api/desktop/updates/check', { method: 'POST', body: {} }), updates)
  assert.equal(manual.status, 200)
  assert.equal(backend.count(RELEASE_API), 1, '手动检查不受开关影响')
  assert.equal(JSON.parse(manual.text).status, 'available')
})
