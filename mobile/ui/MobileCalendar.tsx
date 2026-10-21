import { useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { Task } from '../../src/domain/task'
import { agendaDate, agendaItems, agendaPlanIndex, dayTaskLabel, localDay, monthDays, shiftDay, shiftMonth } from '../../src/home/agenda'
import { dayExceptionLabel, exceptionLabels } from '../../src/planner/exceptionLabels'
import { blocksForDay, minuteOf, minutesLabel, routinesForDay, timeOf, weeklyRoutineSource } from '../../src/planner/model'
import type { DayEvent, DayException, PlannerAction, PlannerState, Routine } from '../../src/planner/types'
import { weekCycleLabel, weekStart } from '../../src/planner/weekCycle'
import { usePeriodMotion } from '../../src/planner/usePeriodMotion'
import { GlassRenderingContext, GlassSamplingContext, MeasuredGlassSurface } from '../../src/home/GlassSurface'
import { ImportStep } from '../../src/planner/ImportSurface'
import { usePreferences } from '../../src/xixi/preferences'
import { calendarDay, calendarWeek } from './calendarModel'
import type { CalendarEntry } from './calendarModel'
import './mobile-calendar.css'

export type MobileCalendarProps = {
  planner: ReturnType<typeof import('../../src/planner/usePlanner').usePlanner>
  tasks: Task[]
  now: Date
  onChat: (text: string) => void
  onImport: (kind: 'screenshot' | 'ics') => void
  onSheetChange?: (open: boolean) => void
  surface?: ReactNode
}

type Sheet =
  | { kind: 'menu' | 'weekly' }
  | { kind: 'routine'; routine?: Routine; sourceDate?: string; sourceWeekday?: number }
  | { kind: 'event'; event?: DayEvent; date: string; start?: string; end?: string }
  | { kind: 'exception'; date: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'free'; date: string; start: number; end: number }

type EditorProps = {
  state: PlannerState
  act: MobileCalendarProps['planner']['act']
  saving: boolean
  onBusy: (busy: boolean) => void
  onSaved: (notice: string, date?: string) => void
}
const weekdays = ['日', '一', '二', '三', '四', '五', '六']
const weekOrder = [1, 2, 3, 4, 5, 6, 0]
const fullDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })
const monthLabel = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' })
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const explain = (reason: unknown) => reason instanceof Error ? reason.message : '暂时无法保存，请重试。草稿已保留。'
const splitItems = (text: string) => [...new Set(text.split(/[，,、\n]/u).map(item => item.trim()).filter(Boolean))]
const kindLabel = (routine: Routine) => routine.sourceDate ? '单日活动' : routine.kind === 'class' ? '课程' : routine.kind === 'break' ? '休息 / 固定占用' : '可安排时间'

function Symbol({ name }: { name: 'left' | 'right' | 'down' | 'close' | 'plus' | 'more' }) {
  return <svg className="m-calendar-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'left' ? <path d="m14 5-7 7 7 7" /> : name === 'right' ? <path d="m10 5 7 7-7 7" /> : name === 'down' ? <path d="m6 9 6 6 6-6" /> : name === 'close' ? <path d="m6 6 12 12M18 6 6 18" /> : name === 'plus' ? <path d="M12 5v14M5 12h14" /> : <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>}
  </svg>
}

