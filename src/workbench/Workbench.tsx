import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Task, TaskStatus } from '../domain/task'
import type { useSpatialTasks } from '../spatial/useSpatialTasks'
import { agendaDate, deadlineLabel } from '../home/agenda'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import type { Appearance, useAppearance } from './appearance'
import { recommendationReason, taskArea, taskGroups } from './tasks'
import { useFocusTimer } from './useFocusTimer'
import { UpcomingDeadlines } from './UpcomingDeadlines'
import { buildWorkbenchBriefing, effectiveEstimate, estimateLabel } from './briefing'
import type { ScheduledMinutes } from './briefing'
import { usePlanner } from '../planner/usePlanner'
import { XixiBriefing } from './XixiBriefing'
import { WorkbenchIcon as Icon } from './WorkbenchIcon'
import { XixiInput } from './XixiInput'
import { useGlassHover } from './useGlassHover'
import { ConversationLog } from '../xixi/ConversationLog'
import { restoreWithdrawnDraft } from '../xixi/draft'
import { ConversationMenu } from '../xixi/ConversationMenu'
import { TaskHandoff } from '../xixi/CompanionPanel'
import type { Handoff } from '../xixi/companionTypes'
import { TaskSteps } from './TaskSteps'
import type { XixiConversation } from '../xixi/useXixiConversation'
import './workbench.css'
import './readability.css'
import './theme.css'
import './focus-layout.css'

type Props = { active: boolean; data: ReturnType<typeof useSpatialTasks>; now: Date; onCapture: () => void; onNotice: (message: string) => void; chat: XixiConversation; onSettings: () => void }
type Timer = ReturnType<typeof useFocusTimer>

function Glass({ appearance, children, className = '' }: { appearance: Appearance; children: ReactNode; className?: string }) {
  return <div className={`wb-glass ${className}`}>
    <MeasuredGlassSurface radius={appearance.radius} material={appearance} />
    <div className="wb-glass-content">{children}</div>
  </div>
}

export function Workbench(props: Props & { appearance: ReturnType<typeof useAppearance> }) {
  const { appearance } = props
  const hover = useGlassHover(props.active)
  const style = {
    '--wb-width': `${appearance.value.width}px`, '--wb-font': `${appearance.value.font}px`,
    '--wb-row': `${appearance.value.row}px`, '--wb-gap': `${appearance.value.gap}px`,
    '--wb-top': `${appearance.value.top}px`, '--wb-radius': `${appearance.value.radius}px`,
    '--wb-shadow': appearance.value.shadow / 100, '--wb-background': 1 - appearance.value.background / 100,
    '--wb-columns': appearance.value.columns,
    '--wb-backdrop-blur': `${appearance.value.backgroundBlur}px`,
  } as CSSProperties
  return <GlassSamplingContext.Provider value={props.active}><section className="workbench" {...hover} data-theme={appearance.value.theme} data-active={props.active} aria-label="工作台" inert={!props.active} aria-hidden={!props.active} style={style}>
    <div className="wb-background" aria-hidden="true" />
    <WorkbenchContent {...props} appearance={appearance.value} />
  </section></GlassSamplingContext.Provider>
}

