import { useEffect, useId, useRef, useState } from 'react'
import type { ReceiptTask } from './types'
import { taskStore } from '../stores/taskStore'
import type { PlannerState } from '../planner/types'
import { localApi } from './api'
import { deadlineOnDay, deadlineParts, deadlineShortcuts, plansAfterDeadline } from './deadlineShortcuts'
import './receipt-deadline.css'

type Props = { task: ReceiptTask; disabled: boolean; multiple?: boolean; onSaved: () => Promise<void> }

export function ReceiptDeadline({ task, disabled, multiple = false, onSaved }: Props) {
  const id = useId()
  const [saved, setSaved] = useState<ReceiptTask | null>(null)
  const current = saved?.id === task.id && saved.updatedAt > task.updatedAt ? saved : task
  const parts = deadlineParts(current.due)
  const [expanded, setExpanded] = useState(false)
  const [date, setDate] = useState(parts.date)
  const [time, setTime] = useState(parts.time)
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const lock = useRef(false)
  const mounted = useRef(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => {
    if (!expanded) { setDate(parts.date); setTime(parts.time) }
  }, [parts.date, parts.time, expanded])
  useEffect(() => {
    if (!expanded) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const timer = setTimeout(() => picker.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'instant' : 'smooth' }), reduced ? 0 : 230)
    return () => clearTimeout(timer)
  }, [expanded])

  const save = async (day: string, clock = parts.time) => {
    if (disabled || lock.current) return
    lock.current = true; setPending(true); setError(''); setFeedback('')
    try {
      const due = deadlineOnDay(day, clock)
      const planner = await localApi<PlannerState>('/planner')
      const result = await taskStore.updateTask(current.id, { due }, current.updatedAt)
      const conflicts = plansAfterDeadline(due, current.id, planner.blocks)
      if (mounted.current) {
        setSaved(result); setExpanded(false)
        setFeedback(conflicts ? `截止时间已保存；已有 ${conflicts} 段安排晚于 DDL，请到日历调整时段` : due ? '截止时间已保存' : '已清除截止时间')
        toggle.current?.focus({ preventScroll: true })
      }
      await onSaved()
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '截止时间未保存，请重试')
      // On a version conflict, reload the current task before another edit.
      await onSaved()
    } finally {
      lock.current = false
      if (mounted.current) setPending(false)
    }
  }
  const busy = disabled || pending
  return <section className="xixi-receipt-deadline" aria-label={`${current.title}的截止时间`} aria-busy={pending}>
    {multiple && <p className="xixi-deadline-task">{current.title}</p>}
    <div className="xixi-deadline-heading"><span>DDL</span><span>{parts.date ? `${parts.date.replaceAll('-', '/')} ${parts.time || '当天截止'}` : '尚未设置'}</span></div>
    <div className="xixi-deadline-shortcuts" role="group" aria-label="快捷设置截止日期">
      {deadlineShortcuts(new Date()).map(option => <button type="button" key={option.date} disabled={busy} aria-pressed={parts.date === option.date} onClick={() => void save(option.date)}>{option.label}</button>)}
      <button type="button" ref={toggle} disabled={busy} aria-expanded={expanded} aria-controls={`${id}-picker`} onClick={() => { setDate(parts.date); setTime(parts.time); setExpanded(value => !value) }}>日期 / 时刻</button>
    </div>
    <div className="xixi-deadline-reveal" ref={picker} id={`${id}-picker`} data-open={expanded} aria-hidden={!expanded} inert={!expanded} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(false); toggle.current?.focus() } }}><div><form onSubmit={event => { event.preventDefault(); void save(date, time) }}>
      <div className="xixi-deadline-fields"><label htmlFor={`${id}-date`}>截止日期<input id={`${id}-date`} type="date" required value={date} disabled={busy} onChange={event => setDate(event.target.value)} /></label><label htmlFor={`${id}-time`}>时刻 · 可选<input id={`${id}-time`} type="time" value={time} disabled={busy} onChange={event => setTime(event.target.value)} /></label></div>
      <div className="xixi-deadline-times" role="group" aria-label="快捷选择截止时刻">{['08:00', '12:00', '18:00', '20:00', ''].map(value => <button type="button" key={value || 'all-day'} disabled={busy} aria-pressed={time === value} onClick={() => setTime(value)}>{value || '全天'}</button>)}</div>
      <div className="xixi-deadline-actions">{current.due && <button className="xixi-text-button" type="button" disabled={busy} onClick={() => void save('', '')}>清除 DDL</button>}<button type="submit" disabled={busy || !date}>保存截止时间</button></div>
    </form></div></div>
    {(pending || feedback) && <p className="xixi-deadline-status" role="status">{pending ? '正在保存…' : feedback}</p>}
    {error && <p className="xixi-deadline-error" role="alert">{error}</p>}
  </section>
}
