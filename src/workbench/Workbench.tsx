import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Task, TaskStatus } from '../domain/task'
import type { useSpatialTasks } from '../spatial/useSpatialTasks'
import { agendaDate, deadlineLabel } from '../home/agenda'
import { MeasuredGlassSurface } from '../home/GlassSurface'
import { AppearanceControls } from './AppearanceControls'
import { useAppearance } from './appearance'
import type { Appearance } from './appearance'
import { previewTasks, recommendationReason, taskArea, taskGroups } from './tasks'
import { useFocusTimer } from './useFocusTimer'
import { DeadlineSummary, UpcomingDeadlines } from './UpcomingDeadlines'
import { DESIGN_PREVIEW } from './designPreview'
import './workbench.css'

type Props = { active: boolean; deadlineRequest: number; data: ReturnType<typeof useSpatialTasks>; now: Date; onCapture: () => void; onNotice: (message: string) => void }
type Timer = ReturnType<typeof useFocusTimer>

function Glass({ appearance, children, className = '' }: { appearance: Appearance; children: ReactNode; className?: string }) {
  return <div className={`wb-glass ${className}`}>
    <MeasuredGlassSurface radius={appearance.radius} material={appearance} />
    <div className="wb-glass-content">{children}</div>
  </div>
}

export function Workbench(props: Props) {
  const appearance = useAppearance()
  const [customize, setCustomize] = useState(false)
  const [preview, setPreview] = useState(false)
  const style = {
    '--wb-width': `${appearance.value.width}px`, '--wb-font': `${appearance.value.font}px`,
    '--wb-row': `${appearance.value.row}px`, '--wb-gap': `${appearance.value.gap}px`,
    '--wb-top': `${appearance.value.top}px`, '--wb-radius': `${appearance.value.radius}px`,
    '--wb-shadow': appearance.value.shadow / 100, '--wb-background': 1 - appearance.value.background / 100,
    '--wb-columns': appearance.value.columns,
  } as CSSProperties
  useEffect(() => { if (!props.active) setCustomize(false) }, [props.active])
  return <section className="workbench" data-active={props.active} aria-label="工作台" inert={!props.active} aria-hidden={!props.active} style={style}>
    <div className="wb-background" aria-hidden="true" />
    <WorkbenchContent key={preview ? 'preview' : 'real'} {...props} appearance={appearance.value} preview={preview} onPreview={() => setPreview(value => !value)} onCustomize={() => setCustomize(true)} />
    {DESIGN_PREVIEW && customize && <AppearanceControls value={appearance.value} onChange={appearance.setValue} warning={appearance.warning} onClose={() => setCustomize(false)} />}
  </section>
}

