import type { MobileViewportBridge, NativeViewport } from './viewport'

/** iOS window coordinates come only from UIKit, never visualViewport panning. */
export function normalizeIOSViewport(value: NativeViewport) {
  const safe = value.safeArea
  if (!safe || ![value.layoutWidth, value.layoutHeight].every(n => Number.isFinite(n) && n > 0)
    || !Number.isFinite(value.keyboardInset) || value.keyboardInset < 0
    || !['top', 'right', 'bottom', 'left'].every(edge => Number.isFinite(safe[edge as keyof typeof safe]) && safe[edge as keyof typeof safe] >= 0)) return null
  const inset = value.keyboardVisible ? Math.min(value.layoutHeight, value.keyboardInset) : 0
  return { layoutWidth: Math.round(value.layoutWidth), layoutHeight: Math.ceil(value.layoutHeight),
    visibleHeight: Math.max(1, Math.round(value.layoutHeight - inset)), offsetTop: 0,
    keyboardInset: Math.round(inset), keyboard: inset > 0 ? 'open' : 'closed', safeArea: safe } as const
}

export function attachIOSViewport(bridge: MobileViewportBridge, initial: NativeViewport | null,
  target: Window = window, document: Document = target.document) {
  const root = document.documentElement
  let disposed = false, lastRevision = -1, signature = ''
  let handle: { remove(): Promise<void> } | undefined
  const publish = (value: NativeViewport) => {
    if (disposed) return
    const revision = value.revision ?? 0
    if (!Number.isFinite(revision) || revision < 0) return
    if (revision < lastRevision) return
    const metrics = normalizeIOSViewport(value)
    if (!metrics) return
    lastRevision = revision
    const next = JSON.stringify(metrics)
    if (next === signature) return
    signature = next
    for (const [name, value] of Object.entries({
      '--m-layout-height': metrics.layoutHeight, '--m-visible-height': metrics.visibleHeight,
      '--m-keyboard-inset': metrics.keyboardInset, '--m-visible-offset-top': 0,
      '--mobile-viewport-height': metrics.visibleHeight,
      ...Object.fromEntries(Object.entries(metrics.safeArea).map(([edge, n]) => [`--safe-area-inset-${edge}`, n])),
    })) {
      const text = `${value}px`
      if (root.style.getPropertyValue(name) !== text) root.style.setProperty(name, text)
    }
    root.dataset.mobileKeyboard = metrics.keyboard
    root.dataset.mobileViewport = 'native-ios'
    document.dispatchEvent(new CustomEvent('astaria-mobile-viewport-change', { detail: metrics, bubbles: true }))
  }
  const refresh = () => { if (!disposed) void bridge.getViewport().then(publish).catch(() => {}) }
  // Subscribe first; revisions prevent the older initial/query result winning.
  void bridge.addListener('viewportChanged', publish).then(listener => {
    if (disposed) void listener.remove().catch(() => {})
    else { handle = listener; refresh() }
  }).catch(refresh)
  if (initial) publish(initial)
  target.addEventListener('pageshow', refresh)
  const visible = () => { if (!document.hidden) refresh() }
  document.addEventListener('visibilitychange', visible)
  return () => {
    disposed = true
    void handle?.remove().catch(() => {})
    target.removeEventListener('pageshow', refresh)
    document.removeEventListener('visibilitychange', visible)
  }
}
