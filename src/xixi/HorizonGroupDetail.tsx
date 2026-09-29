import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import { groupMinutes } from './orbitGroups'
import type { OrbitGroup } from './orbitGroups'
import { interactiveHorizonPoint as horizonPoint, renderedHorizonProjection } from './horizonScene'
import type { HorizonPoint } from './horizonScene'
import { horizonTaskSlot, previewHorizonTasks } from './horizonTasks'
import { horizonPagedDropIndex, horizonTaskPage, horizonTaskPageSize } from './horizonTaskPages'
import type { HorizonTuning } from './horizonTuning'
import { springStep } from './orbitMotion'
import type { Spring } from './orbitMotion'
import './horizon-task-pages.css'

type Props = {
  group: OrbitGroup | undefined; origin: number; tuning: HorizonTuning; reduced: boolean; disabled?: boolean
  onClose: () => void; onMove: (groupId: string, taskId: string, index: number) => void
}
type Grab = { id: string; pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number; x: number; y: number; moved: boolean; target: number; ids: string[] }
type Motion = { t: Spring; lift: Spring; dx: Spring; dy: Spring; point: HorizonPoint }
const spring = (value: number): Spring => ({ value, velocity: 0 })
const DAYS = ['今天', '明天', '后天']

/** Unfold a group's light into task strands on the same physical horizon. */
export function HorizonGroupDetail({ group, origin, tuning, reduced, disabled = false, onClose, onMove }: Props) {
  const [retained, setRetained] = useState(group), [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<string[] | null>(null), [dragged, setDragged] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [page, setPage] = useState(0), [pageSize, setPageSize] = useState(() => horizonTaskPageSize(innerWidth))
  const shell = useRef<HTMLElement>(null), back = useRef<HTMLButtonElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>()), paths = useRef(new Map<string, SVGGElement>())
  const motions = useRef(new Map<string, Motion>()), grab = useRef<Grab | null>(null)
  const pageButtons = useRef(new Map<number, HTMLButtonElement>()), pageHover = useRef<{ direction: number; timer: ReturnType<typeof setTimeout> } | null>(null)
  const focusAfterMove = useRef<string | null>(null)
  const size = useRef({ width: innerWidth, height: innerHeight }), frame = useRef(0), opener = useRef<HTMLElement | null>(null)
  const rememberedOrigin = useRef(origin), currentGroup = useRef(group); currentGroup.current = group
  const retainedSnapshot = useRef(group)
  if (group) retainedSnapshot.current = group
  const active = group ?? (retained ? retainedSnapshot.current : undefined)
  const tasks = active ? (preview ?? active.tasks.map(task => task.id)).map(id => active.tasks.find(task => task.id === id)!).filter(Boolean) : []
  const paging = horizonTaskPage(tasks.length, pageSize, page), pageTasks = tasks.slice(paging.start, paging.end)
  const heldTask = dragged ? tasks.find(task => task.id === dragged) : undefined
  const renderedTasks = heldTask && !pageTasks.some(task => task.id === heldTask.id) ? [...pageTasks, heldTask] : pageTasks
  const latest = useRef({ active, tasks: renderedTasks, pageTasks, paging, pageSize, open, tuning, reduced })
  latest.current = { active, tasks: renderedTasks, pageTasks, paging, pageSize, open, tuning, reduced }
  const gradient = useId().replaceAll(':', '')

  const clearPageHover = () => {
    if (pageHover.current) clearTimeout(pageHover.current.timer)
    pageHover.current = null
  }
  const release = () => {
    clearPageHover()
    const held = grab.current; grab.current = null
    if (held && shell.current?.hasPointerCapture(held.pointerId)) shell.current.releasePointerCapture(held.pointerId)
    setDragged(null); setPreview(null)
  }
  useLayoutEffect(() => {
    release()
    if (group) {
      setPage(0)
      rememberedOrigin.current = origin
      setRetained(group)
      if (group.id !== retained?.id) motions.current.clear()
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const entry = requestAnimationFrame(() => { setOpen(true); back.current?.focus({ preventScroll: true }) })
      return () => cancelAnimationFrame(entry)
    }
    setOpen(false)
    // Return focus only if it is still inside the closing detail. A delayed
    // restore would steal it from controls the user chooses during the fade.
    if (shell.current?.contains(document.activeElement) && opener.current?.isConnected && !opener.current.closest('[inert]')) opener.current.focus({ preventScroll: true })
    const exit = setTimeout(() => {
      if (!currentGroup.current) { setRetained(undefined); motions.current.clear() }
    }, reduced ? 0 : 650)
    return () => clearTimeout(exit)
    // Keep the exit snapshot; task edits must not restart entry or cancel a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [group?.id, reduced])

  useEffect(() => {
    if (focusAfterMove.current) {
      const button = buttons.current.get(focusAfterMove.current)
      if (button) { button.focus({ preventScroll: true }); focusAfterMove.current = null }
    }
  }, [group, page, pageSize])

  useEffect(() => {
    if (!active || !shell.current) return
    const node = shell.current
    const resize = () => {
      const rect = node.getBoundingClientRect(); size.current = { width: rect.width, height: rect.height }
      const nextSize = horizonTaskPageSize(rect.width)
      setPageSize(nextSize)
      const focusedId = [...buttons.current].find(([, button]) => button === document.activeElement)?.[0]
      if (focusedId) {
        const index = latest.current.active?.tasks.findIndex(task => task.id === focusedId) ?? -1
        if (index >= 0) setPage(Math.floor(index / nextSize))
      }
    }
    resize(); const observer = new ResizeObserver(resize); observer.observe(node)
    let last = 0
    const transforms = new WeakMap<HTMLButtonElement, string>()
    const draw = (now: number) => {
      frame.current = 0
      if (document.hidden) return
      const state = latest.current, { width, height } = size.current
      const projection = renderedHorizonProjection(width, height, state.tuning)
      const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60; last = now
      const advance = (from: Spring, to: number, speed = 12) => state.reduced ? spring(to) : springStep(from, to, dt, speed, 1)
      const held = grab.current
      state.tasks.forEach(task => {
        const index = state.pageTasks.findIndex(item => item.id === task.id)
        const target = state.open ? horizonTaskSlot(Math.max(0, index), state.pageTasks.length) : rememberedOrigin.current
        let motion = motions.current.get(task.id)
        if (!motion) {
          const t = state.reduced ? target : rememberedOrigin.current
          motion = { t: spring(t), lift: spring(0), dx: spring(0), dy: spring(0), point: horizonPoint(projection, t) }
          motions.current.set(task.id, motion)
        }
        motion.t = advance(motion.t, target)
        const anchor = horizonPoint(projection, motion.t.value), dragging = held?.moved && held.id === task.id
        motion.lift = advance(motion.lift, dragging ? 1 : 0, 16)
        motion.dx = advance(motion.dx, dragging ? held.x - anchor.x : 0, dragging ? 28 : 15)
        motion.dy = advance(motion.dy, dragging ? held.y - anchor.y : 0, dragging ? 28 : 15)
        const p = { x: anchor.x + motion.dx.value, y: anchor.y + motion.dy.value }; motion.point = p
        const button = buttons.current.get(task.id)
        if (button) {
          const transform = `translate3d(${p.x - 40}px,${p.y - 22}px,0)`
          if (transforms.get(button) !== transform) { button.style.transform = transform; transforms.set(button, transform) }
        }
        const span = Math.min(150, width * .65 / Math.max(1, state.pageTasks.length))
        const bend = 1 - motion.lift.value
        const d = Array.from({ length: 25 }, (_, step) => {
          const x = (step / 24 - .5) * span, point = horizonPoint(projection, motion.t.value + x / width)
          return `${step ? 'L' : 'M'}${(p.x + x).toFixed(2)},${(p.y + (point.y - anchor.y) * bend).toFixed(2)}`
        }).join(' ')
        paths.current.get(task.id)?.querySelectorAll('path').forEach(path => { if (path.getAttribute('d') !== d) path.setAttribute('d', d) })
      })
      frame.current = requestAnimationFrame(draw)
    }
    const visibility = () => {
      cancelAnimationFrame(frame.current); frame.current = 0; last = 0
      if (!document.hidden) frame.current = requestAnimationFrame(draw)
    }
    document.addEventListener('visibilitychange', visibility)
    if (!document.hidden) frame.current = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame.current); observer.disconnect(); document.removeEventListener('visibilitychange', visibility) }
  }, [active?.id])
  useEffect(() => () => { clearPageHover(); const held = grab.current; grab.current = null; if (held && shell.current?.hasPointerCapture(held.pointerId)) shell.current.releasePointerCapture(held.pointerId) }, [])

  const start = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (!group || !open || disabled || !event.isPrimary || event.button !== 0 || grab.current) return
    const point = motions.current.get(id)?.point
    if (!point) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus({ preventScroll: true })
    grab.current = { id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      x: point.x, y: point.y, offsetX: event.clientX - point.x, offsetY: event.clientY - point.y,
      moved: false, target: group.tasks.findIndex(task => task.id === id), ids: group.tasks.map(task => task.id) }
    shell.current?.setPointerCapture(event.pointerId)
  }
  const move = (event: PointerEvent) => {
    const held = grab.current
    if (!held || held.pointerId !== event.pointerId) return
    event.stopPropagation(); held.x = event.clientX - held.offsetX; held.y = event.clientY - held.offsetY
    if (!held.moved && Math.hypot(event.clientX - held.startX, event.clientY - held.startY) < 6) return
    if (!held.moved) { held.moved = true; setDragged(held.id) }
    const target = horizonPagedDropIndex(held.x, size.current.width, held.ids, held.id, latest.current.paging.page, latest.current.pageSize)
    if (target !== held.target) { held.target = target; setPreview(previewHorizonTasks(held.ids, held.id, target)) }
    let direction = 0
    for (const [step, button] of pageButtons.current) {
      const rect = button.getBoundingClientRect()
      if (!button.disabled && event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) direction = step
    }
    if (pageHover.current?.direction === direction) return
    clearPageHover()
    if (direction) pageHover.current = { direction, timer: setTimeout(() => {
      pageHover.current = null
      if (grab.current !== held) return
      const state = latest.current, next = horizonTaskPage(held.ids.length, state.pageSize, state.paging.page + direction)
      setPage(next.page)
      held.target = horizonPagedDropIndex(held.x, size.current.width, held.ids, held.id, next.page, state.pageSize)
      setPreview(previewHorizonTasks(held.ids, held.id, held.target))
      setAnnouncement(`第${next.page + 1}页，继续拖动调整位置`)
    }, 550) }
  }
  const finish = (event?: PointerEvent, cancelled = false) => {
    const held = grab.current
    if (!held || event && held.pointerId !== event.pointerId) return
    event?.stopPropagation()
    if (held.moved && !cancelled && group && !disabled) {
      onMove(group.id, held.id, held.target)
      setPage(Math.floor(held.target / latest.current.pageSize)); focusAfterMove.current = held.id
      setAnnouncement(`已移到第${held.target + 1}项`)
    }
    release()
  }
  if (!active) return null
  return <section ref={shell} className="horizon-group-detail" data-open={open} data-dragging={Boolean(dragged)} data-paged={paging.total > 1} aria-label={`${active.title}组内顺序`} inert={!group || disabled}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); if (grab.current) finish(undefined, true); else onClose() } }}>
    <header className="horizon-detail-heading"><small>{DAYS[active.day]} / {active.tasks.length} 项 · {groupMinutes(active)} 分钟</small><h2>{active.title}</h2>
      <button ref={back} type="button" className="horizon-detail-back" onClick={onClose}>
        <MeasuredGlassSurface radius={20} material={{ transmission:100, blur:0, rim:40, shadow:0, reflection:10 }} />
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m9 5-5 5 5 5M4 10h12" /></svg><span>收拢这组</span>
      </button></header>
    <svg className="horizon-task-strands" aria-hidden="true"><defs>
      <linearGradient id={`${gradient}-strand`}><stop stopColor="#ddad62" stopOpacity="0" /><stop offset=".3" stopColor="#f6d18d" /><stop offset=".5" stopColor="#fffbed" /><stop offset=".7" stopColor="#f6d18d" /><stop offset="1" stopColor="#ddad62" stopOpacity="0" /></linearGradient>
    </defs>{renderedTasks.map(task => <g key={task.id} ref={node => { if (node) paths.current.set(task.id, node); else paths.current.delete(task.id) }} data-dragged={dragged === task.id}>
      <path stroke={`url(#${gradient}-strand)`} strokeWidth="12" opacity=".15" /><path stroke={`url(#${gradient}-strand)`} strokeWidth="4" opacity=".5" /><path stroke={`url(#${gradient}-strand)`} strokeWidth="1.5" />
    </g>)}</svg>
    <div className="horizon-task-layer" role="group" aria-label="沿地平线排列的事项">{renderedTasks.map(task => {
      const index = tasks.findIndex(item => item.id === task.id)
      return <button type="button" key={task.id} className="horizon-task" data-dragged={dragged === task.id}
      ref={node => { if (node) buttons.current.set(task.id, node); else buttons.current.delete(task.id) }}
      title={task.title} aria-label={`第${index + 1}项，${task.title}，${task.minutes}分钟；拖动或方向键调整顺序`} onPointerDown={event => start(event, task.id)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !group || disabled || grab.current) return
        event.preventDefault(); event.stopPropagation()
        const next = Math.max(0, Math.min(tasks.length - 1, index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)))
        onMove(group.id, task.id, next); setPage(Math.floor(next / pageSize)); focusAfterMove.current = task.id
        setAnnouncement(`${task.title}，第${next + 1}项`)
      }}><span className="horizon-task-caption"><small>{String(index + 1).padStart(2, '0')}</small><strong>{task.title}</strong><span>{task.minutes} 分钟</span></span><i aria-hidden="true" /></button>
    })}</div>
    {paging.total > 1 && <nav className="horizon-task-pages" aria-label="浏览组内事项">{([-1, 1] as const).map((direction, index) => <span key={direction}>
      {index === 1 && <span className="horizon-task-page-range" aria-live="polite">{paging.start + 1}–{paging.end} / {tasks.length}</span>}
      <button type="button" ref={node => { if (node) pageButtons.current.set(direction, node); else pageButtons.current.delete(direction) }}
        aria-label={direction < 0 ? '上一页事项' : '下一页事项'} disabled={disabled || !group || !open || (direction < 0 ? paging.page === 0 : paging.page === paging.total - 1)}
        onClick={() => { if (!grab.current) setPage(paging.page + direction) }}>
        <MeasuredGlassSurface radius={20} material={{ transmission:100, blur:0, rim:40, shadow:0, reflection:10 }} />
        <span aria-hidden="true">{direction < 0 ? '←' : '→'}</span>
      </button>
    </span>)}</nav>}
    <p className="horizon-detail-hint">{dragged ? paging.total > 1 ? '停留在箭头上翻页 · 松手放回光里' : '松手，让它落回光里' : '沿着地平线，拖动事项调整先后'}</p>
    <span className="p0-sr-only" role="status">{announcement}</span>
  </section>
}
