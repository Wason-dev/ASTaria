import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type { FilesystemPlugin } from '@capacitor/filesystem'
import type { SharePlugin } from '@capacitor/share'
import { BACKUP_MAX_BYTES, BACKUP_EXPORT_TOO_LARGE, backupByteLength, serializeBackup } from '../../src/xixi/backupLimits.ts'

const CACHE = 'astaria-backup-share-v1'
const MAX_AGE = 24 * 60 * 60 * 1000
type Dependencies = {
  platform?: Pick<typeof Capacitor, 'isNativePlatform' | 'getPlatform' | 'isPluginAvailable'>
  filesystem?: Pick<FilesystemPlugin, 'mkdir' | 'writeFile' | 'readFile' | 'getUri' | 'readdir' | 'deleteFile'>
  share?: Pick<SharePlugin, 'canShare' | 'share'>
  now?: () => number
  uuid?: () => string
}
const activeFiles = new Set<string>()

function checkedJSON(value: unknown) {
  const json = serializeBackup(value)
  if (backupByteLength(json) > BACKUP_MAX_BYTES) throw new Error(BACKUP_EXPORT_TOO_LARGE)
  // /data/export excludes the credential store. Reject accidental credential
  // envelopes as a second boundary; do not rewrite tables or their checksum.
  const credential = /^(?:api[-_]?key|deepseek[-_]?api[-_]?key|authorization|access[-_]?token|refresh[-_]?token|secret[-_]?key)$/iu
  JSON.parse(json, (key, item: unknown) => {
    if (credential.test(key) || (key === 'key' && typeof item === 'string' && credential.test(item))) {
      throw new Error('备份含有凭据字段，未打开分享；请重新导出不含 API Key 的备份')
    }
    return item
  })
  return json
}

/** Private Cache only; resolves after the user's share sheet returns, not proof of an external save. */
export async function exportMobileBackup(value: unknown, name: string, dependencies: Dependencies = {}): Promise<void> {
  const platform = dependencies.platform ?? Capacitor, fs = dependencies.filesystem ?? Filesystem
  const share = dependencies.share ?? Share, now = dependencies.now ?? Date.now
  if (!platform.isNativePlatform() || !['ios', 'android'].includes(platform.getPlatform())) {
    throw new Error('浏览器预览不支持手机备份分享，请使用 iOS 或 Android App')
  }
  if (!platform.isPluginAvailable('Filesystem') || !platform.isPluginAvailable('Share') || !(await share.canShare()).value) {
    throw new Error('系统分享暂不可用，请重新打开或安装当前 App')
  }
  const json = checkedJSON(value)
  if (!/^[\p{L}\p{N} _().-]{1,120}\.json$/u.test(name) || name.includes('..')) throw new Error('备份文件名无效')
  const token = (dependencies.uuid ?? (() => crypto.randomUUID()))()
  if (!/^[a-zA-Z0-9-]{1,64}$/u.test(token)) throw new Error('备份临时文件名无效')
  const path = `${CACHE}/${name.slice(0, -5)}-${now()}-${token}.json`
  let shared = false
  activeFiles.add(path)
  try {
    // mkdir may reject when the folder already exists. Confirm it is readable
    // rather than treating a permission/storage failure as an existing folder.
    try { await fs.mkdir({ directory: Directory.Cache, path: CACHE, recursive: true }) }
    catch { await fs.readdir({ directory: Directory.Cache, path: CACHE }) }
    const previous = await fs.readdir({ directory: Directory.Cache, path: CACHE })
    for (const file of previous.files) {
      const old = `${CACHE}/${file.name}`
      if (file.type === 'file' && /^[\p{L}\p{N} _().-]+-\d{13}-[a-zA-Z0-9-]{1,64}\.json$/u.test(file.name)
        && !file.name.includes('..') && !activeFiles.has(old) && Number.isFinite(file.mtime) && file.mtime < now() - MAX_AGE) {
        await fs.deleteFile({ directory: Directory.Cache, path: old })
      }
    }
    await fs.writeFile({ directory: Directory.Cache, path, data: json, encoding: Encoding.UTF8 })
    const written = await fs.readFile({ directory: Directory.Cache, path, encoding: Encoding.UTF8 })
    if (written.data !== json) throw new Error('备份临时文件未能完整写入，请重试')
    const { uri } = await fs.getUri({ directory: Directory.Cache, path })
    if (!uri.startsWith('file://')) throw new Error('备份临时文件无法分享，请重试')
    await share.share({ title: 'ASTaria 备份', dialogTitle: '保存或分享 ASTaria 备份', files: [uri] })
    shared = true
  } catch (reason) {
    if (reason instanceof Error && /cancel(?:led|ed)?/iu.test(reason.message)) throw new Error('已取消备份分享；尚未确认保存')
    if (reason instanceof Error && /[\u3400-\u9fff]/u.test(reason.message)) throw reason
    throw new Error('备份未能完成分享，请检查可用空间与系统分享设置后重试')
  } finally {
    activeFiles.delete(path)
    if (!shared) await fs.deleteFile({ directory: Directory.Cache, path }).catch(() => {})
    // A receiving app may still be reading a successful share URI. Leave it in
    // private Cache for the bounded cleanup on the next export, never in Data.
    // Android can resolve with an empty activityType; that is not a save receipt.
  }
}

// The settings entry uses this name; retain the adapter API requested by the host.
export { exportMobileBackup as shareMobileBackup }