function WorkbenchContent({ active, data, now, onCapture, onNotice, appearance, chat, onSettings }: Props & {
  appearance: Appearance
}) {
  const preview = false
  const timer = useFocusTimer('astaria-focus-v1')
  const planner = usePlanner(active)
  const tasks = data.tasks
  const scheduledMinutes = useMemo<ScheduledMinutes>(() => {
    const totals: Record<string, number> = {}
    for (const block of planner.state?.blocks ?? []) {
      if (!block.taskId) continue
      const [startHour, startMinute] = block.start.split(':').map(Number)
      const [endHour, endMinute] = block.end.split(':').map(Number)
      const start = startHour * 60 + startMinute
      const end = endHour * 60 + endMinute
      const minutes = end - start
      if (Number.isFinite(minutes) && minutes > 0) totals[block.taskId] = (totals[block.taskId] ?? 0) + minutes
    }
    return totals
  }, [planner.state])
  const groups = useMemo(() => taskGroups(tasks, now), [tasks, now])
  const briefing = useMemo(() => buildWorkbenchBriefing(tasks, now, timer.durations.focusMin, timer.getSpentMs, scheduledMinutes), [tasks, now, timer.durations.focusMin, timer.getSpentMs, timer.session, scheduledMinutes])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transitioning, setTransitioning] = useState(false)
  const [timingOpen, setTimingOpen] = useState(false)
  const [error, setError] = useState('')
  const [assistance, setAssistance] = useState<{ taskId: string; text: string; revision: number } | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const deadlineHeading = useRef<HTMLHeadingElement>(null)
  const [handoffRequest, setHandoffRequest] = useState<{ field: 'progress' | 'obstacle' | 'nextStep'; revision: number } | null>(null)
  const [savedHandoff, setSavedHandoff] = useState<Handoff | null>(null)
  const handoffOpener = useRef<HTMLElement | null>(null)
  const [deadlineReturnId, setDeadlineReturnId] = useState<string | null>(null)
  const taskOpener = useRef<HTMLElement | null>(null)
  const chooserScroll = useRef(0)
  const selectionFocus = useRef<{ returning: boolean; previousId: string | null } | null>(null)
  const [recentCompletion, setRecentCompletion] = useState<string | null>(null)
  const [reopeningId, setReopeningId] = useState<string | null>(null)
  const reopening = useRef(false)
  const scroll = useRef<HTMLDivElement>(null)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selected = tasks.find(task => task.id === selectedId && !task.deletedAt && task.status !== 'dropped')
  const session = timer.session?.taskId === selectedId ? timer.session : null
  const busy = Boolean(reopeningId) || (!preview && (data.saving || data.loading || Boolean(data.loadError)))
  const selectionPending = useRef<string | null>(null)
  const startContext = useRef({ active, selectedId, mounted: true })
  const startRevision = useRef(0)
  startContext.current.active = active
  startContext.current.selectedId = selectedId

  useEffect(() => {
    startRevision.current += 1
    if (!active) { timer.pause(); return }
    const frame = requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [active, timer.pause])
  useEffect(() => {
    startContext.current.mounted = true
    return () => { startContext.current.mounted = false; clearTimeout(transitionTimer.current) }
  }, [])
  useEffect(() => {
    if (selectedId && (!selected || selected.status === 'done')) timer.pause()
    if (active && selected?.status === 'done') heading.current?.focus({ preventScroll: true })
  }, [active, selectedId, selected?.status, timer.pause])
  useLayoutEffect(() => {
    if (transitioning || !selectionFocus.current) return
    const request = selectionFocus.current
    selectionFocus.current = null
    if (!active) return
    const origin = taskOpener.current?.getAttribute('data-focus-origin')
    const fromDeadline = taskOpener.current?.hasAttribute('data-deadline-id')
    const originSelector = origin ? `[data-focus-origin="${CSS.escape(origin)}"]` : `[${fromDeadline ? 'data-deadline-id' : 'data-task-id'}="${CSS.escape(request.previousId ?? '')}"]`
    const candidate = request.returning && request.previousId ? scroll.current?.querySelector<HTMLElement>(originSelector) : null
    const previous = candidate && !candidate.closest('[inert]') ? candidate : request.returning && request.previousId ? scroll.current?.querySelector<HTMLElement>(`.wb-task[data-task-id="${CSS.escape(request.previousId)}"]`) : null
    if (fromDeadline && request.returning && request.previousId) {
      // The timeline resolves its page and width in a child layout effect, then
      // animates the track. Restore focus only after that page is measurable and
      // the track has stopped moving; otherwise the parent can focus an inert
      // off-page node during the first frame at narrow widths.
      let frame = 0
      let lastGeometry = ''
      let stableFrames = 0
      const restoreDeadline = () => {
        const scroller = scroll.current
        if (!scroller) return
        const timeline = scroller.querySelector<HTMLElement>('.wb-deadline-timeline')
        const target = scroller.querySelector<HTMLElement>(originSelector)
        if (!target) {
          // Completion or an external deletion can remove the original node.
          const fallback = scroller.querySelector<HTMLElement>(`.wb-task[data-task-id="${CSS.escape(request.previousId!)}"]`) ?? heading.current
          scroller.scrollTo({ top: 0, behavior: 'instant' })
          fallback?.focus({ preventScroll: true })
          return
        }
        const chooser = scroller.querySelector<HTMLElement>('.wb-chooser')
        const moving = chooser?.getAnimations({ subtree: true }).some(animation => animation.playState === 'running' && Number.isFinite(animation.effect?.getComputedTiming().endTime))
        const box = target.getBoundingClientRect()
        const geometry = [box.left, box.top + scroller.scrollTop, box.width, box.height, scroller.scrollHeight].map(value => value.toFixed(2)).join(',')
        stableFrames = geometry === lastGeometry ? stableFrames + 1 : 0
        lastGeometry = geometry
        if (target.closest('[inert]') || timeline?.dataset.measured !== 'true' || moving || box.width === 0 || stableFrames < 2) {
          frame = requestAnimationFrame(restoreDeadline)
          return
        }
        scroller.scrollTo({ top: chooserScroll.current, behavior: 'instant' })
        const viewportBox = scroller.getBoundingClientRect()
        const targetBox = target.getBoundingClientRect()
        const offset = targetBox.top < viewportBox.top ? targetBox.top - viewportBox.top
          : targetBox.bottom > viewportBox.bottom ? targetBox.bottom - viewportBox.bottom : 0
        if (offset) scroller.scrollTo({ top: scroller.scrollTop + offset, behavior: 'instant' })
        target.focus({ preventScroll: true })
      }
      frame = requestAnimationFrame(restoreDeadline)
      return () => cancelAnimationFrame(frame)
    }
    scroll.current?.scrollTo({ top: previous ? chooserScroll.current : 0 })
    ;(previous ?? heading.current)?.focus({ preventScroll: true })
    previous?.scrollIntoView({ block: 'nearest' })
  }, [active, selectedId, transitioning])
  useEffect(() => {
    if (session?.phase !== 'finished' || !active) return
    onNotice(`${preview ? '示例 · ' : ''}${session.mode === 'focus' ? '这一轮专注结束，可以休息一下' : '休息结束，准备好再开始'}`)
  }, [session?.phase, session?.mode, active, preview, onNotice])

  const switchTo = (id: string | null) => {
    startRevision.current += 1
    clearTimeout(transitionTimer.current)
    if (id !== null) {
      taskOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
      setDeadlineReturnId(taskOpener.current?.hasAttribute('data-deadline-id') ? id : null)
      chooserScroll.current = scroll.current?.scrollTop ?? 0
    }
    timer.pause()
    setError('')
    setAssistance(null)
    setTimingOpen(false)
    setHandoffRequest(null)
    setSavedHandoff(null)
    setTransitioning(true)
    selectionPending.current = id
    const finish = () => {
      // Restore focus after React has committed the new, non-inert stage.
      selectionFocus.current = { returning: selectionPending.current === null, previousId: selectedId }
      setSelectedId(selectionPending.current)
      if (selectionPending.current) timer.selectTask(selectionPending.current)
      setTransitioning(false)
    }
    transitionTimer.current = setTimeout(finish, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150)
  }
  const updateStatus = async (task: Task, status: TaskStatus) => {
    await data.setStatus(task.id, status)
  }
  const start = async () => {
    if (!selected || busy) return
    setError('')
    const revision = startRevision.current
    try {
      if (selected.status === 'todo' && session?.mode === 'focus') await updateStatus(selected, 'doing')
      if (revision !== startRevision.current || !startContext.current.mounted || !startContext.current.active || startContext.current.selectedId !== selected.id) return
      timer.start()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时无法开始，请重试') }
  }
  const complete = async () => {
    if (!selected || busy) return
    setError('')
    try {
      await updateStatus(selected, 'done')
      timer.pause()
      setRecentCompletion(selected.id)
      onNotice(`${preview ? '示例 · ' : ''}已完成「${selected.title}」`)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '暂时未能保存，请重试') }
  }
  const leaveHandoff = (field: 'progress' | 'obstacle' | 'nextStep' = 'progress') => {
    startRevision.current += 1
    timer.pause()
    setTimingOpen(false)
    handoffOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setHandoffRequest({ field, revision: Date.now() })
  }
  const closeHandoff = () => {
    setHandoffRequest(null)
    requestAnimationFrame(() => {
      if (!startContext.current.active) return
      const opener = handoffOpener.current
      if (opener?.isConnected && !opener.closest('[inert]')) opener.focus({ preventScroll: true })
      else heading.current?.focus({ preventScroll: true })
    })
  }
  const askForSteps = () => {
    if (!selected) return
    setAssistance({ taskId: selected.id, text: `请把「${selected.title}」拆成可以逐项勾选的任务步骤，保存在当前事项中。作业要求：`, revision: Date.now() })
  }
  const reopen = async (task: Task) => {
    if (busy || reopening.current || task.status !== 'done') return
    reopening.current = true
    setReopeningId(task.id)
    setError('')
    try {
      await data.reopen(task.id, task.updatedAt)
      timer.pause()
      setRecentCompletion(current => current === task.id ? null : current)
      onNotice(`${preview ? '示例 · ' : ''}已撤回「${task.title}」的完成状态，专注记录已保留`)
      requestAnimationFrame(() => {
        if (!startContext.current.active || !startContext.current.mounted) return
        const target = selectedId === task.id ? heading.current : scroll.current?.querySelector<HTMLElement>(`.wb-task[data-task-id="${CSS.escape(task.id)}"]`)
        target?.focus({ preventScroll: true })
      })
    } catch (reason) { setError(reason instanceof Error ? reason.message : '完成状态尚未撤回，请重试') }
    finally { reopening.current = false; setReopeningId(null) }
  }
  const renderTask = (task: Task, recommended = false) => <button key={task.id} className="wb-task wb-glass" data-task-id={task.id} data-recommended={recommended} onClick={() => switchTo(task.id)} disabled={busy || transitioning}>
    <MeasuredGlassSurface radius={appearance.radius} material={appearance} />
    <span className="wb-task-body">
      <span className="wb-task-top"><strong>{task.title}</strong>{recommended ? <span className="wb-recommendation" role="img" aria-label="析熙推荐 · 本地建议" title="析熙推荐 · 本地建议"><Icon name="xixi" /></span> : <Icon name="arrow" className="wb-task-arrow" />}</span>
      <span className="wb-task-detail"><span>{task.notes || (recommended ? recommendationReason(task, now) : '从这一项开始')}</span></span>
      {appearance.metadata && <span className="wb-task-meta">
        <span className="wb-meta-value" title={`课程或分类：${taskArea(task)}`}><Icon name="book" /><span>{taskArea(task)}</span></span>
        <span className="wb-meta-value" title={task.startAt && agendaDate(task.startAt) ? '安排时间' : '截止时间'}><Icon name="calendar" /><span>{task.startAt && agendaDate(task.startAt) ? `${shortTimestamp(task.startAt, now)}安排` : task.due ? `${deadlineLabel(task, now)}截止` : '待安排'}</span></span>
        {effectiveEstimate(task, scheduledMinutes) !== undefined ? <span className="wb-meta-value" title={estimateLabel(task, scheduledMinutes) ?? '用时'}><Icon name="hourglass" /><span className="p0-sr-only">用时</span>{estimateLabel(task, scheduledMinutes)}</span> : null}
      </span>}
      {appearance.progress && timer.getSpentMs(task.id) > 0 && <span className="wb-task-spent wb-meta-value" title="累计专注"><Icon name="timer" /><span className="p0-sr-only">累计专注</span>{spentLabel(timer.getSpentMs(task.id))}</span>}
    </span>
  </button>

  return <div className="wb-scroll" data-focus={Boolean(selected && session)} ref={scroll}>
    <div className="wb-container">
      <div className="wb-toolbar"><div className="wb-location">{selected && session && <button className="wb-back wb-icon-button" aria-label={selected.status === 'done' ? '选择下一项' : '重新选择'} onClick={() => switchTo(null)} disabled={busy || transitioning}><Icon name="back" /></button>}<span className="wb-eyebrow">工作台</span></div></div>
      <div className="wb-stage" data-leaving={transitioning} inert={transitioning}>
      {selectedId === null ? <div className="wb-chooser wb-enter" key="chooser">
        <header className="wb-heading wb-overview-heading"><div><h2 ref={heading} tabIndex={-1}>想从哪开始？</h2><p>今天的重点，接下来的截止，都在这里</p></div>
          <dl className="wb-today-metrics"><div><dt>可开始</dt><dd>{!preview && (data.loading || data.loadError) ? '—' : briefing.availableCount}</dd></div><div><dt>24h 内截止</dt><dd>{!preview && (data.loading || data.loadError) ? '—' : briefing.dueSoonCount}</dd></div><div><dt>今日完成</dt><dd>{!preview && (data.loading || data.loadError) ? '—' : briefing.completedTodayCount}</dd></div></dl>
        </header>
        <div className="wb-overview-layout">
        <Glass appearance={appearance} className="wb-briefing-panel"><div className="wb-briefing-content">
          {(preview || (!data.loading && !data.loadError)) && <XixiBriefing embedded tasks={tasks} briefing={briefing} appearance={appearance} preview={preview} disabled={busy || transitioning} focusMin={timer.durations.focusMin} restMin={timer.durations.restMin} onSelect={switchTo} onCapture={onCapture} />}
          <UpcomingDeadlines embedded ref={deadlineHeading} revealTaskId={deadlineReturnId ?? undefined} appearance={appearance} tasks={tasks} now={now} disabled={busy || transitioning} loading={!preview && data.loading} error={preview ? '' : data.loadError} highlighted={false} onSelect={id => switchTo(id)} onRetry={data.retry} focusMin={timer.durations.focusMin} getSpentMs={timer.getSpentMs} scheduledMinutes={scheduledMinutes} />
        </div></Glass>
        <div className="wb-task-sections">
        {!preview && data.loading ? <p role="status" className="wb-empty">正在读取你的事项</p> : !preview && data.loadError ? <div className="wb-empty" role="alert"><p>{data.loadError}</p><button className="wb-action" onClick={data.retry}>重新读取</button></div> : <>
          <section className="wb-available" aria-labelledby="wb-available-heading"><header className="wb-section-heading"><h3 id="wb-available-heading">现在可以开始 <span>{groups.available.length}</span></h3></header>
          <div className="wb-task-grid">{groups.available.map((task, index) => renderTask(task, index === 0))}</div>
          {groups.available.length === 0 && <Glass appearance={appearance} className="wb-empty"><p>{groups.later.length ? '今天没有安排，想提前开始也可以' : '暂时没有待做的事项'}</p><button className="wb-action" onClick={onCapture}>交给析熙</button></Glass>}
          {groups.available.length > 0 && <p className="wb-rule-note">推荐暂按截止时间、进行状态与优先级排序</p>}
          </section>
          <section className="wb-later" aria-labelledby="wb-later-heading"><header className="wb-section-heading"><h3 id="wb-later-heading">稍后安排 <span>{groups.later.length}</span></h3><span>提前开始也可以</span></header><div className="wb-task-grid">{groups.later.map(task => renderTask(task))}</div>{groups.later.length === 0 && <p className="wb-section-empty">后面的时间，暂时留白</p>}</section>
          {appearance.completed && <section className="wb-completed" aria-labelledby="wb-completed-heading"><header className="wb-section-heading"><h3 id="wb-completed-heading">已完成 <span>{groups.completed.length}</span></h3><span>每一步都留在这里</span></header><div>{groups.completed.map(task => <div className="wb-completed-row" data-task-id={task.id} data-completed-id={task.id} data-recent={task.id === recentCompletion} key={task.id}><span className="wb-completed-mark" aria-hidden="true">✓</span><span>{task.title}</span><small>{task.doneAt && <time dateTime={task.doneAt}>{shortTimestamp(task.doneAt, now)}</time>}{timer.getSpentMs(task.id) > 0 && <span>专注 {spentLabel(timer.getSpentMs(task.id))}</span>}{!task.doneAt && timer.getSpentMs(task.id) === 0 && '已完成'}</small><button type="button" className="wb-icon-button wb-reopen" title="撤回完成" aria-label={`撤回完成：${task.title}`} disabled={busy || transitioning} onClick={() => void reopen(task)}><Icon name="undo" /><span className="wb-tooltip" role="tooltip">{reopeningId === task.id ? '正在撤回' : '撤回完成'}</span></button></div>)}</div>{groups.completed.length === 0 && <p className="wb-section-empty">完成的事项会留在这里</p>}</section>}
        </>}
        </div></div>
        {error && <p className="wb-error" role="alert">{error}</p>}
        <p className="wb-bottom-note">一次只专注一件事 <span>·</span> 默认 {timer.durations.focusMin} 分钟专注 / {timer.durations.restMin} 分钟休息 <button className="wb-inline-button" aria-expanded={timingOpen} onClick={() => setTimingOpen(value => !value)}>调整时长</button></p>
        <DurationControls timer={timer} open={timingOpen} />
      </div> : selected && session ? <div className="wb-focus wb-enter" key={selectedId}>
        <div className="wb-focus-layout">
          <Glass appearance={appearance} className="wb-focus-main">
            <div className="wb-focus-modes" data-mode={handoffRequest ? 'handoff' : 'focus'}>
            <div className="wb-focus-view" data-view="focus" inert={Boolean(handoffRequest)} aria-hidden={Boolean(handoffRequest)}>
            <div className="wb-focus-details">
            <span className="wb-eyebrow">{selected.status === 'done' ? '这一项，完成了' : '当前专注'}</span>
            <h2 ref={heading} tabIndex={-1}>{selected.title}</h2>
            {appearance.metadata && <p className="wb-focus-meta">{taskArea(selected)}{selected.due && ` · ${deadlineLabel(selected, now)}截止`}{effectiveEstimate(selected, scheduledMinutes) !== undefined && ` · ${estimateLabel(selected, scheduledMinutes)}`}</p>}
            <p className="wb-focus-note">{selected.notes || '先做一个能够推进它的小步骤'}</p>
            </div>
            {selected.status === 'done' ? <div className="wb-finished wb-enter"><span className="wb-finished-mark" aria-hidden="true">✓</span><p>专注了 {spentLabel(session.spentMs)}</p><div className="wb-clock-actions"><button className="wb-action" disabled={busy} onClick={() => switchTo(null)}>选择下一项</button><button type="button" className="wb-secondary wb-reopen wb-meta-value" title="撤回完成" aria-label="撤回完成" disabled={busy} onClick={() => void reopen(selected)}><Icon name="undo" /><span>{reopeningId === selected.id ? '正在撤回' : '撤回完成'}</span></button></div></div> : <>
              <div className="wb-clock-area">
                <div className="wb-clock" role="timer" aria-live="off" aria-label={`${session.mode === 'focus' ? '专注' : '休息'}剩余 ${Math.ceil(session.remainingMs / 1000)} 秒`}>{clockLabel(session.remainingMs)}</div>
                <p className="wb-clock-state" key={`${session.mode}-${session.phase}`} role="status">{clockState(session)}</p>
                {appearance.progress && <div className="wb-progress" role="progressbar" aria-label="本轮进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100 * session.elapsedMs / session.durationMs)}><span style={{ transform: `scaleX(${Math.min(1, session.elapsedMs / session.durationMs)})` }} /></div>}
                <div className="wb-clock-actions">
                  <div className="wb-focus-primary-actions">
                    {session.phase === 'finished' ? session.mode === 'focus' ? <button className="wb-action" onClick={timer.startRest}>休息 {timer.durations.restMin} 分钟</button> : <button className="wb-action" onClick={timer.nextFocus}>准备下一轮</button> : session.phase === 'running' ? <button className="wb-action" onClick={timer.pause}>暂停</button> : <button className="wb-action" disabled={busy} onClick={() => void start()}>{session.phase === 'paused' ? '继续' : '开始'}{session.mode === 'focus' ? '专注' : '休息'}</button>}
                    <button type="button" className="wb-handoff-trigger" disabled={busy || preview} onClick={() => leaveHandoff()}>留个接力</button>
                  </div>
                  {session.phase === 'finished' && session.mode === 'focus' && <button className="wb-secondary" onClick={timer.nextFocus}>继续专注</button>}
                  <button className="wb-secondary" disabled={busy} onClick={() => void complete()}>{data.saving && !preview ? '保存中' : '完成事项'}</button>
                </div>
              </div>
              <div className="wb-focus-bottom"><span className="wb-meta-value" title="累计专注"><Icon name="timer" /><span className="p0-sr-only">累计专注</span>{spentLabel(session.spentMs)}</span><button className="wb-inline-button wb-icon-button" aria-label="专注设置" data-tooltip="专注设置" aria-expanded={timingOpen} onClick={() => setTimingOpen(value => !value)}><Icon name="settings" /><span className="wb-tooltip" role="tooltip">专注设置</span></button></div>
              <DurationControls timer={timer} open={timingOpen} />
            </>}
            {savedHandoff?.taskId === selected.id && <button type="button" className="wb-handoff-summary" onClick={() => leaveHandoff('nextStep')} disabled={busy}><Icon name="check" /><span><small>已保存接力</small><span>{savedHandoff.nextStep ? `下一步：${savedHandoff.nextStep}` : savedHandoff.progress || '回来时，从这里接着做'}</span></span><Icon name="arrow" /></button>}
            {(error || timer.storageError) && <p className="wb-error" role="alert">{error || timer.storageError}</p>}
            </div>
            <div className="wb-focus-view wb-focus-handoff" data-view="handoff" inert={!handoffRequest} aria-hidden={!handoffRequest} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeHandoff() } }}>
              <header className="wb-handoff-heading"><span className="wb-eyebrow">接力现场</span><button type="button" className="wb-handoff-back" onClick={closeHandoff}><Icon name="back" />回到专注</button></header>
              <h2>{selected.title}</h2>
              <div className="wb-handoff-clock"><Icon name="timer" /><span>{clockLabel(session.remainingMs)}</span><small>{session.phase === 'paused' ? '已暂停' : '待继续'} · 累计 {spentLabel(session.spentMs)}</small></div>
              <TaskHandoff key={selected.id} taskId={selected.id} embedded disabled={busy || transitioning || !active || !handoffRequest} focusRequest={handoffRequest} onLoaded={setSavedHandoff} onSaved={value => { setSavedHandoff(value); closeHandoff(); onNotice('接力已保存，下次从这里继续') }} />
            </div>
            </div>
          </Glass>
          <Glass appearance={appearance} className="wb-focus-steps">
            <TaskSteps key={selected.id} task={selected} disabled={busy || transitioning || !active} onRequestSteps={askForSteps} />
          </Glass>
          <XixiContext key={selected.id} task={selected} now={now} active={active && !transitioning} preview={preview} appearance={appearance} chat={chat} onSettings={onSettings} assistance={assistance?.taskId === selected.id ? assistance : null} />
        </div>
      </div> : <div className="wb-empty wb-enter"><h2 ref={heading} tabIndex={-1}>这项任务已不在待办中</h2><button className="wb-action" onClick={() => switchTo(null)}>返回选择</button></div>}
      </div>
      {preview && <p className="wb-preview-footnote">示例数据仅用于体验界面，不会写入你的事项</p>}
    </div>
  </div>
}

