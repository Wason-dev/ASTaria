import { Capacitor, registerPlugin } from '@capacitor/core'
import type { PluginListenerHandle } from '@capacitor/core'
import { attachIOSViewport } from './iosViewport.ts'

export const MOBILE_VIEWPORT_EVENT = 'astaria-mobile-viewport-change'

/** Native numbers use CSS px, relative to the WebView's unoccluded content box. */
export type NativeViewport = {
  layoutWidth: number
  layoutHeight: number
  visibleHeight: number
  keyboardInset: number
  keyboardVisible: boolean
  /** True only while native is publishing the system IME animation curve. */
  keyboardAnimating?: boolean
  /** Native sequence keeps delayed queries from replacing newer keyboard frames. */
  revision?: number
  /** Present when native owns edge-to-edge insets, independently of WebView CSS. */
  safeArea?: { top: number; right: number; bottom: number; left: number }
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
  keyboardAnimating?: boolean
  safeArea?: NativeViewport['safeArea']
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
  const safeArea = native?.safeArea && Object.values(native.safeArea).length === 4 &&
    ['top', 'right', 'bottom', 'left'].every(key => Number.isFinite(native.safeArea![key as keyof NonNullable<NativeViewport['safeArea']>]) &&
      native.safeArea![key as keyof NonNullable<NativeViewport['safeArea']>] >= 0) ? native.safeArea : undefined
  // A native animation frame and a resized/panned visualViewport may refer to
  // different IME frames. The edge-to-edge owner is authoritative in that case.
  const availableBottom = safeArea ? Math.min(layoutHeight, native!.visibleHeight) : Math.min(layoutHeight, bottom, native?.visibleHeight ?? layoutHeight)
  const offsetTop = safeArea ? 0 : Math.min(Math.max(0, layoutHeight - 1), top, Math.max(0, availableBottom - 1))
  const visibleHeight = Math.max(1, availableBottom - offsetTop)
  const keyboard = native ? (native.keyboardVisible ? 'open' : 'closed') : inferredKeyboard ? 'open' : 'closed'
  const keyboardInset = keyboard === 'open' ? Math.min(layoutHeight, native ? native.keyboardInset : Math.max(0, layoutHeight - bottom)) : 0
  return {
    // A native window often has a fractional CSS height (physical px / density).
    // Rounding down exposes the legacy document background as a 1px seam.
    layoutWidth: px(native?.layoutWidth ?? width), layoutHeight: safeArea ? Math.ceil(layoutHeight) : px(layoutHeight),
    visibleHeight: px(visibleHeight), offsetTop: px(offsetTop), keyboardInset: px(keyboardInset), keyboard,
    geometry, keyboardSession: safeArea ? keyboard === 'open' : keyboardSession || keyboard === 'open',
    ...(safeArea ? { safeArea } : {}),
  }
}

/** Android already supplies window-relative geometry. Consume it without
 * reading innerHeight/visualViewport after writing CSS in the previous frame. */
export function nativeAndroidViewport(value: NativeViewport | null): MobileViewportMetrics | null {
  const safe = value?.safeArea
  if (!value || !safe || ![value.layoutWidth, value.layoutHeight, value.visibleHeight].every(n => Number.isFinite(n) && n > 0)
    || !Number.isFinite(value.keyboardInset) || value.keyboardInset < 0
    || !['top', 'right', 'bottom', 'left'].every(edge => Number.isFinite(safe[edge as keyof typeof safe]) && safe[edge as keyof typeof safe] >= 0)) return null
  return { layoutWidth: px(value.layoutWidth), layoutHeight: Math.ceil(value.layoutHeight),
    visibleHeight: px(Math.max(1, Math.min(value.layoutHeight, value.visibleHeight))), offsetTop: 0,
    keyboardInset: value.keyboardVisible ? px(Math.min(value.layoutHeight, value.keyboardInset)) : 0,
    keyboard: value.keyboardVisible ? 'open' : 'closed', safeArea: safe,
    ...(typeof value.keyboardAnimating === 'boolean' ? { keyboardAnimating: value.keyboardAnimating } : {}),
  }
}

