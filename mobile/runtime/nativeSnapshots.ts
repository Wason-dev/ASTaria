import { Directory, Filesystem } from '@capacitor/filesystem'
// @ts-expect-error The shared wire validator is covered by bridge contract tests.
import { validateSnapshotBase64 } from './snapshotCodec.mjs'

const DATA_FILE = 'astaria-v1.sqlite'
// crypto.randomUUID() emits lowercase UUID v4 names. Match the whole basename,
// including rejecting a trailing newline (which a bare regexp $ would allow).
const TEMP_FILE = /^astaria-v1\.sqlite\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.next$/u
let startupCleanup: Promise<void> | undefined

function cleanOrphanSnapshots(): Promise<void> {
  // One barrier per runtime, shared by every adapter. Even a save before the
  // first load waits for cleanup; later loads cannot sweep an active writer.
  return startupCleanup ??= (async () => {
    const { files } = await Filesystem.readdir({ directory: Directory.Data, path: '' })
    for (const file of files) {
      if (file.type !== 'file' || TEMP_FILE.exec(file.name)?.[0] !== file.name) continue
      await Filesystem.deleteFile({ directory: Directory.Data, path: file.name }).catch(() => {})
    }
  })().catch(() => {
    // Cleanup is best-effort. Directory/permission failures must not prevent
    // reading the main snapshot; any orphan can be retried on the next launch.
  })
}

// Capacitor Data is the private app directory. Rename publishes a fully
// written SQLite snapshot; a failed write never receives a success reply.
// Native rename and interruption behavior remain a real-device acceptance
// item, separate from browser IndexedDB tests.
export function nativeSnapshots() {
  return {
    async load(): Promise<string | undefined> {
      await cleanOrphanSnapshots()
      try {
        const file = await Filesystem.readFile({ directory: Directory.Data, path: DATA_FILE })
        if (typeof file.data !== 'string') throw new Error('本机数据读取格式不正确')
        return validateSnapshotBase64(file.data)
      } catch (error) {
        const code = (error as { code?: string }).code
        if (code === 'OS-PLUG-FILE-0008') return undefined
        throw new Error('本机数据无法读取，原文件已保留；请先检查文件权限或恢复备份')
      }
    },
    async save(base64: string) {
      validateSnapshotBase64(base64)
      await cleanOrphanSnapshots()
      const temporary = `${DATA_FILE}.${crypto.randomUUID()}.next`
      try {
        await Filesystem.writeFile({ directory: Directory.Data, path: temporary, data: base64 })
        const check = await Filesystem.readFile({ directory: Directory.Data, path: temporary })
        if (check.data !== base64) throw new Error('本机数据校验未通过')
        await Filesystem.rename({ directory: Directory.Data, from: temporary, to: DATA_FILE })
      } catch {
        throw new Error('本机数据未能保存，原文件已保留；请检查可用空间再重试')
      } finally {
        await Filesystem.deleteFile({ directory: Directory.Data, path: temporary }).catch(() => {})
      }
    },
  }
}
