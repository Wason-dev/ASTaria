import { mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Only called in Electron's main process after app.whenReady(). No plaintext fallback. */
export function createSecretStore({ safeStorage, directory, platform = process.platform }) {
  const available = () => ['darwin', 'win32'].includes(platform) && safeStorage.isEncryptionAvailable()
  const pathFor = name => {
    if (!['api-key', 'sync-key'].includes(name)) throw new Error('凭据名称无效')
    if (!available()) throw new Error('系统凭据存储不可用，请解锁当前用户后重试')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (lstatSync(directory).isSymbolicLink()) throw new Error('凭据目录不能是符号链接')
    return join(directory, `${name}.sealed`)
  }
  const read = name => {
    const file = pathFor(name)
    try {
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16384) throw new Error('凭据文件无效')
      return safeStorage.decryptString(readFileSync(file))
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('系统凭据无法解密，请在这台设备重新导入') }
  }
  const write = (name, value) => {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('凭据格式无效')
    const file = pathFor(name), temp = `${file}.${randomBytes(8).toString('hex')}.tmp`
    try {
      writeFileSync(temp, safeStorage.encryptString(value), { mode: 0o600, flag: 'wx' })
      renameSync(temp, file)
    } finally { try { unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }
  const remove = name => { try { unlinkSync(pathFor(name)) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  return { available, read, write, remove,
    apiVault: {
      prepare: async () => { pathFor('api-key') }, status: async () => Boolean(read('api-key')),
      read: async () => read('api-key'), remove: async () => remove('api-key'),
      save: async value => { if (typeof value !== 'string' || !/^[\x21-\x7e]{8,512}$/u.test(value.trim())) throw new Error('请输入有效的 API Key'); write('api-key', value.trim()) },
    },
  }
}
