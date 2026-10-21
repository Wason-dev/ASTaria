import { object, ValidationError } from '../../server/validation.mjs'
import { localRequestLimit } from '../../src/xixi/requestLimits.ts'
import { abortSignalAny } from '../../server/abortSignal.mjs'
import { coalesceMobileReads } from './readRequests.mjs'

// Response.json() is newer than the Response constructor on Android WebView.
function jsonResponse(value, init = {}) {
  const headers = new Headers(init.headers)
  if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json; charset=utf-8')
  return new Response(JSON.stringify(value), { ...init, headers })
}

/** Intercept only this app's local API. Provider/asset requests keep their
 * original fetch implementation; credentials cannot become a remote API URL. */
export function mobileTransport({ origin, request, fallback }) {
  const execute = coalesceMobileReads(request)
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), origin)
    if (url.origin !== new URL(origin).origin || !url.pathname.startsWith('/api/')) return fallback(input, init)
    const req = new Request(url, init ?? (input instanceof Request ? input : undefined))
    if (!['GET', 'POST'].includes(req.method)) return jsonResponse({ error: '请求方式不支持' }, { status: 405 })
    if (req.headers.get('X-ASTaria-Local') !== '1') return jsonResponse({ error: '请从 ASTaria 页面访问' }, { status: 403 })
    let body
    if (req.method === 'POST') {
      if (!/^application\/json(?:\s*;|$)/iu.test(req.headers.get('Content-Type') ?? '')) return jsonResponse({ error: '请发送 JSON 数据' }, { status: 415 })
      const raw = await req.text(), limit = localRequestLimit(url.pathname)
      if (new TextEncoder().encode(raw).byteLength > limit.bytes) return jsonResponse({ error: limit.message }, { status: 413 })
      try { body = object(JSON.parse(raw || '{}')) } catch { return jsonResponse({ error: 'JSON 内容无法读取' }, { status: 400 }) }
    }
    const path = url.pathname + url.search, headers = Object.fromEntries(req.headers)
    if (req.headers.get('Accept')?.includes('text/event-stream')) {
      const encoder = new TextEncoder()
      const cancelled = new AbortController()
      const signal = abortSignalAny([req.signal, cancelled.signal])
      let closed = false
      const stream = new ReadableStream({
        start(controller) {
          const send = event => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)) }
          execute(path, body, { headers, signal, onEvent: send }).then(result => send({ type: 'result', result }), error => {
            if (closed) return
            if (signal.aborted) { closed = true; controller.error(signal.reason); return }
            send({ type: 'error', error: error.message, status: error.status ?? 503 })
          }).finally(() => { if (!closed) { closed = true; controller.close() } })
        },
        cancel(reason) { closed = true; cancelled.abort(reason ?? new DOMException('已取消', 'AbortError')) },
      })
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store' } })
    }
    try { return jsonResponse(await execute(path, body, { headers, signal: req.signal }), { headers: { 'Cache-Control': 'no-store' } }) }
    catch (error) {
      if (req.signal.aborted) throw req.signal.reason
      return jsonResponse({ error: error instanceof ValidationError ? error.message : error.message ?? '本机操作未完成' }, { status: error.status ?? 503 })
    }
  }
}
