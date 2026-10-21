import type { OrbitDay } from './orbitGroups'

type ContentAnimation = { finished: Promise<unknown>; cancel: () => void }
type ContentAnimator = (frames: Keyframe[], options: KeyframeAnimationOptions) => ContentAnimation

/** Owns only the content animation; the caller commits one live day synchronously. */
export function createHorizonEditorTransition(initialDay: OrbitDay) {
  let day = initialDay
  let active: ContentAnimation | null = null
  const cancel = () => {
    const previous = active
    active = null
    previous?.cancel()
  }
  const update = (nextDay: OrbitDay, reduced: boolean, animate?: ContentAnimator) => {
    const previousDay = day
    day = nextDay
    if (previousDay === nextDay && !reduced) return
    cancel()
    if (reduced || !animate || previousDay === nextDay) return
    try {
      // Keep the new day's data readable and interactive throughout the switch.
      const animation = animate([
        { opacity: .72, transform: `translateX(${nextDay > previousDay ? 10 : -10}px)` },
        { opacity: 1, transform: 'translateX(0px)' },
      ], { duration: 300, easing: 'cubic-bezier(.22,.68,0,1)', fill: 'none' })
      active = animation
      const release = () => {
        // A canceled animation may settle after a newer one has already started.
        if (active !== animation) return
        active = null
        animation.cancel()
      }
      void animation.finished.then(release, release)
    } catch {
      // Unsupported/disabled WAAPI must leave the committed content usable.
    }
  }
  return { update, cancel }
}
