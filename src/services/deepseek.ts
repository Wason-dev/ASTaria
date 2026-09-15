import type { ApiSettings } from '../stores/settingsStore'

export async function testDeepSeekConnection(settings: ApiSettings): Promise<void> {
  if (!settings.apiKey.trim()) throw new Error('请先填写 API Key')
  const response = await fetch(settings.endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey.trim()}` }, body: JSON.stringify({ model: settings.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8 }) })
  if (!response.ok) throw new Error(`连接失败（HTTP ${response.status}）`)
}
