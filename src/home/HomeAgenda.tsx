import { useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent } from 'react'
import type { Task } from '../domain/task'
import { TaskCardStack } from '../ui/TaskCardStack'
import { DayEventDialog } from '../planner/PlannerDialogs'
import { usePlanner } from '../planner/usePlanner'
import type { DayEvent } from '../planner/types'
import { useHomeDeadlinePicker } from './HomeDeadlinePicker'
import { STATUS_LABELS } from '../spatial/scene'
import { agendaDate, agendaItems, agendaPlanIndex, dayTaskLabel, deadlineItems, deadlineLabel, isOverdue, isUndatedTask, localDay, monthDays, shiftDay, shiftMonth, taskOnDay } from './agenda'
import './agenda.css'

type Props = {
  tasks: Task[]; now: Date; loading: boolean; error: string; active: boolean; compact: boolean
  onRetry: () => void; onTask: (id: string) => void; onChat: () => void
}
const fullDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
const monthFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' })
const shortDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' })
type MonthMotion = { month: string; previous: string | null; direction: 'next' | 'previous'; revision: number }

export function HomeAgenda({ tasks, now, loading, error, active, compact, onRetry, onTask, onChat }: Props) {
  const planner = usePlanner(active)
  const [editingEvent, setEditingEvent] = useState<DayEvent | null>(null)
  const [eventNotice, setEventNotice] = useState('')
  const deadlinePicker = useHomeDeadlinePicker()
  const draft = deadlinePicker?.draft
  const presentedDraft = deadlinePicker?.presentedDraft
  const leaving = Boolean(presentedDraft && !draft)
  const calendarDisabled = Boolean(draft?.busy || leaving)
  const [editingMonth, setEditingMonth] = useState<{ token: number; month: string } | null>(null)
  const today = localDay(now)
  const [selection, setSelection] = useState<string | null>(null)
  const overviewDay = selection ?? today
  const selected = presentedDraft?.date || overviewDay
  const [dayMotion, setDayMotion] = useState({ day: overviewDay, revision: 0 })
  if (dayMotion.day !== overviewDay) setDayMotion({ day: overviewDay, revision: dayMotion.revision + 1 })
  const selectedDate = agendaDate(overviewDay)!
  const [browsingMonth, setBrowsingMonth] = useState<string | null>(null)
  const requestedMonth = presentedDraft ? editingMonth?.token === presentedDraft.token ? editingMonth.month : presentedDraft.date.slice(0, 7) : browsingMonth ?? today.slice(0, 7)
  const [motion, setMotion] = useState<MonthMotion>({ month: requestedMonth, previous: null, direction: 'next', revision: 0 })
  // Keep the requested month separate from the page currently in motion. Rapid
  // clicks update the request; each animation still travels one complete page.
  const month = motion.month
  if (motion.previous === null && motion.month !== requestedMonth) {
    setMotion({ month: requestedMonth, previous: motion.month, direction: requestedMonth > motion.month ? 'next' : 'previous', revision: motion.revision + 1 })
  }
  const monthDate = agendaDate(`${month}-01`)!
  const dates = useMemo(() => monthDays(monthDate), [month])
  const previousDates = useMemo(() => motion.previous ? monthDays(agendaDate(`${motion.previous}-01`)!) : null, [motion.previous])
  const calendar = useRef<HTMLTableElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const focusDay = useRef<string | null>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const taskPlans = useMemo(() => agendaPlanIndex(planner.state?.blocks ?? []), [planner.state?.blocks])
  const selectedItems = useMemo(() => agendaItems(tasks, overviewDay, today, taskPlans), [tasks, overviewDay, today, taskPlans])
  const todayItems = useMemo(() => agendaItems(tasks, today, today, taskPlans), [tasks, today, taskPlans])
  const deadlines = useMemo(() => deadlineItems(tasks), [tasks])
  const undated = useMemo(() => tasks.filter(task => isUndatedTask(task, taskPlans)), [tasks, taskPlans])
  const readable = !loading && !error
  const eventsReadable = Boolean(planner.state) && !planner.error
  const selectedEvents = useMemo(() => (planner.state?.dayEvents ?? []).filter(event => event.date === overviewDay)
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end) || a.title.localeCompare(b.title, 'zh-CN')), [planner.state?.dayEvents, overviewDay])
  const eventCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const event of planner.state?.dayEvents ?? []) counts.set(event.date, (counts.get(event.date) ?? 0) + 1)
    return counts
  }, [planner.state?.dayEvents])
  const countForDay = (day: string) => (readable && eventsReadable ? tasks.filter(task => taskOnDay(task, day, today, taskPlans)).length : 0)
    + (eventsReadable ? eventCounts.get(day) ?? 0 : 0)
  const tabDay = dates.some(date => localDay(date) === selected) ? selected : `${month}-01`
  const selectedIndex = dates.findIndex(date => localDay(date) === selected)

  useEffect(() => { if (active && compact && !draft) back.current?.focus({ preventScroll: true }) }, [active, compact])
  useEffect(() => {
    if (!active || presentedDraft) { setEditingEvent(null); setEventNotice('') }
  }, [active, presentedDraft?.token])
  useEffect(() => {
    if (!draft) return
    scroll.current?.scrollTo({ top: 0, behavior: 'instant' })
    focusDay.current = draft.date
  }, [draft?.token])
  useEffect(() => {
    if (!active) { focusDay.current = null; return }
    if (!focusDay.current) return
    const target = calendar.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusDay.current}"]`)
    if (!target) return
    target.focus({ preventScroll: true })
    if (month === requestedMonth) focusDay.current = null
  }, [selected, month, requestedMonth, active, draft?.token])

  const choose = (date: Date, focus = false) => {
    if (calendarDisabled) return
    const day = localDay(date)
    if (focus) focusDay.current = day
    if (draft) {
      deadlinePicker!.update(draft.owner, { date: day })
      setEditingMonth({ token: draft.token, month: day.slice(0, 7) })
      return
    }
    setSelection(day === today ? null : day)
    setEventNotice('')
    setBrowsingMonth(day.slice(0, 7))
  }
  const moveMonth = (direction: number) => {
    if (calendarDisabled) return
    focusDay.current = null
    if (draft) {
      setEditingMonth({ token: draft.token, month: localDay(shiftMonth(agendaDate(`${requestedMonth}-01`)!, direction)).slice(0, 7) })
      return
    }
    setBrowsingMonth(current => localDay(shiftMonth(agendaDate(`${current ?? today.slice(0, 7)}-01`)!, direction)).slice(0, 7))
  }
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const origin = focusDay.current ? agendaDate(focusDay.current)! : date
    const offset = (origin.getDay() + 6) % 7
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -offset, End: 6 - offset }
    if (event.key in deltas) { event.preventDefault(); choose(shiftDay(origin, deltas[event.key]), true) }
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); choose(shiftMonth(origin, event.key === 'PageUp' ? -1 : 1), true)
    }
  }

  return <aside id="home-agenda" className="home-agenda" data-picking-deadline={Boolean(draft)} data-deadline-present={Boolean(presentedDraft)} aria-label="日程概览" inert={!active} aria-hidden={!active} onKeyDown={event => {
    if (event.key === 'Escape' && presentedDraft) { event.preventDefault(); event.stopPropagation(); if (draft && !draft.busy) deadlinePicker!.close(draft.owner) }
  }}>
    <header className="home-agenda-header">
      <h2 className="home-agenda-mode-title"><span className="home-agenda-mode-label" data-visible={!draft} aria-hidden={Boolean(draft)}>日程</span><span className="home-agenda-mode-label" data-visible={Boolean(draft)} aria-hidden={!draft}>选择截止时间</span></h2>
      <div className="home-agenda-mode-actions">
        <span className="home-agenda-mode-label" data-visible={!draft} inert={Boolean(presentedDraft)} aria-hidden={Boolean(draft)}>{compact
          ? <button ref={back} className="home-agenda-back" onClick={onChat} aria-controls="home-xixi">← 对话</button>
          : <span className="home-agenda-summary-label">事项概览</span>}</span>
        <span className="home-agenda-mode-label" data-visible={Boolean(draft)} inert={!draft} aria-hidden={!draft}><button className="home-agenda-back" disabled={!draft || draft.busy} onClick={() => { if (draft) deadlinePicker!.close(draft.owner) }} aria-label="取消选择截止时间">取消</button></span>
      </div>
    </header>
    <div ref={scroll} className="home-agenda-scroll" tabIndex={active ? 0 : -1} aria-label="月历与事项，可滚动">
      <div className="home-agenda-mode-reveal" data-open={Boolean(draft)} inert={!draft} aria-hidden={!draft}><div className="home-agenda-mode-content">
        <div className="home-deadline-target" role={draft ? 'status' : undefined}><span>正在设置</span><strong title={presentedDraft?.title}>{presentedDraft?.title}</strong><p>点选日期，再选择时刻</p></div>
      </div></div>
      <section className="home-calendar" aria-label="月历" inert={leaving}>
        <div className="home-month-controls">
          <strong aria-live="polite"><span key={motion.revision} className={motion.previous ? 'home-month-label-enter' : undefined}>{monthFormat.format(monthDate)}</span></strong>
          <div><button aria-label="上个月" disabled={calendarDisabled} onClick={() => moveMonth(-1)}>‹</button>
            <button className="home-month-today" disabled={calendarDisabled} onClick={() => { if (calendarDisabled) return; if (draft) choose(now, true); else { focusDay.current = null; setSelection(null); setBrowsingMonth(null) } }}>今天</button>
            <button aria-label="下个月" disabled={calendarDisabled} onClick={() => moveMonth(1)}>›</button></div>
        </div>
        <div className="home-month-window" data-direction={motion.direction} data-transitioning={Boolean(motion.previous)}>
        <div key={`selection-${motion.revision}`} className="home-day-highlight-page" data-entering={Boolean(motion.previous)} aria-hidden="true">
          <span className="home-day-highlight" data-visible={selectedIndex >= 0} style={{
            '--selected-column': Math.max(0, selectedIndex) % 7,
            '--selected-row': Math.floor(Math.max(0, selectedIndex) / 7),
          } as CSSProperties} />
        </div>
        {previousDates && <table key={`out-${motion.revision}`} className="home-month-grid home-month-grid-exit" aria-hidden="true" inert>
          <thead><tr>{['一', '二', '三', '四', '五', '六', '日'].map(day => <th key={day}>{day}</th>)}</tr></thead>
          <tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>{previousDates.slice(week * 7, week * 7 + 7).map(date => {
            const day = localDay(date)
            const count = countForDay(day)
            return <td key={day}><span className="home-month-day" data-outside={day.slice(0, 7) !== motion.previous} data-selected={selected === day} data-today={today === day}>
              {date.getDate()}{count > 0 && <i />}
            </span></td>
          })}</tr>)}</tbody>
        </table>}
        <table key={`in-${motion.revision}`} ref={calendar} className={`home-month-grid${motion.previous ? ' home-month-grid-enter' : ''}`} aria-label={`${monthFormat.format(monthDate)}月历`}
          onBlur={event => {
            if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) focusDay.current = null
          }}
          onAnimationEnd={event => {
            if (event.target !== event.currentTarget) return
            setMotion(current => current.revision === motion.revision ? { ...current, previous: null } : current)
          }}>
          <thead><tr>{['一', '二', '三', '四', '五', '六', '日'].map(day => <th scope="col" key={day}><span aria-hidden="true">{day}</span><span className="p0-sr-only">星期{day}</span></th>)}</tr></thead>
          <tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>{dates.slice(week * 7, week * 7 + 7).map(date => {
            const day = localDay(date)
            const count = countForDay(day)
            return <td key={day}><button data-date={day} data-outside={day.slice(0, 7) !== month} tabIndex={day === tabDay ? 0 : -1} disabled={calendarDisabled}
              aria-label={`${fullDate.format(date)}${day === today ? '，今天' : ''}${eventsReadable ? `，${count} 项${readable ? '事项' : '已读取事项'}` : ''}`}
              aria-pressed={selected === day} aria-current={today === day ? 'date' : undefined}
              onClick={() => choose(date, true)} onKeyDown={event => keyboard(event, date)}>
              {date.getDate()}{count > 0 && <i aria-hidden="true" />}
            </button></td>
          })}</tr>)}</tbody>
        </table>
        </div>
      </section>
      <div className="home-agenda-mode-reveal home-agenda-editor-reveal" data-open={Boolean(draft)} inert={!draft} aria-hidden={!draft}><div className="home-agenda-mode-content">
        <div id="home-deadline-editor" className="home-deadline-editor xixi-receipt-deadline" ref={deadlinePicker?.setHost} />
      </div></div>
      <div className="home-agenda-mode-reveal home-agenda-overview-reveal" data-open={!draft} inert={Boolean(presentedDraft)} aria-hidden={Boolean(draft)}><div className="home-agenda-mode-content">
      {loading ? <p className="home-agenda-empty" role="status">正在读取事项</p> : error ? <p className="home-agenda-error" role="alert">读取失败 <button onClick={onRetry}>重试</button></p>
        : planner.error ? <p className="home-agenda-error" role="alert">事项安排读取失败 <button type="button" disabled={planner.loading} onClick={() => void planner.refresh()}>重试</button></p>
          : !planner.state ? <p className="home-agenda-empty" role="status">正在读取事项安排</p>
            : <AgendaSection key={overviewDay} animate={dayMotion.revision > 0} title={`${shortDate.format(selectedDate)} · 事项`} name="selected" tasks={selectedItems} empty="这天暂无已安排事项" onTask={onTask} label={task => dayTaskLabel(task, overviewDay, taskPlans)} />}
      <section key={`events:${overviewDay}`} className={`home-agenda-section${dayMotion.revision > 0 ? ' home-day-content-enter' : ''}`} data-agenda-section="events" data-empty={eventsReadable && selectedEvents.length === 0} aria-label={`${shortDate.format(selectedDate)} · 活动`}>
        <h3>{shortDate.format(selectedDate)} · 活动{eventsReadable && <span>{selectedEvents.length}</span>}</h3>
        {planner.error ? <p className="home-agenda-error" role="alert">活动读取失败 <button type="button" disabled={planner.loading} onClick={() => void planner.refresh()}>重试</button></p>
          : !planner.state ? <p className="home-agenda-empty" role="status">正在读取活动</p>
            : selectedEvents.length ? <ul className="home-agenda-list">{selectedEvents.map(event => <li key={event.id}>
              <button type="button" disabled={planner.saving} style={{ '--task-state-color': 'var(--xixi-gold)' } as CSSProperties} aria-label={`编辑单日活动，${event.title}，${event.date}，${event.start}–${event.end}${event.location ? `，${event.location}` : ''}`} onClick={() => { setEventNotice(''); setEditingEvent(event) }}>
                <span>{event.title}</span><small>{event.start}–{event.end}{event.location && ` · ${event.location}`}</small>
              </button>
            </li>)}</ul> : <p className="home-agenda-empty">这天暂无活动</p>}
      </section>
      {eventNotice && <p className="home-agenda-empty" role="status">{eventNotice}</p>}
      {readable && <>
        {eventsReadable && <AgendaSection title="今日待办" name="today" tasks={todayItems} empty="今天暂无已安排待办" onTask={onTask} label={task => dayTaskLabel(task, today, taskPlans)} />}
        <AgendaSection title="DDL" name="deadlines" tasks={deadlines} empty="暂无截止事项" onTask={onTask} label={task => deadlineLabel(task, now)} overdue={task => isOverdue(task, now)} />
        {eventsReadable && undated.length > 0 && <section className="home-agenda-undated" aria-label="未定日期"><h3>未定日期 <span>{undated.length}</span></h3>
          <TaskCardStack compact label="未定日期" items={undated.map(task => ({ id: task.id, title: task.title, meta: task.estimateMin ? `${task.estimateMin} 分钟 · 待安排` : '用时待估 · 待安排' }))} onOpen={onTask} empty="暂无待安排事项" />
        </section>}
      </>}
      </div></div>
    </div>
    {active && !presentedDraft && editingEvent && planner.state && <DayEventDialog key={editingEvent.id} event={editingEvent} state={planner.state} act={planner.act} onClose={() => setEditingEvent(null)} onNotice={setEventNotice} />}
  </aside>
}

