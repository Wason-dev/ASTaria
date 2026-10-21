import { useRef, useState } from 'react'
import type { Task } from '../domain/task'
import { collectionProgress, collectionRemaining, taskEntries } from '../domain/taskCollections'
import type { TaskCollection } from '../domain/taskCollections'
import { deadlineLabel } from '../home/agenda'
import { localApi } from '../xixi/api'
import type { Operation } from '../xixi/types'
import { notifyLocalDataChange } from '../stores/migration'
import { taskStore } from '../stores/taskStore'
import { FloatingGlassDialog } from './FloatingGlassDialog'
import './task-collections.css'

export { CollectionIcon } from './CollectionIcon'

export function useTaskCollections(tasks: Task[], now: Date, onTask: (id: string) => void, label?: (task: Task) => string, order?: (task: Task) => string) {
  const [opened, setOpened] = useState<{ anchor: HTMLElement; group?: TaskCollection; edit: boolean } | null>(null)
  const [notice, setNotice] = useState<{ text: string; operation?: Operation } | null>(null)
  const [undoing, setUndoing] = useState(false)
  const nextTask = useRef<string | null>(null)
  const undo = async () => {
    if (!notice?.operation || undoing) return
    setUndoing(true)
    try {
      await localApi(`/operations/${encodeURIComponent(notice.operation.id)}/undo`, {})
      notifyLocalDataChange(); setNotice({ text: '已撤销归类' })
    } catch (error) { setNotice(current => current ? { ...current, text: error instanceof Error ? error.message : '尚未撤销，请重试' } : null) }
    finally { setUndoing(false) }
  }
  return {
    open: (group: TaskCollection, anchor: HTMLElement) => { nextTask.current = null; setOpened({ anchor, group, edit: false }) },
    edit: (anchor: HTMLElement) => { nextTask.current = null; setOpened({ anchor, edit: true }) },
    notice: notice && <p className="task-collection-notice" role="status">{notice.text}{notice.operation && <button type="button" disabled={undoing} onClick={() => void undo()}>{undoing ? '撤销中…' : '撤销归类'}</button>}</p>,
    dialog: opened && <TaskCollectionDialog anchor={opened.anchor} initialGroup={opened.group} initialEdit={opened.edit} tasks={tasks} now={now} label={label} order={order}
      onOpen={id => { nextTask.current = id }} onSaved={operation => setNotice({ text: operation.summary, operation })}
      onClose={() => { setOpened(null); const id = nextTask.current; nextTask.current = null; if (id) onTask(id) }} />,
  }
}

