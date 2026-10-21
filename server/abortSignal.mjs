/** AbortSignal compatibility for older Android System WebView versions. */
export function abortSignalTimeout(milliseconds) {
  const duration = Math.max(0, Number.isFinite(milliseconds) ? milliseconds : 0)
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(duration)
  const controller = new AbortController()
  const timer = setTimeout(() => abort(controller, new DOMException('The operation timed out', 'TimeoutError')), duration)
  timer?.unref?.()
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

export function abortSignalAny(signals) {
  const active = signals.filter(Boolean)
  if (active.length === 0) return new AbortController().signal
  if (active.length === 1) return active[0]
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(active)
  const controller = new AbortController()
  const alreadyAborted = active.find(signal => signal.aborted)
  if (alreadyAborted) { abort(controller, alreadyAborted.reason); return controller.signal }
  const onAbort = event => {
    for (const signal of active) signal.removeEventListener('abort', onAbort)
    abort(controller, event.target?.reason)
  }
  for (const signal of active) {
    signal.addEventListener('abort', onAbort, { once: true })
  }
  return controller.signal
}

function abort(controller, reason) {
  try { controller.abort(reason) } catch { controller.abort() }
}
