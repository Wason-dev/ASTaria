import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { downloadVerifiedAsset, verifyAsset } from './updateDownload.mjs'
import { RELEASE_KEYS, verifyReleaseManifest } from './releaseTrust.mjs'

export const RELEASES_URL = 'https://github.com/Wason-dev/ASTaria/releases'
const RELEASE_API = 'https://api.github.com/repos/Wason-dev/ASTaria/releases?per_page=100'
const CHECK_INTERVAL = 6 * 60 * 60 * 1000
const MANUAL_INTERVAL = 60 * 1000

function versionParts(value) {
  if (typeof value !== 'string' || value.length > 120) return null
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/u.exec(value)
  if (!match) return null
  const pre = match[4]?.split('.') ?? []
  if (pre.some(part => /^\d+$/u.test(part) && part.length > 1 && part[0] === '0')) return null
  return { core: match.slice(1, 4).map(BigInt), pre, version: value.replace(/^v/u, '') }
}

/** SemVer ordering, including numeric prereleases; build metadata has no precedence. */
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right)
  if (!a || !b) throw new Error('Invalid version')
  for (let index = 0; index < 3; index++) {
    if (a.core[index] !== b.core[index]) return a.core[index] > b.core[index] ? 1 : -1
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index++) {
    if (a.pre[index] === undefined) return -1
    if (b.pre[index] === undefined) return 1
    const x = a.pre[index], y = b.pre[index]
    if (x === y) continue
    const xn = /^\d+$/u.test(x), yn = /^\d+$/u.test(y)
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1
    if (xn !== yn) return xn ? -1 : 1
    return x > y ? 1 : -1
  }
  return 0
}

function assetFor(release, name) {
  const expected = `${RELEASES_URL}/download/${encodeURIComponent(release.tag_name)}/${encodeURIComponent(name)}`
  return (Array.isArray(release.assets) ? release.assets : []).find(asset => asset && asset.name === name && asset.state === 'uploaded'
    && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.browser_download_url === expected)
}

