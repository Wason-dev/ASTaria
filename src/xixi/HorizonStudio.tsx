import { useCallback, useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { setStringFlight, setStringFlightEdgeFrame } from '../prototype/stringFlight'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import { usePreferences } from './preferences'
import { localDay } from '../home/agenda'
import { notifyLocalDataChange } from '../stores/migration'
import { LocalApiError, localApi } from './api'
import { horizonDate, horizonDraft, horizonPage } from './horizonOrder'
import type { HorizonSnapshot } from './horizonOrder'
import { advanceHorizonActivity, advanceHorizonProgress, horizonOrderApi, horizonProgressCopy } from './horizonProgress'
import type { HorizonProgress } from './horizonProgress'
import { horizonGroupingApi } from './horizonGroupingApi'
import { HorizonGroupEditor } from './HorizonGroupEditor'
import { groupMinutes, moveOrbitGroup, moveOrbitTask, orbitDayGroups } from './orbitGroups'
import type { OrbitDay, OrbitGroup } from './orbitGroups'
import { HorizonCanvas, horizonDropIndex, horizonPoint, horizonProjection } from './horizonScene'
import type { HorizonPoint, HorizonProjection, HorizonVisual } from './horizonScene'
import { readHorizonTuning } from './horizonTuning'
import { HorizonGroupDetail } from './HorizonGroupDetail'
import { orbitTransitionDuration, orbitTransitionFrame } from './orbitTransition'
import './orbit-studio.css'
import './horizon-studio.css'

type Props = { onReveal: () => void; onClose: () => void; onSaved: (message: string) => void }
type Target = { day: OrbitDay; index: number }
type Grab = { id: string; pointerId: number; startX: number; startY: number; x: number; y: number; offsetX: number; offsetY: number; moved: boolean; target: Target }
const DAYS = ['今天', '明天', '后天'] as const
const dateLabel = (base: string, day: OrbitDay) => {
  const date = new Date(`${horizonDate(base, day)}T12:00:00`)
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' }).format(date)
}

/** A local draft of three days of actual scheduled work, committed only on completion. */
export function HorizonStudio({ onReveal, onClose, onSaved }: Props) {
  const dialog = useRef<HTMLDialogElement>(null), canvas = useRef<HTMLCanvasElement>(null)
  const buttons = useRef(new Map<string, HTMLButtonElement>()), destinations = useRef(new Map<OrbitDay, HTMLButtonElement>())
  const positions = useRef(new Map<string, HorizonPoint>())
  const [tuning] = useState(readHorizonTuning)
  const geometry = useRef<HorizonProjection>(horizonProjection(innerWidth, innerHeight, tuning))
  const [groups, setGroups] = useState<OrbitGroup[]>([]), groupsRef = useRef(groups); groupsRef.current = groups
  const [snapshot, setSnapshot] = useState<HorizonSnapshot | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [refreshNeeded, setRefreshNeeded] = useState(false)
  const [uncertain, setUncertain] = useState(false), [showFixed, setShowFixed] = useState(false)
  const [progress, setProgress] = useState<HorizonProgress>({ phase: 'submitting', completed: [] })
  const [elapsed, setElapsed] = useState(0)
  const [showActivities, setShowActivities] = useState(false)
  const [suggesting, setSuggesting] = useState(false), [groupEditor, setGroupEditor] = useState(false)
  const [groupingNote, setGroupingNote] = useState('')
  const [manualDirty, setManualDirty] = useState(false)
  const suggestion = useRef<AbortController | null>(null), suggestionVersion = useRef(0)
  const submission = useRef<AbortController | null>(null), submissionStarted = useRef(0)
  const mounted = useRef(false), saving = useRef(false), loadVersion = useRef(0)
  const operation = useRef({ id: crypto.randomUUID(), draft: '' })
  const [page, setPage] = useState(0), [pageSize, setPageSize] = useState(() => Math.max(1, Math.min(5, Math.floor(innerWidth * .68 / 170))))
  const pageButtons = useRef(new Map<number, HTMLButtonElement>())
  const [day, setDay] = useState<OrbitDay>(0)
  const [expanded, setExpanded] = useState<string | null>(null), [draggedId, setDraggedId] = useState<string | null>(null)
  const [dropDay, setDropDay] = useState<OrbitDay | null>(null), [phase, setPhase] = useState<'entering' | 'ready' | 'leaving'>('entering')
  const [announcement, setAnnouncement] = useState(''), [error, setError] = useState('')
  const grab = useRef<Grab | null>(null), frame = useRef(0), flight = useRef(0), leaving = useRef(false)
  const focusAfterMove = useRef<string | null>(null)
  const callbacks = useRef({ onReveal, onClose, onSaved }); callbacks.current = { onReveal, onClose, onSaved }
  const preferences = usePreferences().value
  const reduced = preferences.effect.motion === 'reduced' || (preferences.effect.motion === 'system' && matchMedia('(prefers-reduced-motion: reduce)').matches)
  const visual = useRef<HorizonVisual>({ groups, day, tuning, reduced, reveal: 0, pointer: null, dragging: null, dropTarget: null, expanded: null })
  const view = horizonPage(groups, day, page, pageSize)
  const progressCopy = horizonProgressCopy(progress, elapsed)
  const processing = busy || suggesting
  const workingIds = processing ? progressCopy.activity?.itemIds ?? [] : []
  Object.assign(visual.current, { groups: view.visible, day, tuning, reduced, expanded, working: processing ? { itemIds: workingIds } : null })
  const currentGroups = view.all, active = currentGroups.find(group => group.id === expanded)
  const baseDate = snapshot?.date ?? localDay(new Date())
  const fixed = snapshot?.items.filter(item => !item.movable && item.date === horizonDate(baseDate, day)) ?? []
  const editable = phase === 'ready' && !loading && !processing && !groupEditor && !refreshNeeded && !uncertain && Boolean(snapshot)
  const changed = Boolean(snapshot && JSON.stringify(horizonDraft(groups)) !== JSON.stringify(horizonDraft(snapshot.groups)))
  const needsReschedule = snapshot?.items.some(item => item.movable && item.needsReschedule) ?? false
  const previousActivities = progressCopy.activities.slice(0, -1)
  const recentActivities = showActivities ? previousActivities : previousActivities.slice(-1)

  useEffect(() => {
    if (!processing) return
    const timer = window.setInterval(() => setElapsed(Math.floor((performance.now() - submissionStarted.current) / 1000)), 1000)
    return () => window.clearInterval(timer)
  }, [processing])

  const cancelSuggestion = useCallback(() => {
    suggestionVersion.current++; suggestion.current?.abort(); suggestion.current = null; setSuggesting(false)
  }, [])
  const suggestGroups = useCallback(async (current: HorizonSnapshot) => {
    suggestion.current?.abort()
    const version = ++suggestionVersion.current, controller = new AbortController()
    suggestion.current = controller; setSuggesting(true); setGroupingNote(''); setExpanded(null); setShowActivities(false)
    submissionStarted.current = performance.now(); setElapsed(0); setProgress({ phase: 'submitting', completed: [], activities: [] })
    const active = () => mounted.current && !leaving.current && version === suggestionVersion.current && !controller.signal.aborted
    try {
      const result = await horizonGroupingApi(current, crypto.randomUUID(),
        next => { if (active()) setProgress(value => advanceHorizonProgress(value, next)) }, controller.signal,
        activity => { if (active()) setProgress(value => advanceHorizonActivity(value, activity)) })
      if (!active()) return
      setGroups(result.groups); setManualDirty(false); setPage(0); setGroupingNote('智能分组已备好，可以继续调整；完成后才会保存')
    } catch (reason) {
      if (active()) {
        if (reason instanceof LocalApiError && reason.status === 409) {
          setRefreshNeeded(true); setGroupingNote('日程已变化，请重新读取后继续调整分组')
        } else setGroupingNote(`智能分组暂未完成，已保留原分组，可直接调整${reason instanceof LocalApiError ? `：${reason.message}` : ''}`)
      }
    } finally { if (version === suggestionVersion.current) { suggestion.current = null; if (mounted.current) setSuggesting(false) } }
  }, [])

  const refresh = useCallback(async () => {
    const version = ++loadVersion.current
    cancelSuggestion(); setLoading(true); setError(''); setGroupingNote(''); setExpanded(null); setGroupEditor(false)
    try {
      const next = await localApi<HorizonSnapshot>('/companion/horizon-order')
      if (!mounted.current || leaving.current || version !== loadVersion.current) return
      setSnapshot(next); setGroups(next.groups); setManualDirty(false); setPage(0); setDay(0)
      operation.current = { id: crypto.randomUUID(), draft: '' }
      setRefreshNeeded(false); setUncertain(false)
      if (!next.groupingSaved && next.items.filter(item => item.movable).length >= 2) void suggestGroups(next)
    } catch (reason) { if (mounted.current && version === loadVersion.current) setError(reason instanceof Error ? reason.message : '暂时无法读取安排，请重试') }
    finally { if (mounted.current && version === loadVersion.current) setLoading(false) }
  }, [cancelSuggestion, suggestGroups])
  useEffect(() => {
    const resize = () => setPageSize(Math.max(1, Math.min(5, Math.floor(innerWidth * .68 / 170))))
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [])

  useEffect(() => {
    setStringFlightEdgeFrame({ height: tuning.height, curvature: tuning.curvature })
  }, [tuning.height, tuning.curvature])
  useEffect(() => {
    if (focusAfterMove.current) { buttons.current.get(focusAfterMove.current)?.focus({ preventScroll: true }); focusAfterMove.current = null }
  }, [groups, day, page])

  const travel = useCallback((exit = false) => {
    cancelAnimationFrame(frame.current)
    const started = performance.now(), from = flight.current
    const duration = orbitTransitionDuration(exit, visual.current.reduced, visual.current.tuning.exitSeconds)
    const initialUi = Number(dialog.current?.style.getPropertyValue('--horizon-ui-reveal') || visual.current.reveal)
    const tick = (now: number) => {
      const t = Math.min(1, (now - started) / duration), next = orbitTransitionFrame(t, from, exit, visual.current.reduced)
      flight.current = next.flight; setStringFlight(next.flight, 'edge')
      visual.current.reveal = next.reveal
      dialog.current?.style.setProperty('--orbit-reveal', String(next.reveal))
      // Reading controls leave promptly while the configured camera pullback
      // and light band continue at their own pace (even with a long exit).
      const fade = Math.min(1, (now - started) / Math.min(360, duration))
      const uiReveal = exit ? initialUi * (1 - fade * fade * (3 - 2 * fade)) : next.reveal
      dialog.current?.style.setProperty('--horizon-ui-reveal', String(uiReveal))
      // Only the task overlay fades in; the homepage sky and disk stay visible.
      dialog.current?.style.setProperty('--orbit-darkness', '0')
      if (t < 1) frame.current = requestAnimationFrame(tick)
      else if (exit) {
        // Reveal and unmount the destination in the same frame. Revealing it
        // while this transparent dialog is still mounted briefly exposes the
        // retained page underneath and produces a dark-then-bright flash.
        callbacks.current.onReveal()
        callbacks.current.onClose()
      }
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
    if (leaving.current || saving.current) return
    cancelSuggestion()
    // Retain the visible layer through the fade so hidden group labels do not
    // flash back into view when exiting directly from a group's details.
    leaving.current = true; setPhase('leaving'); release(); visual.current.pointer = null; travel(true)
  }, [travel, cancelSuggestion])
  useEffect(() => {
    mounted.current = true
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const element = dialog.current
    if (element && !element.open) element.showModal()
    travel(); void refresh()
    return () => {
      mounted.current = false; loadVersion.current++
      submission.current?.abort()
      suggestionVersion.current++; suggestion.current?.abort()
      grab.current = null; visual.current.dragging = null
      cancelAnimationFrame(frame.current); setStringFlight(0, 'edge')
      element?.close()
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
    }
  }, [travel, refresh])
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
        const progressEdge = .5 - Math.min(540, projection.width - 48) / projection.width / 2
        const progressCeiling = horizonPoint(projection, progressEdge).y + 20
        dialog.current?.style.setProperty('--horizon-progress-height', `${Math.max(100, Math.min(180, projection.height - 102 - progressCeiling))}px`)
        const labelWidth = Math.min(158, Math.max(100, projection.width * .68 / Math.max(1, next.size) - 18))
        const heldId = visual.current.dragging?.id, held = heldId ? next.get(heldId) : undefined
        for (const [id, button] of buttons.current) {
          const p = next.get(id)
          if (!p) { button.style.visibility = 'hidden'; continue }
          // Paging leaves room for every name. Keep each one tethered to its
          // strand during a swap instead of collision detection moving it up
          // an entire row. Neighbours quietly yield to the lifted strand.
          const name = { x: Math.max(labelWidth / 2 + 14, Math.min(projection.width - labelWidth / 2 - 14, p.x)), y: p.y - 76 }
          button.style.visibility = 'visible'
          button.style.transform = `translate3d(${p.x - 40}px,${p.y - 24}px,0)`
          const caption = button.querySelector<HTMLElement>('.orbit-group-caption')
          if (caption) {
            const distance = held && heldId !== id ? Math.hypot((p.x - held.x) / (labelWidth + 20), (p.y - held.y) / 70) : 1
            const separation = Math.min(1, distance)
            caption.style.opacity = String(.18 + .82 * separation * separation * (3 - 2 * separation))
            caption.style.width = `${labelWidth}px`; caption.style.transform = `translate3d(${name.x - p.x}px,${name.y - p.y}px,0) translateX(-50%)`
          }
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
    if (phase !== 'ready' || processing || groupEditor || grab.current) return
    setExpanded(null); setShowFixed(false); setDay(next); setPage(0); setAnnouncement(`${DAYS[next]}，${orbitDayGroups(groupsRef.current, next).length}组`)
  }
  const start = (event: PointerEvent<HTMLButtonElement>, group: OrbitGroup) => {
    if (!editable || event.button !== 0 || !event.isPrimary || grab.current) return
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
    let target: Target = { day, index: view.offset + horizonDropIndex(current, geometry.current, view.visible, day, current.id) }
    for (const [destination, button] of destinations.current) {
      const bounds = button.getBoundingClientRect()
      if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
        target = { day: destination, index: orbitDayGroups(groupsRef.current, destination).filter(group => group.id !== current.id).length }; break
      }
    }
    for (const [direction, button] of pageButtons.current) {
      const bounds = button.getBoundingClientRect()
      if (!button.disabled && event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) {
        target = { day, index: direction < 0 ? Math.max(0, view.offset - 1) : Math.min(currentGroups.length - 1, view.offset + view.visible.length) }
      }
    }
    current.target = target; visual.current.dragging = { id: current.id, x: current.x, y: current.y }; visual.current.dropTarget = target.day === day ? { day, index: target.index - view.offset } : target
    setDropDay(target.day)
  }
  const finish = (event: PointerEvent, cancelled = false) => {
    const current = grab.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!cancelled && current.moved) {
      const { day: nextDay, index } = current.target
      focusAfterMove.current = current.id
      setGroups(items => moveOrbitGroup(items, current.id, nextDay, index)); setManualDirty(true); setDay(nextDay); setPage(Math.floor(index / pageSize))
      setAnnouncement(`${groupsRef.current.find(group => group.id === current.id)?.title}移到${DAYS[nextDay]}第${index + 1}组`)
    } else if (!cancelled) setExpanded(value => value === current.id ? null : current.id)
    release()
  }
  const keyboard = (event: KeyboardEvent, group: OrbitGroup) => {
    if (!editable) return
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const direction = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1
    const index = currentGroups.findIndex(item => item.id === group.id)
    if (event.altKey) {
      const nextDay = Math.max(0, Math.min(2, day + direction)) as OrbitDay
      if (nextDay === day) return
      focusAfterMove.current = group.id; setExpanded(null)
      setPage(Math.floor(orbitDayGroups(groups, nextDay).length / pageSize))
      setGroups(items => moveOrbitGroup(items, group.id, nextDay, orbitDayGroups(items, nextDay).length)); setManualDirty(true); setDay(nextDay)
      setAnnouncement(`${group.title}移到${DAYS[nextDay]}`)
    } else { focusAfterMove.current = group.id; setPage(Math.floor(Math.max(0, Math.min(currentGroups.length - 1, index + direction)) / pageSize)); setGroups(items => moveOrbitGroup(items, group.id, day, index + direction)); setManualDirty(true); setAnnouncement(`${group.title}已调整顺序`) }
  }
  const choose = async () => {
    if (saving.current || suggesting || groupEditor || loading || phase !== 'ready') return
    if (!snapshot || refreshNeeded) { await refresh(); return }
    if (!changed && !uncertain && !needsReschedule) { close(); return }
    const draft = horizonDraft(groupsRef.current), signature = JSON.stringify(draft)
    if (operation.current.draft !== signature) operation.current = { id: crypto.randomUUID(), draft: signature }
    saving.current = true; setBusy(true); setError(''); setGroupingNote(''); setExpanded(null); setShowFixed(false); release()
    submissionStarted.current = performance.now(); setElapsed(0); setShowActivities(false); setProgress({ phase: 'submitting', completed: [], activities: [] })
    const controller = new AbortController(); submission.current = controller
    try {
      const result = await horizonOrderApi({ date: snapshot.date, groups: draft,
        expectedRevision: snapshot.revision, snapshotKey: snapshot.snapshotKey, requestId: operation.current.id },
      next => { if (mounted.current) setProgress(current => advanceHorizonProgress(current, next)) }, controller.signal,
      activity => { if (mounted.current) setProgress(current => advanceHorizonActivity(current, activity)) })
      if (!mounted.current) return
      notifyLocalDataChange(); callbacks.current.onSaved(result.summary)
      saving.current = false; setBusy(false); close()
    } catch (reason) {
      if (mounted.current) {
        const unknown = !(reason instanceof LocalApiError)
        setUncertain(unknown)
        setError(unknown ? '保存结果尚未确认，请重试完成以核对结果' : reason.message)
        setRefreshNeeded(reason instanceof LocalApiError && reason.status === 409)
      }
    } finally { saving.current = false; submission.current = null; if (mounted.current) setBusy(false) }
  }
  return <dialog ref={dialog} className="orbit-studio horizon-studio" data-phase={phase} data-busy={processing} data-dragging={Boolean(draggedId)} data-expanded={Boolean(active)} data-reduced={reduced} data-editing={groupEditor} tabIndex={-1}
    aria-label="弦轨事件视界" aria-describedby="horizon-instructions"
    onCancel={event => { event.preventDefault(); if (saving.current) return; if (groupEditor) setGroupEditor(false); else if (grab.current) release(); else if (active) setExpanded(null); else close() }}
    onPointerMove={move} onPointerUp={event => finish(event)} onPointerCancel={event => finish(event, true)} onLostPointerCapture={event => finish(event, true)}
    onPointerLeave={() => { if (!grab.current) visual.current.pointer = null }} onKeyDown={event => event.stopPropagation()}>
    <div inert={groupEditor} aria-hidden={groupEditor || undefined}>
    <canvas ref={canvas} className="orbit-canvas" aria-hidden="true" />
    <header className="orbit-heading"><h1>弦轨</h1><p>沿着光，让今天慢慢展开</p></header>
    <div className="horizon-day-heading">
      <GlassSamplingContext value={Boolean(draggedId)}><nav aria-label="选择哪一天" data-dropping={Boolean(draggedId)}>{([0, 1, 2] as const).map(value => <button type="button" key={value}
        ref={node => { if (node && value !== day) destinations.current.set(value, node); else destinations.current.delete(value) }}
        data-drop={Boolean(draggedId) && value !== day} data-target={Boolean(draggedId) && dropDay === value && value !== day}
        aria-pressed={day === value} disabled={phase !== 'ready' || processing || groupEditor || Boolean(draggedId)} onClick={() => selectDay(value)}>
        <MeasuredGlassSurface radius={18} material={{ transmission:100, blur:0, rim:40, shadow:0, reflection:10 }} /><span>{DAYS[value]}</span>
      </button>)}</nav></GlassSamplingContext>
      <div key={day} className="horizon-day-copy"><p>{dateLabel(baseDate, day)}</p><span>{loading ? '正在读取你的安排' : suggesting ? '析熙正在建议怎样分组 · 可以随时改为手动' : busy ? progressCopy.current : !snapshot ? '暂时无法读取安排' : currentGroups.length ? `${currentGroups.length} 组事情，沿着光依次展开` : '这一天没有待重排的安排'}</span></div>
    </div>
    <div className="orbit-hit-layer" inert={Boolean(active) || !editable} aria-label={`${DAYS[day]}的任务组`}>
      {view.visible.map((group, index) => <button key={group.id} type="button" className="orbit-group" data-group-id={group.id} data-day={group.day} data-active={expanded === group.id} data-dragged={draggedId === group.id} data-working={group.tasks.some(task => workingIds.includes(task.id))}
        ref={node => { if (node) buttons.current.set(group.id, node); else buttons.current.delete(group.id) }} disabled={!editable}
        aria-label={`${DAYS[day]}，${group.title}，${group.tasks.length}项；方向键排序，Alt加方向键换天，回车展开`} aria-expanded={expanded === group.id}
        onPointerDown={event => start(event, group)} onKeyDown={event => keyboard(event, group)} onClick={event => { if (editable && event.detail === 0) setExpanded(value => value === group.id ? null : group.id) }}>
        <i className="orbit-group-tether" aria-hidden="true" /><span className="orbit-group-caption"><span className="horizon-group-order">{String(view.offset + index + 1).padStart(2, '0')}{group.tasks.some(task => task.needsReschedule) && <span className="horizon-reschedule">待重新安排</span>}</span><strong>{group.title}</strong><small>{group.tasks.length} 项 · {groupMinutes(group)} 分钟</small></span>
      </button>)}
    </div>
    <HorizonGroupDetail group={active} origin={active ? (positions.current.get(active.id)?.x ?? geometry.current.width / 2) / geometry.current.width : .5}
      tuning={tuning} reduced={reduced} disabled={!editable} onClose={() => setExpanded(null)} onMove={(groupId, taskId, index) => { if (editable) { setGroups(items => moveOrbitTask(items, groupId, taskId, index)); setManualDirty(true) } }} />
    {!active && !processing && view.count > 1 && <nav className="horizon-browse" aria-label="浏览任务组">
      {([-1, 1] as const).map(direction => <button key={direction} type="button" ref={node => { if (node) pageButtons.current.set(direction, node); else pageButtons.current.delete(direction) }}
        disabled={!editable || (direction < 0 ? view.page === 0 : view.page === view.count - 1)}
        onClick={() => setPage(view.page + direction)} aria-label={direction < 0 ? '前面的组' : '后面的组'}>{direction < 0 ? '‹' : '›'}</button>)}
      <span>{view.offset + 1}–{view.offset + view.visible.length} / {currentGroups.length} 组</span>
    </nav>}
    {processing ? <section className="horizon-progress" aria-label={suggesting ? '智能分组进度' : '安排进度'} data-step={progress.phase} data-expanded={showActivities}>
      <div className="horizon-progress-line"><span className="horizon-progress-light" aria-hidden="true" /><span role="status" aria-live="polite" aria-atomic="true">{progressCopy.activity?.title ?? (suggesting ? '正在读取事项，准备智能分组' : progressCopy.current)}</span><span className="horizon-progress-elapsed" aria-label={`已用时 ${progressCopy.elapsed}`}>{progressCopy.elapsed}</span></div>
      {progressCopy.activity && <p className="horizon-progress-context"><span>{progressCopy.activity.source === 'model' ? '模型建议 · 尚未保存' : '本地核验'}{progressCopy.activity.day === undefined ? '' : ` · ${DAYS[progressCopy.activity.day]}`}</span>{progressCopy.activity.detail && <span title={progressCopy.activity.detail}>{progressCopy.activity.detail}</span>}</p>}
      {recentActivities.length > 0 && <ol className="horizon-progress-trail" aria-label="具体活动轨迹">{recentActivities.map(activity => <li key={`${activity.source}:${activity.id}`} data-state={activity.state} data-source={activity.source}><span aria-hidden="true">{activity.state === 'done' ? '✓' : activity.source === 'model' ? '◇' : '·'}</span><div><span className="horizon-activity-source">{activity.source === 'model' ? '模型建议' : '本地'}</span><span>{activity.title}</span>{showActivities && activity.detail && <small>{activity.detail}</small>}</div></li>)}</ol>}
      {progressCopy.activities.length > 2 && <button type="button" className="horizon-progress-expand" aria-expanded={showActivities} onClick={() => setShowActivities(value => !value)}>{showActivities ? '收起活动轨迹' : `查看 ${progressCopy.activities.length} 条活动`}</button>}
      {progressCopy.reassurance && !showActivities && <p className="horizon-progress-note">{suggesting ? '仍在等待分组建议，可以直接选择「调整分组」' : progressCopy.reassurance}</p>}
    </section> : <div className="orbit-caption"><p>{draggedId ? dropDay !== null && dropDay !== day ? `松手，放到${DAYS[dropDay]}` : '沿光带排序 · 拖到顶部日期换天' : uncertain ? '保存结果待核对，请重试完成' : groupingNote || (needsReschedule ? '有未完成事项错过原时段 · 完成为它们重新找空档' : changed ? '完成后保存新顺序 · 取消保留原安排' : currentGroups.length ? '拖动光带或组名排序 · 点击展开' : '')}</p></div>}
    <footer className="orbit-footer"><div className="horizon-tools"><div className="horizon-group-controls">
      <button type="button" title={manualDirty ? '先完成当前手动调整，再请求新的智能分组' : '请析熙按事项内容与关联重新建议分组'} disabled={loading || busy || suggesting || manualDirty || uncertain || refreshNeeded || !snapshot || phase !== 'ready' || groupEditor} onClick={() => { if (snapshot && !manualDirty) void suggestGroups(snapshot) }}>智能整理</button>
      <button type="button" disabled={loading || busy || uncertain || refreshNeeded || !snapshot || phase !== 'ready' || groupEditor} onClick={() => { cancelSuggestion(); setGroupingNote(''); setExpanded(null); setGroupEditor(true) }}>调整分组</button>
      {suggesting && <button type="button" onClick={() => { cancelSuggestion(); setGroupingNote('已停止等待，当前分组保留') }}>停止等待</button>}
    </div><div className="horizon-fixed">
      {fixed.length > 0 && <button type="button" aria-expanded={showFixed} disabled={processing || phase !== 'ready' || groupEditor} onClick={() => setShowFixed(value => !value)}>{fixed.length} 项固定安排</button>}
      {showFixed && <ul>{fixed.map(item => <li key={item.id}><span>{item.start}–{item.end}</span><strong>{item.title}</strong><small>{item.reason ?? '保持原安排'}</small></li>)}</ul>}
    </div></div>
      <div className="orbit-actions"><button type="button" className="orbit-cancel" onClick={close} disabled={busy || phase === 'leaving' || groupEditor}>{uncertain ? '返回' : '取消'}</button><button type="button" className="orbit-select" onClick={() => void choose()} disabled={processing || groupEditor || loading || phase !== 'ready' || Boolean(draggedId)}>{busy ? '安排中' : refreshNeeded || !snapshot ? '重新读取' : uncertain ? '重试完成' : '完成'}</button></div>
    </footer>
    {error && <p className="orbit-error" role="alert">{error}{refreshNeeded && <span>重新读取会以最新日程替换当前草稿</span>}</p>}
    <p className="p0-sr-only" id="horizon-instructions">一条地平线呈现一天，顶部切换今天、明天、后天。组名常驻。拖动组调整顺序，拖到顶部日期移动到另一天末尾。方向键调整顺序，Alt加方向键换天。点开组，事项沿地平线展开，可以拖动或用方向键调整内部顺序。Escape取消拖动或收拢组。任务多时可翻页查看；拖到左右翻页按钮或使用方向键可跨页移动。完成后析熙根据所选日期和顺序重新安排具体时间，取消不提交。外观在设置中调整。</p>
    <span className="p0-sr-only" role="status">{announcement}</span>
    </div>
    {groupEditor && <HorizonGroupEditor groups={groups} disabled={busy} onClose={() => setGroupEditor(false)} onChange={next => { cancelSuggestion(); setGroups(next); setManualDirty(true); setPage(0); setGroupingNote('分组已调整，完成后才会保存') }} />}
  </dialog>
}