function TaskCollectionDialog({ anchor, initialGroup, initialEdit, tasks, now, label, order, onClose, onOpen, onSaved }: {
  anchor: HTMLElement; initialGroup?: TaskCollection; initialEdit: boolean; tasks: Task[]; now: Date; label?: (task: Task) => string; order?: (task: Task) => string
  onClose: () => void; onOpen: (id: string) => void; onSaved: (operation: Operation) => void
}) {
  const [editing, setEditing] = useState(initialEdit), [name, setName] = useState(initialGroup?.name ?? '')
  const [snapshot, setSnapshot] = useState(tasks)
  const [chosen, setChosen] = useState(() => new Set(initialGroup?.tasks.map(task => task.id) ?? []))
  const [query, setQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [finished, setFinished] = useState(false)
  const [requestId, setRequestId] = useState(() => crypto.randomUUID())
  const lock = useRef(false)
  const group = taskEntries(tasks).find((entry): entry is TaskCollection => entry.kind === 'collection' && entry.id === initialGroup?.id)
  const members = [...(group?.tasks ?? [])].sort((a, b) => Number(a.status === 'done') - Number(b.status === 'done') || (order?.(a) ?? a.startAt ?? '9999').localeCompare(order?.(b) ?? b.startAt ?? '9999') || a.title.localeCompare(b.title, 'zh-CN', { numeric: true }))
  const candidates = snapshot.filter(task => !task.deletedAt && task.status !== 'dropped' && (task.status !== 'done' || chosen.has(task.id)))
  candidates.sort((a, b) => Number(chosen.has(b.id)) - Number(chosen.has(a.id)) || a.title.localeCompare(b.title, 'zh-CN', { numeric: true }))
  const filtered = candidates.filter(task => !query.trim() || `${task.title} ${task.collection ?? ''}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  const beginEdit = () => { setSnapshot(tasks); setChosen(new Set(members.map(task => task.id))); setEditing(true); setError('') }
  const toggle = (task: Task) => {
    setChosen(current => { const next = new Set(current); if (next.has(task.id)) next.delete(task.id); else next.add(task.id); return next })
    setRequestId(crypto.randomUUID()); setError('')
  }
  const save = async (remove = false) => {
    if (lock.current) return
    const removed = !remove && initialGroup ? snapshot.filter(task => initialGroup.tasks.some(member => member.id === task.id) && !chosen.has(task.id)) : []
    if ((!remove && !name.trim()) || !chosen.size && !removed.length || chosen.size + removed.length > 50) { setError('填写集合名称，并选择 1–50 项事项'); return }
    lock.current = true; setBusy(true); setError('')
    try {
      const refs = snapshot.filter(task => chosen.has(task.id)).map(task => ({ id: task.id, expectedUpdatedAt: task.updatedAt }))
      const result = await localApi<{ operation: Operation }>('/tasks/collection', { collection: remove ? null : name.trim(), tasks: refs, removeTasks: removed.map(task => ({ id: task.id, expectedUpdatedAt: task.updatedAt })), requestId: remove ? `${requestId}-remove` : requestId })
      notifyLocalDataChange(); onSaved(result.operation); setFinished(true)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '归类未保存，请重试') }
    finally { lock.current = false; setBusy(false) }
  }
  const reload = async () => {
    if (lock.current) return
    lock.current = true; setBusy(true)
    try { setSnapshot(await taskStore.listTasks()); setRequestId(crypto.randomUUID()); setError('已重新读取，请核对选择后保存') }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败，请重试') }
    finally { lock.current = false; setBusy(false) }
  }
  return <FloatingGlassDialog anchor={anchor} title={editing ? '归类事项' : initialGroup?.name ?? '事项集合'} className="task-collection-dialog" width={760} maxHeight={640} placement="center" busy={busy} closeRequested={finished} onClose={onClose}>
    {editing ? <form className="task-collection-editor" onSubmit={event => { event.preventDefault(); void save() }}>
      <label className="task-collection-field">集合名称<input value={name} maxLength={60} placeholder="例如 SAT 作业" disabled={busy} onChange={event => { setName(event.target.value); setRequestId(crypto.randomUUID()) }} /></label>
      <div className="task-collection-select-heading"><span>已选 {chosen.size} 项</span><button type="button" disabled={busy} onClick={() => { setChosen(new Set(filtered.slice(0, 50).map(task => task.id))); setRequestId(crypto.randomUUID()) }}>选择当前结果</button></div>
      <input className="task-collection-search" aria-label="查找要归类的事项" placeholder="查找事项" value={query} onChange={event => setQuery(event.target.value)} disabled={busy} />
      <ul className="task-collection-list" aria-label="选择事项">{filtered.map(task => <li key={task.id}><button type="button" role="checkbox" aria-checked={chosen.has(task.id)} disabled={busy} onClick={() => toggle(task)}>
        <span className="task-collection-check" aria-hidden="true">{chosen.has(task.id) && <svg viewBox="0 0 16 16"><path d="m3.5 8 3 3 6-6" /></svg>}</span><span className="task-collection-copy"><strong>{task.title}</strong><small>{task.due ? `截止 ${deadlineLabel(task, now)}` : '未设 DDL'}{task.collection && ` · ${task.collection}`}</small></span>
      </button></li>)}</ul>
      {!filtered.length && <p className="task-collection-muted">没有匹配的事项</p>}
      <p className="task-collection-muted">保留每项安排与完成状态；同名集合按 DDL 分开显示。</p>
      {error && <p className="task-collection-error" role="alert">{error} <button type="button" disabled={busy} onClick={() => void reload()}>重新读取</button></p>}
      <div className="task-collection-actions">{initialGroup && <button type="button" disabled={busy || !chosen.size} onClick={() => void save(true)}>移出集合</button>}<button type="submit" disabled={busy || !chosen.size && !initialGroup || !name.trim()}>{busy ? '正在保存…' : '保存归类'}</button></div>
    </form> : <>
      <p className="task-collection-summary">{group ? collectionProgress(group) : '集合暂无事项'}{group?.due && ` · 截止 ${deadlineLabel({ due: group.due } as Task, now)}`}</p>
      {group && <p className="task-collection-muted">{collectionRemaining(group)}</p>}
      <ul className="task-collection-list task-collection-detail-list" aria-label="集合中的事项">{members.map(task => <li key={task.id}><button type="button" data-done={task.status === 'done'} onClick={() => { onOpen(task.id); setFinished(true) }}>
        <span className="task-collection-copy"><strong>{task.title}</strong><small>{task.status === 'done' ? '已完成' : [task.estimateMin ? `${task.estimateMin} 分钟` : '用时待估', label?.(task)].filter(Boolean).join(' · ')}</small></span><span className="task-collection-enter" aria-hidden="true">↗</span>
      </button></li>)}</ul>
      <div className="task-collection-actions"><button type="button" onClick={beginEdit}>调整归类</button></div>
    </>}
  </FloatingGlassDialog>
}