export function MobileCalendar({ planner, tasks, now, onChat, onImport, onSheetChange, surface }: MobileCalendarProps) {
  const today = localDay(now)
  const [selected, setSelected] = useState(today)
  const [expanded, setExpanded] = useState(false)
  const [month, setMonth] = useState(() => agendaDate(today)!)
  const [sheet, setSheet] = useState<Sheet | null>(null)
  const [sheetTrail, setSheetTrail] = useState<Sheet[]>([])
  const [weekOverview, setWeekOverview] = useState(true)
  const [direction, setDirection] = useState(1)
  const [sheetBusy, setSheetBusy] = useState(false)
  const busyRef = useRef(false)
  const [notice, setNotice] = useState('')
  const content = useRef<HTMLDivElement>(null)
  const datesId = useId()
  const sheetOpen = Boolean(sheet)
  const sheetListener = useRef(onSheetChange)
  sheetListener.current = onSheetChange
  useLayoutEffect(() => { sheetListener.current?.(sheetOpen) }, [sheetOpen])
  useLayoutEffect(() => () => sheetListener.current?.(false), [])
  const state = planner.state
  const date = agendaDate(selected)!
  const week = useMemo(() => calendarWeek(selected), [selected])
  const monthDates = useMemo(() => monthDays(month), [month])
  const day = useMemo(() => state ? calendarDay(state, tasks, selected, now) : null, [state, tasks, selected, now])
  const plans = useMemo(() => agendaPlanIndex(state?.blocks ?? []), [state?.blocks])
  const markers = useMemo(() => {
    const result = new Set<string>()
    if (state) for (const value of expanded ? monthDates.map(localDay) : week) {
      if (routinesForDay(state, value).some(row => row.kind !== 'available') || blocksForDay(state, tasks, value).length
        || agendaItems(tasks, value, today, plans).length) result.add(value)
    }
    return result
  }, [state, tasks, expanded, monthDates, week, today, plans])
  const select = (value: string) => {
    setSelected(value); setMonth(agendaDate(value)!); setNotice('')
  }
  const onBusy = (value: boolean) => { busyRef.current = value; setSheetBusy(value) }
  const closeSheet = () => {
    if (busyRef.current) return
    setNotice(''); setSheet(sheetTrail.at(-1) ?? null); setSheetTrail(sheetTrail.slice(0, -1))
  }
  const open = (value: Sheet) => {
    if (busyRef.current) return
    setNotice(''); setSheetTrail(sheet ? [...sheetTrail, sheet] : []); setSheet(value)
  }
  const saved = (message: string, value?: string) => {
    if (value) select(value)
    setNotice(message)
    if (sheet?.kind === 'routine' && sheetTrail.at(-1)?.kind === 'weekly') { setSheet(sheetTrail.at(-1)!); setSheetTrail(sheetTrail.slice(0, -1)) }
    else { setSheet(null); setSheetTrail([]) }
  }
  const ask = (text: string) => { setSheet(null); onChat(text) }
  const openRoutine = (routine: Routine) => {
    if (!state) return
    if (routine.sourceDate) {
      const event = state.dayEvents?.find(item => item.id === routine.id && item.date === routine.sourceDate)
      if (event) open({ kind: 'event', event, date: event.date })
    } else open({ kind: 'routine', routine, sourceDate: selected,
      sourceWeekday: state.dayExceptions?.[selected]?.sourceWeekday ?? state.dayOverrides?.[selected]?.sourceWeekday ?? date.getDay() })
  }
  const openEntry = (entry: CalendarEntry) => {
    if (entry.kind === 'routine') openRoutine(entry.routine)
    else if (entry.kind === 'task') open({ kind: 'task', taskId: entry.task.id })
    else open({ kind: 'free', date: selected, start: entry.start, end: entry.end })
  }
  const dayButton = (value: string, monthly: boolean) => {
    const item = agendaDate(value)!, isToday = value === today
    return <button type="button" key={value} className="m-calendar-date" data-outside={monthly && item.getMonth() !== month.getMonth()}
      data-today={isToday} aria-current={isToday ? 'date' : undefined} aria-pressed={selected === value}
      aria-label={`${fullDate.format(item)}${isToday ? '，今天' : ''}${markers.has(value) ? '，有安排' : ''}`} onClick={() => { select(value); setExpanded(false); setWeekOverview(false) }}>
      {!monthly && <span className="m-calendar-weekday">{weekdays[item.getDay()]}</span>}
      <strong>{item.getDate()}</strong><span className="m-calendar-date-mark" data-present={markers.has(value)} aria-hidden="true" />
    </button>
  }
  const editorProps: EditorProps | null = state ? { state, act: planner.act, saving: planner.saving, onBusy, onSaved: saved } : null
  const selectedTask = sheet?.kind === 'task' ? tasks.find(task => task.id === sheet.taskId && !task.deletedAt && task.status !== 'dropped') : undefined
  const sheetTitle = !sheet ? '' : sheet.kind === 'menu' ? '日程菜单' : sheet.kind === 'weekly' ? '每周课程与可用时间'
    : sheet.kind === 'routine' ? sheet.routine ? '编辑每周安排' : '新增每周安排'
      : sheet.kind === 'event' ? sheet.event ? '编辑单日活动' : '新增单日活动'
        : sheet.kind === 'exception' ? '调休与日期例外' : sheet.kind === 'free' ? '这段空档' : '事项详情'

  const frame = <>
      <div className="m-calendar-date-picker" aria-label={expanded ? '月历' : '本周日期'}>
        {expanded ? <><div className="m-calendar-week-labels" aria-hidden="true">{weekOrder.map(value => <span key={value}>{weekdays[value]}</span>)}</div>
          <div className="m-calendar-month-grid">{monthDates.map(value => dayButton(localDay(value), true))}</div>
          <button type="button" className="m-calendar-collapse" onClick={() => setExpanded(false)}>收起月历</button></>
          : <div className="m-calendar-week">{week.map(value => dayButton(value, false))}</div>}
      </div>
      {planner.error && <div className="m-calendar-feedback" role="alert"><p>{planner.error}</p><button type="button" className="m-calendar-button" disabled={planner.loading || planner.saving} onClick={() => void planner.refresh()}>重新读取</button></div>}
      {notice && <p className="m-calendar-notice" role="status">{notice}</p>}
      {state && !expanded && weekOverview && <div key={week[0]} className="m-calendar-week-overview" aria-label="本周安排总览">{week.map(value => {
        const model = calendarDay(state, tasks, value, now), stamp = agendaDate(value)!
        const entries = model.entries.filter(entry => entry.kind !== 'free')
        return <button type="button" key={value} className="m-calendar-week-summary" aria-label={`${fullDate.format(stamp)}，查看日程`} data-today={value === today} onClick={() => { select(value); setWeekOverview(false) }}><span className="m-calendar-week-summary-date"><strong>周{weekdays[stamp.getDay()]}</strong><small>{stamp.getMonth() + 1}/{stamp.getDate()}</small></span><span className="m-calendar-week-summary-copy">{entries.slice(0, 2).map(entry => <span key={entry.key}><time>{timeOf(entry.start)}</time>{entry.kind === 'routine' ? entry.routine.title : entry.kind === 'task' ? entry.task.title : ''}</span>)}{!entries.length && <span className="m-calendar-week-empty">{model.reminders.length ? `${model.reminders.length} 项待办与截止` : '暂无安排'}</span>}<small>{entries.length > 2 ? `另有 ${entries.length - 2} 项 · ` : ''}{model.availabilityKnown ? `空档 ${minutesLabel(model.capacity.freeMin)}` : '可用时间待设置'}</small></span><span aria-hidden="true">›</span></button>
      })}</div>}
      {!state ? <div className="m-calendar-empty" role="status"><p>{planner.loading ? '正在读取日程…' : '日程尚未读取'}</p>{!planner.loading && !planner.error && <button type="button" className="m-calendar-button" onClick={() => void planner.refresh()}>读取日程</button>}</div>
        : !expanded && !weekOverview && day && <>
          <header className="m-calendar-day-heading">
            <div><h2>{date.getMonth() + 1}月{date.getDate()}日 <span>周{weekdays[date.getDay()]}</span></h2>
              <p>{day.availabilityKnown ? `${selected === today ? '从现在起空档' : '全天空档'} ${minutesLabel(selected === today ? day.capacity.remainingMin : day.capacity.freeMin)}` : '尚未设置可用时间'}</p>
            </div>
            <div className="m-calendar-day-actions"><button type="button" className="m-calendar-return-week" aria-label="返回所在周" onClick={() => setWeekOverview(true)}>返回周</button><button type="button" className="m-calendar-icon-button" aria-label="新增单日活动" disabled={planner.saving} onClick={() => open({ kind: 'event', date: selected })}><Symbol name="plus" /></button></div>
          </header>
          {dayExceptionLabel(state, selected) && <button type="button" className="m-calendar-exception" onClick={() => open({ kind: 'exception', date: selected })}>{dayExceptionLabel(state, selected)}<span>查看 / 修改</span></button>}
          {!state.timetableConfirmed && <p className="m-calendar-note">空档仅按已知的可用时间计算。</p>}
          {day.capacity.unestimatedCount > 0 && <p className="m-calendar-note" role="note">有未估时事项，尚未从空档中扣除。</p>}
          {day.reminders.length > 0 && <section className="m-calendar-reminders" aria-label="当天待办与截止"><h3>待办与截止</h3>
            {day.reminders.map(task => <button type="button" className="m-calendar-reminder" key={task.id} onClick={() => open({ kind: 'task', taskId: task.id })}><strong>{task.title}</strong><span>{dayTaskLabel(task, selected, plans)}{!task.estimateMin && task.startAt?.includes('T') ? ' · 用时待估' : ''}</span></button>)}
          </section>}
          {day.entries.length ? <ol key={selected} className="m-calendar-timeline" aria-label={`${fullDate.format(date)}时间线`}>
            {day.entries.map(entry => <TimelineRow key={entry.key} entry={entry} day={selected} today={today} now={now} onOpen={() => openEntry(entry)} />)}
          </ol> : <div className="m-calendar-empty"><p>这天还没有安排</p><button type="button" className="m-calendar-button" onClick={() => open({ kind: 'event', date: selected })}>添加单日活动</button></div>}
          {!day.availabilityKnown && <button type="button" className="m-calendar-inline-action" onClick={() => open({ kind: 'weekly' })}>设置每周课程与可用时间<Symbol name="right" /></button>}
        </>}
    </>
  const view = expanded ? 'month' : weekOverview ? 'week' : 'day'
  const periodKey = expanded ? `month:${localDay(month)}` : weekOverview ? `week:${week[0]}` : `day:${selected}`
  const motion = usePeriodMotion(`${view}:${periodKey}`, content.current?.closest('[data-motion=reduced]') ? periodKey : 'mobile-calendar', frame, direction)
  const navigate = (delta: number) => {
    setDirection(delta)
    if (expanded) setMonth(shiftMonth(month, delta))
    else select(localDay(shiftDay(date, delta * (weekOverview ? 7 : 1))))
  }

  return <section className="m-calendar" aria-label="日程" data-sheet-open={Boolean(sheet)}>
    <div ref={content} className="m-calendar-content" inert={Boolean(sheet)} style={sheet ? { visibility: 'hidden' } : undefined}>
      <header className="m-calendar-heading">
        <h1>日程</h1>
        <div className="m-calendar-view" role="group" aria-label="日程视图">{(['month', 'week', 'day'] as const).map(mode => <button key={mode} type="button" data-mode={mode} aria-pressed={view === mode} onClick={() => { setDirection(mode === 'month' ? -1 : 1); setExpanded(mode === 'month'); setWeekOverview(mode === 'week'); setMonth(date) }}>{mode === 'month' ? '月' : mode === 'week' ? '周' : '日'}</button>)}</div>
      </header>
      <div className="m-calendar-body">{surface}<div className="m-calendar-body-content">
      <div className="m-calendar-period">
        <button type="button" className="m-calendar-icon-button" aria-label={expanded ? '上个月' : weekOverview ? '上一周' : '前一天'} onClick={() => navigate(-1)}><Symbol name="left" /></button>
        <button type="button" className="m-calendar-month-toggle" aria-expanded={expanded} aria-controls={datesId} onClick={() => { setMonth(date); setExpanded(!expanded) }}>
          <span>{monthLabel.format(expanded ? month : date)}</span><Symbol name="down" />
        </button>
        <button type="button" className="m-calendar-icon-button" aria-label={expanded ? '下个月' : weekOverview ? '下一周' : '后一天'} onClick={() => navigate(1)}><Symbol name="right" /></button>
        <div className="m-calendar-actions"><button type="button" className="m-calendar-button" onClick={() => { select(today); setMonth(agendaDate(today)!) }}>今天</button>
          <button type="button" className="m-calendar-icon-button" aria-label="打开日程菜单" onClick={() => open({ kind: 'menu' })}><Symbol name="more" /></button></div>
      </div>
      <div id={datesId} className="m-calendar-period-window" data-moving={motion.moving} data-direction={motion.direction}>
        {motion.previous && <div key={`old:${motion.revision}`} className="m-calendar-period-frame" data-current="false" inert aria-hidden="true">{motion.previous}</div>}
        <div key={motion.revision} className="m-calendar-period-frame" data-current="true" inert={motion.moving} onAnimationEnd={motion.finish}>{frame}</div>
      </div>
      </div></div>
    </div>
    {sheet && <CalendarSheet title={sheetTitle} busy={sheetBusy} onClose={closeSheet} returnLabel={sheetTrail.at(-1)?.kind === 'weekly' ? '返回每周安排' : sheetTrail.length ? '返回上一级' : '返回日程'}>
      {notice && <p className="m-calendar-notice" role="status">{notice}</p>}
      {sheet.kind === 'menu' && <nav className="m-calendar-menu" aria-label="日程工具">
        <button type="button" onClick={() => { setSheet(null); onImport('screenshot') }}>截图导入课表<Symbol name="right" /></button>
        <button type="button" onClick={() => { setSheet(null); onImport('ics') }}>导入 ICS 日历<Symbol name="right" /></button>
        <button type="button" disabled={!state} onClick={() => open({ kind: 'weekly' })}>每周课程与可用时间<Symbol name="right" /></button>
        <button type="button" disabled={!state} onClick={() => open({ kind: 'event', date: selected })}>新增单日活动<Symbol name="plus" /></button>
        <button type="button" disabled={!state} onClick={() => open({ kind: 'exception', date: selected })}>调休 / 假期 / 停课<Symbol name="right" /></button>
      </nav>}
      {sheet.kind === 'weekly' && state && <WeeklyList state={state} onOpen={routine => open({ kind: 'routine', routine })} onAdd={() => open({ kind: 'routine' })} />}
      {sheet.kind === 'routine' && editorProps && <ArrangementEditor key={`routine:${sheet.routine?.id ?? 'new'}`} {...editorProps} mode="routine" routine={sheet.routine} initialDate={selected} sourceDate={sheet.sourceDate} sourceWeekday={sheet.sourceWeekday} />}
      {sheet.kind === 'event' && editorProps && <ArrangementEditor key={`event:${sheet.event?.id ?? 'new'}`} {...editorProps} mode="event" event={sheet.event} initialDate={sheet.date} initialStart={sheet.start} initialEnd={sheet.end} />}
      {sheet.kind === 'exception' && editorProps && <ExceptionEditor key={sheet.date} {...editorProps} date={sheet.date} />}
      {sheet.kind === 'task' && (selectedTask ? <TaskDetail task={selectedTask} state={state!} day={selected} onChat={ask} /> : <p className="m-calendar-note">这项事项已被移除，请关闭后查看最新日程。</p>)}
      {sheet.kind === 'free' && <div className="m-calendar-slot-detail"><p className="m-calendar-detail-time">{sheet.date} · {timeOf(sheet.start)}–{timeOf(sheet.end)}</p><p>{minutesLabel(sheet.end - sheet.start)}空档</p>
        <button type="button" className="m-calendar-primary" onClick={() => open({ kind: 'event', date: sheet.date, start: timeOf(sheet.start), end: sheet.end < 1440 ? timeOf(sheet.end) : undefined })}>在这段时间添加活动</button>
        <button type="button" className="m-calendar-button" onClick={() => ask(`请核对 ${sheet.date} ${timeOf(sheet.start)}–${timeOf(sheet.end)} 的真实空档，结合我的待办协助安排；先确认估时与冲突。`)}>请析熙协助安排</button>
      </div>}
    </CalendarSheet>}
  </section>
}