function DurationControls({ timer, open }: { timer: Timer; open: boolean }) {
  return <div className="wb-duration-reveal" data-open={open} inert={!open} aria-hidden={!open}><div>
  <div className="wb-duration" aria-label="专注时长设置">
    <label><span>专注</span><input aria-label="专注分钟" type="range" min={5} max={120} step={5} value={timer.durations.focusMin} onChange={event => timer.setDurations({ ...timer.durations, focusMin: Number(event.target.value) })} /><output>{timer.durations.focusMin} 分钟</output></label>
    <label><span>休息</span><input aria-label="休息分钟" type="range" min={1} max={30} step={1} value={timer.durations.restMin} onChange={event => timer.setDurations({ ...timer.durations, restMin: Number(event.target.value) })} /><output>{timer.durations.restMin} 分钟</output></label>
    <small>进行中的计时保持不变，新时长从下一轮开始</small>
  </div></div></div>
}

function XixiContext({ task, now, active, preview, appearance, chat, onSettings, assistance }: { task: Task; now: Date; active: boolean; preview: boolean; appearance: Appearance; chat: XixiConversation; onSettings: () => void; assistance: { text: string; revision: number } | null }) {
  const key = `${preview ? 'preview' : 'real'}-${task.id}`
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(`astaria-xixi-${key}`) ?? '' } catch { return '' } })
  const [warning, setWarning] = useState('')
  const draftRevision = useRef(0)
  const composeForm = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (!assistance || preview) return
    setDraft(value => restoreWithdrawnDraft(value, assistance.text))
    draftRevision.current += 1
    const frame = requestAnimationFrame(() => {
      const input = composeForm.current?.querySelector('textarea')
      input?.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      input?.focus({ preventScroll: true })
      input?.setSelectionRange(input.value.length, input.value.length)
    })
    return () => cancelAnimationFrame(frame)
  }, [assistance, preview])
  useEffect(() => {
    try { sessionStorage.setItem(`astaria-xixi-${key}`, draft); setWarning('') }
    catch { setWarning('草稿暂未保存，离开前请复制') }
  }, [key, draft])
  const send = async () => {
    if (preview || chat.busy || !draft.trim()) return
    const sent = draft
    const revision = draftRevision.current
    if (await chat.send(sent, { page: 'workbench', taskId: task.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })) {
      if (revision !== draftRevision.current) return
      // The focus panel may have closed while the reply was arriving.
      // Clear the persisted draft even when that component is now unmounted.
      try { if (sessionStorage.getItem(`astaria-xixi-${key}`) === sent) sessionStorage.removeItem(`astaria-xixi-${key}`) } catch { /* The current draft remains available in memory. */ }
      setDraft(value => value === sent ? '' : value)
    }
  }
  const clearSentDraft = (sent: string) => {
    try { if (sessionStorage.getItem(`astaria-xixi-${key}`)?.trim() === sent) sessionStorage.removeItem(`astaria-xixi-${key}`) } catch { /* Keep the current draft in memory if session storage is unavailable. */ }
    setDraft(value => value.trim() === sent ? '' : value)
  }
  const restoreDraft = (text: string) => {
    draftRevision.current += 1
    setDraft(value => restoreWithdrawnDraft(value, text))
    requestAnimationFrame(() => {
      const input = composeForm.current?.querySelector('textarea')
      input?.focus({ preventScroll: true })
      input?.setSelectionRange(input.value.length, input.value.length)
    })
  }
  return <Glass appearance={appearance} className="wb-xixi">
    <header><strong>析熙</strong><ConversationMenu chat={chat} disabled={preview} /></header>
    <div className="wb-xixi-context"><span>正在一起看</span><p>{task.title}</p>{task.due && <small>{deadlineLabel(task, now)}截止</small>}</div>
    {preview ? <p className="xixi-preview-message">这里是示例事项，退出示例后就可以和我聊真实安排</p>
      : <ConversationLog chat={chat} active={active} onSettings={onSettings} context={{ page: 'workbench', taskId: task.id, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }} onSent={clearSentDraft} onRetracted={restoreDraft} />}
    <form ref={composeForm} className="xixi-compose" onSubmit={event => { event.preventDefault(); void send() }}>
      <label className="p0-sr-only" htmlFor="wb-xixi-input">结合当前事项和析熙对话</label>
      <XixiInput value={draft} onChange={setDraft} disabled={chat.busy} onSubmit={() => void send()} />
      <footer><small>{warning || (preview ? '示例草稿不会发送' : 'Enter 发送 · Shift + Enter 换行')}</small><button type="submit" className="wb-action xixi-send" disabled={preview || chat.busy || chat.loading || !draft.trim()}>{chat.sending ? '正在想' : '发给析熙'}</button></footer>
      {!preview && chat.error && <p className="xixi-send-error" role="alert">{chat.error}{!chat.status?.configured && <button type="button" className="xixi-text-button" onClick={onSettings}>打开设置</button>}</p>}
    </form>
  </Glass>
}

function clockLabel(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}
function shortTimestamp(value: string, now: Date) {
  const date = agendaDate(value)
  if (!date) return '时间待确认'
  const day = new Intl.DateTimeFormat('zh-CN', { ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}), month: 'numeric', day: 'numeric' }).format(date)
  return value.length === 10 ? day : `${day} ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)}`
}
function spentLabel(ms: number) {
  return ms < 60000 ? `${Math.floor(ms / 1000)} 秒` : `${Math.floor(ms / 60000)} 分钟`
}
function clockState(session: NonNullable<Timer['session']>) {
  if (session.phase === 'finished') return session.mode === 'focus' ? '这一轮结束了，任务由你决定何时完成' : '休息结束，准备好再开始'
  if (session.phase === 'paused') return '已暂停，进度留在这里'
  if (session.phase === 'ready') return '准备好了，就开始'
  return session.mode === 'focus' ? '现在，只做这一件事' : '休息一下，暂时放下任务'
}