export function selectRelease(releases, current) {
  if (!Array.isArray(releases) || !versionParts(current.version)) throw new Error('Invalid release data')
  const beta = versionParts(current.version).pre.length > 0
  const candidates = releases.filter(release => release && !release.draft && versionParts(release.tag_name)
    && (beta || (!release.prerelease && !versionParts(release.tag_name).pre.length))
    && compareVersions(release.tag_name, current.version) >= 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
  const release = candidates[0]
  if (!release) return null
  const version = versionParts(release.tag_name).version
  const stem = `ASTaria-${version}-mac-${current.arch}-adhoc`
  const asset = current.platform === 'darwin' ? assetFor(release, `${stem}.dmg`) : null
  const manifest = asset ? assetFor(release, `${stem}.manifest.json`) : null
  return {
    version, tag: release.tag_name, prerelease: Boolean(release.prerelease || versionParts(version).pre.length),
    notes: typeof release.body === 'string' ? release.body.slice(0, 12000) : '',
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
    downloadUrl: asset?.browser_download_url ?? null, assetName: asset?.name ?? null,
    size: asset?.size ?? null, manifestUrl: manifest?.browser_download_url ?? null,
  }
}

export function validateManifest(manifest, release, current, trustedKeys = RELEASE_KEYS) {
  verifyReleaseManifest(manifest, trustedKeys)
  if (manifest?.schemaVersion !== 1 || manifest.name !== 'ASTaria' || manifest.bundleId !== 'dev.wason.ASTaria'
    || manifest.version !== release.version || manifest.platform !== current.platform || manifest.arch !== current.arch
    || manifest.dmg !== release.assetName || manifest.sizeBytes !== release.size
    || !/^[a-f0-9]{64}$/u.test(manifest.sha256 ?? '')) throw new Error('Invalid build manifest')
  const build = manifest.buildInfo
  if (!build || build.version !== release.version || typeof build.builtAt !== 'string' || !Number.isFinite(Date.parse(build.builtAt))) throw new Error('Invalid build information')
  return build
}

function validCommit(value) { return typeof value === 'string' && /^[a-f0-9]{40,64}$/u.test(value) }

function isNewBuild(build, current) {
  if (!Number.isFinite(Date.parse(current.builtAt)) || Date.parse(build.builtAt) <= Date.parse(current.builtAt)) return false
  return validCommit(build.source?.commit) && validCommit(current.source?.commit) && build.source.commit !== current.source.commit
}

async function limitedJson(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new Error('Response too large')
  }
  const chunks = []; let size = 0
  for await (const chunk of response.body) {
    size += chunk.byteLength
    if (size > limit) throw new Error('Response too large')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

/** Public release metadata only. No model keys, local tasks or machine identity are sent. */
export function createUpdateService({ current, stateFile, fetcher = fetch, now = Date.now, allowNetwork = true, downloadDirectory, installer: installHandler, trustedKeys = RELEASE_KEYS, installResultFile }) {
  let automatic = true, lastCheckedAt = null, nextCheckAt = 0, lastAttempt = -Infinity, retryAfter = 0
  let releases = null, etag = null, latest = null, manifest = null, status = 'idle', error = null, pending = null, closed = false
  let lastInstall = null
  let download = null, downloadPending = null, downloadController = null, installPending = null
  const downloadRoot = downloadDirectory ?? (stateFile ? join(dirname(stateFile), 'updates') : null)
  const installer = typeof installHandler === 'function' ? installHandler : null
  const network = new AbortController()
  let diskWrite = Promise.resolve()
  const snapshot = () => ({ supported: allowNetwork && current.platform !== 'win32', unsupportedReason: current.platform === 'win32' ? 'Windows 首版请从官方发布页下载新版并手动更新；自动安装尚未提供。' : null, current: { version: current.version, builtAt: current.builtAt ?? null,
    commit: current.source?.commit?.slice(0, 7) ?? null }, automatic, status, error, lastCheckedAt,
    nextCheckAt: nextCheckAt ? new Date(nextCheckAt).toISOString() : null, latest, releasesUrl: RELEASES_URL,
    download: download ? { version: download.version, sizeBytes: download.sizeBytes, downloadedBytes: download.downloadedBytes ?? 0, path: null } : null,
    canInstall: Boolean(download?.path && installer), lastInstall })
  const persist = () => {
    if (!stateFile) return Promise.resolve()
    const value = JSON.stringify({ schema: 1, automatic, lastCheckedAt, nextCheckAt, retryAfter, etag, releases, manifest, status, error, downloaded: download?.path ? { sha256: manifest?.sha256 } : null })
    const write = async () => {
      await mkdir(dirname(stateFile), { recursive: true })
      await writeFile(`${stateFile}.tmp`, value, { mode: 0o600 })
      await rename(`${stateFile}.tmp`, stateFile)
    }
    diskWrite = diskWrite.catch(() => {}).then(write)
    return diskWrite
  }
  const resolveStatus = () => {
    latest = selectRelease(releases, current)
    status = 'up-to-date'; error = null
    if (!latest) {
      if (releases.length === 0) { status = 'unavailable'; error = 'GitHub 暂时没有可用的公开版本' }
      return
    }
    if (!latest.downloadUrl || !latest.manifestUrl) {
      status = 'unavailable'; error = '这个版本尚未提供适合此设备的完整安装包，可到发布页查看'
      return
    }
    const build = validateManifest(manifest, latest, current, trustedKeys)
    const newerVersion = compareVersions(latest.version, current.version) > 0
    latest = { ...latest, builtAt: build.builtAt, sameVersion: !newerVersion }
    if (newerVersion || isNewBuild(build, current)) status = 'available'
    else if (!Number.isFinite(Date.parse(current.builtAt)) || !validCommit(current.source?.commit) || !validCommit(build.source?.commit)) {
      status = 'unavailable'; error = '构建信息不完整，请到发布页核对同版本的更新'
    }
  }
  const ready = (async () => {
    if (installResultFile) {
      try {
        const result = (await readFile(installResultFile, 'utf8')).trim()
        const messages = { installed: '上次更新已安装并成功启动', failed: '上次更新未能启动，已恢复原版本；可重试或手动安装', prepared: '上次更新尚未完成，当前仍在使用原版本' }
        if (Object.hasOwn(messages, result)) lastInstall = { status: result, message: messages[result] }
      } catch { /* No previous installation result. */ }
    }
    if (!stateFile) return
    try {
      const raw = await readFile(stateFile, 'utf8')
      if (raw.length > 2_500_000) return
      const saved = JSON.parse(raw)
      if (saved.schema !== 1) return
      if (typeof saved.automatic === 'boolean') automatic = saved.automatic
      if (typeof saved.lastCheckedAt === 'string' && Number.isFinite(Date.parse(saved.lastCheckedAt))) lastCheckedAt = saved.lastCheckedAt
      if (Number.isFinite(saved.nextCheckAt)) nextCheckAt = Math.min(saved.nextCheckAt, now() + CHECK_INTERVAL)
      if (Number.isFinite(saved.retryAfter)) retryAfter = Math.min(saved.retryAfter, now() + 24 * 60 * 60 * 1000)
      if (typeof saved.etag === 'string' && saved.etag.length < 300) etag = saved.etag
      if (Array.isArray(saved.releases)) { releases = saved.releases; manifest = saved.manifest; resolveStatus() }
      else { etag = null; nextCheckAt = 0; lastCheckedAt = null }
      if (saved.downloaded?.sha256 === manifest?.sha256 && status === 'available' && downloadRoot) {
        const path = join(downloadRoot, `${manifest.sha256}.dmg`)
        try {
          await verifyAsset(path, manifest)
          download = { version: latest.version, sizeBytes: manifest.sizeBytes, downloadedBytes: manifest.sizeBytes, path }
          status = 'ready'
        } catch { /* A missing or changed cache must be downloaded again. */ }
      }
      if (saved.status === 'error' && !download) {
        status = 'error'; error = '上次更新检查未完成，请重试或查看发布页'
      }
    } catch {
      // A damaged release cache cannot claim freshness or delay a fresh check.
      releases = null; etag = null; manifest = null; latest = null; nextCheckAt = 0; status = 'idle'
    }
  })()

  const request = async (url, { manifest = false, signal: providedSignal } = {}) => {
    const signal = providedSignal ?? AbortSignal.any([network.signal, AbortSignal.timeout(12000)])
    for (let count = 0; count < 5; count++) {
      const response = await fetcher(url, { redirect: 'manual', signal, headers: {
        Accept: manifest ? 'application/json' : 'application/vnd.github+json', 'User-Agent': 'ASTaria-Update-Check',
        ...(!manifest && etag && releases ? { 'If-None-Match': etag } : {}),
      } })
      if (manifest && [301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new Error('Missing redirect')
        const target = new URL(location, url)
        if (target.protocol !== 'https:' || target.username || target.password || target.port
          || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) throw new Error('Invalid redirect')
        url = target.href; continue
      }
      if ([403, 429].includes(response.status)) {
        const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000
        const retry = Number(response.headers.get('retry-after')) * 1000
        retryAfter = Math.min(now() + 24 * 60 * 60 * 1000, Math.max(now() + 15 * 60 * 1000, reset || 0, now() + (retry || 0)))
        await response.body?.cancel()
        throw new Error('GitHub 暂时限制了检查频率，请稍后重试，或直接查看发布页')
      }
      return response
    }
    throw new Error('Too many redirects')
  }

  const check = async ({ force = false } = {}) => {
    await ready
    if (closed || !allowNetwork || (!force && !automatic)) return snapshot()
    if (downloadPending || installPending || download?.path) return snapshot()
    if (pending) return pending
    if (now() < retryAfter || (force ? now() - lastAttempt < MANUAL_INTERVAL : now() < nextCheckAt)) return snapshot()
    lastAttempt = now(); status = 'checking'; error = null
    pending = (async () => {
      try {
        const response = await request(RELEASE_API)
        if (response.status !== 304) {
          if (!response.ok) {
            await response.body?.cancel()
            throw new Error('GitHub 暂时无法连接，请稍后重试，或直接查看发布页')
          }
          const data = await limitedJson(response, 2_000_000)
          if (!Array.isArray(data)) throw new Error('Invalid releases')
          releases = data; etag = response.headers.get('etag')
        }
        if (!releases) throw new Error('No cached releases')
        const candidate = selectRelease(releases, current)
        manifest = null
        if (candidate?.downloadUrl && candidate?.manifestUrl) {
          const metadata = await request(candidate.manifestUrl, { manifest: true })
          if (!metadata.ok) {
            await metadata.body?.cancel()
            throw new Error('暂时无法核对安装包信息，请稍后重试')
          }
          manifest = await limitedJson(metadata, 128_000)
        }
        resolveStatus()
        lastCheckedAt = new Date(now()).toISOString()
        nextCheckAt = now() + CHECK_INTERVAL
      } catch (reason) {
        status = 'error'
        error = reason instanceof Error && /[\u3400-\u9fff]/u.test(reason.message)
          ? reason.message : '暂时无法完成更新检查，请稍后重试，或直接查看发布页'
        nextCheckAt = Math.max(now() + MANUAL_INTERVAL, retryAfter)
      }
      try { await persist() } catch { /* Checks can still work without a writable cache. */ }
      return snapshot()
    })().finally(() => { pending = null })
    return pending
  }
  const downloadUpdate = async () => {
    await ready
    if (closed || !allowNetwork || downloadPending || installPending || download?.path) return snapshot()
    if (pending) await pending
    if (closed || downloadPending || installPending || download?.path) return snapshot()
    if (!latest?.downloadUrl || !manifest || !downloadRoot) throw new Error('请先检查到可用更新')
    const build = validateManifest(manifest, latest, current, trustedKeys)
    if (compareVersions(latest.version, current.version) <= 0 && !isNewBuild(build, current)) throw new Error('当前没有可安装的新版本')
    const candidate = structuredClone(latest), metadata = structuredClone(manifest)
    status = 'downloading'; error = null
    download = { version: candidate.version, sizeBytes: metadata.sizeBytes, downloadedBytes: 0 }
    const controller = new AbortController()
    downloadController = controller
    downloadPending = (async () => {
      try {
        const path = await downloadVerifiedAsset({ url: candidate.downloadUrl, manifest: metadata, directory: downloadRoot,
          fetcher, signal: AbortSignal.any([network.signal, controller.signal]),
          onProgress: downloadedBytes => { download = { ...download, downloadedBytes } },
        })
        download = { ...download, path }
        status = 'ready'
      } catch (reason) {
        download = null
        status = controller.signal.aborted ? 'available' : 'error'
        error = controller.signal.aborted ? null : reason instanceof Error && /[\u3400-\u9fff]/u.test(reason.message)
          ? reason.message : '更新下载未完成，请稍后重试'
      } finally {
        downloadController = null
        try { await persist() } catch { /* Memory still retains the verified download. */ }
      }
    })().finally(() => { downloadPending = null })
    return snapshot()
  }
  const cancelDownload = async () => {
    downloadController?.abort()
    if (downloadPending) await downloadPending
    return snapshot()
  }
  const installUpdate = async () => {
    await ready
    if (closed || downloadPending || installPending) return snapshot()
    if (!download?.path || !installer) throw new Error('请先下载适合此设备的更新')
    status = 'installing'; error = null
    const candidate = { path: download.path, version: download.version, manifest: structuredClone(manifest) }
    installPending = (async () => {
      let bytesVerified = false
      try {
        // Recheck the cached bytes immediately before mounting, even after a restart.
        validateManifest(candidate.manifest, latest, current, trustedKeys)
        await verifyAsset(candidate.path, candidate.manifest)
        bytesVerified = true
        await installer(candidate)
      } catch (reason) {
        if (!bytesVerified) download = null
        status = bytesVerified ? 'ready' : 'error'
        error = reason instanceof Error && /[\u3400-\u9fff]/u.test(reason.message) ? reason.message : '更新安装未完成，原版本已保留，请重试或手动安装'
        try { await persist() } catch { /* The next startup still authenticates all cached bytes. */ }
      }
    })().finally(() => { installPending = null })
    return snapshot()
  }

  return {
    ready,
    getStatus: async () => { await ready; return snapshot() }, whenIdle: () => Promise.all([pending, downloadPending, installPending]), check, download: downloadUpdate, cancelDownload, install: installUpdate,
    setAutomatic: async enabled => {
      await ready
      if (typeof enabled !== 'boolean') throw new Error('自动检查选项无效')
      const before = automatic; automatic = enabled
      try { await persist() } catch { automatic = before; throw new Error('更新偏好暂时无法保存，请重试') }
      return snapshot()
    },
    close: () => { closed = true; network.abort(); downloadController?.abort() },
  }
}

export async function handleUpdateRequest(updates, req, res) {
  if (!req.url?.startsWith('/api/desktop/updates')) return false
  const send = (code, value) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(value))
  }
  try {
    if (req.method === 'GET' && req.url === '/api/desktop/updates') send(200, await updates.getStatus())
    else if (req.method === 'POST' && ['/api/desktop/updates/check', '/api/desktop/updates/automatic', '/api/desktop/updates/download', '/api/desktop/updates/cancel', '/api/desktop/updates/install'].includes(req.url)) {
      if (req.headers['x-astaria-local'] !== '1') { send(403, { error: 'Forbidden' }); return true }
      let size = 0; const chunks = []
      for await (const chunk of req) { size += chunk.length; if (size > 1024) { send(413, { error: '请求过大' }); return true }; chunks.push(chunk) }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
      const value = req.url.endsWith('/check') ? await updates.check({ force: body?.automatic !== true })
        : req.url.endsWith('/automatic') ? await updates.setAutomatic(body?.enabled)
          : req.url.endsWith('/download') ? await updates.download()
            : req.url.endsWith('/cancel') ? await updates.cancelDownload()
              : await updates.install()
      send(200, value)
    } else send(405, { error: 'Method not allowed' })
  } catch (reason) { send(400, { error: reason instanceof Error && /[\u3400-\u9fff]/u.test(reason.message) ? reason.message : '更新操作暂未完成，请重试' }) }
  return true
}
