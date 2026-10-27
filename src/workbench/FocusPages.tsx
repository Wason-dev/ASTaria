import { Children, useContext, useEffect, useId, useLayoutEffect, useRef } from 'react'
import type { ReactNode } from 'react'
import { GlassSamplingContext } from '../home/GlassSurface'

const labels = ['专注', '步骤', '析熙']
/** Native horizontal scrolling preserves touch momentum and all three panels'
 * local state. Desktop retains its existing three-column DOM and geometry. */
export function FocusPages({ children, page, onPage }: { children: ReactNode; page: number; onPage: (page: number) => void }) {
  const mobile = Boolean(document.documentElement.dataset.mobile)
  const sampling = useContext(GlassSamplingContext)
  const id = useId(), rail = useRef<HTMLDivElement>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(settleTimer.current), [])
  const selected = useRef(page)
  selected.current = page
  const go = (index: number, focus = false) => {
    const node = rail.current
    if (!node) return
    const previous = node.querySelector<HTMLElement>('.wb-focus-page:not([inert])')
    if (previous?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    onPage(index)
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || Boolean(node.closest('[data-motion=reduced]'))
    node.scrollTo({ left: index * node.clientWidth, behavior: reduced ? 'instant' : 'smooth' })
    if (focus) document.getElementById(`${id}-tab-${index}`)?.focus({ preventScroll: true })
  }
  useLayoutEffect(() => {
    const node = rail.current
    if (!node) return
    let width = node.clientWidth
    node.scrollLeft = page * width
    const observer = new ResizeObserver(() => {
      if (node.clientWidth === width) return
      width = node.clientWidth
      node.scrollTo({ left: selected.current * width, behavior: 'instant' })
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [mobile])
  useLayoutEffect(() => {
    const node = rail.current
    if (!node || Math.round(node.scrollLeft / node.clientWidth) === page) return
    // Also handles "请析熙拆步骤", which chooses the conversation externally.
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches || Boolean(node.closest('[data-motion=reduced]'))
    node.scrollTo({ left: page * node.clientWidth, behavior: reduced ? 'instant' : 'smooth' })
  }, [page])
  if (!mobile) return <div className="wb-focus-layout">{children}</div>
  return <div className="wb-focus-pages">
    <nav className="wb-focus-page-tabs" role="tablist" aria-label="专注页面">
      {labels.map((label, index) => <button key={label} id={`${id}-tab-${index}`} type="button" role="tab" aria-selected={page === index} aria-controls={`${id}-page-${index}`} tabIndex={page === index ? 0 : -1} onClick={() => go(index)} onKeyDown={event => {
        const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
        if (!delta && event.key !== 'Home' && event.key !== 'End') return
        event.preventDefault()
        go(event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + delta + 3) % 3, true)
      }}>{label}</button>)}
    </nav>
    <div ref={rail} className="wb-focus-page-rail" onScroll={event => {
      const node = event.currentTarget
      clearTimeout(settleTimer.current)
      settleTimer.current = setTimeout(() => {
        const index = Math.max(0, Math.min(2, Math.round(node.scrollLeft / node.clientWidth)))
        if (Math.abs(node.scrollLeft - index * node.clientWidth) < 2 && index !== selected.current) onPage(index)
      }, 100)
    }}>
      {Children.toArray(children).map((child, index) => <section key={index} id={`${id}-page-${index}`} className="wb-focus-page" role="tabpanel" aria-labelledby={`${id}-tab-${index}`} inert={index !== page}>
        <GlassSamplingContext.Provider value={sampling && Math.abs(index - page) <= 1}>{child}</GlassSamplingContext.Provider>
      </section>)}
    </div>
  </div>
}
