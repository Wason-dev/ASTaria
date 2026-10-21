/** Native WebViews can report app background before document.visibilityState
 * changes. Neither a blurred desktop window nor a visible split view is hidden. */
export const PAGE_ACTIVITY_EVENT = 'astaria-app-activity'
export const pageIsHidden = () => document.hidden || document.documentElement?.dataset?.mobileActive === 'false'
export const pageIsVisible = () => document.visibilityState === 'visible' && !pageIsHidden()
export function observePageActivity(callback: () => void) {
  document.addEventListener('visibilitychange', callback)
  document.addEventListener(PAGE_ACTIVITY_EVENT, callback)
  return () => { document.removeEventListener('visibilitychange', callback); document.removeEventListener(PAGE_ACTIVITY_EVENT, callback) }
}
