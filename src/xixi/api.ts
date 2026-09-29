import type { ChatResult, ChatStreamEvent } from './types'
import { isChatResult, readChatStream } from './stream'
import { validLocalResponse } from './localResponse'

export class LocalApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'LocalApiError' }
}

export async function localApi<T>(path: string, body?: unknown, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  const url = path.startsWith('/api/') ? path : `/api/${path.replace(/^\//, '')}`
  const controller = new AbortController()
  const cancel = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) cancel()
  else options.signal?.addEventListener('abort', cancel, { once: true })
  const timeoutMs = options.timeoutMs ?? (/\/companion\/route/.test(url) ? 180_000 : /\/settings\/.*test|\/data\/import/.test(url) ? 120_000 : 30_000)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
  try {
    const response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-ASTaria-Local': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('请重新启动 ASTaria 本机服务后再试')
    const result: unknown = await response.json()
    if (!response.ok) throw new LocalApiError(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : '操作暂时未完成，请重试', response.status)
    if (!validLocalResponse(url, result)) throw new Error('本机数据格式不完整，请重新读取；若仍失败，请更新或重启 ASTaria')
    return result as T
  } catch (reason) {
    if (options.signal?.aborted) throw options.signal.reason ?? reason
    if (timedOut) throw new Error(body === undefined ? '本机服务响应超时，请重新读取' : '操作响应超时，保存结果尚未确认，请先重新读取再继续')
    if (reason instanceof TypeError) throw new Error('本机服务暂时无法连接，请确认 ASTaria 正在运行')
    throw reason
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', cancel)
  }
}

export async function chatApi(body: unknown, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<ChatResult> {
  let response: Response
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'X-ASTaria-Local': '1', 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify(body), cache: 'no-store', signal,
    })
  } catch (reason) {
    if (signal?.aborted) throw reason
    throw new Error('本机服务暂时无法连接，请确认 ASTaria 正在运行')
  }
  const type = response.headers.get('Content-Type') ?? ''
  if (response.ok && type.includes('text/event-stream') && response.body) return readChatStream(response.body, onEvent, signal)
  if (!type.includes('application/json')) throw new Error('请重新启动 ASTaria 本机服务后再试')
  const result: unknown = await response.json()
  if (!response.ok) throw new LocalApiError(result && typeof result === 'object' && 'error' in result && typeof result.error === 'string' ? result.error : '操作暂时未完成，请重试', response.status)
  if (!isChatResult(result)) throw new Error('回复尚未完整收到，可用原消息重试')
  return result
}