function TimelineRow({ entry, day, today, now, onOpen }: { entry: CalendarEntry; day: string; today: string; now: Date; onOpen: () => void }) {
  const currentMinute = now.getHours() * 60 + now.getMinutes()
  const past = day < today || (day === today && entry.end <= currentMinute)
  const current = day === today && entry.start <= currentMinute && entry.end > currentMinute
  const title = entry.kind === 'free' ? '空档' : entry.kind === 'task' ? entry.task.title : entry.routine.title
  const label = entry.kind === 'free' ? minutesLabel(entry.end - entry.start) : entry.kind === 'task'
    ? [entry.done ? '已完成' : '任务', entry.block.locked ? '已锁定' : '', agendaDate(entry.task.due) && localDay(agendaDate(entry.task.due)!) === day ? `当天${entry.task.due?.length === 10 ? '' : ` ${clock.format(agendaDate(entry.task.due))}`}截止` : ''].filter(Boolean).join(' · ')
    : [kindLabel(entry.routine), entry.routine.location].filter(Boolean).join(' · ')
  return <li className="m-calendar-timeline-row" data-kind={entry.kind} data-past={past} data-current={current}>
    <div className="m-calendar-time" aria-hidden="true"><span>{timeOf(entry.start)}</span><small>{timeOf(entry.end)}</small></div>
    <button type="button" className="m-calendar-entry" data-done={entry.kind === 'task' && entry.done} onClick={onOpen}>
      <span className="m-calendar-entry-heading"><strong>{title}</strong>{current && <small>{entry.kind === 'free' ? '当前空档' : '此刻'}</small>}</span>
      <span className="m-calendar-entry-meta">{label}{entry.kind === 'free' && past ? ' · 已过去' : ''}</span>
      {entry.kind !== 'free' && entry.conflict && <span className="m-calendar-conflict">时间或截止有冲突，待核对</span>}
      <span className="m-calendar-sr-only">{timeOf(entry.start)}至{timeOf(entry.end)}</span>
    </button>
  </li>
}

