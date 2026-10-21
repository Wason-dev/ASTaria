import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'

export const MOBILE_VIEWPORT_EVENT = 'astaria-mobile-viewport-change'

/** Native numbers use CSS px, relative to the WebView's unoccluded content box. */
export type NativeViewport = {
  layoutWidth: number
  layoutHeight: number
  visibleHeight: number
  keyboardInset: number
  keyboardVisible: boolean
}

export type MobileViewportInput = {
  innerWidth: number
  innerHeight: number
  screenWidth?: number
  screenHeight?: number
  orientation?: string
  focused?: boolean
  visualViewport?: { height: number; offsetTop?: number; scale?: number } | null
  native?: NativeViewport | null
}

export type MobileViewportMetrics = {
  layoutWidth: number
  layoutHeight: number
  /** Actual visible extent; its top is offsetTop in layout coordinates. */
  visibleHeight: number
  offsetTop: number
  /** Bottom occlusion only: iOS viewport panning is not part of the IME. */
  keyboardInset: number
  keyboard: 'open' | 'closed'
}

export type MobileViewportState = MobileViewportMetrics & {
  geometry: string
  keyboardSession: boolean
}

const positive = (value: number | undefined, fallback: number) => Number.isFinite(value) && value! > 0 ? value! : fallback
const nonnegative = (value: number | undefined) => Number.isFinite(value) ? Math.max(0, value!) : 0
const px = (value: number) => Math.round(value)

/** Pure reducer. Keep one previous state per attachment, never per page. */
export function calculateMobileViewport(input: MobileViewportInput, previous?: MobileViewportState): MobileViewportState {
  const width = Math.max(1, positive(input.innerWidth, previous?.layoutWidth ?? 1))
  const height = Math.max(1, positive(input.innerHeight, previous?.layoutHeight ?? 1))
  const geometry = [px(width), input.orientation ?? '', px(nonnegative(input.screenWidth)), px(nonnegative(input.screenHeight))].join(':')
  const sameGeometry = previous?.geometry === geometry
  const visual = input.visualViewport
  // Pinch zoom changes the visual viewport without opening a keyboard.
  const unzoomed = Math.abs(positive(visual?.scale, 1) - 1) < 0.02
  const top = Math.min(height - 1, nonnegative(visual?.offsetTop))
  const visualHeight = positive(visual?.height, height)
  const bottom = Math.min(height, top + visualHeight)
  // A queued native event from the previous orientation must not seed this one.
  const native = input.native && Math.abs(input.native.layoutWidth - width) <= 2 &&
    Number.isFinite(input.native.layoutHeight) && input.native.layoutHeight >= 1 &&
    Number.isFinite(input.native.visibleHeight) && input.native.visibleHeight >= 1 &&
    Number.isFinite(input.native.keyboardInset) && input.native.keyboardInset >= 0 ? input.native : null

  const baseline = sameGeometry ? previous.layoutHeight : height
  const loss = Math.max(0, baseline - bottom)
  const threshold = sameGeometry && previous.keyboard === 'open' ? 48 : 120
  const visualLoss = height - bottom
  const inferredKeyboard = unzoomed && loss > threshold && Boolean(input.focused ||
    (sameGeometry && previous.keyboardSession) || visualLoss > threshold)
  // Lock even the early/late, sub-threshold animation frames while editing.
  // The latch survives blur and clears only after the viewport has recovered.
  const keyboardSession = Boolean(sameGeometry && bottom < baseline - 1 &&
    (previous.keyboardSession || (unzoomed && (input.focused || inferredKeyboard))))
  const layoutHeight = native?.layoutHeight ?? (keyboardSession ? Math.max(baseline, height) : height)
  const availableBottom = Math.min(layoutHeight, bottom, native?.visibleHeight ?? layoutHeight)
  const offsetTop = Math.min(Math.max(0, layoutHeight - 1), top, Math.max(0, availableBottom - 1))
  const visibleHeight = Math.max(1, availableBottom - offsetTop)
  const keyboard = native ? (native.keyboardVisible ? 'open' : 'closed') : inferredKeyboard ? 'open' : 'closed'
  const keyboardInset = keyboard === 'open' ? Math.min(layoutHeight, native ? native.keyboardInset : Math.max(0, layoutHeight - bottom)) : 0
  return {
    layoutWidth: px(native?.layoutWidth ?? width), layoutHeight: px(layoutHeight),
    visibleHeight: px(visibleHeight), offsetTop: px(offsetTop), keyboardInset: px(keyboardInset), keyboard,
    geometry, keyboardSession: keyboardSession || keyboard === 'open',
  }
}

export interface MobileViewportBridge {
  getViewport(): Promise<NativeViewport>
  addListener(event: 'viewportChanged', listener: (viewport: NativeViewport) => void): Promise<PluginListenerHandle>
}

