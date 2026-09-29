/** Keep the foreground refresh cadence, with no polling timer while hidden. */
export function startVisiblePolling(refresh: () => void, milliseconds: number, immediate = true) {
  let timer: ReturnType<typeof window.setInterval> | undefined
  const stop = () => { clearInterval(timer); timer = undefined }
  const resume = () => {
    stop()
    if (document.visibilityState !== 'visible') return
    refresh()
    timer = window.setInterval(refresh, milliseconds)
  }
  document.addEventListener('visibilitychange', resume)
  if (immediate) resume()
  else if (document.visibilityState === 'visible') timer = window.setInterval(refresh, milliseconds)
  return () => { stop(); document.removeEventListener('visibilitychange', resume) }
}
