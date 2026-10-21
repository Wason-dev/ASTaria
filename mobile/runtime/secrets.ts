import { Capacitor, registerPlugin } from '@capacitor/core'

interface SecretsStatus { configured: boolean }
interface SecretsReadResult { key: string | null }
interface SecretsWriteOptions { key: string; userInitiated: true }
interface SecretsRemoveOptions { userInitiated: true }

export interface SecretsVault {
  status(): Promise<boolean>
  read(): Promise<string>
  /** Call only from the user's explicit Save action. */
  write(key: string): Promise<void>
  /** Call only from the user's explicit Delete action. */
  remove(): Promise<void>
}

interface NativeSecretsPlugin {
  status(): Promise<SecretsStatus>
  read(): Promise<SecretsReadResult>
  write(options: SecretsWriteOptions): Promise<void>
  remove(options: SecretsRemoveOptions): Promise<void>
}

// No web implementation: previews never persist or cache a credential.
const secretsPlugin = registerPlugin<NativeSecretsPlugin>('ASTariaSecrets')

const safeMessages = {
  SECRETS_INVALID_INPUT: 'API Key 必须为 1–4096 个不含空格的可见 ASCII 字符。',
  SECRETS_USER_ACTION_REQUIRED: '请通过明确的保存或删除操作更改 API Key。',
  SECRETS_UNSUPPORTED: '网页预览不支持 API Key 安全存储，请使用原生手机应用。',
  SECRETS_NOT_CONFIGURED: '尚未保存 API Key，请通过保存操作进行配置。',
  SECRETS_UNAVAILABLE: '安全存储暂时不可用，请在原生手机应用中解锁设备后重试。',
  SECRETS_CORRUPT: '保存的 API Key 已损坏，请明确删除后重新保存。',
  SECRETS_KEY_LOST: '设备加密密钥不可用，请明确删除保存的 API Key 后重新保存。',
  SECRETS_WRITE_FAILED: '无法保存 API Key，请解锁设备后重试。',
  SECRETS_REMOVE_FAILED: '无法删除 API Key，请解锁设备后重试。',
} as const

export type SecretsErrorCode = keyof typeof safeMessages

export class SecretsError extends Error {
  readonly code: SecretsErrorCode

  constructor(code: SecretsErrorCode) {
    super(safeMessages[code])
    this.name = 'ASTariaSecretsError'
    this.code = code
  }
}

function safeError(error: unknown, fallback: SecretsErrorCode): SecretsError {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return new SecretsError(typeof code === 'string' && Object.hasOwn(safeMessages, code)
    ? code as SecretsErrorCode : fallback)
}

function requireNativePlugin(): void {
  if (!Capacitor.isNativePlatform()) throw new SecretsError('SECRETS_UNSUPPORTED')
  const platform = Capacitor.getPlatform()
  if ((platform !== 'ios' && platform !== 'android')
    || !Capacitor.isPluginAvailable('ASTariaSecrets')) {
    throw new SecretsError('SECRETS_UNAVAILABLE')
  }
}

function validKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= 4096 && /^[\x21-\x7e]+$/.test(key)
}

/** Wire mutations only to an explicit user Save/Delete action, never hydration or autosave. */
const vault: SecretsVault = {
  async status() {
    if (!Capacitor.isNativePlatform()) return false
    requireNativePlugin()
    try {
      const result = await secretsPlugin.status()
      if (!result || typeof result.configured !== 'boolean' || Object.keys(result).length !== 1) {
        throw new SecretsError('SECRETS_CORRUPT')
      }
      return result.configured
    } catch (error) { throw safeError(error, 'SECRETS_UNAVAILABLE') }
  },
  async read() {
    requireNativePlugin()
    try {
      const result = await secretsPlugin.read()
      if (!result || (result.key !== null && !validKey(result.key)) || Object.keys(result).length !== 1) {
        throw new SecretsError('SECRETS_CORRUPT')
      }
      if (result.key === null) throw new SecretsError('SECRETS_NOT_CONFIGURED')
      return result.key
    } catch (error) { throw safeError(error, 'SECRETS_UNAVAILABLE') }
  },
  async write(key) {
    requireNativePlugin()
    if (!validKey(key)) {
      throw new SecretsError('SECRETS_INVALID_INPUT')
    }
    try {
      await secretsPlugin.write({ key, userInitiated: true })
    } catch (error) { throw safeError(error, 'SECRETS_WRITE_FAILED') }
  },
  async remove() {
    requireNativePlugin()
    try {
      await secretsPlugin.remove({ userInitiated: true })
    } catch (error) { throw safeError(error, 'SECRETS_REMOVE_FAILED') }
  },
}

/** The fixed bootstrap contract; no key is cached by this factory or its vault. */
export function nativeSecrets(): SecretsVault {
  return vault
}
