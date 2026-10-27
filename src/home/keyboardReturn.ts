type Box = { top: number; height: number }
type Axis = { value: number; velocity: number }

/** Critically damped: a short soft landing without overshoot or a timer reset. */
export function settleKeyboardAxis(state: Axis, target: number, seconds: number): Axis {
  const omega = 28, time = Math.min(.064, Math.max(0, seconds))
  const distance = state.value - target, decay = Math.exp(-omega * time)
  const c = state.velocity + omega * distance
  const value = target + (distance + c * time) * decay
  if ((target - state.value) * (target - value) < 0) return { value: target, velocity: 0 }
  return { value, velocity: (state.velocity - omega * c * time) * decay }
}

/** Native geometry stays exact; only the home panel's return is eased. */
export function attachKeyboardReturn(surface: HTMLElement, workspace: HTMLElement,
  onGeometry?: (width: number, height: number, radius: number) => void) {
  const doc = surface.ownerDocument, win = doc.defaultView!
  let frame = 0, lastTime = 0, previousVisible = 0, geometry = ''
  let followingAndroidCurve = false
  let top: Axis | undefined, height: Axis | undefined, target: Box | undefined
  const clear = () => {
    win.cancelAnimationFrame(frame); frame = 0
    surface.style.removeProperty('--home-keyboard-top')
    surface.style.removeProperty('--home-keyboard-height')
    top = height = target = undefined
    followingAndroidCurve = false
  }
  const paint = () => {
    for (const [key, value] of [['--home-keyboard-top', top!.value], ['--home-keyboard-height', height!.value]] as const) {
      const text = `${Math.round(value * 1000) / 1000}px`
      if (surface.style.getPropertyValue(key) !== text) surface.style.setProperty(key, text)
    }
    // Exact numeric dimensions already exist; CSS-only glass needs no updates.
    onGeometry?.(parseFloat(surface.style.width), height!.value, parseFloat(surface.style.borderRadius))
  }
  const motion = win.matchMedia('(prefers-reduced-motion: reduce)')
  const reduced = () => workspace.dataset.motion === 'reduced' || motion.matches
  const active = () => ['native-ios', 'native-android'].includes(doc.documentElement.dataset.mobileViewport ?? '')
    && workspace.dataset.page === 'home' && workspace.dataset.chatOpen === 'true'
    && Number(surface.style.getPropertyValue('--home-chat-progress')) >= .99 && !doc.hidden
  const step = (time: number) => {
    frame = 0
    if (!active() || reduced() || !top || !height || !target) { clear(); return }
    const dt = (time - lastTime) / 1000; lastTime = time
    top = settleKeyboardAxis(top, target.top, dt)
    height = settleKeyboardAxis(height, target.height, dt)
    // Available space is authoritative, even during a reversed IME gesture.
    height.value = Math.min(height.value, previousVisible - top.value - 12)
    if (Math.abs(top.value - target.top) < .1 && Math.abs(height.value - target.height) < .1) {
      top = { value: target.top, velocity: 0 }; height = { value: target.height, velocity: 0 }
      paint(); return
    }
    paint(); frame = win.requestAnimationFrame(step)
  }
  const update = () => {
    if (!active()) { clear(); return }
    // React/camera owns these inline endpoints. Reading computed style or
    // clientWidth here would synchronously flush layout on every IME frame.
    const root = doc.documentElement.style, style = surface.style
    const visible = parseFloat(root.getPropertyValue('--m-visible-height')) - parseFloat(root.getPropertyValue('--safe-area-inset-top') || '0')
    const endTop = parseFloat(style.getPropertyValue('--home-chat-end-top'))
    const endHeight = parseFloat(style.getPropertyValue('--home-chat-end-height'))
    const minTop = endTop
    if (![visible, endTop, endHeight, minTop].every(Number.isFinite)) { clear(); return }
    const nextTop = Math.max(minTop, Math.min(endTop, visible - endHeight - 12))
    target = { top: nextTop, height: Math.max(0, Math.min(endHeight, visible - nextTop - 12)) }
    const nextGeometry = `${style.width}:${root.getPropertyValue('--m-layout-height')}:${endTop}:${endHeight}`
    const androidAnimating = doc.documentElement.dataset.mobileViewport === 'native-android'
      && doc.documentElement.dataset.mobileKeyboardAnimation === 'running'
    // Android onProgress is already eased by the keyboard. A second spring
    // makes the panel visibly trail it; follow the final onEnd sample too.
    const nativeCurve = androidAnimating || followingAndroidCurve
    followingAndroidCurve = androidAnimating
    const restore = !nativeCurve && top && height && nextGeometry === geometry && visible >= previousVisible && !reduced()
    previousVisible = visible; geometry = nextGeometry
    if (!restore) {
      win.cancelAnimationFrame(frame); frame = 0
      top = { value: target.top, velocity: 0 }; height = { value: target.height, velocity: 0 }
      paint(); return
    }
    if (!frame) { lastTime = win.performance.now(); frame = win.requestAnimationFrame(step) }
  }
  doc.addEventListener('astaria-mobile-viewport-change', update)
  doc.addEventListener('visibilitychange', update)
  motion.addEventListener?.('change', update)
  // Closing the chat or navigating away cancels the return in the same turn.
  let endpoints = ''
  const observer = new MutationObserver(() => {
    // A Stage Manager resize changes React's endpoints after the native event.
    // Observe only those inputs, never restart for our own animated variables.
    const next = [surface.style.width, surface.style.getPropertyValue('--home-chat-end-top'),
      surface.style.getPropertyValue('--home-chat-end-height'), Number(surface.dataset.progress) >= .99,
      workspace.dataset.chatOpen, workspace.dataset.page, workspace.dataset.motion].join('|')
    if (next === endpoints) return
    endpoints = next
    update()
  })
  observer.observe(workspace, { attributes: true, attributeFilter: ['data-chat-open', 'data-page', 'data-motion'] })
  observer.observe(surface, { attributes: true, attributeFilter: ['style', 'data-progress'] })
  update()
  return () => { clear(); observer.disconnect(); motion.removeEventListener?.('change', update); doc.removeEventListener('astaria-mobile-viewport-change', update); doc.removeEventListener('visibilitychange', update) }
}