function CalendarSheet({ title, busy, onClose, returnLabel, children }: { title: string; busy: boolean; onClose: () => void; returnLabel: string; children: ReactNode }) {
  const sampling = useContext(GlassSamplingContext)
  const { value: preferences } = usePreferences()
  const element = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleId = useId()
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [opener] = useState(() => document.activeElement instanceof HTMLElement ? document.activeElement : null)
  useEffect(() => {
    const dialog = element.current
    dialog?.showModal()
    return () => {
      clearTimeout(timer.current)
      dialog?.close()
      requestAnimationFrame(() => {
        const target = opener?.isConnected && !opener.closest('[inert]') ? opener : dialog?.closest('.m-calendar')?.querySelector<HTMLElement>('[aria-label="打开日程菜单"]')
        target?.focus({ preventScroll: true })
      })
    }
  }, [])
  useEffect(() => { closingRef.current = false; setClosing(false); heading.current?.focus({ preventScroll: true }); element.current?.querySelector('.m-calendar-sheet-body')?.scrollTo(0, 0) }, [title])
  const back = () => {
    if (busy || closingRef.current) return
    closingRef.current = true; setClosing(true)
    timer.current = setTimeout(onClose, preferences.effect.motion === 'reduced' || matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180)
  }
  return <GlassRenderingContext.Provider value={preferences.render.glass}><GlassSamplingContext.Provider value={sampling && !closing}><dialog ref={element} className="import-surface m-calendar-sheet" data-mobile-sheet="calendar" data-closing={closing} data-theme={preferences.theme} data-glass={preferences.glass} data-reduced-motion={preferences.effect.motion === 'reduced'} inert={closing} aria-labelledby={titleId} aria-busy={busy} onCancel={event => { event.preventDefault(); back() }} onKeyDown={event => event.stopPropagation()}>
    <MeasuredGlassSurface radius={22} material={{ transmission: preferences.theme === 'light' ? preferences.glass === 'soft' ? 14 : 18 : preferences.glass === 'soft' ? 24 : 30, blur: preferences.glass === 'soft' ? 6 : 0, rim: 44, shadow: 30, reflection: 12 }} />
    <header className="m-calendar-sheet-heading"><button type="button" className="m-calendar-icon-button" disabled={busy} aria-label={returnLabel} onClick={back}><Symbol name="left" /></button><h2 id={titleId} ref={heading} tabIndex={-1}>{title}</h2></header>
    <div className="m-calendar-sheet-body import-body"><ImportStep step={title}>{children}</ImportStep></div>
  </dialog></GlassSamplingContext.Provider></GlassRenderingContext.Provider>
}

