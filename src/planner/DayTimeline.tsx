import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { Task } from '../domain/task'
import { agendaDate, agendaPlanIndex, dayTaskLabel, localDay } from '../home/agenda'
import { dayExceptionLabel } from './exceptionLabels'
import { minutesLabel, timeOf } from './model'
import type { PlannerState, Routine } from './types'
import { desktopDayModel, dayStripLayout } from './desktopDayModel'
import type { DesktopDayEntry } from './desktopDayModel'
import { usePeriodMotion } from './usePeriodMotion'
import './desktop-day-timeline.css'

const clock = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const dateLabel = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })
const kindLabel = { course: '课程', event: '活动', break: '休息', task: '计划', free: '空档' }
export type DayTimelineProps = {
  state: PlannerState; tasks: Task[]; selected: string; now: Date; direction?: number
  onRoutine: (routine: Routine, date: string) => void
  onTask: (id: string, blockId?: string, date?: string) => void
  onCreate?: () => void
}

/** Desktop day: one horizontal timetable, with overlaps inside their time slot. */
export function DayTimeline({ state, tasks, selected, now, direction = 1, onRoutine, onTask, onCreate }: DayTimelineProps) {
  const measure = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [sourceKey, setSourceKey] = useState<string | null>(null)
  const model = useMemo(() => desktopDayModel(state, tasks, selected, now), [state, tasks, selected, now])
  const strip = useMemo(() => dayStripLayout(model.tracks.flatMap(track => track.entries), model.start, model.end), [model])
  const plans = useMemo(() => agendaPlanIndex(state.blocks), [state.blocks])
  const current = now.getHours() * 60 + now.getMinutes()
  const showNow = localDay(now) === selected && current >= model.start && current <= model.end
  const exception = dayExceptionLabel(state, selected)
  const lastSources = useRef<DesktopDayEntry | undefined>(undefined)
  const selectedSources = strip.items.find(item => item.entry.key === sourceKey)?.entry
  useLayoutEffect(() => { if (selectedSources) lastSources.current = selectedSources }, [selectedSources])
  const shownSources = selectedSources ?? lastSources.current
  useLayoutEffect(() => setSourceKey(null), [selected])
  useLayoutEffect(() => {
    const element = measure.current
    if (!element) return
    const read = () => {
      const next = Math.floor(element.getBoundingClientRect().width)
      if (next > 0) setWidth(previous => previous === next ? previous : next)
    }
    read()
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const activate = (entry: DesktopDayEntry) => {
    if (entry.kind === 'free' && (entry.availableSources?.length ?? 0) > 1) setSourceKey(previous => previous === entry.key ? null : entry.key)
    else if (entry.routine) onRoutine(entry.routine, selected)
    else if (entry.task) onTask(entry.task.id, entry.block?.id, selected)
  }
  const ticks: number[] = []
  for (const minute of strip.boundaries) {
    if (!ticks.length || (strip.position(minute) - strip.position(ticks.at(-1)!)) / 100 * width >= 48) ticks.push(minute)
  }
  const frame = <div className="pl-desktop-day-frame">
    {exception && <p className="pl-desktop-day-exception">{exception}</p>}
    <div className="pl-desktop-day-ruler" aria-hidden="true">{ticks.map(minute => <span key={minute} data-edge={minute === model.start ? 'start' : minute === model.end ? 'end' : undefined} style={{ left: `${strip.position(minute)}%` }}>{timeOf(minute)}</span>)}</div>
    <div className="pl-desktop-day-strip" data-ready={width > 0} style={{ '--pl-day-height': `${Math.max(168, strip.maxLanes * 112)}px` } as CSSProperties}>
      <div className="pl-desktop-day-grid" aria-hidden="true">{strip.boundaries.slice(0, -1).map(minute => <i key={minute} style={{ left: `${strip.position(minute)}%` }} />)}</div>
      {strip.items.map(({ entry, left, width: span, lane, lanes }) => {
        const pixelWidth = width * span / 100
        const slim = pixelWidth < 38
        const deadline = entry.task?.due && agendaDate(entry.task.due)
        const label = `${kindLabel[entry.kind]}${entry.title === kindLabel[entry.kind] ? '' : `，${entry.title}`}，${timeOf(entry.start)}–${timeOf(entry.end)}${entry.routine?.location ? `，${entry.routine.location}` : ''}${entry.conflict ? '，时间有冲突' : ''}${entry.done ? '，已完成' : ''}`
        const actionable = Boolean(entry.routine || entry.task || entry.availableSources?.length)
        const content = <>{entry.kind !== 'free' && <span className="pl-desktop-day-kind">{kindLabel[entry.kind]}</span>}
          <span className="pl-desktop-day-time"><time>{timeOf(entry.start)}</time><span aria-hidden="true">–</span><time>{timeOf(entry.end)}</time></span>
          <strong>{slim && entry.kind === 'free' ? `${entry.end - entry.start}分` : entry.title}</strong>
          {entry.routine?.location && <span className="pl-desktop-day-meta">{entry.routine.location}</span>}
          {entry.kind === 'free' && !slim && <span className="pl-desktop-day-meta">{minutesLabel(entry.end - entry.start)}</span>}
          {entry.block?.locked && <span className="pl-desktop-day-meta">已锁定</span>}
          {entry.done && <span className="pl-desktop-day-meta">已完成</span>}
          {deadline && localDay(deadline) === selected && <span className="pl-desktop-day-meta">{entry.task?.due?.length === 10 ? '当天截止' : `${clock.format(deadline)} 截止`}</span>}
          {entry.conflict && <span className="pl-desktop-day-warning">有冲突</span>}</>
        const props = { className: 'pl-desktop-day-cell', 'data-kind': entry.kind, 'data-slim': slim, 'data-narrow': pixelWidth < 72,
          'data-micro': pixelWidth < 28, 'data-stacked': lanes > 1, 'data-done': entry.done, 'data-conflict': entry.conflict, 'aria-label': label, title: label,
          style: { left: `${left}%`, width: `${span}%`, top: `${lane / lanes * 100}%`, height: `${100 / lanes}%` } }
        return actionable ? <button key={entry.key} {...props} type="button" onClick={() => activate(entry)}>{content}</button>
          : <div key={entry.key} {...props}>{content}</div>
      })}
      {!strip.items.length && <div className="pl-desktop-day-empty"><span>这一天还没有安排</span>{onCreate && <button className="pl-secondary" type="button" onClick={onCreate}>＋ 记录事项</button>}</div>}
      {showNow && <span className="pl-desktop-day-now" aria-label={`现在 ${timeOf(current)}`} style={{ left: `${strip.position(current)}%` }} />}
    </div>
    <div className="pl-reveal" data-open={Boolean(selectedSources)} aria-hidden={!selectedSources} inert={!selectedSources}><div>{shownSources && <div className="pl-desktop-day-sources" role="group" aria-label="选择来源可用时间"><span>{timeOf(shownSources.start)}–{timeOf(shownSources.end)} · 编辑可用时间</span>
      {shownSources.availableSources?.map(routine => <button className="pl-secondary" type="button" key={routine.id} onClick={() => { setSourceKey(null); onRoutine(routine, selected) }}>{routine.title} · {routine.start}–{routine.end}</button>)}
      <button className="pl-text-button" type="button" onClick={() => setSourceKey(null)}>收起</button>
    </div>}</div></div>
    {model.reminders.length > 0 && <details className="pl-desktop-day-reminders">
      <summary>待办与截止 <span>{model.reminders.length}</span></summary>
      <div className="pl-desktop-day-reminder-list">{model.reminders.map(task => <button type="button" key={task.id} onClick={() => onTask(task.id, undefined, selected)}><strong>{task.title}</strong><span>{dayTaskLabel(task, selected, plans)}</span></button>)}</div>
    </details>}
    {!state.timetableConfirmed && <p className="pl-desktop-day-note">空档仅按已知的可用时间计算。</p>}
  </div>
  const motion = usePeriodMotion(selected, 'day-timeline', frame, direction)
  const currentFrame = <div key="current" className="pl-period-frame" data-period-current="true">{frame}</div>
  const previousFrame = motion.previous && <div key="previous" className="pl-period-frame" data-period-current="false" inert aria-hidden="true">{motion.previous}</div>
  return <section className="pl-desktop-day" aria-label={`${dateLabel.format(agendaDate(selected))}当天时间线`}>
    <div ref={measure} className="pl-desktop-day-measure" />
    <div className="pl-period-window" data-moving={motion.moving} data-direction={motion.direction}>
      <div key={motion.revision} className="pl-period-track" onAnimationEnd={motion.finish}>{motion.direction === 'previous' ? <>{currentFrame}{previousFrame}</> : <>{previousFrame}{currentFrame}</>}</div>
    </div>
  </section>
}
