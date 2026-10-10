import { randomUUID } from 'node:crypto'
import { localEndpoint, DEFAULT_REASONING_EFFORT, REASONING_EFFORTS } from './modelSettings.mjs'
import { choice, knownKeys } from './validation.mjs'
import { readCompletionStream } from './completionStream.mjs'
const ENDPOINT = 'https://api.deepseek.com/chat/completions'
export const MODEL = 'deepseek-flash'
export const MODELS = [
  { id: 'deepseek-flash', label: 'DeepSeek Flash' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
]
export class ProviderError extends Error {}

async function readJSON(response, label, maxBytes = 512 * 1024) {
  try {
    const reader = response.body.getReader(), chunks = []
    let size = 0
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) { await reader.cancel(); throw new Error('RESPONSE_LIMIT') }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch { throw new ProviderError(`${label}返回了无法读取的回复，请重试`) }
}

export function createCompletion(keychain, fetcher = fetch, getModel = () => MODEL, getSettings) {
  return async (payload, { onDelta, signal, purpose } = {}) => {
    const settings = getSettings?.()
    const local = settings?.provider === 'local'
    const label = local ? '本地模型' : 'DeepSeek'
    const hasImages = payload.messages?.some(message => Array.isArray(message.content) && message.content.some(part => part?.type === 'image_url'))
    const model = local ? settings.local.model : getModel()
    if (!model || (!local && !MODELS.some(option => option.id === model))) throw new ProviderError('请在设置中选择有效模型')
    const endpoint = local ? `${localEndpoint(settings.local.baseUrl)}/chat/completions` : ENDPOINT
    const configuredEffort = settings?.reasoningEffort ?? DEFAULT_REASONING_EFFORT
    // Horizon grouping and ordering use light reasoning to keep the interaction responsive.
    // This request-local cap does not change the user's chat preference.
    const reasoningEffort = ['horizon-order', 'horizon-grouping'].includes(purpose) ? 'low' : configuredEffort
    if (!local && !REASONING_EFFORTS.includes(reasoningEffort)) throw new ProviderError('请在设置中选择有效的思考深度')
    const thinkingEnabled = !local && reasoningEffort !== 'off'
    // max_tokens includes reasoning. A short-answer budget of 1800 would cut
    // thinking off before it can emit the tools. Use the documented provider
    // default (64K / 128K for Max) for thinking, retain local/off budgets.
    const streaming = (settings?.streamResponses ?? true) && typeof onDelta === 'function'
    const body = { ...payload, model, stream: streaming }
    if (!local) {
      body.thinking = { type: thinkingEnabled ? 'enabled' : 'disabled' }
      body.reasoning_effort = thinkingEnabled ? reasoningEffort : 'none'
      if (thinkingEnabled) delete body.max_tokens
      body.messages = payload.messages.map(message => message.role === 'assistant'
        ? { ...message, ...(thinkingEnabled ? { reasoning_content: message.reasoning_content ?? '' } : {}) }
        : message)
    }
    const headers = { 'Content-Type': 'application/json' }
    if (!local) headers.Authorization = `Bearer ${await keychain.read()}`
    let response
    try {
      response = await fetcher(endpoint, {
        method: 'POST', redirect: 'error', signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(thinkingEnabled ? 300_000 : local ? 180_000 : 75_000)])
          : AbortSignal.timeout(thinkingEnabled ? 300_000 : local ? 180_000 : 75_000),
        headers,
        // DeepSeek's OpenAI-compatible API exposes both the thinking toggle and
        // effort control. Keep these fields off local providers because Ollama
        // and LM Studio use different controls. `low` is the app default.
        body: JSON.stringify(body),
      })
    } catch { throw new ProviderError(local ? '无法连接本地模型，请确认服务已启动、模型已加载；对话已保留，可以重试' : '连接 DeepSeek 暂时失败，对话已保留，可以重试') }
    if (!response.ok) {
      await response.body?.cancel()
      throw new ProviderError(hasImages
        ? `${label}未接受图片请求，请确认当前模型支持视觉输入后再试`
        : local ? '本地模型未接受请求，请检查模型名称、上下文容量和工具调用支持' : response.status === 401 ? 'API Key 未通过验证，请在设置中重新录入' : response.status === 429 ? 'DeepSeek 暂时限流或额度不足，请稍后重试' : 'DeepSeek 暂时无法回复，请稍后重试')
    }
    // Bound upstream data, never reflecting provider response bodies into errors.
    const maxBytes = thinkingEnabled ? 4 * 1024 * 1024 : 512 * 1024
    let result
    if (streaming && response.headers.get('content-type')?.includes('text/event-stream')) {
      try { result = await readCompletionStream(response, { maxBytes, onDelta }) }
      catch { throw new ProviderError(`${label}的流式回复中断，未执行其中不完整的工具调用；已保存进度保留，可以重试`) }
    } else result = await readJSON(response, label, maxBytes)
    if (!result?.choices?.[0]?.message) throw new ProviderError(`${label}暂未返回完整回复，请重试`)
    if (['length', 'aborted', 'insufficient_system_resource', 'content_filter'].includes(result.choices[0].finish_reason)) {
      throw new ProviderError(`${label}的这一轮输出未完成，未执行其中不完整的工具调用；已保存的进度保留，可以重试`)
    }
    return result
  }
}

