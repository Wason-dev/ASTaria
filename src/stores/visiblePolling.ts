import { observePageActivity, pageIsVisible } from './pageActivity.ts'

/** Keep the foreground refresh cadence, with no polling timer while hidden. */
export function startVisiblePolling(refresh: () => void, milliseconds: number, immediate = true) {
  let timer: number | undefined
  const stop = () => { clearInterval(timer); timer = undefined }
  const resume = () => {
    stop()
    if (!pageIsVisible()) return
    refresh()
    timer = window.setInterval(refresh, milliseconds)
  }
  const unobserve = observePageActivity(resume)
  if (immediate) resume()
  else if (pageIsVisible()) timer = window.setInterval(refresh, milliseconds)
  return () => { stop(); unobserve() }
}
