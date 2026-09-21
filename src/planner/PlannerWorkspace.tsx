import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import type { Task } from '../domain/task'
import { weekSchedule, WEEKDAYS } from '../domain/schedule'
import { localDay, shiftDay, shiftMonth } from '../home/agenda'
import { GlassSamplingContext, MeasuredGlassSurface } from '../home/GlassSurface'
import type { useAppearance } from '../workbench/appearance'
import type { useXixiConversation } from '../xixi/useXixiConversation'
import { ConversationLog } from '../xixi/ConversationLog'
import { ConversationMenu } from '../xixi/ConversationMenu'
import { XixiInput } from '../workbench/XixiInput'
import { restoreWithdrawnDraft } from '../xixi/draft'
import { usePlanner } from './usePlanner'
import { usePlannerInteraction } from './usePlannerInteraction'
import { usePlannerLayout, usePlannerChatSurface } from './usePlannerLayout'
import { CalendarBoard } from './CalendarBoard'
import { TimetableBoard } from './TimetableBoard'
import { PlannerOverview } from './PlannerOverview'
import { PlannerIcon as Icon } from './PlannerIcon'
import { CreateTaskDialog, PlannerDialog, RoutineDialog, TaskPlanDialog } from './PlannerDialogs'
import type { Routine, PlannerAction } from './types'
import './planner.css'
import './planner-glass.css'
import './planner-motion.css'
import './planner-layout.css'

export type PlannerPage = 'schedule'
export type PlannerMode = 'month' | 'week' | 'day'
type Props = { active: boolean; initialMode?: PlannerMode; tasks: Task[]; tasksLoading: boolean; tasksError: string; now: Date; appearance: ReturnType<typeof useAppearance>; chat: ReturnType<typeof useXixiConversation>; onSettings: () => void; onNotice: (text: string) => void; onRefresh: () => void }
const fullDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const readableMonth = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' })
const parseDay = (day: string) => new Date(`${day}T12:00:00`)