export async function discoverLocalModels(input, fetcher = fetch) {
  knownKeys(input, ['engine', 'baseUrl'])
  choice(input.engine, ['ollama', 'lmstudio', 'openai'], '本地服务')
  const endpoint = localEndpoint(input.baseUrl)
  let response
  try { response = await fetcher(`${endpoint}/models`, { redirect: 'error', signal: AbortSignal.timeout(10_000) }) }
  catch { throw new ProviderError('未连接到本地服务，请先启动 Ollama、LM Studio 或本机兼容服务') }
  if (!response.ok) { await response.body?.cancel(); throw new ProviderError('无法读取模型列表，可手动填写已加载的模型名称') }
  const result = await readJSON(response, '本地服务')
  if (!Array.isArray(result.data)) throw new ProviderError('模型列表格式不兼容，可手动填写模型名称')
  const ids = [...new Set(result.data.map(item => item?.id).filter(id => typeof id === 'string' && id.length > 0 && id.length <= 200 && !/[\x00-\x1f\x7f]/u.test(id)))].slice(0, 200)
  return { models: ids.map(id => ({ id, label: id })) }
}

export async function testLocalCompletion(complete) {
  const token = randomUUID()
  const messages = [{ role: 'user', content: `Call astaria_connection_check with token "${token}". After its result reply exactly OK.` }]
  const tools = [{ type: 'function', function: { name: 'astaria_connection_check', description: 'Connection check only; no user data or side effects.', parameters: { type: 'object', properties: { token: { type: 'string' } }, required: ['token'], additionalProperties: false } } }]
  const result = await complete({ messages, tools, tool_choice: 'auto', max_tokens: 512 })
  const message = result.choices[0].message, calls = message.tool_calls
  const unsupported = { ok: true, toolCalling: false, message: '模型可以回复，但未通过工具调用往返测试；暂不建议用于修改任务和日程，请更换支持工具调用的指令模型或检查服务配置。' }
  if (!Array.isArray(calls) || calls.length !== 1 || typeof calls[0].id !== 'string' || calls[0].function?.name !== 'astaria_connection_check') return unsupported
  try { if (JSON.parse(calls[0].function.arguments).token !== token) return unsupported } catch { return unsupported }
  const follow = await complete({ messages: [...messages, message, { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ ok: true }) }], tools, max_tokens: 128 })
  if (follow.choices[0].message.tool_calls?.length || follow.choices[0].message.content?.trim() !== 'OK') return unsupported
  return { ok: true, toolCalling: true, message: '连接与工具调用往返测试通过。复杂排程能力仍取决于模型，操作后可以查看实际回执。' }
}