export interface MobileViewportBridge {
  getViewport(): Promise<NativeViewport>
  addListener(event: 'viewportChanged', listener: (viewport: NativeViewport) => void): Promise<PluginListenerHandle>
}

const appearance = registerPlugin<MobileViewportBridge>('ASTariaAppearance')
const attachments = new WeakMap<Document, () => void>()
const nativeBridge = () => Capacitor.isNativePlatform() && ['android', 'ios'].includes(Capacitor.getPlatform()) ? appearance : null

/** Bootstrap waits for the native baseline before mounting a possibly focused page. */
export async function initializeMobileViewport() {
  const bridge = nativeBridge()
  let initialNative: NativeViewport | null = null
  if (bridge) {
    try { initialNative = await bridge.getViewport() }
    catch { /* Older native packages still have the DOM fallback. */ }
  }
  if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' && bridge) {
    return attachIOSViewport(bridge, initialNative)
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

/** No root sizing, transforms or polling. Native safe areas have one owner. */
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
  let lastSampleRevision = native?.revision ?? -1
  const acceptNative = (value: NativeViewport) => {
    if (value.revision !== undefined) {
      if (!Number.isSafeInteger(value.revision) || value.revision < 0 || value.revision < lastSampleRevision) return false
      lastSampleRevision = value.revision
    }
    native = value
    return true
  }
  let nativeListener: PluginListenerHandle | undefined
  const listeners: Array<() => void> = []
  const listen = (subject: EventTarget, event: string, listener: EventListener) => {
    subject.addEventListener(event, listener)
    listeners.push(() => subject.removeEventListener(event, listener))
  }
  const update = () => {
    if (disposed) return
    let metrics = nativeAndroidViewport(native)
    if (!metrics) {
      state = calculateMobileViewport({
        innerWidth: target.innerWidth, innerHeight: target.innerHeight,
        screenWidth: target.screen?.width, screenHeight: target.screen?.height,
        orientation: target.screen?.orientation?.type ?? String((target as Window & { orientation?: number }).orientation ?? ''),
        focused: isEditing(document), visualViewport: viewport, native,
      }, state)
      const { layoutWidth, layoutHeight, visibleHeight, offsetTop, keyboardInset, keyboard } = state
      metrics = { layoutWidth, layoutHeight, visibleHeight, offsetTop, keyboardInset, keyboard,
        ...(state.safeArea ? { safeArea: state.safeArea } : {}) }
    }
    const { layoutHeight, visibleHeight, offsetTop, keyboardInset, keyboard } = metrics
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
    if (metrics.safeArea) for (const [edge, value] of Object.entries(metrics.safeArea)) {
      const name = `--safe-area-inset-${edge}`, text = `${px(value)}px`
      if (root.style.getPropertyValue(name) !== text) root.style.setProperty(name, text)
    }
    if (root.dataset.mobileKeyboard !== keyboard) root.dataset.mobileKeyboard = keyboard
    if (metrics.safeArea) root.dataset.mobileViewport = 'native-android'
    if (metrics.keyboardAnimating !== undefined) root.dataset.mobileKeyboardAnimation = metrics.keyboardAnimating ? 'running' : 'idle'
    document.dispatchEvent(new CustomEvent(MOBILE_VIEWPORT_EVENT, { detail: metrics, bubbles: true }))
  }
  const schedule = () => {
    if (!disposed && !frame) frame = target.requestAnimationFrame(() => { frame = 0; update() })
  }
  const refreshNative = () => {
    if (!bridge || disposed) return
    const revision = ++nativeRevision
    void bridge.getViewport().then(value => {
      if (!disposed && revision === nativeRevision && acceptNative(value)) {
        if (nativeAndroidViewport(value)) update()
        else schedule()
      }
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
      if (!disposed) {
        nativeRevision++
        if (!acceptNative(value)) return
        // This already is the system's current animation frame. A second RAF
        // would put the foreground an extra frame behind the keyboard.
        if (nativeAndroidViewport(value)) update()
        else schedule()
      }
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
