// AppKit owns traffic lights in fullscreen. Poll only while the windowed
// controls can actually be used; keep their existing 50 ms hover response.
function watchWindowButtons(window, screen, timers = globalThis) {
  let visible
  let poll
  let hideTimer
  let disposed = false
  let nativeFullscreen = window.isFullScreen()
  let htmlFullscreen = false
  const fullscreen = () => nativeFullscreen || htmlFullscreen || window.isFullScreen()
  const usable = () => !disposed && !window.isDestroyed() && window.isVisible() && !window.isMinimized() && !fullscreen()
  const setVisible = value => {
    if (disposed || window.isDestroyed() || visible === value) return
    visible = value
    window.setWindowButtonVisibility(value)
  }
  const cancelHide = () => { timers.clearTimeout(hideTimer); hideTimer = undefined }
  const stop = () => {
    timers.clearInterval(poll)
    poll = undefined
    cancelHide()
  }
  const overButtons = () => {
    if (!usable()) return false
    const bounds = window.getBounds(), pointer = screen.getCursorScreenPoint()
    return pointer.x >= bounds.x && pointer.x <= bounds.x + 92
      && pointer.y >= bounds.y && pointer.y <= bounds.y + 42
  }
  const track = () => {
    if (!usable()) { stop(); return }
    if (overButtons()) {
      cancelHide()
      setVisible(true)
    } else if (visible && hideTimer === undefined) {
      hideTimer = timers.setTimeout(() => {
        hideTimer = undefined
        if (usable() && !overButtons()) setVisible(false)
      }, 220)
    }
  }
  const sync = () => {
    if (!usable()) { stop(); return }
    if (poll === undefined) poll = timers.setInterval(track, 50)
  }
  const enter = html => {
    if (html) htmlFullscreen = true
    else nativeFullscreen = true
    stop()
    setVisible(true)
  }
  const leave = html => {
    if (html) htmlFullscreen = false
    else nativeFullscreen = false
    stop()
    setVisible(fullscreen())
    sync()
  }
  const handlers = {
    show: sync, restore: sync, hide: stop, minimize: stop,
    'enter-full-screen': () => enter(false),
    'leave-full-screen': () => leave(false),
    'enter-html-full-screen': () => enter(true),
    'leave-html-full-screen': () => leave(true),
    closed: () => dispose(),
  }
  const dispose = () => {
    stop()
    disposed = true
    for (const [event, handler] of Object.entries(handlers)) window.removeListener(event, handler)
  }
  for (const [event, handler] of Object.entries(handlers)) window.on(event, handler)
  setVisible(fullscreen())
  sync()
  return { dispose, isVisible: () => visible }
}

module.exports = { watchWindowButtons }
