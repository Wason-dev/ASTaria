/** Electron net.fetch rejects manual redirects instead of exposing the 30x.
 * The updater must inspect every redirect before contacting its destination.
 * net.request retains system proxy support while allowing that validation. */
function createNetFetch(net) {
  return (url, { headers = {}, signal, method = 'GET' } = {}) => new Promise((resolve, reject) => {
    if (method !== 'GET') { reject(new Error('Updater transport only supports GET')); return }
    if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return }
    const request = net.request({ url: String(url), method, redirect: 'manual', credentials: 'omit', useSessionCookies: false })
    let delivered = false, ended = false, controller, incoming
    const cleanup = () => signal?.removeEventListener('abort', abort)
    const fail = reason => {
      if (ended) return
      ended = true; cleanup()
      if (delivered) controller?.error(reason)
      else reject(reason)
    }
    const abort = () => { fail(signal.reason ?? new DOMException('Aborted', 'AbortError')); request.abort() }
    const responseHeaders = values => {
      const result = new Headers()
      for (const [name, value] of Object.entries(values)) for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined) result.append(name, String(item))
      }
      return result
    }
    signal?.addEventListener('abort', abort, { once: true })
    request.on('error', fail)
    request.on('redirect', (statusCode, _method, destination, values) => {
      if (ended) return
      try {
        const resultHeaders = responseHeaders(values)
        resultHeaders.set('location', destination)
        const result = new Response(null, { status: statusCode, headers: resultHeaders })
        ended = true; delivered = true; cleanup(); resolve(result)
      } catch (reason) { fail(reason) }
      // Never follow here. The updater checks the destination allowlist first.
      request.abort()
    })
    request.on('response', response => {
      if (ended) return
      incoming = response
      try {
        const noBody = [204, 205, 304].includes(response.statusCode)
        const body = noBody ? null : new ReadableStream({
          start(value) { controller = value },
          pull() { incoming.resume?.() },
          cancel() { ended = true; cleanup(); request.abort() },
        })
        incoming.on('data', chunk => {
          if (ended || noBody) return
          controller.enqueue(chunk)
          if (controller.desiredSize <= 0) incoming.pause?.()
        })
        incoming.on('end', () => { if (!ended) { ended = true; cleanup(); controller?.close() } })
        incoming.on('error', fail)
        incoming.on('aborted', () => fail(new Error('Update response interrupted')))
        const result = new Response(body, { status: response.statusCode, headers: responseHeaders(response.headers) })
        delivered = true; resolve(result)
      } catch (reason) { fail(reason); request.abort() }
    })
    try {
      for (const [name, value] of new Headers(headers)) request.setHeader(name, value)
      request.end()
    } catch (reason) { fail(reason); request.abort() }
  })
}

module.exports = { createNetFetch }
