import { Directory, Filesystem } from '@capacitor/filesystem'
// @ts-expect-error The shared wire validator is covered by bridge contract tests.
import { validateSnapshotBase64 } from './snapshotCodec.mjs'

const DATA_FILE = 'astaria-v1.sqlite'

// Capacitor Data is the private app directory. Rename publishes a fully
// written SQLite snapshot; a failed write never receives a success reply.
// Native rename and interruption behavior remain a real-device acceptance
// item, separate from browser IndexedDB tests.
export function nativeSnapshots() {
  return {
    async load(): Promise<string | undefined> {
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
