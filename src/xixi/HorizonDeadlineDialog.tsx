import { useEffect, useRef, useState } from 'react'
import type { Task } from '../domain/task'
import { taskStore } from '../stores/taskStore'
import { FloatingGlassDialog } from '../ui/FloatingGlassDialog'
import { DeadlineFields } from './DeadlineFields'
import { deadlineOnDay, deadlineParts, deadlineShortcuts } from './deadlineShortcuts'
import './horizon-deadline.css'

export function HorizonDeadlineDialog({ anchor, taskId, title, targetDate, onClose, onSaved }: {
  anchor: HTMLElement; taskId: string; title: string; targetDate: string; onClose: () => void; onSaved: () => Promise<void>
}) {
  const [task, setTask] = useState<Task | null>(null), [date, setDate] = useState(''), [time, setTime] = useState('')
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [saved, setSaved] = useState(false), [finished, setFinished] = useState(false)
  const alive = useRef(false), lock = useRef(false)
  const load = async () => {
    setLoading(true); setError('')
    try {
      const fresh = await taskStore.getTask(taskId)
      if (!fresh || fresh.deletedAt) throw new Error('这项事项已移除，请重新读取弦轨')
      if (alive.current) { const parts = deadlineParts(fresh.due); setTask(fresh); setDate(parts.date); setTime(parts.time) }
    } catch (reason) { if (alive.current) setError(reason instanceof Error ? reason.message : '暂时无法读取截止时间') }
    finally { if (alive.current) setLoading(false) }
  }
  useEffect(() => { alive.current = true; void load(); return () => { alive.current = false } }, [taskId])
  const save = async (clear = false) => {
    if (lock.current || !task) return
    let due: string | null
    try { due = clear ? null : deadlineOnDay(date, time) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '请选择有效的截止时间'); return }
    lock.current = true; setBusy(true); setError('')
    let written = saved
    try {
      if (!written) {
        await taskStore.updateTask(task.id, { due }, task.updatedAt)
        written = true
        if (alive.current) setSaved(true)
      }
      await onSaved()
      if (alive.current) setFinished(true)
    } catch (reason) {
      if (alive.current) setError(written ? 'DDL 已保存，日程暂未刷新；重新读取后可继续调整。' : reason instanceof Error ? reason.message : '截止时间未保存，请重试')
      if (!written) {
        // Preserve the entered values. A stale edit must be explicitly reloaded
        // and checked, never silently retried against a newer write token.
        if (alive.current) setTask(null)
      }
    } finally { lock.current = false; if (alive.current) setBusy(false) }
  }
  const disabled = loading || busy || saved || !task
  const shortcuts: Array<{ label: string; date: string }> = deadlineShortcuts(new Date())
  if (targetDate && !shortcuts.some(option => option.date === targetDate)) shortcuts.push({ label: targetDate.replaceAll('-', '/'), date: targetDate })
  return <FloatingGlassDialog anchor={anchor} title="更改 DDL" label="截止时间" className="horizon-deadline-dialog" width={336} placement="above" align="end" busy={busy} closeRequested={finished} onClose={onClose}>
    <p className="horizon-deadline-title">{title}</p>
    {loading ? <p role="status">正在读取截止时间…</p> : <form className="xixi-deadline-form" aria-label="更改事项截止时间" onSubmit={event => { event.preventDefault(); void save() }}>
      <div className="xixi-deadline-shortcuts" role="group" aria-label="快捷选择截止日期">{shortcuts.map(option => <button type="button" key={option.date} disabled={disabled} aria-pressed={date === option.date} onClick={() => setDate(option.date)}>{option.label}</button>)}</div>
      <DeadlineFields date={date} time={time} busy={disabled} onDate={setDate} onTime={setTime} />
      <p className="horizon-deadline-note">DDL 单独保存；分组顺序保留，具体时段仍需点击「完成」。</p>
      {error && <p className="horizon-deadline-error" role="alert">{error}</p>}
      <div className="xixi-deadline-actions">{!saved && task?.due && <button type="button" className="xixi-text-button" disabled={disabled} onClick={() => void save(true)}>清除 DDL</button>}
        {!task && !saved ? <button type="button" onClick={() => void load()}>重新读取</button> : <button type={saved ? 'button' : 'submit'} disabled={busy || finished || (!saved && (!date || !task))} onClick={saved ? () => void save() : undefined}>{busy ? saved ? '正在更新日程…' : '正在保存…' : finished ? '已保存' : saved ? '重新读取日程' : '保存截止时间'}</button>}
      </div>
    </form>}
  </FloatingGlassDialog>
}
