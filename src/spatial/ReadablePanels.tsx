import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { Task, TaskStatus } from '../domain/task'
import { readableDate, STATUS_LABELS } from './scene'

export type PanelState = { kind: 'create' } | { kind: 'task'; id: string } | { kind: 'index' } | { kind: 'history' }
type Props = {
  panel: PanelState
  tasks: Task[]
  saving: boolean
  onClose: () => void
  onSelect: (id: string) => void
  onCreate: (input: { title: string; notes: string }) => Promise<void>
  onStatus: (id: string, status: TaskStatus) => Promise<void>
}

export function ReadablePanels({ panel, tasks, saving, onClose, onSelect, onCreate, onStatus }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const task = panel.kind === 'task' ? tasks.find(item => item.id === panel.id) : undefined
  const name = panel.kind === 'create' ? '投放一粒星辰' : panel.kind === 'history' ? '回望' : panel.kind === 'index' ? '星图索引' : '任务详情'

  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])
  useEffect(() => {
    setError('')
    if (panel.kind === 'create') titleInput.current?.focus()
    else heading.current?.focus()
  }, [panel])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    try { await onCreate({ title, notes }) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试。') }
  }
  const changeStatus = async (status: TaskStatus) => {
    if (!task) return
    setError('')
    try { await onStatus(task.id, status) }
    catch (reason) { setError(reason instanceof Error ? reason.message : '状态保存失败，请重试。') }
  }
  const rows = tasks.filter(item => (panel.kind !== 'history' || item.status === 'done') && item.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))

  return <dialog ref={dialog} className="spatial-panel" data-spatial-ui aria-labelledby="spatial-panel-title"
    onCancel={event => { event.preventDefault(); if (!saving) onClose() }}
    onKeyDown={event => event.stopPropagation()}>
    <header><div><small>{panel.kind === 'history' ? 'MEMORY / 记录仍在' : 'ASTARIA / 星域'}</small><h2 id="spatial-panel-title" ref={heading} tabIndex={-1}>{name}</h2></div>
      <button aria-label="返回星域" onClick={onClose} disabled={saving}>×</button></header>
    {panel.kind === 'create' ? <form onSubmit={submit}>
      <p className="spatial-panel-note">把一件悬着的事，放进轨道。</p>
      <label htmlFor="spatial-title">这颗星辰承载什么？</label>
      <input ref={titleInput} id="spatial-title" autoFocus autoComplete="off" required maxLength={160} value={title} onChange={event => setTitle(event.target.value)} placeholder="例如：完成物理实验报告" disabled={saving} />
      <label htmlFor="spatial-notes">留一句备注 <span>可选</span></label>
      <textarea id="spatial-notes" rows={3} maxLength={2000} value={notes} onChange={event => setNotes(event.target.value)} disabled={saving} />
      <p className="spatial-panel-note">进入外轨 · 待开始<br/>任务保存在当前浏览器中。</p>
      <button className="spatial-submit" disabled={saving || !title.trim()} type="submit">{saving ? '正在保存…' : '投放到轨道'} <span aria-hidden="true">↗</span></button>
    </form> : panel.kind === 'task' ? task ? <div className="spatial-detail">
      <p className="spatial-task-title">{task.title}</p>
      <p className="spatial-task-state" role="status">{STATUS_LABELS[task.status]} · {task.status === 'todo' ? '外轨' : task.status === 'doing' ? '内轨' : task.status === 'done' ? '已归入回望' : '暂离轨道'}</p>
      {task.notes && <p className="spatial-task-notes">{task.notes}</p>}
      <dl><div><dt>创建</dt><dd>{readableDate(task.createdAt)}</dd></div>
        <div><dt>截止</dt><dd>{readableDate(task.due)}</dd></div>
        {task.estimateMin !== undefined && <div><dt>预计投入</dt><dd>{task.estimateMin} 分钟</dd></div>}
        {task.status === 'done' && <div><dt>完成</dt><dd>{task.doneAt ? readableDate(task.doneAt) : '未记录时间'}</dd></div>}
      </dl>
      <p className="spatial-panel-note">改变状态，星辰会进入相应轨道。完成的记录可以随时重新打开。</p>
      <div className="spatial-status-options" role="group" aria-label="修改任务状态">
        {(['todo', 'doing', 'done', 'dropped'] as const).map(status => <button key={status} aria-pressed={task.status === status}
          disabled={saving || task.status === status} onClick={() => void changeStatus(status)}>{STATUS_LABELS[status]}</button>)}
      </div>
      <button className="spatial-submit" onClick={onClose} disabled={saving}>返回星域 <span aria-hidden="true">↗</span></button>
    </div> : <p>这条任务已不在星图中。<button onClick={onClose}>返回星域</button></p> : <div className="spatial-task-index">
      <p className="spatial-panel-note">{panel.kind === 'history' ? '已完成的星辰保留在这里，可以查看、重新开始。' : '每颗星辰都有可读的名字和状态，包括当前画面以外的任务。'}</p>
      <label htmlFor="spatial-search">查找任务</label>
      <input id="spatial-search" type="search" autoComplete="off" value={query} onChange={event => setQuery(event.target.value)} placeholder="按名称查找" />
      <p className="spatial-panel-note">{rows.length} 条记录</p>
      {rows.length ? <ul>{rows.map(item => <li key={item.id}><button onClick={() => onSelect(item.id)}>
        <strong>{item.title}</strong><span>{STATUS_LABELS[item.status]} · {item.status === 'done' ? `完成 ${item.doneAt ? readableDate(item.doneAt) : '时间未记录'}` : readableDate(item.due)}</span>
      </button></li>)}</ul> : <p className="spatial-empty">{query ? '没有匹配的任务。' : panel.kind === 'history' ? '这里会留下已完成星辰的记录。' : '星图还很安静。投放第一粒星辰即可开始。'}</p>}
    </div>}
    {error && <p className="spatial-form-error" role="alert">{error}</p>}
  </dialog>
}
