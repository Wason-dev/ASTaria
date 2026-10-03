import { useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import type { Task } from '../domain/task'
import { agendaDate, localDay, monthDays, shiftDay } from '../home/agenda'
import { blocksForDay, compactMinutesLabel, dayCapacity, minuteOf, minutesLabel, routinesForDay } from './model'
import type { DayCapacity, PlannerState } from './types'
import { usePeriodMotion } from './usePeriodMotion'
import { taskDayCompletion } from './completion'
import { dayExceptionLabel } from './exceptionLabels'

type Props = {
  state: PlannerState; tasks: Task[]; selected: string; anchor: Date; now: Date
  mode: 'month' | 'week'; direction: number; onSelect: (date: string) => void
}
type Entry = { id: string; title: string; done: boolean; event: boolean; deadline: boolean; planned: boolean; time: string; label: string }
const weekdays = ['一', '二', '三', '四', '五', '六', '日']
const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

function entriesForDay(state: PlannerState, tasks: Task[], day: string): Entry[] {
  const blocks = blocksForDay(state, tasks, day)
  const explicitlyPlanned = new Set(state.blocks.filter(block => {
    const start = minuteOf(block.start), end = minuteOf(block.end)
    return agendaDate(block.date) && Number.isFinite(start) && start < 1440 && Number.isFinite(end) && start !== end
  }).map(block => block.taskId))
  const taskEntries: Entry[] = tasks.filter(task => !task.deletedAt && task.status !== 'dropped').flatMap(task => {
    const due = agendaDate(task.due), start = agendaDate(task.startAt)
    const taskBlocks = blocks.filter(block => block.taskId === task.id)
    const deadline = Boolean(due && localDay(due) === day)
    const undeterminedDay = !explicitlyPlanned.has(task.id) && task.startAt?.length === 10 && start && localDay(start) === day
    const planned = taskBlocks.length > 0 || Boolean(undeterminedDay)
    if (!deadline && !planned) return []
    const block = taskBlocks[0]
    const time = block ? `${block.start}–${block.end}`
      : planned && task.startAt?.includes('T') && start ? clock.format(start)
        : deadline && task.due?.includes('T') && due ? clock.format(due) : ''
    const completion = taskDayCompletion(task, state, day, taskBlocks)
    const label = [planned ? '已安排' : '', deadline ? '截止' : '', time, completion.label].filter(Boolean).join(' · ')
    return [{ id: `task:${task.id}`, title: task.title, done: completion.done, event: false, deadline, planned, time, label }]
  })
  const eventEntries: Entry[] = (state.dayEvents ?? []).filter(event => event.date === day).map(event => {
    const time = `${event.start}–${event.end}`
    return { id: `event:${event.id}`, title: event.title, done: false, event: true, deadline: false, planned: true, time, label: `单日活动 · ${time}` }
  })
  return [...taskEntries, ...eventEntries].sort((a, b) => Number(a.done) - Number(b.done)
    || Number(b.deadline) - Number(a.deadline) || a.time.localeCompare(b.time) || a.title.localeCompare(b.title, 'zh-CN'))
}

function capacityInfo(state: PlannerState, day: string, today: string, capacity: DayCapacity) {
  const known = routinesForDay(state, day).some(routine => routine.kind === 'available')
  const minutes = day === today ? capacity.remainingMin : capacity.freeMin
  const label = known ? `可支配 ${minutesLabel(minutes)}` : '空课待补充'
  return { known, minutes, label, title: `${state.timetableConfirmed ? '' : '仅按已知时段 · '}${label}` }
}

export function CalendarBoard({ state, tasks, selected, anchor, now, mode, direction, onSelect }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const keyboardDate = useRef<string | null>(null)
  const today = localDay(now)
  const monday = shiftDay(anchor, -((anchor.getDay() + 6) % 7))
  const dates = mode === 'month' ? monthDays(anchor) : Array.from({ length: 7 }, (_, i) => shiftDay(monday, i))
  const pageKey = mode === 'month' ? `month-${anchor.getFullYear()}-${anchor.getMonth()}` : `week-${localDay(monday)}`
  const focusDate = dates.some(date => localDay(date) === selected) ? selected : localDay(dates[0])

  useLayoutEffect(() => {
    if (!keyboardDate.current || keyboardDate.current !== selected) return
    root.current?.querySelector<HTMLButtonElement>(`[data-period-current=true] button[data-date="${selected}"]`)?.focus({ preventScroll: true })
    keyboardDate.current = null
  }, [selected, pageKey])

  const moveDate = (event: KeyboardEvent<HTMLButtonElement>, day: Date) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key]
    if (delta === undefined) return
    event.preventDefault()
    const next = localDay(shiftDay(day, delta))
    keyboardDate.current = next
    onSelect(next)
  }

  const frame = <div className={mode === 'month' ? 'pl-calendar-grid' : 'pl-week-grid'} data-period-key={pageKey}
      aria-label={mode === 'month' ? `${anchor.getFullYear()}年${anchor.getMonth() + 1}月` : `${dateLabel.format(monday)}起的一周`}>
      {dates.map(date => {
        const day = localDay(date), entries = entriesForDay(state, tasks, day)
        const capacity = dayCapacity(state, tasks, day, now), info = capacityInfo(state, day, today, capacity)
        const isToday = day === today, outside = date.getMonth() !== anchor.getMonth()
        const exception = dayExceptionLabel(state, day)
        const ariaLabel = `${dateLabel.format(date)}${isToday ? '，今天' : ''}${exception ? `，${exception}` : ''}，${entries.length} 项，${info.title}`
        const capacityBar = <span className="pl-calendar-capacity" data-known={info.known} title={info.title}>
          <span className="pl-calendar-capacity-track" aria-hidden="true"><span style={{ width: `${capacity.totalMin ? Math.min(100, info.minutes / capacity.totalMin * 100) : 0}%` }} /></span>
          <small>{info.known ? compactMinutesLabel(info.minutes) : info.label}</small>
        </span>

        return mode === 'month' ? <button key={day} type="button" className="pl-calendar-day" data-date={day} data-today={isToday}
          data-outside={outside} aria-pressed={day === selected} aria-current={isToday ? 'date' : undefined} aria-label={ariaLabel}
          tabIndex={day === focusDate ? 0 : -1} onClick={() => onSelect(day)} onKeyDown={event => moveDate(event, date)}>
          <span className="pl-calendar-date"><span>{date.getDate()}</span>{exception && <small className="pl-calendar-exception" title={exception}>{exception}</small>}{isToday && <small>今天</small>}</span>
          <span className="pl-calendar-entries">{entries.slice(0, 2).map(entry => <span key={entry.id} className="pl-calendar-entry"
            data-kind={entry.planned ? 'plan' : 'deadline'} data-done={entry.done} title={`${entry.title} · ${entry.label}`}>
            {entry.deadline && <span className="pl-calendar-deadline-mark" aria-hidden="true">◇</span>}<span className="pl-calendar-entry-copy">{entry.event && <small className="pl-calendar-entry-time">{entry.time}</small>}<span>{entry.title}</span></span>
          </span>)}</span>
          {entries.length > 2 && <span className="pl-calendar-more">+{entries.length - 2}</span>}
          {capacityBar}
        </button> : <section key={day} className="pl-week-day" data-selected={day === selected} data-today={isToday}>
          <button type="button" className="pl-week-date" data-date={day} aria-pressed={day === selected} aria-current={isToday ? 'date' : undefined}
            aria-label={ariaLabel} tabIndex={day === focusDate ? 0 : -1} onClick={() => onSelect(day)} onKeyDown={event => moveDate(event, date)}>
            <span>周{weekdays[(date.getDay() + 6) % 7]}</span><strong>{date.getDate()}</strong>{exception && <small title={exception}>{exception}</small>}{isToday && <small>今天</small>}
          </button>
          <ul className="pl-week-list">{entries.map(entry => <li key={entry.id} className="pl-week-entry" data-kind={entry.planned ? 'plan' : 'deadline'} data-done={entry.done}>
            <button type="button" onClick={() => onSelect(day)} aria-label={`${dateLabel.format(date)}，${entry.title}，${entry.label}`}>
              <span className="pl-week-entry-time">{entry.deadline && <span aria-hidden="true">◇ </span>}{entry.time || (entry.deadline ? '当天截止' : '时间待定')}</span>
              <strong>{entry.title}</strong>{entry.deadline && entry.planned && <small>含当日截止</small>}
            </button>
          </li>)}</ul>
          {!entries.length && <p className="pl-week-empty">暂无事项</p>}
          <div className="pl-week-capacity">{capacityBar}</div>
        </section>
      })}
    </div>
  const motion = usePeriodMotion(pageKey, mode, frame, direction)
  const current = <div key="current" className="pl-period-frame" data-period-current="true">{frame}</div>
  const previous = motion.previous && <div key="previous" className="pl-period-frame" data-period-current="false" inert aria-hidden="true">{motion.previous}</div>
  return <div ref={root} className="pl-calendar-board" data-mode={mode}>
    {mode === 'month' && <div className="pl-calendar-weekdays" aria-hidden="true">{weekdays.map(day => <span key={day}>周{day}</span>)}</div>}
    <div className="pl-period-window" data-moving={motion.moving} data-direction={motion.direction}>
      <div key={motion.revision} className="pl-period-track" onAnimationEnd={motion.finish}>
        {motion.direction === 'previous' ? <>{current}{previous}</> : <>{previous}{current}</>}
      </div>
    </div>
    {!state.timetableConfirmed && <p className="pl-calendar-note">可支配时间仅按已知时段计算，未填写的时间不算空课</p>}
  </div>
}
