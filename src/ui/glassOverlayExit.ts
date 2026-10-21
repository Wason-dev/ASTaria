/** Fade only this popup's layers. The source page is never masked, hidden or
 * switched to a different filter; its own glass remains visible throughout. */
export function glassOverlayExit(element: HTMLDialogElement, done: () => void, duration = 200) {
  const media = matchMedia('(prefers-reduced-motion: reduce)')
  const reduced = media.matches || element.dataset.reducedMotion === 'true'
  let current = true
  if (reduced) { done(); return () => {} }
  const style = getComputedStyle(element)
  const options: KeyframeAnimationOptions = { duration, easing: 'cubic-bezier(.16,.8,.25,1)', fill: 'both' }
  const clock = element.animate([
    { borderColor: style.borderColor, boxShadow: style.boxShadow },
    { borderColor: 'transparent', boxShadow: 'none' },
  ], options)
  const paint = [...element.querySelectorAll<HTMLElement>('.home-glass-backdrop,.home-glass-surface,.floating-glass-outline')]
  const content = [...element.children].filter((child): child is HTMLElement => child instanceof HTMLElement
    && !child.matches('.home-glass-measure,.floating-glass-outline'))
  const animations = [clock,
    ...paint.map(layer => {
      const current = getComputedStyle(layer)
      return layer.animate([{ opacity: current.opacity, backgroundColor: current.backgroundColor }, { opacity: 0, backgroundColor: current.backgroundColor }], options)
    }),
    ...content.map(layer => {
      const current = getComputedStyle(layer)
      return layer.animate([{ opacity: current.opacity, transform: current.transform }, { opacity: 0, transform: 'translateY(-5px)' }], options)
    }),
  ]
  const finish = () => {
    if (!current) return
    done()
  }
  void clock.finished.then(finish, () => {})
  const reduce = () => { if (media.matches) animations.forEach(animation => animation.finish()) }
  media.addEventListener('change', reduce)
  return () => {
    current = false; media.removeEventListener('change', reduce)
    animations.forEach(animation => animation.cancel())
  }
}
