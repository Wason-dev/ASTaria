import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReceiptTask } from './types'
import { taskStore } from '../stores/taskStore'
import type { TaskPatch } from '../stores/taskStore'
import type { PlannerState } from '../planner/types'
import { localApi } from './api'
import { DEADLINE_TIME_SHORTCUTS, deadlineOnDay, deadlineParts, deadlineShortcuts, plansAfterDeadline } from './deadlineShortcuts'
import { ESTIMATE_MAX, ESTIMATE_MIN, ESTIMATE_SHORTCUTS, parseReceiptEstimate, receiptScheduledMinutes } from './receiptTaskSettings'
import { useHomeDeadlinePicker } from '../home/HomeDeadlinePicker'
import { localDay } from '../home/agenda'
import './receipt-deadline.css'

type Props = { task: ReceiptTask; disabled: boolean; multiple?: boolean; onSaved: () => Promise<void> }

export function ReceiptDeadline({ task, disabled, multiple = false, onSaved }: Props) {
  const id = useId()
  const homePicker = useHomeDeadlinePicker()
  const homeDraft = homePicker?.presentedDraft?.owner === id ? homePicker.presentedDraft : null
  const editingHomeDraft = homePicker?.draft?.owner === id ? homePicker.draft : null
  const closeHomePicker = homePicker?.close
  const updateHomePicker = homePicker?.update
  const [saved, setSaved] = useState<ReceiptTask | null>(null)
  const current = saved?.id === task.id && saved.updatedAt > task.updatedAt ? saved : task
  // DDL and estimate edits share one version, including before React renders
  // the result or the conversation refresh catches up.
  const latest = useRef(current)
  if (latest.current.id !== current.id || latest.current.updatedAt <= current.updatedAt) latest.current = current
  const parts = deadlineParts(current.due)
  const [expanded, setExpanded] = useState<'deadline' | 'estimate' | null>(null)
  const [date, setDate] = useState(parts.date)
  const [time, setTime] = useState(parts.time)
  const [estimate, setEstimate] = useState(String(current.estimateMin ?? ''))
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState('')
  const lock = useRef(false)
  const mounted = useRef(false)
  const toggle = useRef<HTMLButtonElement>(null)
  const estimateToggle = useRef<HTMLButtonElement>(null)
  const picker = useRef<HTMLDivElement>(null)
  const estimatePicker = useRef<HTMLDivElement>(null)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  useEffect(() => () => closeHomePicker?.(id, false), [closeHomePicker, id])
  useEffect(() => { updateHomePicker?.(id, { busy: disabled || pending }) }, [disabled, pending, id, updateHomePicker])
  useEffect(() => {
    if (expanded !== 'deadline') { setDate(parts.date); setTime(parts.time) }
    if (expanded !== 'estimate') setEstimate(String(current.estimateMin ?? ''))
  }, [parts.date, parts.time, current.estimateMin, expanded])
  useEffect(() => {
    if (!expanded) return
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const target = expanded === 'deadline' ? picker : estimatePicker
    const timer = setTimeout(() => target.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'instant' : 'smooth' }), reduced ? 0 : 230)
    return () => clearTimeout(timer)
  }, [expanded])

  const save = async (patch: TaskPatch, kind: 'deadline' | 'estimate') => {
    if (disabled || lock.current) return
    const pickerToken = editingHomeDraft?.token
    lock.current = true; setPending(true); setError(''); setFeedback('')
    updateHomePicker?.(id, { busy: true })
    let updated = false
    try {
      const previous = latest.current
      const result = await taskStore.updateTask(previous.id, patch, previous.updatedAt)
      latest.current = result
      updated = true
      if (mounted.current) { setSaved(result); setExpanded(null) }
      // This read only informs the user. A temporary planner read failure must
      // not roll back, repeat, or disguise an already saved task edit.
      const planner = await localApi<PlannerState>('/planner').catch(() => null)
      let message = kind === 'deadline' ? result.due ? '截止时间已保存' : '已清除截止时间' : '预估时间已保存'
      if (planner && kind === 'deadline') {
        const conflicts = plansAfterDeadline(result.due ?? null, result.id, planner.blocks)
        if (conflicts) message += `；已有 ${conflicts} 段安排晚于 DDL，请到日历调整时段`
      } else if (planner && result.estimateMin !== undefined) {
        const planned = receiptScheduledMinutes(result.id, planner.blocks)
        if (planned > 0 && planned !== result.estimateMin) message += `；已排 ${planned} 分钟，日程保持不变`
      }
      if (mounted.current) {
        setFeedback(message)
      }
    } catch (reason) {
      if (mounted.current) setError(reason instanceof Error ? reason.message : '修改未保存，请重试')
      // Refresh the edit token directly so another quick edit can recover even
      // if the conversation has not refreshed or a previous response was lost.
      try {
        const fresh = await taskStore.getTask(latest.current.id)
        if (fresh) { latest.current = fresh; if (mounted.current) setSaved(fresh) }
      } catch { /* Keep the error and let the next attempt retry. */ }
    } finally {
      try { await onSaved() } catch {
        if (mounted.current && updated) setFeedback('修改已保存，对话暂未刷新')
      }
      lock.current = false
      if (mounted.current) {
        setPending(false)
        if (pickerToken !== undefined && homePicker?.isCurrent(id, pickerToken)) {
          updateHomePicker?.(id, { busy: disabled })
          if (updated) closeHomePicker?.(id)
        }
        if (updated) {
          if (!homePicker) requestAnimationFrame(() => (kind === 'deadline' ? toggle : estimateToggle).current?.focus({ preventScroll: true }))
        }
      }
    }
  }
  const saveDeadline = (day: string, clock = deadlineParts(latest.current.due).time, token?: number) => {
    if (token !== undefined && !homePicker?.isCurrent(id, token)) return
    try { void save({ due: deadlineOnDay(day, clock) }, 'deadline') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请选择有效的截止日期') }
  }
  const saveEstimate = (value: string) => {
    try { void save({ estimateMin: parseReceiptEstimate(value) }, 'estimate') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请输入有效的预估时间') }
  }
  const busy = disabled || pending || Boolean(homePicker?.draft?.busy)
  const formBusy = busy || Boolean(homeDraft && !editingHomeDraft)
  const draftDate = homeDraft?.date ?? date
  const draftTime = homeDraft?.time ?? time
  const changeTime = (value: string) => {
    if (homeDraft) {
      if (homePicker!.isCurrent(id, homeDraft.token)) homePicker!.update(id, { time: value })
    } else setTime(value)
  }
  const deadlineForm = <form className="xixi-deadline-form" aria-label={`${current.title}的截止时间`} onKeyDown={event => {
    // Portal events bubble through the receipt, not the visible calendar pane.
    if (event.key === 'Escape' && homeDraft) { event.preventDefault(); event.stopPropagation(); if (!formBusy && homePicker!.isCurrent(id, homeDraft.token)) homePicker!.close(id) }
  }} onSubmit={event => { event.preventDefault(); if (!formBusy) saveDeadline(draftDate, draftTime, homeDraft?.token) }}>
    <div className="xixi-deadline-fields">{homeDraft
      ? <div className="xixi-deadline-selected"><span>截止日期</span><strong>{draftDate.replaceAll('-', ' / ')}</strong></div>
      : <label htmlFor={`${id}-date`}>截止日期<input id={`${id}-date`} type="date" required value={date} disabled={formBusy} onChange={event => setDate(event.target.value)} /></label>}
      <label htmlFor={`${id}-time`}>时刻 · 可选<input id={`${id}-time`} type={homeDraft ? 'text' : 'time'} placeholder="HH:MM" maxLength={5} pattern={homeDraft ? '([01][0-9]|2[0-3]):[0-5][0-9]' : undefined} title="24 小时时刻，例如 20:00" value={draftTime} disabled={formBusy} onChange={event => changeTime(event.target.value)} /></label></div>
    <div className="xixi-deadline-times" role="group" aria-label="快捷选择截止时刻">{[...DEADLINE_TIME_SHORTCUTS, ''].map(value => <button type="button" key={value || 'all-day'} disabled={formBusy} aria-pressed={draftTime === value} onClick={() => changeTime(value)}>{value || '全天'}</button>)}</div>
    <div className="xixi-deadline-actions">{current.due && <button className="xixi-text-button" type="button" disabled={formBusy} onClick={() => saveDeadline('', '', homeDraft?.token)}>清除 DDL</button>}{homeDraft && <button className="xixi-text-button" type="button" disabled={formBusy} onClick={() => { if (homePicker!.isCurrent(id, homeDraft.token)) homePicker!.close(id) }}>取消</button>}<button type="submit" disabled={formBusy || !draftDate}>{pending ? '正在保存…' : '保存截止时间'}</button></div>
    {homeDraft && error && <p className="xixi-deadline-error" role="alert">{error}</p>}
  </form>
  return <section className="xixi-receipt-deadline xixi-receipt-task-settings" aria-label={`${current.title}的快捷设置`} aria-busy={pending}>
    {multiple && <p className="xixi-deadline-task">{current.title}</p>}
    <div className="xixi-receipt-setting-group">
      <div className="xixi-deadline-heading"><span>DDL</span><span>{parts.date ? `${parts.date.replaceAll('-', '/')} ${parts.time || '当天截止'}` : '尚未设置'}</span></div>
      <div className="xixi-deadline-shortcuts" role="group" aria-label="快捷设置截止日期">
        {deadlineShortcuts(new Date()).map(option => <button type="button" key={option.date} disabled={busy} aria-pressed={parts.date === option.date} onClick={() => saveDeadline(option.date)}>{option.label}</button>)}
        <button type="button" ref={toggle} disabled={busy} aria-expanded={homePicker ? Boolean(editingHomeDraft) : expanded === 'deadline'} aria-controls={homePicker ? 'home-deadline-editor' : `${id}-picker`} onClick={() => {
          setError('')
          if (homePicker) {
            setExpanded(null)
            if (editingHomeDraft) homePicker.close(id)
            else homePicker.open({ owner: id, title: current.title, date: parts.date || localDay(new Date()), time: parts.time }, toggle.current)
          } else { setDate(parts.date); setTime(parts.time); setExpanded(value => value === 'deadline' ? null : 'deadline') }
        }}>日期 / 时刻</button>
      </div>
      {homePicker ? <>
        {editingHomeDraft && <p className="xixi-deadline-calendar-hint" role="status">正在日程月历中选择截止时间</p>}
        {homeDraft && homePicker.host && createPortal(deadlineForm, homePicker.host)}
      </> : <div className="xixi-deadline-reveal" ref={picker} id={`${id}-picker`} data-open={expanded === 'deadline'} aria-hidden={expanded !== 'deadline'} inert={expanded !== 'deadline'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(null); toggle.current?.focus() } }}><div>{deadlineForm}</div></div>}
    </div>
    <div className="xixi-receipt-setting-group">
      <div className="xixi-deadline-heading"><span>预估时间</span><span>{current.estimateMin ? `${current.estimateMin} 分钟` : '尚未设置'}</span></div>
      <div className="xixi-estimate-shortcuts" role="group" aria-label="快捷设置预估时间">
        {ESTIMATE_SHORTCUTS.map(minutes => <button type="button" key={minutes} disabled={busy} aria-pressed={current.estimateMin === minutes} onClick={() => saveEstimate(String(minutes))}>{minutes}分</button>)}
        <button type="button" ref={estimateToggle} disabled={busy} aria-expanded={expanded === 'estimate'} aria-pressed={current.estimateMin !== undefined && !ESTIMATE_SHORTCUTS.some(value => value === current.estimateMin)} aria-controls={`${id}-estimate-picker`} onClick={() => { closeHomePicker?.(id); setEstimate(String(current.estimateMin ?? '')); setExpanded(value => value === 'estimate' ? null : 'estimate') }}>自定义</button>
      </div>
      <div className="xixi-deadline-reveal" ref={estimatePicker} id={`${id}-estimate-picker`} data-open={expanded === 'estimate'} aria-hidden={expanded !== 'estimate'} inert={expanded !== 'estimate'} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setExpanded(null); estimateToggle.current?.focus() } }}><div><form className="xixi-estimate-form" onSubmit={event => { event.preventDefault(); saveEstimate(estimate) }}>
        <label htmlFor={`${id}-estimate`}>分钟<input id={`${id}-estimate`} type="number" min={ESTIMATE_MIN} max={ESTIMATE_MAX} step={1} required inputMode="numeric" value={estimate} disabled={busy} onChange={event => setEstimate(event.target.value)} /></label><button type="submit" disabled={busy || !estimate}>保存预估时间</button>
      </form></div></div>
    </div>
    {(pending || feedback) && <p className="xixi-deadline-status" role="status">{pending ? '正在保存…' : feedback}</p>}
    {error && <p className="xixi-deadline-error" role="alert">{error}</p>}
  </section>
}
