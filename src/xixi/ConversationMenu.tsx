import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, RefObject } from 'react'
import type { ConversationSummary } from './types'
import type { XixiConversation } from './useXixiConversation'

export function ConversationMenu({ chat, disabled = false }: { chat: XixiConversation; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const editInput = useRef<HTMLInputElement>(null)
  const cancelDelete = useRef<HTMLButtonElement>(null)
  const id = useId()

  useEffect(() => {
    if (!open) { setEditingId(null); setConfirmingId(null); return }
    void chat.loadTopics()
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.current?.contains(event.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', outside)
    return () => document.removeEventListener('pointerdown', outside)
  }, [open, chat.loadTopics])
  useEffect(() => { if (editingId) { editInput.current?.focus(); editInput.current?.select() } }, [editingId])
  useEffect(() => { if (confirmingId) cancelDelete.current?.focus() }, [confirmingId])

  const focusRow = (topicId: string, control = '.xixi-topic-select') => {
    requestAnimationFrame(() => {
      const row = [...(panel.current?.querySelectorAll<HTMLElement>('[data-topic-id]') ?? [])].find(item => item.dataset.topicId === topicId)
      const target = row?.querySelector<HTMLButtonElement>(control) ?? panel.current?.querySelector<HTMLButtonElement>('.xixi-topic-select') ?? trigger.current
      target?.focus()
    })
  }
  const closeMenu = () => { setOpen(false); setEditingId(null); setConfirmingId(null); trigger.current?.focus() }
  const cancelAction = () => {
    const topicId = editingId || confirmingId
    setEditingId(null); setEditingTitle(''); setConfirmingId(null); chat.clearTopicActionError()
    if (topicId) focusRow(topicId)
  }
  const beginRename = (topic: ConversationSummary) => {
    chat.clearTopicActionError(); setConfirmingId(null); setEditingId(topic.id); setEditingTitle(topic.title || '一段新的对话')
  }
  const submitRename = async (event: FormEvent) => {
    event.preventDefault()
    if (!editingId || !editingTitle.trim()) return
    const topicId = editingId
    if (await chat.renameTopic(topicId, editingTitle)) { setEditingId(null); setEditingTitle(''); focusRow(topicId, '.xixi-topic-rename') }
  }
  const deleteTopic = async (topic: ConversationSummary) => {
    if (confirmingId !== topic.id) {
      chat.clearTopicActionError(); setEditingId(null); setConfirmingId(topic.id)
      return
    }
    if (await chat.deleteTopic(topic.id)) { setConfirmingId(null); focusRow(topic.id) }
  }

  return <div ref={panel} className="xixi-topic-menu" onKeyDown={event => {
    if (open && event.key === 'Escape') {
      event.preventDefault(); event.stopPropagation()
      if (editingId || confirmingId) cancelAction()
      else closeMenu()
    }
  }}>
    <button ref={trigger} type="button" className="xixi-text-button" disabled={disabled || chat.busy || chat.loading} aria-expanded={open} aria-controls={id} onClick={() => { chat.clearTopicActionError(); setOpen(value => !value) }}>对话记录</button>
    {open && <div id={id} className="xixi-topic-popover" role="dialog" aria-label="对话记录">
      <button className="xixi-topic-new" type="button" disabled={chat.busy} onClick={async () => { if (await chat.newTopic()) closeMenu() }}>另开话题 <span aria-hidden="true">＋</span></button>
      {chat.topicsLoading && <p role="status">正在读取</p>}
      {chat.topicsError && <p className="xixi-topic-error" role="alert">{chat.topicsError}<button className="xixi-text-button" type="button" onClick={() => void chat.loadTopics()}>重试</button></p>}
      {chat.topicActionError && <p className="xixi-topic-error" role="alert">{chat.topicActionError}</p>}
      {!chat.topicsLoading && !chat.topics.length && <p className="xixi-topic-empty">还没有其他对话</p>}
      <ul>{chat.topics.map(topic => <TopicRow key={topic.id} topic={topic} active={topic.id === chat.conversation?.conversationId} disabled={chat.busy} editing={editingId === topic.id} editingTitle={editingTitle} confirming={confirmingId === topic.id} editInput={editInput} cancelDelete={cancelDelete} onEditChange={setEditingTitle} onSelect={async () => { if (await chat.selectTopic(topic.id)) closeMenu() }} onRename={() => beginRename(topic)} onSave={submitRename} onCancel={cancelAction} onDelete={() => void deleteTopic(topic)} />)}</ul>
    </div>}
  </div>
}

function TopicRow({ topic, active, disabled, editing, editingTitle, confirming, editInput, cancelDelete, onEditChange, onSelect, onRename, onSave, onCancel, onDelete }: {
  topic: ConversationSummary; active: boolean; disabled: boolean; editing: boolean; editingTitle: string; confirming: boolean
  editInput: RefObject<HTMLInputElement | null>; cancelDelete: RefObject<HTMLButtonElement | null>
  onEditChange: (value: string) => void; onSelect: () => void; onRename: () => void; onSave: (event: FormEvent) => void; onCancel: () => void; onDelete: () => void
}) {
  return <li className="xixi-topic-row" data-topic-id={topic.id} data-active={active}>
    {editing ? <form className="xixi-topic-edit" onSubmit={onSave}>
      <label className="p0-sr-only" htmlFor={`topic-name-${topic.id}`}>对话名称</label>
      <input id={`topic-name-${topic.id}`} ref={editInput} value={editingTitle} disabled={disabled} maxLength={80} autoComplete="off" onChange={event => onEditChange(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault() }} />
      <button type="submit" className="xixi-topic-icon" title="保存名称" aria-label="保存名称" disabled={disabled || !editingTitle.trim()}><TopicIcon kind="save" /></button>
      <button type="button" className="xixi-topic-icon" title="取消重命名" aria-label="取消重命名" disabled={disabled} onClick={onCancel}><TopicIcon kind="cancel" /></button>
    </form> : confirming ? <div className="xixi-topic-confirm" role="group" aria-label={`删除${topic.title || '对话'}的确认`}>
      <p><strong>删除这段对话？</strong><span>{topic.title || '一段新的对话'}</span><small>聊天记录将移除，已创建的事项会保留</small></p>
      <div><button ref={cancelDelete} type="button" className="xixi-topic-confirm-cancel" disabled={disabled} onClick={onCancel}>保留</button><button type="button" className="xixi-topic-confirm-delete" disabled={disabled} onClick={onDelete}>确认删除</button></div>
    </div> : <>
      <button type="button" className="xixi-topic-select" aria-current={active ? 'true' : undefined} disabled={disabled} onClick={onSelect}><span title={topic.title}>{topic.title || '一段新的对话'}</span><time dateTime={topic.createdAt}>{dateLabel(topic.createdAt)}</time></button>
      <span className="xixi-topic-actions">
        <button type="button" className="xixi-topic-icon xixi-topic-rename" title="重命名" aria-label={`重命名${topic.title || '对话'}`} disabled={disabled} onClick={onRename}><TopicIcon kind="rename" /></button>
        <button type="button" className="xixi-topic-icon xixi-topic-delete" title="删除" aria-label={`删除${topic.title || '对话'}`} disabled={disabled} onClick={onDelete}><TopicIcon kind="delete" /></button>
      </span>
    </>}
  </li>
}

function TopicIcon({ kind }: { kind: 'rename' | 'delete' | 'save' | 'cancel' }) {
  return <svg viewBox="0 0 16 16" aria-hidden="true">{kind === 'rename' ? <><path d="m10.5 3 2.5 2.5M3 13l3.5-.8L13 5.7a1.8 1.8 0 0 0-2.5-2.5L4 9.7 3 13Z" /><path d="M9 13h4" /></> : kind === 'delete' ? <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8h5.8l.6-8M6.5 7v3.5M9.5 7v3.5" /> : kind === 'save' ? <path d="m3 8 3 3 7-7" /> : <path d="m4 4 8 8m0-8-8 8" />}</svg>
}

function dateLabel(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date)
}
