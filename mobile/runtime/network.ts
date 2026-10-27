import { Capacitor, CapacitorHttp } from '@capacitor/core'

type NetworkInput = { url: string; method: string; headers?: Record<string, string>; body?: string }
const endpoints = new Set(['/chat/completions', '/v1/tools/search', '/v1/tools/fetch'])
export async function nativeRequest(input: NetworkInput): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const url = new URL(input.url)
  if (!Capacitor.isNativePlatform()) throw new Error('浏览器手机预览不连接云端模型，请在原生 App 中配置')
  if (url.username || url.password || url.origin !== 'https://api.deepseek.com' || !endpoints.has(url.pathname) || url.search || url.hash || input.method !== 'POST') {
    throw new Error('手机端只允许已配置的模型服务请求')
  }
  const response = await CapacitorHttp.request({ url: url.toString(), method: 'POST', headers: input.headers,
    data: input.body, disableRedirects: true, connectTimeout: 15_000, readTimeout: 300_000, responseType: 'text' })
  const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
  if (new TextEncoder().encode(body).byteLength > 4 * 1024 * 1024) throw new Error('模型回复内容过多，请重试')
  if (response.status >= 300 && response.status < 400) throw new Error('模型服务重定向被拒绝，请重试')
  return { status: response.status, body, headers: response.headers }
}