function ChoiceGroup({ label, value, options, onChange }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const id = useId(), hasValue = options.some(option => option.value === value)
  return <div className="m-calendar-field"><span id={id}>{label}</span><div className="m-calendar-choices" role="radiogroup" aria-labelledby={id}>
    {options.map((option, index) => <button key={option.value} type="button" role="radio" aria-checked={value === option.value} tabIndex={value === option.value || (!hasValue && index === 0) ? 0 : -1} onClick={() => onChange(option.value)} onKeyDown={event => {
      const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 }[event.key]
      if (delta === undefined && event.key !== 'Home' && event.key !== 'End') return
      event.preventDefault()
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + delta! + options.length) % options.length
      onChange(options[next].value)
      event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus({ preventScroll: true })
    }}>{option.label}</button>)}
  </div></div>
}

function WeeklyList({ state, onOpen, onAdd }: { state: PlannerState; onOpen: (routine: Routine) => void; onAdd: () => void }) {
  const rows = [...state.routines].sort((a, b) => minuteOf(a.start) - minuteOf(b.start) || a.title.localeCompare(b.title, 'zh-CN'))
  return <div className="m-calendar-weekly-list"><p className="m-calendar-note">修改每周安排会同步今天及以后的相关课表，过去记录保留。</p>
    <button type="button" className="m-calendar-primary" onClick={onAdd}><Symbol name="plus" />新增每周安排</button>
    {!rows.length && <p className="m-calendar-note">还没有每周课程或可用时间。</p>}
    {rows.map(row => <button type="button" className="m-calendar-weekly-row" key={row.id} onClick={() => onOpen(row)}><strong>{row.title}{!row.enabled && ' · 已停用'}</strong><span>{kindLabel(row)} · {weekCycleLabel(row)} · {weekOrder.filter(value => row.weekdays.includes(value)).map(value => `周${weekdays[value]}`).join('、')}</span><span>{row.start}–{row.end}{row.location ? ` · ${row.location}` : ''}</span></button>)}
  </div>
}

