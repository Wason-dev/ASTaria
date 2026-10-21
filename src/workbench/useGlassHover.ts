import { useEffect, useRef } from 'react'
import type { PointerEvent } from 'react'
import { observePageActivity, pageIsHidden } from '../stores/pageActivity'

const targets = '.wb-task,.wb-brief,.wb-focus-main,.wb-xixi,.wb-watch-related button,.wb-ddl-select,.wb-icon-button,.wb-tool,.wb-action,.wb-secondary,.wb-brief-start,.wb-ddl-fold-toggle,.wb-focus-steps,.wb-briefing-panel'

/** Move a surface highlight without re-rendering the scene or moving its glass plane. */
export function useGlassHover(active: boolean, selector = targets) {
  const current = useRef<HTMLElement | null>(null)
  const frame = useRef(0)
  const point = useRef({ x: 0, y: 0 })
  const clear = () => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    current.current?.removeAttribute('data-hovered')
    current.current = null
  }
  useEffect(() => {
    if (!active) { clear(); return clear }
    const stopObserving = observePageActivity(() => { if (pageIsHidden()) clear() })
    return () => { stopObserving(); clear() }
  }, [active])
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType !== 'mouse' || !active || pageIsHidden()) { clear(); return }
    let target = (event.target as Element).closest<HTMLElement>(selector)
    // Embedded briefing has no optical shell; keep its glint on the outer glass.
    // Nested controls still win closest(), so only one surface is highlighted.
    if (target?.matches('.wb-brief-embedded')) target = target.closest<HTMLElement>('.wb-briefing-panel') ?? target
    if (!target || !event.currentTarget.contains(target) || target.closest('[inert]') || target.matches(':disabled')) { clear(); return }
    if (current.current !== target) {
      clear()
      current.current = target
      target.dataset.hovered = 'true'
    }
    point.current = { x: event.clientX, y: event.clientY }
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const element = current.current
      if (!element?.isConnected || pageIsHidden() || element.closest('[inert]') || element.matches(':disabled')) { clear(); return }
      const rect = element.getBoundingClientRect()
      const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches || Boolean(element.closest('[data-motion=reduced],[data-reduced-motion=true]'))
      element.style.setProperty('--wb-pointer-x', `${reduce ? rect.width / 2 : point.current.x - rect.left}px`)
      element.style.setProperty('--wb-pointer-y', `${reduce ? rect.height / 2 : point.current.y - rect.top}px`)
    })
  }
  return { onPointerMove, onPointerLeave: clear, onPointerCancel: clear }
}
