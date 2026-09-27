import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { AnimationEvent, ReactNode } from 'react'

type Motion = { key: string; group: string; previous: ReactNode | null; direction: 'next' | 'previous'; revision: number }

/** Each change replaces the in-flight transition from its latest requested page. */
export function usePeriodMotion(key: string, group: string, frame: ReactNode, direction: number) {
  const [reduced, setReduced] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [motion, setMotion] = useState<Motion>({ key, group, previous: null, direction: 'next', revision: 0 })
  const committed = useRef({ key, group, frame })
  if (motion.key !== key || motion.group !== group) {
    setMotion({ key, group, previous: !reduced && committed.current.group === group ? committed.current.frame : null,
      direction: direction < 0 ? 'previous' : 'next', revision: motion.revision + 1 })
  }
  useLayoutEffect(() => { committed.current = { key, group, frame } })
  useEffect(() => {
    const media = matchMedia('(prefers-reduced-motion: reduce)')
    const changed = () => {
      setReduced(media.matches)
      if (media.matches) setMotion(current => ({ ...current, previous: null }))
    }
    media.addEventListener('change', changed)
    return () => media.removeEventListener('change', changed)
  }, [])
  useEffect(() => {
    if (!motion.previous) return
    // Also release the inert frame if animations are disabled or interrupted.
    const timer = setTimeout(() => setMotion(current => current.revision === motion.revision ? { ...current, previous: null } : current), 320)
    return () => clearTimeout(timer)
  }, [motion.previous, motion.revision])
  const finish = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    setMotion(current => current.revision === motion.revision ? { ...current, previous: null } : current)
  }
  return { ...motion, moving: Boolean(motion.previous), finish }
}
