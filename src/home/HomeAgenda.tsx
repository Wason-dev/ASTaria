import { useEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Task } from '../domain/task'
import { agendaDate, agendaItems, dayTaskLabel, deadlineItems, deadlineLabel, isOpenTask, isOverdue, localDay, monthDays, shiftDay, shiftMonth, taskOnDay } from './agenda'
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
  const today = localDay(now)
  const [selection, setSelection] = useState<string | null>(null)
  const selected = selection ?? today
  const selectedDate = agendaDate(selected)!
  const [browsingMonth, setBrowsingMonth] = useState<string | null>(null)
  const month = browsingMonth ?? today.slice(0, 7)
  const monthDate = agendaDate(`${month}-01`)!
  const dates = useMemo(() => monthDays(monthDate), [month])
  const [motion, setMotion] = useState<MonthMotion>({ month, previous: null, direction: 'next', revision: 0 })
  // Keep just one outgoing month. A newer destination replaces an interrupted transition.
  if (motion.month !== month) setMotion({ month, previous: motion.month, direction: month > motion.month ? 'next' : 'previous', revision: motion.revision + 1 })
  const previousDates = useMemo(() => motion.previous ? monthDays(agendaDate(`${motion.previous}-01`)!) : null, [motion.previous])
  const calendar = useRef<HTMLTableElement>(null)
  const back = useRef<HTMLButtonElement>(null)
  const focusDay = useRef<string | null>(null)
  const selectedItems = useMemo(() => agendaItems(tasks, selected, today), [tasks, selected, today])
  const todayItems = useMemo(() => agendaItems(tasks, today, today), [tasks, today])
  const deadlines = useMemo(() => deadlineItems(tasks), [tasks])
  const undated = useMemo(() => tasks.filter(task => isOpenTask(task) && !agendaDate(task.startAt) && !task.due && task.fuzzyWindow !== 'today' && task.status !== 'doing'), [tasks])
  const readable = !loading && !error
  const tabDay = dates.some(date => localDay(date) === selected) ? selected : `${month}-01`

  useEffect(() => { if (active && compact) back.current?.focus({ preventScroll: true }) }, [active, compact])
  useEffect(() => {
    if (!focusDay.current) return
    calendar.current?.querySelector<HTMLButtonElement>(`button[data-date="${focusDay.current}"]`)?.focus({ preventScroll: true })
    focusDay.current = null
  }, [selected, month])

  const choose = (date: Date, focus = false) => {
    const day = localDay(date)
    if (focus) focusDay.current = day
    setSelection(day === today ? null : day)
    setBrowsingMonth(day.slice(0, 7))
  }
  const moveMonth = (direction: number) => setBrowsingMonth(current => localDay(shiftMonth(agendaDate(`${current ?? today.slice(0, 7)}-01`)!, direction)).slice(0, 7))
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, date: Date) => {
    const offset = (date.getDay() + 6) % 7
    const deltas: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7, Home: -offset, End: 6 - offset }
    if (event.key in deltas) { event.preventDefault(); choose(shiftDay(date, deltas[event.key]), true) }
    else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault(); choose(shiftMonth(date, event.key === 'PageUp' ? -1 : 1), true)
    }
  }

  return <aside id="home-agenda" className="home-agenda" aria-label="日程概览" inert={!active} aria-hidden={!active}>
    <header className="home-agenda-header"><h2>日程</h2>{compact
      ? <button ref={back} className="home-agenda-back" onClick={onChat} aria-controls="home-xixi">← 对话</button>
      : <span>事项概览</span>}</header>
    <div className="home-agenda-scroll" tabIndex={active ? 0 : -1} aria-label="月历与事项，可滚动">
      <section className="home-calendar" aria-label="月历">
        <div className="home-month-controls">
          <strong aria-live="polite"><span key={motion.revision} className={motion.previous ? 'home-month-label-enter' : undefined}>{monthFormat.format(monthDate)}</span></strong>
          <div><button aria-label="上个月" onClick={() => moveMonth(-1)}>‹</button>
            <button className="home-month-today" onClick={() => { setSelection(null); setBrowsingMonth(null) }}>今天</button>
            <button aria-label="下个月" onClick={() => moveMonth(1)}>›</button></div>
        </div>
        <div className="home-month-window" data-direction={motion.direction} data-transitioning={Boolean(motion.previous)}>
        {previousDates && <table key={`out-${motion.revision}`} className="home-month-grid home-month-grid-exit" aria-hidden="true" inert>
          <thead><tr>{['一', '二', '三', '四', '五', '六', '日'].map(day => <th key={day}>{day}</th>)}</tr></thead>
          <tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>{previousDates.slice(week * 7, week * 7 + 7).map(date => {
            const day = localDay(date)
            const count = readable ? tasks.filter(task => taskOnDay(task, day, today)).length : 0
            return <td key={day}><span className="home-month-day" data-outside={day.slice(0, 7) !== motion.previous} data-selected={selected === day} data-today={today === day}>
              {date.getDate()}{count > 0 && <i />}
            </span></td>
          })}</tr>)}</tbody>
        </table>}
        <table key={`in-${motion.revision}`} ref={calendar} className={`home-month-grid${motion.previous ? ' home-month-grid-enter' : ''}`} aria-label={`${monthFormat.format(monthDate)}月历`}
          onAnimationEnd={event => {
            if (event.target !== event.currentTarget) return
            setMotion(current => current.revision === motion.revision ? { ...current, previous: null } : current)
          }}>
          <thead><tr>{['一', '二', '三', '四', '五', '六', '日'].map(day => <th scope="col" key={day}><span aria-hidden="true">{day}</span><span className="p0-sr-only">星期{day}</span></th>)}</tr></thead>
          <tbody>{Array.from({ length: 6 }, (_, week) => <tr key={week}>{dates.slice(week * 7, week * 7 + 7).map(date => {
            const day = localDay(date)
            const count = readable ? tasks.filter(task => taskOnDay(task, day, today)).length : 0
            return <td key={day}><button data-date={day} data-outside={day.slice(0, 7) !== month} tabIndex={day === tabDay ? 0 : -1}
              aria-label={`${fullDate.format(date)}${day === today ? '，今天' : ''}${readable ? `，${count} 项事项` : ''}`}
              aria-pressed={selected === day} aria-current={today === day ? 'date' : undefined}
              onClick={() => choose(date)} onKeyDown={event => keyboard(event, date)}>
              {date.getDate()}{count > 0 && <i aria-hidden="true" />}
            </button></td>
          })}</tr>)}</tbody>
        </table>
        </div>
      </section>
      {loading ? <p className="home-agenda-empty" role="status">正在读取事项</p> : error ? <p className="home-agenda-error" role="alert">读取失败 <button onClick={onRetry}>重试</button></p> : <>
        <AgendaSection title={`${shortDate.format(selectedDate)} · 事项`} name="selected" tasks={selectedItems} empty="这天暂无已安排事项" onTask={onTask} label={task => dayTaskLabel(task, selected)} />
        <AgendaSection title="今日待办" name="today" tasks={todayItems} empty="今天暂无已安排待办" onTask={onTask} label={task => dayTaskLabel(task, today)} />
        <AgendaSection title="DDL" name="deadlines" tasks={deadlines} empty="暂无截止事项" onTask={onTask} label={task => deadlineLabel(task, now)} overdue={task => isOverdue(task, now)} />
        {undated.length > 0 && <details className="home-agenda-undated"><summary>未定日期 <span>{undated.length}</span></summary>
          <AgendaList tasks={undated} onTask={onTask} label={() => '待安排'} />
        </details>}
      </>}
    </div>
  </aside>
}

function AgendaSection({ title, name, tasks, empty, onTask, label, overdue }: {
  title: string; name: string; tasks: Task[]; empty: string; onTask: (id: string) => void; label: (task: Task) => string; overdue?: (task: Task) => boolean
}) {
  return <section className="home-agenda-section" data-agenda-section={name} data-empty={tasks.length === 0} aria-label={title}>
    <h3>{title}<span>{tasks.length}</span></h3>
    {tasks.length ? <AgendaList tasks={tasks} onTask={onTask} label={label} overdue={overdue} /> : <p className="home-agenda-empty">{empty}</p>}
  </section>
}

function AgendaList({ tasks, onTask, label, overdue }: {
  tasks: Task[]; onTask: (id: string) => void; label: (task: Task) => string; overdue?: (task: Task) => boolean
}) {
  return <ul className="home-agenda-list">{tasks.map(task => <li key={task.id}>
    <button onClick={() => onTask(task.id)} title={task.title} data-overdue={overdue?.(task)}>
      <span>{task.title}</span><small>{label(task)}</small>
    </button>
  </li>)}</ul>
}
