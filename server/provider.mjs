const ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const MODEL = 'deepseek-flash'
export const MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
]
export class ProviderError extends Error {}

export function createCompletion(keychain, fetcher = fetch, getModel = () => MODEL) {
  return async payload => {
    const model = getModel()
    if (!MODELS.some(option => option.id === model)) throw new ProviderError('请在设置中选择有效模型')
    const key = await keychain.read()
    let response
    try {
      response = await fetcher(ENDPOINT, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(75_000),
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ ...payload, model, thinking: { type: 'disabled' }, stream: false }),
      })
    } catch { throw new ProviderError('连接 DeepSeek 暂时失败，对话已保留，可以重试') }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ProviderError(response.status === 401 ? 'API Key 未通过验证，请在设置中重新录入' : response.status === 429 ? 'DeepSeek 暂时限流或额度不足，请稍后重试' : 'DeepSeek 暂时无法回复，请稍后重试')
    }
    // Bound upstream data, never reflecting provider response bodies into errors.
    let result
    try {
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.length
        if (size > 512 * 1024) { await reader.cancel(); throw new Error('RESPONSE_LIMIT') }
        chunks.push(value)
      }
      result = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch { throw new ProviderError('DeepSeek 返回了无法读取的回复，请重试') }
    if (!result?.choices?.[0]?.message) throw new ProviderError('DeepSeek 暂未返回完整回复，请重试')
    return result
  }
}