function useEditor(props: EditorProps) {
  const [baseRevision, setBaseRevision] = useState(props.state.revision)
  const [busy, setBusy] = useState(false)
  const guard = useRef(false)
  const [error, setError] = useState('')
  const [deleting, setDeleting] = useState(false)
  const stale = baseRevision !== props.state.revision
  const execute = async (action: PlannerAction, notice: string, date?: string) => {
    if (guard.current || props.saving || stale) return
    guard.current = true; setBusy(true); props.onBusy(true); setError('')
    try { await props.act(action, baseRevision); props.onSaved(notice, date) }
    catch (reason) { setError(explain(reason)) }
    finally { guard.current = false; setBusy(false); props.onBusy(false) }
  }
  const revisionNotice = stale && <div className="m-calendar-feedback" role="alert"><p>日程已有更新，草稿已保留。核对后可使用当前草稿再次保存。</p><button type="button" className="m-calendar-button" disabled={busy || props.saving} onClick={() => { setBaseRevision(props.state.revision); setDeleting(false); setError('') }}>已核对，保留草稿继续</button></div>
  return { busy, error, setError, deleting, setDeleting, execute, revisionNotice, disabled: busy || props.saving || stale }
}

type ArrangementProps = EditorProps & {
  mode: 'routine' | 'event'; routine?: Routine; event?: DayEvent; initialDate: string
  sourceDate?: string; sourceWeekday?: number; initialStart?: string; initialEnd?: string
}

