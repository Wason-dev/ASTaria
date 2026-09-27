// OpenAI-compatible SSE decoding. Tool arguments are accumulated privately and
// are never executable until both a finish reason and the stream terminator arrive.
export async function readCompletionStream(response, { maxBytes, onDelta }) {
  const reader = response.body.getReader(), decoder = new TextDecoder()
  const message = { role: 'assistant', content: '' }, calls = new Map()
  let pending = '', data = [], bytes = 0, ended = false, finishReason = null, usage
  let publishedContent = 0, protocolText = false
  const emitContent = () => {
    const content = message.content
    if (/(?:DSML|<\|(?:tool|function)|<｜(?:tool|function))/iu.test(content)) protocolText = true
    if (protocolText) return
    // Hold an unfinished markup prefix across chunks so textual tool protocols
    // cannot flash into the chat before the ordinary protocol validator runs.
    const lastOpen = content.lastIndexOf('<'), lastClose = content.lastIndexOf('>')
    const safeEnd = lastOpen > lastClose ? lastOpen : content.length
    if (safeEnd > publishedContent) {
      onDelta?.({ type: 'content', delta: content.slice(publishedContent, safeEnd) })
      publishedContent = safeEnd
    }
  }
  const event = () => {
    if (!data.length) return
    const raw = data.join('\n'); data = []
    if (raw === '[DONE]') { ended = true; return }
    if (ended) throw new Error('AFTER_STREAM_END')
    const chunk = JSON.parse(raw)
    if (chunk.error) throw new Error('UPSTREAM_STREAM_ERROR')
    if (chunk.usage) usage = chunk.usage
    const choice = chunk.choices?.find(item => item.index === 0 || item.index === undefined)
    if (!choice) return
    const delta = choice.delta ?? {}
    // A terminal reason closes this choice. In particular, a later chunk must
    // never upgrade a truncated `length` result into executable `tool_calls`.
    // Usage-only frames (with no choice) remain valid after termination.
    if (finishReason && (Object.keys(delta).length || choice.finish_reason)) throw new Error('AFTER_CHOICE_FINISH')
    if (typeof delta.reasoning_content === 'string') {
      message.reasoning_content = (message.reasoning_content ?? '') + delta.reasoning_content
      onDelta?.({ type: 'reasoning', delta: delta.reasoning_content })
    }
    if (typeof delta.content === 'string') { message.content += delta.content; emitContent() }
    for (const part of delta.tool_calls ?? []) {
      if (!Number.isInteger(part.index) || part.index < 0 || part.index > 63) throw new Error('INVALID_TOOL_INDEX')
      const call = calls.get(part.index) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
      if (part.id !== undefined && typeof part.id !== 'string') throw new Error('INVALID_TOOL_ID')
      if (part.function !== undefined && (!part.function || typeof part.function !== 'object' || Array.isArray(part.function))) throw new Error('INVALID_TOOL_FUNCTION')
      for (const key of ['name', 'arguments']) {
        if (part.function?.[key] !== undefined && typeof part.function[key] !== 'string') throw new Error('INVALID_TOOL_FUNCTION_FIELD')
      }
      if (part.id) call.id += part.id
      if (part.type !== undefined && part.type !== 'function') throw new Error('INVALID_TOOL_TYPE')
      if (part.function?.name) call.function.name += part.function.name
      if (part.function?.arguments) call.function.arguments += part.function.arguments
      calls.set(part.index, call)
    }
    if (choice.finish_reason) finishReason = choice.finish_reason
  }
  const line = value => {
    if (value === '') event()
    else if (value.startsWith('data:')) data.push(value.slice(5).replace(/^ /u, ''))
  }
  try {
    while (!ended) {
      const { value, done } = await reader.read()
      if (done) { pending += decoder.decode(); break }
      bytes += value.byteLength
      if (bytes > maxBytes) throw new Error('RESPONSE_LIMIT')
      pending += decoder.decode(value, { stream: true })
      let newline
      while ((newline = pending.indexOf('\n')) >= 0) {
        line(pending.slice(0, newline).replace(/\r$/u, ''))
        pending = pending.slice(newline + 1)
      }
    }
    if (pending) line(pending.replace(/\r$/u, ''))
    event()
    if (!ended || !finishReason) throw new Error('INCOMPLETE_STREAM')
    if (calls.size) message.tool_calls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)
    return { choices: [{ index: 0, message, finish_reason: finishReason }], ...(usage ? { usage } : {}) }
  } finally { await reader.cancel().catch(() => {}) }
}
