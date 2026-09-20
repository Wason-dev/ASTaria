import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

const hoverTargets = '.pl-calendar-day,.pl-timetable-date,.pl-slot,.pl-week-entry,.pl-day-task,.pl-calendar-summary-task,.pl-month-deadline,.pl-preparation,.pl-checklist li,.pl-capacity,.pl-life-section,.pl-calendar-summary-focus,.pl-glass,.pl-primary,.pl-secondary,.pl-icon-button'
const completionTargets = '.pl-day-task,.pl-calendar-summary-task,.pl-month-deadline,.pl-week-entry,.pl-calendar-entry,.pl-slot'

/** Keep visual feedback local to the glass surface, without rendering or moving the scene. */
export function usePlannerInteraction(ref: RefObject<HTMLElement | null>, active: boolean, page: string) {
  useLayoutEffect(() => {
    const root = ref.current
    if (!root || !active) return

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let hovered: HTMLElement | null = null
    let pending: { element: HTMLElement; x: number; y: number } | null = null
    let frame = 0
    let entryTimer: ReturnType<typeof setTimeout> | undefined
    const pulseTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>()

    const clearElement = (element: HTMLElement) => {
      element.removeAttribute('data-hovered')
      element.style.removeProperty('--pl-pointer-x')
      element.style.removeProperty('--pl-pointer-y')
    }
    const clearHover = () => {
      cancelAnimationFrame(frame)
      frame = 0
      pending = null
      if (hovered) clearElement(hovered)
      hovered = null
    }
    const clearEntry = () => {
      clearTimeout(entryTimer)
      entryTimer = undefined
      root.removeAttribute('data-entering')
    }
    const clearPulses = () => {
      pulseTimers.forEach((timer, element) => {
        clearTimeout(timer)
        element.removeAttribute('data-status-pulse')
      })
      pulseTimers.clear()
    }
    const clearMotion = () => {
      clearHover()
      clearEntry()
      clearPulses()
    }
    const move = (event: PointerEvent) => {
      if (motion.matches || event.pointerType !== 'mouse' || !(event.target instanceof Element)) {
        clearHover()
        return
      }
      // closest() chooses one nested surface, so parent and child highlights never stack.
      const element = event.target.closest<HTMLElement>(hoverTargets)
      if (!element || !root.contains(element) || element.closest('[inert],[aria-hidden=true]') || element.matches(':disabled')) {
        clearHover()
        return
      }
      pending = { element, x: event.clientX, y: event.clientY }
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        const point = pending
        pending = null
        if (!point || !point.element.isConnected || !root.contains(point.element) || motion.matches) {
          clearHover()
          return
        }
        if (hovered !== point.element) {
          if (hovered) clearElement(hovered)
          hovered = point.element
        }
        const rect = hovered.getBoundingClientRect()
        hovered.style.setProperty('--pl-pointer-x', `${Math.max(0, Math.min(rect.width, point.x - rect.left))}px`)
        hovered.style.setProperty('--pl-pointer-y', `${Math.max(0, Math.min(rect.height, point.y - rect.top))}px`)
        hovered.dataset.hovered = 'true'
      })
    }

    const observer = new MutationObserver(records => {
      if (motion.matches) return
      const changed = new Set<HTMLElement>()
      for (const record of records) {
        const element = record.target
        if (!(element instanceof HTMLElement) || !root.contains(element)) continue
        const completed = record.attributeName === 'data-done' && element.matches(completionTargets)
          && element.dataset.done === 'true'
        const checked = record.attributeName === 'aria-pressed' && element.matches('.pl-check')
          && element.getAttribute('aria-pressed') === 'true'
        // Only false → true changes pulse; initially completed items stay quiet on mount.
        if (completed || checked) {
          if (record.oldValue === 'false') changed.add(element)
        } else if (pulseTimers.has(element)) {
          clearTimeout(pulseTimers.get(element))
          pulseTimers.delete(element)
          element.removeAttribute('data-status-pulse')
        }
      }
      changed.forEach(element => {
        clearTimeout(pulseTimers.get(element))
        element.dataset.statusPulse = 'true'
        pulseTimers.set(element, setTimeout(() => {
          element.removeAttribute('data-status-pulse')
          pulseTimers.delete(element)
        }, 600))
      })
    })
    observer.observe(root, { subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['data-done', 'aria-pressed'] })

    if (!motion.matches) {
      root.dataset.entering = 'true'
      entryTimer = setTimeout(clearEntry, 420)
    }
    const onMotionChange = () => {
      // Preference changes clear ongoing effects; entry only starts on activation/page change.
      if (motion.matches) clearMotion()
    }
    root.addEventListener('pointermove', move, { passive: true })
    root.addEventListener('pointerleave', clearHover, { passive: true })
    root.addEventListener('pointercancel', clearHover, { passive: true })
    root.addEventListener('scroll', clearHover, { capture: true, passive: true })
    motion.addEventListener('change', onMotionChange)

    return () => {
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerleave', clearHover)
      root.removeEventListener('pointercancel', clearHover)
      root.removeEventListener('scroll', clearHover, true)
      motion.removeEventListener('change', onMotionChange)
      observer.disconnect()
      clearMotion()
    }
  }, [ref, active, page])
}