export function PlannerWorkspace({ active, initialMode = 'week', tasks, tasksLoading, tasksError, now, appearance, chat, onSettings, onNotice, onRefresh }: Props) {
  const root = useRef<HTMLElement>(null)
  usePlannerInteraction(root, active, 'schedule')
  const layoutMode = usePlannerLayout()
  const planner = usePlanner(active)
  const [selected, setSelected] = useState(() => localDay(now)), [anchor, setAnchor] = useState(() => now)
  const [mode, setMode] = useState<PlannerMode>(initialMode), [direction, setDirection] = useState(1)
  const view = mode === 'month' ? 'calendar' : 'timetable'
  const [routine, setRoutine] = useState<{ value: Routine | 'new'; source?: { date: string; weekday: number } } | null>(null), [taskId, setTaskId] = useState<string | null>(null)
  const [creating, setCreating] = useState(false), [importing, setImporting] = useState(false), [routinesOpen, setRoutinesOpen] = useState(false)
  const [chatOpen, setChatOpen] = useState(false), [draft, setDraft] = useState(''), [actionError, setActionError] = useState('')
  const [chatPresent, setChatPresent] = useState(false)
  const [chatVisited, setChatVisited] = useState(false)
  const [chatSettled, setChatSettled] = useState(false)
  const [importDone, setImportDone] = useState(false)
  const chatColumn = useRef<HTMLDialogElement>(null)
  const chatTrigger = useRef<HTMLButtonElement>(null)
  const restoreChatFocus = useRef(false)
  usePlannerChatSurface(chatColumn, layoutMode, active, chatOpen, chatPresent)
  const closeChat = () => { restoreChatFocus.current = true; setChatOpen(false) }
  useEffect(() => {
    if (!active || chatOpen) { restoreChatFocus.current = false; return }
    if (chatPresent || !restoreChatFocus.current) return
    const frame = requestAnimationFrame(() => { restoreChatFocus.current = false; chatTrigger.current?.focus({ preventScroll: true }) })
    return () => cancelAnimationFrame(frame)
  }, [active, chatOpen, chatPresent])
  useEffect(() => {
    setChatSettled(false)
    if (!chatOpen) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = setTimeout(() => {
      setChatSettled(true)
    }, reduced ? 0 : 350)
    return () => clearTimeout(timer)
  }, [chatOpen])
  useEffect(() => {
    if (chatOpen) { setChatPresent(true); setChatVisited(true); return }
    // Keep the closing column mounted until its width and contents finish leaving.
    const timer = setTimeout(() => setChatPresent(false), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 360)
    return () => clearTimeout(timer)
  }, [chatOpen])
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (!active) { setRoutine(null); setTaskId(null); setCreating(false); setImporting(false); setRoutinesOpen(false); setChatOpen(false); setChatPresent(false); return }
    heading.current?.focus({ preventScroll: true })
  }, [active])
  const select = (date: string) => {
    const next = parseDay(date)
    setDirection(date >= selected ? 1 : -1); setSelected(date)
    setAnchor(next)
  }
  const move = (amount: number) => {
    setDirection(amount)
    const next = mode === 'month' ? shiftMonth(parseDay(selected), amount) : shiftDay(parseDay(selected), amount * (mode === 'week' ? 7 : 1))
    setAnchor(next); setSelected(localDay(next))
  }
  const act = async (action: PlannerAction, expectedRevision?: number) => {
    setActionError('')
    try { return await planner.act(action, expectedRevision) }
    catch (reason) { const message = reason instanceof Error ? reason.message : '暂未保存成功'; setActionError(message); throw reason }
  }
  const safeAct = async (action: PlannerAction, notice?: string) => {
    try { await act(action); if (notice) onNotice(notice) } catch { /* Shared error remains next to the controls. */ }
  }
  const state = planner.state
  const selectedTask = tasks.find(task => task.id === taskId)
  const palette = appearance.value
  const style = { '--pl-font': `${palette.font}px`, '--pl-width': `${Math.max(1100, palette.width)}px`, '--pl-top': `${palette.top}px`, '--pl-bg-opacity': 1 - palette.background / 100, '--pl-bg-blur': `${palette.backgroundBlur}px`, '--pl-shadow': palette.shadow / 100, '--pl-radius': `${palette.radius}px`, '--pl-inner-tint': (1 - palette.transmission / 100) * .26, '--pl-rim': palette.rim / 100, '--pl-direction': direction } as CSSProperties
  const pane = (children: ReactNode, className: string) => {
    const hidden = className === 'pl-chat' && !chatOpen
    return <GlassSamplingContext.Provider value={active && !hidden}><section className={`pl-glass ${className}`} data-obscured={hidden} inert={hidden} aria-hidden={hidden || undefined}><MeasuredGlassSurface radius={palette.radius} material={palette} settleResize /><div className="pl-glass-content">{children}</div></section></GlassSamplingContext.Provider>
  }
  const title = '日程'
  const periodTitle = mode === 'month' ? readableMonth.format(anchor) : mode === 'day' ? fullDate.format(parseDay(selected)) : (() => { const start = shiftDay(anchor, -(anchor.getDay() + 6) % 7); const end = shiftDay(start, 6); return `${start.getMonth()+1}月${start.getDate()}日 — ${end.getMonth()+1}月${end.getDate()}日` })()
  const changeMode = (next: PlannerMode) => {
    setDirection(['month', 'week', 'day'].indexOf(next) >= ['month', 'week', 'day'].indexOf(mode) ? 1 : -1)
    setMode(next); setAnchor(parseDay(selected))
  }
  const send = async () => {
    const sent = draft.trim(); if (!sent || chat.busy) return
    if (await chat.send(sent, { page: view, date: selected, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone })) setDraft(value => value.trim() === sent ? '' : value)
  }
  const loadLegacy = async () => {
    const imported: Routine[] = WEEKDAYS.flatMap((day, index) => weekSchedule(day).map(slot => ({
      id: `legacy-${index+1}-${slot.period}`, title: slot.period === '午休' ? '午休' : slot.subject === '—' ? '晨间准备' : slot.subject,
      kind: slot.period === '午休' || slot.kind === 'blank' ? 'break' as const : slot.kind === 'free' ? 'available' as const : 'class' as const,
      weekdays: [index+1], start: slot.start, end: slot.end, location: '学校', items: [], enabled: true,
    })))
    try { await act({ type: 'import-routines', routines: imported }); setImportDone(true); onNotice('已载入旧课表，请核对课程和空课；晚自习保留') } catch { /* Dialog keeps the error visible. */ }
  }
  return <GlassSamplingContext.Provider value={active}><section ref={root} className="planner" data-mode={mode} data-selected-date={selected} data-layout={layoutMode} data-chat-open={chatOpen} data-active={active} data-theme={palette.theme} data-bg-blur={palette.backgroundBlur > 0 ? 'on' : 'off'} style={style} aria-label={title} aria-hidden={!active} inert={!active}>
    <div className="pl-background" /><div className="pl-scroll"><div className="pl-container">
      <header className="pl-page-header">
        <div className="pl-page-title"><h2 ref={heading} tabIndex={-1}>{title}</h2></div>
        <div className="pl-board-toolbar"><div className="pl-period"><button className="pl-icon-button" onClick={() => move(-1)} aria-label={mode === 'month' ? '上个月' : mode === 'week' ? '上一周' : '前一天'}><Icon name="left" /></button><strong aria-live="polite">{periodTitle}</strong><button className="pl-icon-button" onClick={() => move(1)} aria-label={mode === 'month' ? '下个月' : mode === 'week' ? '下一周' : '后一天'}><Icon name="right" /></button></div><div><button className="pl-secondary" onClick={() => select(localDay(now))}>今天</button><div className="pl-segment" role="group" aria-label="日程视图">{(['month','week','day'] as const).map(value => <button key={value} type="button" data-mode={value} aria-pressed={mode === value} onClick={() => changeMode(value)}>{value === 'month' ? '月' : value === 'week' ? '周' : '日'}</button>)}</div></div></div>
        <div className="pl-header-actions">
          <button className="pl-secondary pl-header-edit" aria-label="每周安排" title="每周安排" onClick={() => setRoutinesOpen(true)}><Icon name="edit" /><span>每周安排</span></button>
          <button className="pl-secondary pl-header-add" aria-label="记录事项" title="记录事项" onClick={() => setCreating(true)}><Icon name="plus" /><span>记录事项</span></button>
          <button ref={chatTrigger} disabled={!state} className="pl-primary" aria-label="交给析熙" aria-expanded={chatOpen} onClick={() => chatOpen ? closeChat() : setChatOpen(true)}><Icon name="send" /><span className="pl-chat-action-label">交给析熙</span></button>
        </div>
      </header>
      {(planner.error || tasksError) && <p className="pl-error" role="alert">{planner.error || tasksError}<button onClick={() => { void planner.refresh(); onRefresh() }}>重新读取</button></p>}
      {!state && <div className="pl-empty">{planner.loading ? '正在读取日程' : '日程暂不可用'}</div>}
      {state && <>
        {view === 'timetable' && !state.timetableConfirmed && <div className="pl-setup"><span>核对课程和可用时间 · 默认含晚自习与周末 09:00–22:00，可在每周安排中调整</span><div><button onClick={() => { setImportDone(false); setImporting(true) }}>载入旧课表</button><button onClick={() => setRoutine({ value: 'new' })}>自己录入</button><button disabled={planner.saving} onClick={() => void safeAct({ type: 'import-routines', routines: [] }, '已确认每周安排')}>已核对完成</button></div></div>}
        {pane(<PlannerOverview view={view} selected={selected} anchor={anchor} now={now} state={state} tasks={tasks} saving={planner.saving} error={actionError}
          onMoveDay={amount => select(localDay(shiftDay(parseDay(selected), amount)))} onTask={setTaskId} onCreate={() => setCreating(true)} onAct={safeAct} />, `pl-overview ${view === 'calendar' ? 'pl-calendar-summary' : 'pl-day-panel'}`)}
        <div className="pl-layout" data-chat={chatPresent || chatOpen} data-chat-open={chatOpen}>
          {pane(<>
          <div className="pl-board-scroll"><div key={mode} className="pl-mode-frame" data-mode={mode}>{mode === 'month' ? <CalendarBoard state={state} tasks={tasks} selected={selected} anchor={anchor} now={now} mode="month" direction={direction} onSelect={select} /> : <TimetableBoard state={state} tasks={tasks} selected={selected} anchor={anchor} now={now} mode={mode} direction={direction} onSelect={select} onRoutine={(item, date) => {
            const override = state.dayOverrides?.[date]
            setRoutine({ value: item, source: override ? { date, weekday: override.sourceWeekday } : undefined })
          }} onTask={setTaskId} />}</div></div>
          <div className="pl-legend"><span><i data-kind="available" />可安排</span><span><i data-kind="plan" />计划</span><span>◇ 截止</span>{view === 'timetable' && <span><i data-kind="class" />固定占用</span>}<span className="pl-legend-note">{state.timetableConfirmed ? '按每周安排计算' : '仅统计已知时段'}</span></div></>, 'pl-board')}
          <dialog ref={chatColumn} className="pl-chat-column" aria-label="日程析熙" onKeyDown={event => {
            if (event.key === 'Escape' && !event.defaultPrevented && !event.nativeEvent.isComposing) {
              event.preventDefault(); event.stopPropagation(); closeChat()
            }
          }} onCancel={event => { event.preventDefault(); event.stopPropagation(); closeChat() }} data-settled={chatSettled && chatOpen} inert={!chatOpen} aria-hidden={!chatOpen}>{(chatPresent || chatOpen || (layoutMode === 'medium' && chatVisited)) && <GlassSamplingContext.Provider value={active && chatOpen}>{pane(<><header className="pl-chat-header"><strong>析熙</strong><div><ConversationMenu chat={chat} /><button className="pl-icon-button" data-chat-close aria-label="收起日程析熙" onClick={closeChat}><Icon name="close" /></button></div></header><p className="pl-muted">一起看 {fullDate.format(parseDay(selected))}</p><ConversationLog chat={chat} active={active && chatOpen} onSettings={onSettings} context={{ page: view, date: selected, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }} onSent={sent => setDraft(value => value.trim() === sent ? '' : value)} onRetracted={text => setDraft(value => restoreWithdrawnDraft(value, text))} />
            <form className="pl-chat-compose" onSubmit={event => { event.preventDefault(); void send() }}><label className="p0-sr-only" htmlFor="planner-xixi-input">和析熙讨论日程</label><XixiInput id="planner-xixi-input" value={draft} onChange={setDraft} disabled={chat.busy || !chatOpen} onSubmit={() => void send()} /><button className="pl-primary" type="submit" disabled={!draft.trim() || chat.busy || !chatOpen}>{chat.sending ? '正在想' : '发给析熙'}</button>{chat.error && <p className="pl-error" role="alert">{chat.error}</p>}</form></>, 'pl-chat')}</GlassSamplingContext.Provider>}</dialog>
        </div>
      </>}
      {tasksLoading && <span className="pl-loading" role="status">正在同步事项</span>}
    </div></div>
    {routine && state && <RoutineDialog routine={routine.value === 'new' ? undefined : routine.value} source={routine.source} state={state} act={act} onClose={() => setRoutine(null)} onNotice={onNotice} onBrowseRoutines={() => { setRoutine(null); setRoutinesOpen(true) }} />}
    {selectedTask && state && <TaskPlanDialog task={selectedTask} state={state} selected={selected} act={act} onClose={() => setTaskId(null)} onNotice={onNotice} onRefresh={onRefresh} />}
    {creating && <CreateTaskDialog selected={selected} onClose={() => setCreating(false)} onRefresh={onRefresh} onNotice={onNotice} />}
    {importing && <PlannerDialog title="载入旧课表" onClose={() => setImporting(false)} busy={planner.saving} closeRequested={importDone}><p>项目里保存着一份周一到周五的旧课表，载入后请核对课程、空课和时间</p><p className="pl-muted">午休会作为休息保留；已有晚自习和自行添加的安排都会保留</p><div className="pl-import-preview">{WEEKDAYS.map(day => <div key={day}><strong>{day}</strong><span>{weekSchedule(day).filter(slot => slot.kind !== 'free' && slot.kind !== 'blank' && slot.period !== '午休').map(slot => slot.subject).join(' · ')}</span></div>)}</div>{actionError && <p className="pl-error" role="alert">{actionError}</p>}<button className="pl-primary" disabled={planner.saving} onClick={() => void loadLegacy()}>载入并核对</button></PlannerDialog>}
    {routinesOpen && state && <PlannerDialog title="每周安排" onClose={() => setRoutinesOpen(false)}><div className="pl-routine-list">{state.routines.map(item => <button key={item.id} className="pl-day-task" onClick={() => { setRoutinesOpen(false); setRoutine({ value: item }) }}><strong>{item.title}{!item.enabled ? ' · 已停用' : ''}</strong><small>{item.weekdays.map(day => `周${['日','一','二','三','四','五','六'][day]}`).join('、')}　{item.start}–{item.end}</small></button>)}</div><button className="pl-primary" onClick={() => { setRoutinesOpen(false); setRoutine({ value: 'new' }) }}><Icon name="plus" />添加时段</button></PlannerDialog>}
  </section></GlassSamplingContext.Provider>
}