function ArrangementEditor(props: ArrangementProps) {
  const { state, mode, routine, event, initialDate, sourceDate, sourceWeekday } = props
  const original = mode === 'routine' ? routine && weeklyRoutineSource(state, routine, sourceWeekday) : event && state.dayEvents?.find(row => row.id === event.id)
  const existing = mode === 'routine' ? Boolean(routine) : Boolean(event)
  const missing = existing && !original
  const [draft, setDraft] = useState(() => ({
    id: original?.id ?? crypto.randomUUID(), title: original?.title ?? '', location: original?.location ?? '',
    start: original?.start ?? props.initialStart ?? '', end: original?.end ?? props.initialEnd ?? '',
    date: event?.date ?? initialDate,
    kind: (mode === 'routine' && original && 'kind' in original ? original.kind : 'class') as Routine['kind'],
    weekdays: mode === 'routine' && original && 'weekdays' in original ? [...original.weekdays] : [agendaDate(initialDate)!.getDay()],
    enabled: mode === 'routine' && original && 'enabled' in original ? original.enabled : true,
    weekCycle: (mode === 'routine' && original && 'weekCycle' in original ? original.weekCycle ?? 'weekly' : 'weekly') as NonNullable<Routine['weekCycle']>,
    weekAnchor: mode === 'routine' && original && 'weekAnchor' in original ? original.weekAnchor ?? state.firstWeekMonday ?? '' : state.firstWeekMonday ?? '',
    courseInfo: mode === 'routine' && original && 'courseInfo' in original ? original.courseInfo : undefined,
  }))
  const [items, setItems] = useState(() => original?.items.join('、') ?? '')
  const editor = useEditor(props)
  const patch = <K extends keyof typeof draft>(key: K, value: typeof draft[K]) => { setDraft(current => ({ ...current, [key]: value })); editor.setDeleting(false) }
  const submit = (form: FormEvent) => {
    form.preventDefault()
    if (missing || editor.disabled) return
    if (!draft.title.trim()) { editor.setError('请填写名称。'); return }
    const from = minuteOf(draft.start), to = minuteOf(draft.end)
    if (!Number.isFinite(from) || !Number.isFinite(to) || from >= to || to >= 1440) { editor.setError('请选择同一天内的起止时刻，结束应晚于开始。跨天安排请拆成两天。'); return }
    if (mode === 'routine' && !draft.weekdays.length) { editor.setError('至少选择一个重复星期。'); return }
    if (mode === 'routine' && draft.weekCycle !== 'weekly' && (!draft.weekAnchor || weekStart(draft.weekAnchor) !== draft.weekAnchor)) { editor.setError('单双周课程需要明确第1周的周一日期。'); return }
    const common = { id: draft.id, title: draft.title.trim(), start: draft.start, end: draft.end, location: draft.location.trim(), items: splitItems(items) }
    if (mode === 'event') {
      if (!agendaDate(draft.date)) { editor.setError('请选择有效的活动日期。'); return }
      void editor.execute({ type: 'save-day-event', event: { ...common, date: draft.date } }, `${draft.date} ${draft.start}–${draft.end}「${common.title}」已保存`, draft.date)
    } else {
      const value: Routine = { ...common, kind: draft.kind, weekdays: draft.weekdays, enabled: draft.enabled,
        ...(draft.weekCycle !== 'weekly' ? { weekCycle: draft.weekCycle, weekAnchor: draft.weekAnchor } : {}),
        ...(draft.courseInfo ? { courseInfo: draft.courseInfo } : {}) }
      void editor.execute({ type: 'save-routine', routine: value }, `每周安排「${common.title}」${draft.start}–${draft.end}已保存`)
    }
  }
  const remove = () => {
    if (missing || editor.disabled) return
    if (!editor.deleting) { editor.setDeleting(true); return }
    void editor.execute(mode === 'routine' ? { type: 'delete-routine', id: draft.id } : { type: 'delete-day-event', id: draft.id }, `已删除${mode === 'routine' ? '每周安排' : `${event?.date}的活动`}「${draft.title}」`)
  }
  return <>
    {missing ? <div className="m-calendar-feedback" role="alert"><p>来源安排已被移除或改到其他星期。这条历史记录不能覆盖现在的每周课表。</p><p>{routine?.title ?? event?.title} · {routine?.start ?? event?.start}–{routine?.end ?? event?.end}</p></div>
      : sourceDate && (state.dayExceptions?.[sourceDate] || state.dayOverrides?.[sourceDate]) && <p className="m-calendar-note">{sourceDate} 使用临时课表。这里修改来源的每周安排，今天及以后的相关日期会同步。</p>}
    {editor.revisionNotice}
    <form className="m-calendar-form" onSubmit={submit} onChange={() => editor.setDeleting(false)}><fieldset disabled={editor.disabled || missing}>
      <label>名称<input required maxLength={160} value={draft.title} onChange={e => patch('title', e.target.value)} /></label>
      {mode === 'event' ? <label>日期<input required type="date" value={draft.date} onChange={e => patch('date', e.target.value)} /></label>
        : <ChoiceGroup label="类型" value={draft.kind} onChange={value => patch('kind', value as Routine['kind'])} options={[{ value: 'class', label: '课程 / 固定活动' }, { value: 'available', label: '可用时间 / 空课 / 自习' }, { value: 'break', label: '休息 / 通勤 / 用餐' }]} />}
      <div className="m-calendar-form-pair"><label>开始<input type="time" step={60} required value={draft.start} onInput={e => patch('start', e.currentTarget.value.slice(0, 5))} onChange={e => patch('start', e.target.value.slice(0, 5))} /></label><label>结束<input type="time" step={60} required value={draft.end} onInput={e => patch('end', e.currentTarget.value.slice(0, 5))} onChange={e => patch('end', e.target.value.slice(0, 5))} /></label></div>
      {mode === 'routine' && <>
        <div className="m-calendar-field"><span>重复星期</span><div className="m-calendar-weekday-picks" role="group" aria-label="重复星期">{weekOrder.map(value => <button key={value} type="button" aria-label={`周${weekdays[value]}`} aria-pressed={draft.weekdays.includes(value)} onClick={() => patch('weekdays', draft.weekdays.includes(value) ? draft.weekdays.filter(day => day !== value) : [...draft.weekdays, value])}>{weekdays[value]}</button>)}</div></div>
        <ChoiceGroup label="重复周次" value={draft.weekCycle} onChange={value => patch('weekCycle', value as typeof draft.weekCycle)} options={[{ value: 'weekly', label: '每周' }, { value: 'odd', label: '单周' }, { value: 'even', label: '双周' }]} />
        {draft.weekCycle !== 'weekly' && <><label>第1周的周一<input type="date" required readOnly={Boolean(state.firstWeekMonday)} value={draft.weekAnchor} onChange={e => patch('weekAnchor', e.target.value)} /></label><p className="m-calendar-note">{state.firstWeekMonday ? '沿用统一的第1周日期。' : '请按真实校历选择第1周的周一。'}跨年后周次连续计算。</p></>}
      </>}
      <label>地点<input maxLength={160} value={draft.location} onChange={e => patch('location', e.target.value)} placeholder="可留空" /></label>
      <label>需要携带<textarea rows={2} value={items} onChange={e => setItems(e.target.value)} placeholder="用顿号或换行分隔，可留空" /></label>
      {mode === 'routine' && draft.courseInfo && <details className="m-calendar-course-info"><summary>课程信息</summary>{(['period', 'classGroup', 'note'] as const).map(key => <label key={key}>{{ period: '节次', classGroup: '分组', note: '备注' }[key]}<input maxLength={key === 'note' ? 500 : key === 'period' ? 80 : 160} value={draft.courseInfo?.[key] ?? ''} onChange={e => patch('courseInfo', { ...draft.courseInfo!, [key]: e.target.value })} /></label>)}</details>}
      {mode === 'routine' && <button className="m-calendar-toggle" type="button" role="switch" aria-checked={draft.enabled} onClick={() => patch('enabled', !draft.enabled)}><span>启用这项安排</span><span className="m-calendar-toggle-state" aria-hidden="true">{draft.enabled ? '开' : '关'}</span></button>}
      {editor.error && <p className="m-calendar-feedback" role="alert">{editor.error}<span>草稿已保留。</span></p>}
      {editor.deleting && <p className="m-calendar-feedback" role="alert">确认删除「{draft.title}」？{mode === 'routine' ? '将移除这项每周安排及其未来相关安排。' : '只删除这项单日活动。'}</p>}
      <footer className="m-calendar-form-footer">{existing && <button type="button" className="m-calendar-button" onClick={remove}>{editor.deleting ? '确认删除' : '删除'}</button>}<button type="submit" className="m-calendar-primary">{editor.busy ? '正在保存…' : '保存'}</button></footer>
    </fieldset></form>
  </>
}

