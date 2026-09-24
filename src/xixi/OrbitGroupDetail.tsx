import { useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { groupMinutes } from './orbitGroups'
import type { OrbitGroup } from './orbitGroups'

type Props = {
  group: OrbitGroup | undefined
  reduced: boolean
  onClose: () => void
  onMove: (groupId: string, taskId: string, index: number) => void
}
type Grab = { id: string; groupId: string; pointerId: number; startY: number; y: number; offset: number; moved: boolean }
const DAYS = ['今天', '明天', '后天']
const easing = 'cubic-bezier(.2,.8,.2,1)'

/** Keep the glass shell in place; only its contents and the ordered rows move. */
export function OrbitGroupDetail({ group, reduced, onClose, onMove }: Props) {
  const [displayed, setDisplayed] = useState(group)
  const [outgoing, setOutgoing] = useState<OrbitGroup>()
  const [open, setOpen] = useState(Boolean(group))
  const [preview, setPreview] = useState<string[] | null>(null)
  const [dragged, setDragged] = useState<string | null>(null)
  const shell = useRef<HTMLElement>(null), content = useRef<HTMLDivElement>(null), list = useRef<HTMLOListElement>(null)
  const rows = useRef(new Map<string, HTMLLIElement>())
  const animations = useRef(new Map<string, Animation>())
  const before = useRef(new Map<string, number>())
  const grab = useRef<Grab | null>(null)
  const order = useRef<string[]>([])
  const currentGroup = useRef(group); currentGroup.current = group

  const stopGrab = () => {
    const current = grab.current
    grab.current = null
    if (current && list.current?.hasPointerCapture(current.pointerId)) list.current.releasePointerCapture(current.pointerId)
    for (const row of rows.current.values()) row.style.removeProperty('transform')
  }
  useLayoutEffect(() => {
    const changed = group?.id !== displayed?.id
    if (changed) {
      stopGrab(); setPreview(null); setDragged(null); before.current.clear()
      for (const animation of animations.current.values()) animation.cancel()
      animations.current.clear()
    }
    if (group) {
      if (changed) setOutgoing(reduced ? undefined : displayed)
      setDisplayed(group); setOpen(true)
    } else setOpen(false)
    const timer = window.setTimeout(() => {
      setOutgoing(undefined)
      if (!currentGroup.current) setDisplayed(undefined)
    }, reduced ? 0 : 200)
    return () => window.clearTimeout(timer)
    // displayed is the retained exit snapshot, not an independent selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group, reduced])
  useLayoutEffect(() => () => {
    stopGrab()
    for (const animation of animations.current.values()) animation.cancel()
  }, [])

  const active = group?.id === displayed?.id ? group : displayed
  const tasks = active ? preview?.map(id => active.tasks.find(task => task.id === id)).filter(task => task !== undefined) ?? active.tasks : []
  order.current = tasks.map(task => task.id)

  useLayoutEffect(() => {
    const node = content.current, panel = shell.current
    if (!node || !panel) return
    const measure = () => {
      const style = getComputedStyle(panel)
      const inset = ['padding-top', 'padding-bottom', 'border-top-width', 'border-bottom-width']
        .reduce((sum, key) => sum + (parseFloat(style.getPropertyValue(key)) || 0), 0)
      panel.style.setProperty('--orbit-detail-height', `${node.offsetHeight + inset}px`)
    }
    measure()
    const observer = new ResizeObserver(measure); observer.observe(node)
    return () => observer.disconnect()
  }, [active?.id])

  const capture = () => {
    before.current = new Map([...rows.current].map(([id, row]) => [id, row.getBoundingClientRect().top]))
    for (const animation of animations.current.values()) animation.cancel()
    animations.current.clear()
  }
  const followPointer = () => {
    const current = grab.current, row = current && rows.current.get(current.id)
    if (!current?.moved || !row) return
    // offsetTop is the stable layout position; transformed neighbors never steer the target.
    row.style.transform = 'none'
    const top = row.getBoundingClientRect().top
    row.style.transform = `translate3d(0,${current.y - current.offset - top}px,0)`
  }
  useLayoutEffect(() => {
    for (const [id, row] of rows.current) {
      if (grab.current?.moved && grab.current.id === id) continue
      row.style.removeProperty('transform')
      const previous = before.current.get(id)
      const distance = previous === undefined ? 0 : previous - row.getBoundingClientRect().top
      if (!reduced && Math.abs(distance) > .5) {
        const animation = row.animate([{ transform: `translateY(${distance}px)` }, { transform: 'translateY(0)' }], { duration: 240, easing })
        animations.current.set(id, animation)
        animation.onfinish = () => { if (animations.current.get(id) === animation) animations.current.delete(id) }
      }
    }
    before.current.clear(); followPointer()
  }, [active, preview, dragged, reduced])

  const start = (event: PointerEvent<HTMLLIElement>, taskId: string) => {
    if (!active || !open || !event.isPrimary || event.button !== 0 || grab.current || (event.target as HTMLElement).closest('button')) return
    const row = rows.current.get(taskId)
    if (!row) return
    event.preventDefault(); event.stopPropagation()
    grab.current = { id: taskId, groupId: active.id, pointerId: event.pointerId, startY: event.clientY, y: event.clientY,
      offset: event.clientY - row.getBoundingClientRect().top, moved: false }
    list.current?.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent) => {
    const current = grab.current
    if (!current || event.pointerId !== current.pointerId) return
    event.stopPropagation(); current.y = event.clientY
    if (!current.moved && Math.abs(current.y - current.startY) < 5) return
    const justLifted = !current.moved
    if (justLifted) { capture(); current.moved = true; setDragged(current.id) }
    followPointer()
    const row = rows.current.get(current.id), container = list.current
    if (!row || !container) return
    const y = current.y - current.offset + row.offsetHeight / 2 - container.getBoundingClientRect().top
    const from = order.current.indexOf(current.id)
    let target = from, best = Infinity
    for (const [index, id] of order.current.entries()) {
      const item = rows.current.get(id)
      if (!item) continue
      const distance = Math.abs(y - (item.offsetTop + item.offsetHeight / 2))
      if (distance < best) { best = distance; target = index }
    }
    if (target !== from) {
      // A small dead band prevents a stationary pointer flipping adjacent slots.
      const source = rows.current.get(order.current[from]), destination = rows.current.get(order.current[target])
      if (source && destination) {
        const boundary = (source.offsetTop + source.offsetHeight / 2 + destination.offsetTop + destination.offsetHeight / 2) / 2
        if (Math.abs(y - boundary) < 5) return
      }
      if (!justLifted) capture()
      const next = [...order.current]; next.splice(from, 1); next.splice(target, 0, current.id)
      order.current = next; setPreview(next)
    }
  }
  const finish = (event?: PointerEvent, cancelled = false) => {
    const current = grab.current
    if (!current || (event && current.pointerId !== event.pointerId)) return
    event?.stopPropagation()
    capture()
    const index = order.current.indexOf(current.id)
    stopGrab(); setDragged(null); setPreview(null)
    if (current.moved && !cancelled && index >= 0) onMove(current.groupId, current.id, index)
  }
  const step = (taskId: string, index: number) => {
    if (!active || grab.current) return
    capture(); onMove(active.id, taskId, index)
  }
  if (!active) return null
  return <section ref={shell} className="orbit-group-detail" data-open={open} data-reduced={reduced} aria-label={`${active.title}组内顺序`}
    inert={!open} onKeyDown={event => { if (event.key === 'Escape' && grab.current) { event.preventDefault(); event.stopPropagation(); finish(undefined, true) } }}>
    {outgoing && outgoing.id !== active.id && <div key={outgoing.id} className="orbit-detail-outgoing" aria-hidden="true" inert>
      <header><div><small>{DAYS[outgoing.day]} / {outgoing.project ?? '一起推进'}</small><h2>{outgoing.title}</h2></div></header>
      <p>这些事放在一起，按这个顺序推进</p>
      <ol>{outgoing.tasks.map((task, index) => <li key={task.id}><span className="orbit-task-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{task.title}</strong><small>{task.minutes} 分钟</small></div></li>)}</ol>
      <footer><span>{outgoing.tasks.length} 项 · {groupMinutes(outgoing)} 分钟</span><span>拖动条目可换顺序</span></footer>
    </div>}
    <div ref={content} className="orbit-detail-content" key={active.id}>
      <header><div><small>{DAYS[active.day]} / {active.project ?? '一起推进'}</small><h2>{active.title}</h2></div><button type="button" className="orbit-detail-close" aria-label="收起任务组" onClick={onClose}>×</button></header>
      <p>这些事放在一起，按这个顺序推进</p>
      <ol ref={list} onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}>
        {tasks.map((task, index) => <li key={task.id} ref={node => { if (node) rows.current.set(task.id, node); else rows.current.delete(task.id) }}
          onPointerDown={event => start(event, task.id)} data-dragged={dragged === task.id}>
          <span className="orbit-task-index">{String(index + 1).padStart(2, '0')}</span><div><strong>{task.title}</strong><small>{task.minutes} 分钟</small></div>
          <span className="orbit-task-actions"><button type="button" aria-label={`${task.title}提前`} disabled={index === 0 || Boolean(dragged)} onClick={() => step(task.id, index - 1)}>↑</button><button type="button" aria-label={`${task.title}延后`} disabled={index === tasks.length - 1 || Boolean(dragged)} onClick={() => step(task.id, index + 1)}>↓</button></span>
        </li>)}
      </ol><footer><span>{tasks.length} 项 · {groupMinutes(active)} 分钟</span><span>拖动条目可换顺序</span></footer>
    </div>
  </section>
}
