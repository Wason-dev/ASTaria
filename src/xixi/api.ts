import type { ChatResult, ChatStreamEvent } from './types'
import { isChatResult, readChatStream } from './stream'

export class LocalApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'LocalApiError' }
}

export async function localApi<T>(path: string, body?: unknown): Promise<T> {
  const url = path.startsWith('/api/') ? path : `/api/${path.replace(/^\//, '')}`
  let response: Response
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-ASTaria-Local': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    })
  } catch { throw new Error('本机服务暂时无法连接，请确认 ASTaria 正在运行') }
  if (!response.headers.get('Content-Type')?.includes('application/json')) throw new Error('请重新启动 ASTaria 本机服务后再试')
  const result = await response.json()
  if (!response.ok) throw new LocalApiError(typeof result.error === 'string' ? result.error : '操作暂时未完成，请重试', response.status)
  return result as T
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
