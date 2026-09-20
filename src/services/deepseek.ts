import type { ApiSettings } from '../stores/settingsStore'
import { localApi } from '../xixi/api'

export async function testDeepSeekConnection(settings: ApiSettings): Promise<void> {
  if (settings.apiKey.trim()) throw new Error('先将密钥保存到本机钥匙串，再测试连接')
  await localApi('/settings/test', {})
}
