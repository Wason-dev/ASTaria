import type { ChatResult, ChatStreamDraft, ChatStreamEvent, SavedReasoning } from './types'

const interrupted = () => new Error('回复连接已中断，正在核对已保存的内容，可用原消息重试')

export function isChatResult(value: unknown): value is ChatResult {
  if (!value || typeof value !== 'object') return false
  const result = value as Record<string, unknown>
  return typeof result.requestId === 'string' && typeof result.conversationId === 'string'
    && (result.status === 'completed' || result.status === 'failed')
    && Array.isArray(result.messages) && Array.isArray(result.operations)
}

function parseEvent(data: string): ChatStreamEvent | null {
  let value: Record<string, unknown>
  try { value = JSON.parse(data) } catch { throw interrupted() }
  if (!value || typeof value !== 'object') throw interrupted()
  if (value.type === 'result') {
    if (!isChatResult(value.result)) throw interrupted()
    return { type: 'result', result: value.result }
  }
  if (value.type === 'error' && typeof value.error === 'string') return { type: 'error', error: value.error }
  if (value.type === 'phase' && (value.phase === 'thinking' || value.phase === 'replying' || value.phase === 'executing')) return { type: 'phase', phase: value.phase }
  if (typeof value.round === 'number' && Number.isInteger(value.round) && value.round >= 0) {
    if (value.type === 'round') return { type: 'round', round: value.round }
    if ((value.type === 'reasoning' || value.type === 'content') && typeof value.delta === 'string') return { type: value.type, round: value.round, delta: value.delta }
  }
  // Unknown events (including tool payloads) never enter the presentation layer.
  return null
}

/** Previous attempts are durable context; a retry only appends new provider rounds. */
export function restoreChatReasoning(draft: ChatStreamDraft, saved: SavedReasoning): ChatStreamDraft {
  const reasoningRounds = saved.rounds?.length
    ? saved.rounds.map(item => ({ id: `saved:${item.id}`, content: item.content }))
    : saved.reasoningContent ? [{ id: 'saved:previous', content: saved.reasoningContent }] : []
  return { ...draft, reasoningContent: reasoningRounds.map(item => item.content).join('\n\n'), reasoningRounds }
}

/** Keep the provider's reasoning across tools; temporary prose is not a receipt. */
export function advanceChatStream(draft: ChatStreamDraft, event: ChatStreamEvent): ChatStreamDraft {
  if (event.type === 'phase') return { ...draft, phase: event.phase }
  if (event.type !== 'round' && event.type !== 'reasoning' && event.type !== 'content') return draft
  if (event.round < draft.round) return draft
  const next = event.round > draft.round
    ? { ...draft, round: event.round, content: '', phase: 'thinking' as const }
    : draft
  if (event.type === 'reasoning') {
    if (!event.delta) return next
    const id = `live:${event.round}`
    const previous = next.reasoningRounds ?? (next.reasoningContent ? [{ id: 'previous', content: next.reasoningContent }] : [])
    const exists = previous.some(item => item.id === id)
    const reasoningRounds = exists
      ? previous.map(item => item.id === id ? { ...item, content: item.content + event.delta } : item)
      : [...previous, { id, round: event.round, content: event.delta }]
    const reasoningContent = next.reasoningContent + (!exists && next.reasoningContent ? '\n\n' : '') + event.delta
    return { ...next, reasoningRounds, reasoningContent, phase: 'thinking' }
  }
  if (event.type === 'content') return { ...next, content: next.content + event.delta, phase: 'replying' }
  return next
}

/** Accept only a complete terminal event; EOF must never turn a draft into a reply. */
export async function readChatStream(body: ReadableStream<Uint8Array>, onEvent: (event: ChatStreamEvent) => void, signal?: AbortSignal): Promise<ChatResult> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const aborted = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', aborted, { once: true })
  try {
    while (true) {
      signal?.throwIfAborted()
      let chunk: ReadableStreamReadResult<Uint8Array>
      try { chunk = await reader.read() } catch {
        signal?.throwIfAborted()
        throw interrupted()
      }
      const { value, done } = chunk
      signal?.throwIfAborted()
      buffer += decoder.decode(value, { stream: !done })
      let separator: RegExpExecArray | null
      while ((separator = /\r\n\r\n|\r\n\n|\n\r\n|\n\n|\r\r/.exec(buffer))) {
        const frame = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator[0].length)
        const data = frame.split(/\r\n|\n|\r/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
        if (!data) continue
        const event = parseEvent(data)
        if (!event) continue
        if (event.type === 'error') throw new Error(event.error || '回复暂时没有完成，可用原消息重试')
        onEvent(event)
        if (event.type === 'result') return event.result
      }
      if (done) throw interrupted()
      // A missing event boundary must not retain an unbounded broken response.
      if (buffer.length > 4 * 1024 * 1024) throw interrupted()
    }
  } finally {
    signal?.removeEventListener('abort', aborted)
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
