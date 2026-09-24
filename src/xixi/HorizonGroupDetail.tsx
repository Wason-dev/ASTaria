import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { PointerEvent } from 'react'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import { groupMinutes } from './orbitGroups'
import type { OrbitGroup } from './orbitGroups'
import { interactiveHorizonPoint as horizonPoint, renderedHorizonProjection } from './horizonScene'
import type { HorizonPoint } from './horizonScene'
import { horizonTaskDropIndex, horizonTaskSlot, previewHorizonTasks } from './horizonTasks'
import type { HorizonTuning } from './horizonTuning'
import { springStep } from './orbitMotion'
import type { Spring } from './orbitMotion'

type Props = {
  group: OrbitGroup | undefined; origin: number; tuning: HorizonTuning; reduced: boolean
  onClose: () => void; onMove: (groupId: string, taskId: string, index: number) => void
}
type Grab = { id: string; pointerId: number; startX: number; startY: number; offsetX: number; offsetY: number; x: number; y: number; moved: boolean; target: number; ids: string[] }
type Motion = { t: Spring; lift: Spring; dx: Spring; dy: Spring; point: HorizonPoint }
const spring = (value: number): Spring => ({ value, velocity: 0 })
const DAYS = ['今天', '明天', '后天']

/** Unfold a group's light into task strands on the same physical horizon. */
export function HorizonGroupDetail({ group, origin, tuning, reduced, onClose, onMove }: Props) {
  const [retained, setRetained] = useState(group), [open, setOpen] = useState(false)
  const [preview, setPreview] = useState<string[] | null>(null), [dragged, setDragged] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const shell = useRef<HTMLElement>(null), back = useRef<HTMLButtonElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>()), paths = useRef(new Map<string, SVGGElement>())
  const motions = useRef(new Map<string, Motion>()), grab = useRef<Grab | null>(null)
  const size = useRef({ width: innerWidth, height: innerHeight }), frame = useRef(0), opener = useRef<HTMLElement | null>(null)
  const rememberedOrigin = useRef(origin), currentGroup = useRef(group); currentGroup.current = group
  const retainedSnapshot = useRef(group)
  if (group) retainedSnapshot.current = group
  const active = group ?? (retained ? retainedSnapshot.current : undefined)
  const tasks = active ? (preview ?? active.tasks.map(task => task.id)).map(id => active.tasks.find(task => task.id === id)!).filter(Boolean) : []
  const latest = useRef({ active, tasks, open, tuning, reduced })
  latest.current = { active, tasks, open, tuning, reduced }
  const gradient = useId().replaceAll(':', '')

  const release = () => {
    const held = grab.current; grab.current = null
    if (held && shell.current?.hasPointerCapture(held.pointerId)) shell.current.releasePointerCapture(held.pointerId)
    setDragged(null); setPreview(null)
  }
  useLayoutEffect(() => {
    release()
    if (group) {
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
    if (!active || !shell.current) return
    const node = shell.current
    const resize = () => { const rect = node.getBoundingClientRect(); size.current = { width: rect.width, height: rect.height } }
    resize(); const observer = new ResizeObserver(resize); observer.observe(node)
    let last = 0
    const draw = (now: number) => {
      const state = latest.current, { width, height } = size.current
      const projection = renderedHorizonProjection(width, height, state.tuning)
      const dt = last ? Math.min(.05, (now - last) / 1000) : 1 / 60; last = now
      const advance = (from: Spring, to: number, speed = 12) => state.reduced ? spring(to) : springStep(from, to, dt, speed, 1)
      const held = grab.current
      state.tasks.forEach((task, index) => {
        const target = state.open ? horizonTaskSlot(index, state.tasks.length) : rememberedOrigin.current
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
        if (button) button.style.transform = `translate3d(${p.x - 40}px,${p.y - 22}px,0)`
        const span = Math.min(150, width * .65 / Math.max(1, state.tasks.length))
        const bend = 1 - motion.lift.value
        const d = Array.from({ length: 25 }, (_, step) => {
          const x = (step / 24 - .5) * span, point = horizonPoint(projection, motion.t.value + x / width)
          return `${step ? 'L' : 'M'}${(p.x + x).toFixed(2)},${(p.y + (point.y - anchor.y) * bend).toFixed(2)}`
        }).join(' ')
        paths.current.get(task.id)?.querySelectorAll('path').forEach(path => path.setAttribute('d', d))
      })
      frame.current = requestAnimationFrame(draw)
    }
    frame.current = requestAnimationFrame(draw)
    return () => { cancelAnimationFrame(frame.current); observer.disconnect() }
  }, [active?.id])
  useEffect(() => () => { const held = grab.current; grab.current = null; if (held && shell.current?.hasPointerCapture(held.pointerId)) shell.current.releasePointerCapture(held.pointerId) }, [])

  const start = (event: PointerEvent<HTMLButtonElement>, id: string) => {
    if (!group || !open || !event.isPrimary || event.button !== 0 || grab.current) return
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
    const target = horizonTaskDropIndex(held.x, size.current.width, held.ids, held.id)
    if (target !== held.target) { held.target = target; setPreview(previewHorizonTasks(held.ids, held.id, target)) }
  }
  const finish = (event?: PointerEvent, cancelled = false) => {
    const held = grab.current
    if (!held || event && held.pointerId !== event.pointerId) return
    event?.stopPropagation()
    if (held.moved && !cancelled && group) {
      onMove(group.id, held.id, held.target)
      setAnnouncement(`已移到第${held.target + 1}项`)
    }
    release()
  }
  if (!active) return null
  return <section ref={shell} className="horizon-group-detail" data-open={open} data-dragging={Boolean(dragged)} aria-label={`${active.title}组内顺序`} inert={!group}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); if (grab.current) finish(undefined, true); else onClose() } }}>
    <header className="horizon-detail-heading"><small>{DAYS[active.day]} / {active.tasks.length} 项 · {groupMinutes(active)} 分钟</small><h2>{active.title}</h2>
      <button ref={back} type="button" className="horizon-detail-back" onClick={onClose}>
        <MeasuredGlassSurface radius={20} material={{ transmission:100, blur:0, rim:40, shadow:0, reflection:10 }} />
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m9 5-5 5 5 5M4 10h12" /></svg><span>收拢这组</span>
      </button></header>
    <svg className="horizon-task-strands" aria-hidden="true"><defs>
      <linearGradient id={`${gradient}-strand`}><stop stopColor="#ddad62" stopOpacity="0" /><stop offset=".3" stopColor="#f6d18d" /><stop offset=".5" stopColor="#fffbed" /><stop offset=".7" stopColor="#f6d18d" /><stop offset="1" stopColor="#ddad62" stopOpacity="0" /></linearGradient>
    </defs>{tasks.map(task => <g key={task.id} ref={node => { if (node) paths.current.set(task.id, node); else paths.current.delete(task.id) }} data-dragged={dragged === task.id}>
      <path stroke={`url(#${gradient}-strand)`} strokeWidth="12" opacity=".15" /><path stroke={`url(#${gradient}-strand)`} strokeWidth="4" opacity=".5" /><path stroke={`url(#${gradient}-strand)`} strokeWidth="1.5" />
    </g>)}</svg>
    <div className="horizon-task-layer" role="group" aria-label="沿地平线排列的事项">{tasks.map((task, index) => <button type="button" key={task.id} className="horizon-task" data-dragged={dragged === task.id}
      ref={node => { if (node) buttons.current.set(task.id, node); else buttons.current.delete(task.id) }}
      aria-label={`第${index + 1}项，${task.title}，${task.minutes}分钟；拖动或方向键调整顺序`} onPointerDown={event => start(event, task.id)}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key) || !group || grab.current) return
        event.preventDefault(); event.stopPropagation()
        const next = Math.max(0, Math.min(tasks.length - 1, index + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 1)))
        onMove(group.id, task.id, next); setAnnouncement(`${task.title}，第${next + 1}项`)
      }}><span className="horizon-task-caption"><small>{String(index + 1).padStart(2, '0')}</small><strong>{task.title}</strong><span>{task.minutes} 分钟</span></span><i aria-hidden="true" /></button>)}</div>
    <p className="horizon-detail-hint">{dragged ? '松手，让它落回光里' : '沿着地平线，拖动事项调整先后'}</p>
    <span className="p0-sr-only" role="status">{announcement}</span>
  </section>
}
