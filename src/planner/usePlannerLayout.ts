import { useLayoutEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'

export type PlannerLayout = 'wide' | 'medium' | 'narrow'
const readLayout = (): PlannerLayout => window.innerWidth >= 1280 ? 'wide' : window.innerWidth >= 768 ? 'medium' : 'narrow'

export function usePlannerLayout() {
  const [layout, setLayout] = useState(readLayout)
  useLayoutEffect(() => {
    const update = () => setLayout(readLayout())
    window.addEventListener('resize', update)
    return () => window.removeEventListener('resize', update)
  }, [])
  return layout
}

/** Native modal semantics keep keyboard focus inside the compact drawer. */
export function usePlannerChatSurface(
  ref: RefObject<HTMLDialogElement | null>, layout: PlannerLayout,
  active: boolean, open: boolean, present: boolean,
) {
  const shownAsModal = useRef(false)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const visible = active && (open || (present && element.open))
    const modal = layout === 'narrow'
    const focused = element.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    if (element.open && (!visible || shownAsModal.current !== modal)) element.close()
    if (visible && !element.open) {
      if (modal) element.showModal()
      else element.show()
      shownAsModal.current = modal
      // Resize changes modal semantics, but keeps the draft and input caret.
      // First opening focuses a control without summoning the software keyboard.
      if (open && focused?.isConnected) focused.focus({ preventScroll: true })
      else if (open && modal) element.querySelector<HTMLButtonElement>('[data-chat-close]')?.focus({ preventScroll: true })
    }
  }, [ref, layout, active, open, present])
}