const appearance = registerPlugin<MobileViewportBridge>('ASTariaAppearance')
const attachments = new WeakMap<Document, () => void>()
const nativeBridge = () => Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' ? appearance : null

/** Bootstrap waits for the native baseline before mounting a possibly focused page. */
export async function initializeMobileViewport() {
  const bridge = nativeBridge()
  let initialNative: NativeViewport | null = null
  if (bridge) {
    try { initialNative = await bridge.getViewport() }
    catch { /* Older native packages still have the DOM fallback. */ }
  }
  return attachMobileViewport({ nativeBridge: bridge, initialNative })
}

function isEditing(document: Document) {
  const element = document.activeElement
  if (!(element instanceof HTMLElement)) return false
  if (element.isContentEditable) return true
  if (element instanceof HTMLTextAreaElement) return !element.readOnly && !element.disabled
  return element instanceof HTMLInputElement && !element.readOnly && !element.disabled &&
    !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(element.type)
}

/** No root sizing, transforms, polling or safe-area writes. Returns an idempotent disposer. */
export function attachMobileViewport(options: {
  window?: Window
  document?: Document
  nativeBridge?: MobileViewportBridge | null
  initialNative?: NativeViewport | null
} = {}): () => void {
  const target = options.window ?? window
  const document = options.document ?? target.document
  attachments.get(document)?.()
  const root = document.documentElement
  const viewport = target.visualViewport
  const bridge = options.nativeBridge === undefined ? nativeBridge() : options.nativeBridge
  let state: MobileViewportState | undefined, published = ''
  let native = options.initialNative ?? null, nativeRevision = 0, frame = 0, disposed = false
  let nativeListener: PluginListenerHandle | undefined
  const listeners: Array<() => void> = []
  const listen = (subject: EventTarget, event: string, listener: EventListener) => {
    subject.addEventListener(event, listener)
    listeners.push(() => subject.removeEventListener(event, listener))
  }
  const update = () => {
    if (disposed) return
    state = calculateMobileViewport({
      innerWidth: target.innerWidth, innerHeight: target.innerHeight,
      screenWidth: target.screen?.width, screenHeight: target.screen?.height,
      orientation: target.screen?.orientation?.type ?? String((target as Window & { orientation?: number }).orientation ?? ''),
      focused: isEditing(document), visualViewport: viewport, native,
    }, state)
    const { layoutWidth, layoutHeight, visibleHeight, offsetTop, keyboardInset, keyboard } = state
    const metrics: MobileViewportMetrics = { layoutWidth, layoutHeight, visibleHeight, offsetTop, keyboardInset, keyboard }
    const signature = JSON.stringify(metrics)
    if (signature === published) return
    published = signature
    for (const [name, value] of Object.entries({
      '--m-layout-height': layoutHeight, '--m-visible-height': visibleHeight,
      '--m-keyboard-inset': keyboardInset, '--m-visible-offset-top': offsetTop,
      '--mobile-viewport-height': visibleHeight,
    })) {
      const text = `${value}px`
      if (root.style.getPropertyValue(name) !== text) root.style.setProperty(name, text)
    }
    if (root.dataset.mobileKeyboard !== keyboard) root.dataset.mobileKeyboard = keyboard
    document.dispatchEvent(new CustomEvent(MOBILE_VIEWPORT_EVENT, { detail: metrics, bubbles: true }))
  }
  const schedule = () => {
    if (!disposed && !frame) frame = target.requestAnimationFrame(() => { frame = 0; update() })
  }
  const refreshNative = () => {
    if (!bridge || disposed) return
    const revision = ++nativeRevision
    void bridge.getViewport().then(value => {
      if (!disposed && revision === nativeRevision) { native = value; schedule() }
    }).catch(() => { /* Older native packages use the DOM fallback. */ })
  }
  const restore = () => { refreshNative(); schedule() }
  listen(target, 'resize', schedule)
  listen(target, 'orientationchange', restore)
  listen(target, 'pageshow', restore)
  listen(target, 'focus', restore)
  listen(document, 'focusin', schedule)
  listen(document, 'focusout', schedule)
  listen(document, 'visibilitychange', () => { if (!document.hidden) restore() })
  if (viewport) { listen(viewport, 'resize', schedule); listen(viewport, 'scroll', schedule) }
  if (bridge) {
    // Subscribe before querying; a newer push must win over an older query reply.
    void bridge.addListener('viewportChanged', value => {
      if (!disposed) { nativeRevision++; native = value; schedule() }
    }).then(handle => {
      if (disposed) void handle.remove().catch(() => {})
      else { nativeListener = handle; refreshNative() }
    }).catch(refreshNative)
  }
  update()
  const detach = () => {
    if (disposed) return
    disposed = true
    if (frame) target.cancelAnimationFrame(frame)
    listeners.forEach(remove => remove())
    void nativeListener?.remove().catch(() => {})
    if (attachments.get(document) === detach) attachments.delete(document)
  }
  attachments.set(document, detach)
  return detach
}
