import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { setStringFlight, setStringFlightEdgeFrame } from '../prototype/stringFlight'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { usePreferences } from './preferences'
import { cloneOrbitGroups, groupMinutes, moveOrbitGroup, moveOrbitTask, orbitDayGroups } from './orbitGroups'
import type { OrbitDay, OrbitGroup } from './orbitGroups'
import { HorizonCanvas, horizonDropIndex, horizonProjection } from './horizonScene'
import type { HorizonPoint, HorizonProjection, HorizonVisual } from './horizonScene'
import { readHorizonTuning, saveHorizonTuning } from './horizonTuning'
import { HorizonTuningPanel } from './HorizonTuningPanel'
import { HorizonGroupDetail } from './HorizonGroupDetail'
import { orbitLabelPositions } from './orbitLabels'
import { orbitTransitionDuration, orbitTransitionFrame } from './orbitTransition'
import './orbit-studio.css'
import './horizon-studio.css'

type Props = { onReveal: () => void; onClose: () => void; onSelected: (message: string) => void; onExisting: () => void }
type Target = { day: OrbitDay; index: number }
type Grab = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; offsetX: number; offsetY: number; moved: boolean; target: Target }
const DAYS = ['今天', '明天', '后天'] as const
const dateLabel = (day: OrbitDay) => {
  const date = new Date(); date.setDate(date.getDate() + day)
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(date)
}

