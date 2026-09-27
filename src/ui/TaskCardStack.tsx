import { useEffect, useRef, useState } from 'react'
import './task-card-stack.css'

export type StackTask = { id: string; title: string; meta: string; done?: boolean; overdue?: boolean }
type Props = { label: string; items: StackTask[]; onOpen: (id: string) => void; empty: string; compact?: boolean }

/** A bounded queue: only the current card is rendered and interactive. */
export function TaskCardStack({ label, items, onOpen, empty, compact = false }: Props) {
  const [selection, setSelection] = useState<{ id: string | null; leaving: StackTask | null; direction: number; revision: number }>({ id: null, leaving: null, direction: 1, revision: 0 })
  const root = useRef<HTMLDivElement>(null)
  const touchStart = useRef<number | null>(null)
  const gesture = useRef({ last: 0, total: 0, moved: false })
  const active = Math.max(0, items.findIndex(item => item.id === selection.id))
  const current = items[active]
  const canMove = (amount: number) => active + amount >= 0 && active + amount < items.length
  const move = (amount: number) => {
    if (!canMove(amount)) return false
    setSelection({ id: items[active + amount].id, leaving: current, direction: Math.sign(amount), revision: selection.revision + 1 })
    return true
  }
  const moveRef = useRef({ move, canMove })
  moveRef.current = { move, canMove }

  useEffect(() => {
    const element = root.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaX) > Math.abs(event.deltaY) || !event.deltaY) return
      const now = performance.now(), state = gesture.current
      if (now - state.last > 160) { state.total = 0; state.moved = false }
      state.last = now
      const direction = Math.sign(event.deltaY)
      // At either end, a fresh gesture goes back to scrolling the page. Momentum
      // from a completed flip stays here instead of unexpectedly moving it.
      if (!state.moved && !moveRef.current.canMove(direction)) return
      event.preventDefault()
      if (state.moved) return
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1)
      if (Math.sign(state.total) !== direction) state.total = 0
      state.total += delta
      if (Math.abs(state.total) < 24) return
      state.moved = moveRef.current.move(direction)
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  }, [])

  useEffect(() => {
    if (!selection.leaving) return
    const timeout = window.setTimeout(() => setSelection(value => value.revision === selection.revision ? { ...value, leaving: null } : value), 360)
    return () => window.clearTimeout(timeout)
  }, [selection.revision, selection.leaving])

  const card = (item: StackTask, leaving = false) => <button
    key={leaving ? `exit-${selection.revision}` : item.id}
    type="button"
    className={`task-stack-card${leaving ? ' task-stack-exit' : ''}`}
    data-active={!leaving}
    data-done={Boolean(item.done)}
    data-overdue={Boolean(item.overdue)}
    aria-hidden={leaving}
    inert={leaving}
    tabIndex={leaving ? -1 : 0}
    title={[item.title, item.meta].filter(Boolean).join(' · ')}
    aria-label={[item.title, item.meta, item.done ? '已完成' : ''].filter(Boolean).join('，')}
    onClick={() => onOpen(item.id)}
  ><strong>{item.title}</strong>{item.meta && <small>{item.meta}</small>}</button>

  return <div ref={root} className="task-stack" data-compact={compact} data-direction={selection.direction > 0 ? 'next' : 'previous'} data-moving={Boolean(selection.leaving)} data-count={items.length}
    role="region" aria-roledescription="卡片堆叠" aria-label={label}
    onKeyDown={event => {
      const offset = event.key === 'ArrowDown' || event.key === 'ArrowRight' || event.key === 'PageDown' ? 1
        : event.key === 'ArrowUp' || event.key === 'ArrowLeft' || event.key === 'PageUp' ? -1
          : event.key === 'Home' ? -active : event.key === 'End' ? items.length - active - 1 : null
      if (offset === null || !items.length) return
      event.preventDefault()
      if (offset && move(offset)) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('.task-stack-card[data-active=true]')?.focus({ preventScroll: true }))
    }}>
    {current ? <>
      <div className="task-stack-stage"
        onTouchStart={event => { touchStart.current = event.touches[0]?.clientY ?? null }}
        onTouchCancel={() => { touchStart.current = null }}
        onTouchEnd={event => {
          const start = touchStart.current, end = event.changedTouches[0]?.clientY
          touchStart.current = null
          if (start != null && end != null && Math.abs(end - start) >= 24) move(end < start ? 1 : -1)
        }}>
        {card(current)}
        {selection.leaving && card(selection.leaving, true)}
      </div>
      <div className="task-stack-footer">
        <span className="task-stack-count" role="status" aria-live="polite" aria-atomic="true"><span className="p0-sr-only">{label}，第 </span>{active + 1}<span aria-hidden="true"> / </span><span className="p0-sr-only"> 项，共 </span>{items.length}<span className="p0-sr-only"> 项</span></span>
        <div className="task-stack-controls"><button type="button" disabled={!canMove(-1)} aria-label={`${label}：上一项`} onClick={() => move(-1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 12 4-4 4 4" /></svg></button><button type="button" disabled={!canMove(1)} aria-label={`${label}：下一项`} onClick={() => move(1)}><svg viewBox="0 0 20 20" aria-hidden="true"><path d="m6 8 4 4 4-4" /></svg></button></div>
      </div>
    </> : <p className="task-stack-empty">{empty}</p>}
  </div>
}