function AgendaSection({ title, name, tasks, empty, onTask, label, overdue, animate = false }: {
  title: string; name: string; tasks: Task[]; empty: string; onTask: (id: string) => void; label: (task: Task) => string; overdue?: (task: Task) => boolean; animate?: boolean
}) {
  return <section className={`home-agenda-section${animate ? ' home-day-content-enter' : ''}`} data-agenda-section={name} data-empty={tasks.length === 0} aria-label={title}>
    <h3>{title}<span>{tasks.length}</span></h3>
    {tasks.length ? <AgendaList tasks={tasks} onTask={onTask} label={label} overdue={overdue} /> : <p className="home-agenda-empty">{empty}</p>}
  </section>
}

function AgendaList({ tasks, onTask, label, overdue }: {
  tasks: Task[]; onTask: (id: string) => void; label: (task: Task) => string; overdue?: (task: Task) => boolean
}) {
  return <ul className="home-agenda-list">{tasks.map(task => <li key={task.id}>
    <button onClick={() => onTask(task.id)} title={`${task.title} · ${STATUS_LABELS[task.status]}`} aria-label={`${task.title}，${STATUS_LABELS[task.status]}，${label(task)}`} data-task-status={task.status} data-overdue={overdue?.(task)}>
      <span>{task.title}</span><small>{label(task)}</small>
    </button>
  </li>)}</ul>
}