/** One day at the edge of the black hole. Sample groups never enter the planner. */
export function HorizonStudio({ onReveal, onClose, onSelected, onExisting }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>()), destinations = useRef(new Map<OrbitDay, HTMLButtonElement>())
  const positions = useRef(new Map<string, HorizonPoint>())
  const [tuning, setTuning] = useState(readHorizonTuning), latestTuning = useRef(tuning); latestTuning.current = tuning
  const geometry = useRef<HorizonProjection>(horizonProjection(innerWidth, innerHeight, tuning))
  const [groups, setGroups] = useState(cloneOrbitGroups), groupsRef = useRef(groups); groupsRef.current = groups
  const [day, setDay] = useState<OrbitDay>(0)
  const [expanded, setExpanded] = useState<string | null>(null), [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropDay, setDropDay] = useState<OrbitDay | null>(null), [phase, setPhase] = useState<'entering' | 'ready' | 'leaving'>('entering')
  const [announcement, setAnnouncement] = useState(''), [error, setError] = useState('')
  const grab = useRef<Grab | null>(null), frame = useRef(0), flight = useRef(0), leaving = useRef(false)
  const focusAfterMove = useRef<string | null>(null)
  const callbacks = useRef({ onReveal, onClose, onSelected, onExisting }); callbacks.current = { onReveal, onClose, onSelected, onExisting }
  const preferences = usePreferences().value
  const reduced = preferences.effect.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches
  const visual = useRef<HorizonVisual>({ groups, day, tuning, reduced, reveal: 0, pointer: null, dragging: null, dropTarget: null, expanded: null })
  Object.assign(visual.current, { groups, day, tuning, reduced, expanded })
  const currentGroups = orbitDayGroups(groups, day), active = currentGroups.find(group => group.id === expanded)

  useEffect(() => {
    setStringFlightEdgeFrame({ height: tuning.height, curvature: tuning.curvature })
  }, [tuning.height, tuning.curvature])
  useEffect(() => {
    const timer = setTimeout(() => { if (!saveHorizonTuning(tuning)) setError('外观已应用，本机暂时无法保存') }, 180)
    return () => clearTimeout(timer)
  }, [tuning])
  useEffect(() => () => { saveHorizonTuning(latestTuning.current) }, [])
  useEffect(() => {
    if (focusAfterMove.current) { buttons.current.get(focusAfterMove.current)?.focus({ preventScroll: true }); focusAfterMove.current = null }
  }, [groups, day])

  const travel = useCallback((exit = false) => {
    cancelAnimationFrame(frame.current)
    const started = performance.now(), from = flight.current
    const duration = orbitTransitionDuration(exit, visual.current.reduced, visual.current.tuning.exitSeconds)
    let revealed = false
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration), next = orbitTransitionFrame(t, from, exit, visual.current.reduced)
      flight.current = next.flight; setStringFlight(next.flight, 'edge')
      visual.current.reveal = next.reveal
      dialog.current?.style.setProperty('--orbit-reveal', String(next.reveal))
      // Only the task overlay fades in; the homepage sky and disk stay visible.
      dialog.current?.style.setProperty('--orbit-darkness', '0')
      // This scene has no opaque veil: bring the workspace back only when
      // the camera is close to home, rather than over the enlarged horizon.
      if (exit && (visual.current.reduced || next.flight <= .14) && !revealed) { callbacks.current.onReveal(); revealed = true }
      if (t < 1) frame.current = requestAnimationFrame(tick)
      else if (exit) callbacks.current.onClose()
      else setPhase('ready')
    }
    frame.current = requestAnimationFrame(tick)
  }, [])
  const release = () => {
    const captured = grab.current; grab.current = null
    visual.current.dragging = null; visual.current.dropTarget = null
    if (captured && dialog.current?.hasPointerCapture(captured.pointerId)) dialog.current.releasePointerCapture(captured.pointerId)
    setDraggedId(null); setDropDay(null)
  }
  const close = useCallback(() => {
    if (leaving.current) return
    leaving.current = true; setPhase('leaving'); release(); setExpanded(null); visual.current.pointer = null; travel(true)
  }, [travel])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.showModal(); travel()
    return () => {
      grab.current = null; visual.current.dragging = null
      cancelAnimationFrame(frame.current); setStringFlight(0, 'edge')
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    }
  }, [travel])
  useEffect(() => {
    // Preferences can arrive after entry started. Honour reduced motion as
    // soon as it is known, including an exit already in progress.
    if (reduced && phase !== 'ready') travel(phase === 'leaving')
  }, [reduced, phase, travel])
  useEffect(() => {
    if (!canvas.current) return
    let renderer: HorizonCanvas
    try {
      renderer = new HorizonCanvas(canvas.current, () => visual.current, (next, projection) => {
        positions.current = next; geometry.current = projection
        const above = new Map([...next].map(([id, p]) => [id, { x: p.x, y: p.y - 105 }]))
        const labelWidth = Math.min(158, Math.max(100, projection.width * .68 / Math.max(1, next.size) - 18))
        const names = orbitLabelPositions(above, projection.width, projection.height, { labelWidth, labelHeight:58, aboveOnly:true })
        for (const [id, button] of buttons.current) {
          const p = next.get(id), name = names.get(id)
          if (!p || !name) { button.style.visibility = 'hidden'; continue }
          button.style.visibility = 'visible'
          button.style.transform = `translate3d(${p.x - 40}px,${p.y - 24}px,0)`
          const caption = button.querySelector<HTMLElement>('.orbit-group-caption')
          if (caption) { caption.style.width = `${labelWidth}px`; caption.style.transform = `translate3d(${name.x - p.x}px,${name.y - p.y}px,0) translateX(-50%)` }
          const tether = button.querySelector<HTMLElement>('.orbit-group-tether')
          if (tether) {
            const dx = name.x - p.x, dy = name.y - p.y + 29
            tether.style.height = `${Math.max(0, Math.hypot(dx, dy) - 13)}px`
            tether.style.transform = `rotate(${-Math.atan2(dx, dy)}rad)`
          }
        }
      })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法绘制地平线'); return }
    return () => renderer.destroy()
  }, [])

  const selectDay = (next: OrbitDay) => {
    if (phase !== 'ready' || grab.current) return
    setExpanded(null); setDay(next); setAnnouncement(`${DAYS[next]}，${orbitDayGroups(groupsRef.current, next).length}组`)
  }
  const start = (event: PointerEvent<HTMLButtonElement>, group: OrbitGroup) => {
    if (phase !== 'ready' || event.button !== 0 || !event.isPrimary || grab.current) return
    const point = positions.current.get(group.id)
    if (!point) return
    event.preventDefault(); event.currentTarget.focus({ preventScroll: true }); dialog.current?.setPointerCapture(event.pointerId)
    grab.current = { id: group.id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, x: point.x, y: point.y,
      offsetX: event.clientX - point.x, offsetY: event.clientY - point.y, moved: false, target: { day, index: currentGroups.findIndex(item => item.id === group.id) } }
  }
  const move = (event: PointerEvent) => {
    visual.current.pointer = { x: event.clientX, y: event.clientY }
    const current = grab.current
    if (!current || current.pointerId !== event.pointerId) return
    current.x = event.clientX - current.offsetX; current.y = event.clientY - current.offsetY
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) > 6) {
      current.moved = true; setDraggedId(current.id); setExpanded(null)
    }
    if (!current.moved) return
    let target: Target = { day, index: horizonDropIndex(current, geometry.current, groupsRef.current, day, current.id) }
    for (const [destination, button] of destinations.current) {
      const bounds = button.getBoundingClientRect()
      if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
        target = { day: destination, index: orbitDayGroups(groupsRef.current, destination).filter(group => group.id !== current.id).length }; break
      }
    }
    current.target = target; visual.current.dragging = { id: current.id, x: current.x, y: current.y }; visual.current.dropTarget = target
    setDropDay(target.day)
  }
  const finish = (event: PointerEvent, cancelled = false) => {
    const current = grab.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!cancelled && current.moved) {
      const { day: nextDay, index } = current.target
      focusAfterMove.current = current.id
      setGroups(items => moveOrbitGroup(items, current.id, nextDay, index)); setDay(nextDay)
      setAnnouncement(`${groupsRef.current.find(group => group.id === current.id)?.title}移到${DAYS[nextDay]}第${index + 1}组`)
    } else if (!cancelled) setExpanded(value => value === current.id ? null : current.id)
    release()
  }
  const keyboard = (event: KeyboardEvent, group: OrbitGroup) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const index = currentGroups.findIndex(item => item.id === group.id)
    if (event.altKey) {
      const nextDay = Math.max(0, Math.min(2, day + direction)) as OrbitDay
      if (nextDay === day) return
      focusAfterMove.current = group.id; setExpanded(null)
      setGroups(items => moveOrbitGroup(items, group.id, nextDay, orbitDayGroups(items, nextDay).length)); setDay(nextDay)
      setAnnouncement(`${group.title}移到${DAYS[nextDay]}`)
    } else { setGroups(items => moveOrbitGroup(items, group.id, day, index + direction)); setAnnouncement(`${group.title}已调整顺序`) }
  }
  const choose = () => {
    if (!saveHorizonTuning(tuning)) { setError('外观已应用，本机暂时无法保存'); return }
    callbacks.current.onSelected('已保留事件视界外观，示例排序未写入日程'); close()
  }
  return <dialog ref={dialog} className="orbit-studio horizon-studio" data-phase={phase} data-dragging={Boolean(draggedId)} data-expanded={Boolean(active)} data-reduced={reduced} tabIndex={-1}
    aria-label="弦轨事件视界，视觉预览" aria-describedby="horizon-instructions"
    onCancel={event => { event.preventDefault(); if (grab.current) release(); else if (active) setExpanded(null); else close() }}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onPointerLeave={() => { if (!grab.current) visual.current.pointer = null }} onKeyDown={event => event.stopPropagation()}>
    <canvas ref={canvas} className="orbit-canvas" aria-hidden="true" />
    <header className="orbit-heading"><h1>弦轨</h1><p>沿着光，让今天慢慢展开</p></header>
    <HorizonTuningPanel value={tuning} onChange={setTuning} disabled={phase !== 'ready' || Boolean(draggedId)} />
    <div className="horizon-day-heading">
      <GlassSamplingContext value={Boolean(draggedId)}><nav aria-label="选择哪一天" data-dropping={Boolean(draggedId)}>{([0, 1, 2] as const).map(value => <button type="button" key={value}
        ref={node => { if (node && value !== day) destinations.current.set(value, node); else destinations.current.delete(value) }}
        data-drop={Boolean(draggedId) && value !== day} data-target={Boolean(draggedId) && dropDay === value && value !== day}
        aria-pressed={day === value} disabled={phase !== 'ready' || Boolean(draggedId)} onClick={() => selectDay(value)}>
        <MeasuredGlassSurface radius={18} material={{ transmission:100, blur:0, rim:40, shadow:0, reflection:10 }} /><span>{DAYS[value]}</span>
      </button>)}</nav></GlassSamplingContext>
      <div key={day} className="horizon-day-copy"><p>{dateLabel(day)}</p><span>{currentGroups.length ? `${currentGroups.length} 组事情，沿着光依次展开` : '这一天，留给新的可能'}</span></div>
    </div>
    <div className="orbit-hit-layer" inert={Boolean(active)} aria-label={`${DAYS[day]}的示例任务组`}>
      {currentGroups.map((group, index) => <button key={group.id} type="button" className="orbit-group" data-group-id={group.id} data-day={group.day} data-active={expanded === group.id} data-dragged={draggedId === group.id}
        ref={node => { if (node) buttons.current.set(group.id, node); else buttons.current.delete(group.id) }} disabled={phase !== 'ready'}
        aria-label={`${DAYS[day]}，${group.title}，${group.tasks.length}项；方向键排序，Alt加方向键换天，回车展开`} aria-expanded={expanded === group.id}
        onPointerDown={event => start(event, group)} onKeyDown={event => keyboard(event, group)} onClick={event => { if (event.detail === 0) setExpanded(value => value === group.id ? null : group.id) }}>
        <i className="orbit-group-tether" aria-hidden="true" /><span className="orbit-group-caption"><span className="horizon-group-order" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><strong>{group.title}</strong><small>{group.tasks.length} 项 · {groupMinutes(group)} 分钟</small></span>
      </button>)}
    </div>
    <HorizonGroupDetail group={active} origin={active ? (positions.current.get(active.id)?.x ?? geometry.current.width / 2) / geometry.current.width : .5}
      tuning={tuning} reduced={reduced} onClose={() => setExpanded(null)} onMove={(groupId, taskId, index) => setGroups(items => moveOrbitTask(items, groupId, taskId, index))} />
    <div className="orbit-caption"><p>{draggedId ? dropDay !== null && dropDay !== day ? `松手，放到${DAYS[dropDay]}` : '沿光带排序 · 拖到顶部日期换天' : '拖动光带或组名排序 · 点击展开'}</p></div>
    <footer className="orbit-footer"><div><p>示例预览 · 不改动真实日程</p><button type="button" onClick={onExisting} disabled={phase !== 'ready' || Boolean(draggedId)}>现有日程排序 <span>↗</span></button></div>
      <div className="orbit-actions"><button type="button" className="orbit-cancel" onClick={close} disabled={phase === 'leaving'}>取消</button><button type="button" className="orbit-select" onClick={choose} disabled={phase !== 'ready' || Boolean(draggedId)}>保留外观</button></div>
    </footer>
    {error && <p className="orbit-error" role="alert">{error}</p>}
    <p className="p0-sr-only" id="horizon-instructions">一条地平线呈现一天，顶部切换今天、明天、后天。组名常驻。拖动组调整顺序，拖到顶部日期移动到另一天末尾。方向键调整顺序，Alt加方向键换天。点开组，事项沿地平线展开，可以拖动或用方向键调整内部顺序。Escape取消拖动或收拢组。当前使用示例，保留外观只保存本机视觉参数。</p>
    <span className="p0-sr-only" role="status">{announcement}</span>
  </dialog>
}