function ExceptionEditor(props: EditorProps & { date: string }) {
  const existing = props.state.dayExceptions?.[props.date]
  const [date, setDate] = useState(props.date)
  const [endDate, setEndDate] = useState(props.date)
  const [kind, setKind] = useState<DayException['kind']>(existing?.kind ?? 'holiday')
  const [source, setSource] = useState(existing?.sourceWeekday?.toString() ?? '')
  const editor = useEditor(props)
  const label = dayExceptionLabel(props.state, date)
  const submit = (form: FormEvent) => {
    form.preventDefault()
    if (!agendaDate(date) || !agendaDate(endDate) || endDate < date) { editor.setError('请选择有效的起止日期。'); return }
    if (endDate > localDay(shiftDay(agendaDate(date)!, 30))) { editor.setError('连续日期例外最多31天。'); return }
    if (kind === 'rescheduled' && source === '') { editor.setError('请明确选择这天使用星期几的课表。'); return }
    void editor.execute({ type: 'set-day-exception', date, endDate, kind, ...(kind === 'rescheduled' ? { sourceWeekday: Number(source) } : {}) }, `${date}${endDate === date ? '' : ` 至 ${endDate}`} ${exceptionLabels[kind]}已保存`, date)
  }
  return <><p className="m-calendar-note">按真实校历设置。调课使用你选择的星期课表，单日活动和任务保留。</p>{editor.revisionNotice}
    <form className="m-calendar-form" onSubmit={submit} onChange={() => editor.setDeleting(false)}><fieldset disabled={editor.disabled}>
      <label>开始日期<input type="date" required value={date} onChange={e => { setDate(e.target.value); if (e.target.value > endDate) setEndDate(e.target.value) }} /></label>
      <label>结束日期<input type="date" required min={date} max={agendaDate(date) ? localDay(shiftDay(agendaDate(date)!, 30)) : undefined} value={endDate} onChange={e => setEndDate(e.target.value)} /></label>
      <ChoiceGroup label="日期例外" value={kind} onChange={value => setKind(value as DayException['kind'])} options={Object.entries(exceptionLabels).map(([value, text]) => ({ value, label: text }))} />
      {kind === 'rescheduled' && <><ChoiceGroup label="使用哪天的课表" value={source} onChange={setSource} options={weekOrder.map(value => ({ value: String(value), label: `周${weekdays[value]}` }))} />{source === '' && <p className="m-calendar-note">请选择来源星期，不会自动推断调休课表。</p>}</>}
      {label && <p className="m-calendar-note">{date} 当前：{label}</p>}
      {editor.error && <p className="m-calendar-feedback" role="alert">{editor.error}<span>草稿已保留。</span></p>}
      {editor.deleting && <p className="m-calendar-feedback" role="alert">确认撤销 {date} 的日期例外？恢复这一天的每周安排。</p>}
      <footer className="m-calendar-form-footer">{label && <button type="button" className="m-calendar-button" onClick={() => { if (!editor.deleting) editor.setDeleting(true); else void editor.execute({ type: 'clear-day-exception', date }, `${date} 的日期例外已撤销`, date) }}>{editor.deleting ? '确认撤销' : '撤销当天例外'}</button>}<button type="submit" className="m-calendar-primary">{editor.busy ? '正在保存…' : '保存'}</button></footer>
    </fieldset></form>
  </>
}

function TaskDetail({ task, state, day, onChat }: { task: Task; state: PlannerState; day: string; onChat: (text: string) => void }) {
  const blocks = blocksForDay(state, [task], day)
  const details = state.details[task.id]
  return <article className="m-calendar-task-detail"><h3>{task.title}</h3><p className="m-calendar-note">{task.status === 'done' ? '已完成' : task.status === 'doing' ? '进行中' : '待完成'}{task.estimateMin ? ` · 预计 ${minutesLabel(task.estimateMin)}` : ' · 用时待估'}</p>
    {blocks.map(block => <p className="m-calendar-detail-time" key={block.id}>{day} · {block.start}–{block.end}{block.locked && ' · 已锁定'}</p>)}
    {task.due && <p>截止：{task.due.length === 10 ? task.due : agendaDate(task.due) ? `${fullDate.format(agendaDate(task.due))} ${clock.format(agendaDate(task.due))}` : task.due}</p>}
    {task.notes && <p className="m-calendar-detail-prose">{task.notes}</p>}{details?.preparation && <p className="m-calendar-detail-prose">准备：{details.preparation}</p>}{details?.items.length ? <p>携带：{details.items.join('、')}</p> : null}
    <button type="button" className="m-calendar-primary" onClick={() => onChat(`请核对事项「${task.title}」（ID：${task.id}）在 ${day} 的安排，协助我调整时间或估时。`)}>请析熙协助调整</button>
  </article>
}