function WorkbenchContent({ active, deadlineRequest, data, now, onCapture, onNotice, appearance, preview, onPreview, onCustomize }: Props & {
  appearance: Appearance; preview: boolean; onPreview: () => void; onCustomize: () => void
}) {
  const timer = useFocusTimer(preview ? 'astaria-focus-preview-v1' : 'astaria-focus-v1')
  const [examples, setExamples] = useState(() => DESIGN_PREVIEW ? previewTasks(now) : [])
  const tasks = preview ? examples : data.tasks
  const groups = useMemo(() => taskGroups(tasks, now), [tasks, now])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transitioning, setTransitioning] = useState(false)
  const [timingOpen, setTimingOpen] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  const deadlineHeading = useRef<HTMLHeadingElement>(null)
  const lastDeadlineRequest = useRef(deadlineRequest)
  const [deadlinePending, setDeadlinePending] = useState(false)
  const [deadlineHighlighted, setDeadlineHighlighted] = useState(false)
  const deadlineHighlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const taskOpener = useRef<HTMLElement | null>(null)
  const chooserScroll = useRef(0)
  const selectionFocus = useRef<{ returning: boolean; previousId: string | null } | null>(null)
  const [recentCompletion, setRecentCompletion] = useState<string | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const transitionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const selected = tasks.find(task => task.id === selectedId && !task.deletedAt && task.status !== 'dropped')
  const session = timer.session?.taskId === selectedId ? timer.session : null
  const busy = !preview && (data.saving || data.loading || Boolean(data.loadError))
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
    return () => { startContext.current.mounted = false; clearTimeout(transitionTimer.current); clearTimeout(deadlineHighlightTimer.current) }
  }, [])
  useEffect(() => {
    if (deadlineRequest === lastDeadlineRequest.current) return
    lastDeadlineRequest.current = deadlineRequest
    setDeadlinePending(true)
    if (selectedId !== null || transitioning) switchTo(null)
  }, [deadlineRequest])
  useEffect(() => {
    if (!active || !deadlinePending || selectedId !== null || transitioning) return
    const frame = requestAnimationFrame(() => {
      deadlineHeading.current?.focus({ preventScroll: true })
      deadlineHeading.current?.closest('.wb-deadlines')?.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
      setDeadlinePending(false)
      setDeadlineHighlighted(true)
      clearTimeout(deadlineHighlightTimer.current)
      deadlineHighlightTimer.current = setTimeout(() => setDeadlineHighlighted(false), 950)
    })
    return () => cancelAnimationFrame(frame)
  }, [active, deadlinePending, selectedId, transitioning])
  useEffect(() => {
    if (selectedId && (!selected || selected.status === 'done')) timer.pause()
    if (active && selected?.status === 'done') heading.current?.focus({ preventScroll: true })
  }, [active, selectedId, selected?.status, timer.pause])
  useLayoutEffect(() => {
    if (transitioning || !selectionFocus.current) return
    const request = selectionFocus.current
    selectionFocus.current = null
    if (!active) return
    const fromDeadline = taskOpener.current?.hasAttribute('data-deadline-id')
    const previous = request.returning && request.previousId ? scroll.current?.querySelector<HTMLElement>(`[${fromDeadline ? 'data-deadline-id' : 'data-task-id'}="${CSS.escape(request.previousId)}"]`) : null
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
      chooserScroll.current = scroll.current?.scrollTop ?? 0
    }
    timer.pause()
    setError('')
    setTimingOpen(false)
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
    if (preview) {
      setExamples(items => items.map(item => item.id === task.id ? { ...item, status, doneAt: status === 'done' ? new Date().toISOString() : undefined } : item))
    } else await data.setStatus(task.id, status)
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
  const renderTask = (task: Task, recommended = false) => <button key={task.id} className="wb-task wb-glass" data-task-id={task.id} data-recommended={recommended} onClick={() => switchTo(task.id)} disabled={busy || transitioning}>
    <MeasuredGlassSurface radius={appearance.radius} material={appearance} />
    <span className="wb-task-body">
      <span className="wb-task-top"><strong>{task.title}</strong><span className="wb-task-arrow" aria-hidden="true">↗</span></span>
      <span className="wb-task-detail">{recommended ? <><span className="wb-recommendation">析熙推荐</span><span title="预览使用截止时间、进行状态和优先级排序，尚未接入 AI 推荐">{recommendationReason(task, now)}</span></> : <span>{task.notes || '从这一项开始'}</span>}</span>
      {appearance.metadata && <span className="wb-task-meta">{taskArea(task)}<span>·</span>{task.startAt && agendaDate(task.startAt) ? `${shortTimestamp(task.startAt, now)}安排` : task.due ? `${deadlineLabel(task, now)}截止` : '时间待安排'}{task.estimateMin ? <><span>·</span>{task.estimateMin} 分钟</> : null}</span>}
      {appearance.progress && timer.getSpentMs(task.id) > 0 && <span className="wb-task-spent">已专注 {spentLabel(timer.getSpentMs(task.id))}</span>}
    </span>
  </button>

  return <div className="wb-scroll" ref={scroll}>
    <div className="wb-container">
      <div className="wb-toolbar"><span className="wb-eyebrow">工作台{preview && <span className="wb-preview-label">示例预览</span>}</span>{DESIGN_PREVIEW && <div>
        <button className="wb-tool" onClick={() => { timer.pause(); onPreview() }}>{preview ? '返回我的事项' : '示例预览'}</button>
        <button className="wb-tool wb-customize-trigger" onClick={onCustomize}><span aria-hidden="true">⌘</span> 自定义</button>
      </div>}</div>
      <div className="wb-stage" data-leaving={transitioning} inert={transitioning}>
      {selectedId === null ? <div className="wb-chooser wb-enter" key="chooser">
        <header className="wb-heading"><h2 ref={heading} tabIndex={-1}>想从哪开始？</h2><p>{preview ? '先选一件事，也看看接下来有哪些截止时间' : '把手头的事做好，也给接下来留一点余地'}</p></header>
        {!busy && <DeadlineSummary tasks={tasks} now={now} onReveal={() => setDeadlinePending(true)} />}
        <div className="wb-overview-layout"><div className="wb-task-sections">
        {!preview && data.loading ? <p role="status" className="wb-empty">正在读取你的事项</p> : !preview && data.loadError ? <div className="wb-empty" role="alert"><p>{data.loadError}</p><button className="wb-action" onClick={data.retry}>重新读取</button></div> : <>
          <section className="wb-available" aria-labelledby="wb-available-heading"><header className="wb-section-heading"><h3 id="wb-available-heading">现在可以开始 <span>{groups.available.length}</span></h3></header>
          <div className="wb-task-grid">{groups.available.map((task, index) => renderTask(task, index === 0))}</div>
          {groups.available.length === 0 && <Glass appearance={appearance} className="wb-empty"><p>{groups.later.length ? '今天没有安排，想提前开始也可以' : '暂时没有待做的事项'}</p><button className="wb-action" onClick={onCapture}>交给析熙</button></Glass>}
          {groups.available.length > 0 && <p className="wb-rule-note">推荐暂按截止时间、进行状态与优先级排序</p>}
          </section>
          <section className="wb-later" aria-labelledby="wb-later-heading"><header className="wb-section-heading"><h3 id="wb-later-heading">稍后安排 <span>{groups.later.length}</span></h3><span>提前开始也可以</span></header><div className="wb-task-grid">{groups.later.map(task => renderTask(task))}</div>{groups.later.length === 0 && <p className="wb-section-empty">后面的时间，暂时留白</p>}</section>
          {appearance.completed && <section className="wb-completed" aria-labelledby="wb-completed-heading"><header className="wb-section-heading"><h3 id="wb-completed-heading">已完成 <span>{groups.completed.length}</span></h3><span>每一步都留在这里</span></header><div>{groups.completed.map(task => <div className="wb-completed-row" data-recent={task.id === recentCompletion} key={task.id}><span className="wb-completed-mark" aria-hidden="true">✓</span><span>{task.title}</span><small>{task.doneAt && <time dateTime={task.doneAt}>{shortTimestamp(task.doneAt, now)}</time>}{timer.getSpentMs(task.id) > 0 && <span>专注 {spentLabel(timer.getSpentMs(task.id))}</span>}{!task.doneAt && timer.getSpentMs(task.id) === 0 && '已完成'}</small></div>)}</div>{groups.completed.length === 0 && <p className="wb-section-empty">完成的事项会留在这里</p>}</section>}
        </>}
        </div><UpcomingDeadlines ref={deadlineHeading} tasks={tasks} now={now} disabled={busy || transitioning} loading={!preview && data.loading} error={preview ? '' : data.loadError} highlighted={deadlineHighlighted} onSelect={id => switchTo(id)} onRetry={data.retry} /></div>
        <p className="wb-bottom-note">一次只专注一件事 <span>·</span> 默认 {timer.durations.focusMin} 分钟专注 / {timer.durations.restMin} 分钟休息 <button className="wb-inline-button" aria-expanded={timingOpen} onClick={() => setTimingOpen(value => !value)}>调整时长</button></p>
        <DurationControls timer={timer} open={timingOpen} />
      </div> : selected && session ? <div className="wb-focus wb-enter" key={selectedId}>
        <button className="wb-back" onClick={() => switchTo(null)} disabled={busy}>← {selected.status === 'done' ? '选择下一项' : '重新选择'}<span>{session.phase === 'running' ? '离开会暂停计时' : '进度会保留'}</span></button>
        <div className="wb-focus-layout">
          <Glass appearance={appearance} className="wb-focus-main">
            <span className="wb-eyebrow">{selected.status === 'done' ? '这一项，完成了' : '当前专注'}</span>
            <h2 ref={heading} tabIndex={-1}>{selected.title}</h2>
            {appearance.metadata && <p className="wb-focus-meta">{taskArea(selected)}{selected.due && ` · ${deadlineLabel(selected, now)}截止`}{selected.estimateMin && ` · 预计 ${selected.estimateMin} 分钟`}</p>}
            <p className="wb-focus-note">{selected.notes || '先做一个能够推进它的小步骤'}</p>
            {selected.status === 'done' ? <div className="wb-finished wb-enter"><span className="wb-finished-mark" aria-hidden="true">✓</span><p>专注了 {spentLabel(session.spentMs)}</p><button className="wb-action" onClick={() => switchTo(null)}>选择下一项</button></div> : <>
              <div className="wb-clock-area">
                <div className="wb-clock" role="timer" aria-live="off" aria-label={`${session.mode === 'focus' ? '专注' : '休息'}剩余 ${Math.ceil(session.remainingMs / 1000)} 秒`}>{clockLabel(session.remainingMs)}</div>
                <p className="wb-clock-state" key={`${session.mode}-${session.phase}`} role="status">{clockState(session)}</p>
                {appearance.progress && <div className="wb-progress" role="progressbar" aria-label="本轮进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(100 * session.elapsedMs / session.durationMs)}><span style={{ transform: `scaleX(${Math.min(1, session.elapsedMs / session.durationMs)})` }} /></div>}
                <div className="wb-clock-actions">
                  {session.phase === 'finished' ? session.mode === 'focus' ? <><button className="wb-action" onClick={timer.startRest}>休息 {timer.durations.restMin} 分钟</button><button className="wb-secondary" onClick={timer.nextFocus}>继续专注</button></> : <button className="wb-action" onClick={timer.nextFocus}>准备下一轮</button> : session.phase === 'running' ? <button className="wb-action" onClick={timer.pause}>暂停</button> : <button className="wb-action" disabled={busy} onClick={() => void start()}>{session.phase === 'paused' ? '继续' : '开始'}{session.mode === 'focus' ? '专注' : '休息'}</button>}
                  <button className="wb-secondary" disabled={busy} onClick={() => void complete()}>{data.saving && !preview ? '保存中' : '完成事项'}</button>
                </div>
              </div>
              <div className="wb-focus-bottom"><span>累计专注 {spentLabel(session.spentMs)}</span><button className="wb-inline-button" aria-expanded={timingOpen} onClick={() => setTimingOpen(value => !value)}>专注设置</button></div>
              <DurationControls timer={timer} open={timingOpen} />
            </>}
            {(error || timer.storageError) && <p className="wb-error" role="alert">{error || timer.storageError}</p>}
          </Glass>
          <XixiContext key={selected.id} task={selected} now={now} preview={preview} appearance={appearance} />
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

function XixiContext({ task, now, preview, appearance }: { task: Task; now: Date; preview: boolean; appearance: Appearance }) {
  const key = `${preview ? 'preview' : 'real'}-${task.id}`
  const [draft, setDraft] = useState(() => { try { return sessionStorage.getItem(`astaria-xixi-${key}`) ?? '' } catch { return '' } })
  const [warning, setWarning] = useState('')
  useEffect(() => {
    try { sessionStorage.setItem(`astaria-xixi-${key}`, draft); setWarning('') }
    catch { setWarning('草稿暂未保存，离开前请复制') }
  }, [key, draft])
  return <Glass appearance={appearance} className="wb-xixi">
    <header><strong>析熙</strong><span>在这里陪你</span></header>
    <div className="wb-xixi-context"><span>这次只看这一项</span><p>{task.title}</p>{task.due && <small>{deadlineLabel(task, now)}截止</small>}</div>
    <div className="wb-xixi-body"><p>{task.status === 'done' ? '这一步已经完成，下一步由你来选' : '卡住的地方，可以先写在这里'}</p><span>对话接入后，我会结合当前事项帮助你</span></div>
    <label className="p0-sr-only" htmlFor="wb-xixi-input">给析熙的草稿，暂不发送</label>
    <textarea id="wb-xixi-input" placeholder="哪里需要一起想想" value={draft} rows={3} maxLength={4000} onChange={event => setDraft(event.target.value)} />
    <footer><small>{warning || '草稿仅保存在本次浏览器会话'}</small><span>对话待接入</span></footer>
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
