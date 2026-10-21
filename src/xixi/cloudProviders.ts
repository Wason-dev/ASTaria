export const CLOUD_PRESETS = [
  { id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1' },
  { id: 'dashscope', label: '通义千问 · 百炼', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { id: 'siliconflow', label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: '' },
  { id: 'zhipu', label: '智谱', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: '' },
  { id: 'custom', label: '自定义 · OpenAI 兼容', baseUrl: '', model: '' },
] as const
export type CompatibleConnection = { preset: (typeof CLOUD_PRESETS)[number]['id']; baseUrl: string; model: string }

/** A cloud URL is explicit configuration, never a key or a local-model URL. */
export function compatibleEndpoint(value: string) {
  if (typeof value !== 'string' || value.length > 300 || /[\s\x00-\x1f\x7f?#]/u.test(value)) throw new Error('请输入有效的 HTTPS API 地址，不含参数或片段')
  let url: URL
  try { url = new URL(value) } catch { throw new Error('API 地址格式不正确') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(url.hostname) || !url.hostname.includes('.')
    || /^(?:\d+\.){3}\d+$/u.test(url.hostname) || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/iu.test(url.hostname)
    || /\/chat\/completions\/?$/u.test(url.pathname) || !/^\/[A-Za-z0-9_./-]*$/u.test(url.pathname)) {
    throw new Error('请填写公开 HTTPS 服务的基础地址，不含密钥、参数或 chat/completions；本地模型请用本地连接')
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`
}
