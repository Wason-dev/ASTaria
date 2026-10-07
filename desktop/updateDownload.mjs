import { createHash, randomUUID } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_PACKAGE = 2 * 1024 ** 3
const HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

export function validateAsset(manifest) {
  if (!Number.isSafeInteger(manifest?.sizeBytes) || manifest.sizeBytes <= 0 || manifest.sizeBytes > MAX_PACKAGE
    || !/^[a-f0-9]{64}$/u.test(manifest.sha256 ?? '')) throw new Error('安装包清单无效')
}

export async function verifyAsset(path, manifest) {
  validateAsset(manifest)
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size !== manifest.sizeBytes) throw new Error('安装包大小校验失败，请重新下载')
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  if (hash.digest('hex') !== manifest.sha256) throw new Error('安装包校验失败，请重新下载')
}

/** Stream to an owned temporary file; incomplete or mismatched bytes never become an install candidate. */
export async function downloadVerifiedAsset({ url, manifest, directory, fetcher = fetch, signal, onProgress = () => {} }) {
  validateAsset(manifest)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const directoryInfo = await lstat(directory)
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('更新目录不可用')
  const temporary = join(directory, `${randomUUID()}.part`), destination = join(directory, `${manifest.sha256}.${manifest.platform === 'win32' ? 'exe' : 'dmg'}`)
  const stall = new AbortController()
  let timer, file
  const wake = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), 30_000); timer.unref?.() }
  const abort = AbortSignal.any([signal ?? new AbortController().signal, stall.signal, AbortSignal.timeout(30 * 60_000)])
  try {
    wake()
    let response
    for (let count = 0; count < 5; count++) {
      const target = new URL(url)
      if (target.protocol !== 'https:' || target.username || target.password || target.port || !HOSTS.has(target.hostname)) throw new Error('安装包地址无效')
      response = await fetcher(target.href, { redirect: 'manual', signal: abort, headers: { Accept: 'application/octet-stream', 'User-Agent': 'ASTaria-Updater' } })
      if (![301, 302, 303, 307, 308].includes(response.status)) break
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (!location || count === 4) throw new Error('安装包重定向无效')
      url = new URL(location, target).href
      wake()
    }
    if (!response?.ok || !response.body) { await response?.body?.cancel(); throw new Error('暂时无法下载安装包，请稍后重试') }
    const declared = response.headers.get('content-length')
    if (declared !== null && Number(declared) !== manifest.sizeBytes) { await response.body.cancel(); throw new Error('安装包大小校验失败') }
    file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const hash = createHash('sha256')
    let total = 0
    for await (const chunk of response.body) {
      abort.throwIfAborted(); wake()
      total += chunk.byteLength
      if (total > manifest.sizeBytes) throw new Error('安装包体积超过清单')
      hash.update(chunk)
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
        if (!bytesWritten) throw new Error('更新文件暂时无法写入')
        offset += bytesWritten
      }
      onProgress(total, manifest.sizeBytes)
    }
    abort.throwIfAborted()
    if (total !== manifest.sizeBytes || hash.digest('hex') !== manifest.sha256) throw new Error('安装包校验失败，请重新下载')
    await file.sync(); await file.close(); file = null
    await rename(temporary, destination)
    return destination
  } finally {
    clearTimeout(timer)
    await file?.close().catch(() => {})
    await rm(temporary, { force: true }).catch(() => {})
  }
}
