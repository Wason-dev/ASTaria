import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { XixiConversation, XixiContext } from './useXixiConversation'
import type { Operation } from './types'
import { MessageMarkdown } from './MessageMarkdown'
import './conversation.css'

type Props = {
  chat: XixiConversation
  active: boolean
  onSettings: () => void
  context: XixiContext
  onSent: (text: string) => void
  onRetracted: (text: string) => void
  children?: ReactNode
}

export function ConversationLog({ chat, active, onSettings, context, onSent, onRetracted, children }: Props) {
  const log = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const prependAnchor = useRef<{ height: number; top: number; conversationId: string } | null>(null)
  const [copyFeedback, setCopyFeedback] = useState<{ id: string; text: string } | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftRevision = useRef(0)
  const messages = chat.conversation?.messages.filter(item => item.role !== 'tool') ?? []
  const operations = chat.conversation?.operations ?? []
  const lastAssistant = new Map<string, string>()
  for (const entry of messages) if (entry.role === 'assistant' && entry.requestId) lastAssistant.set(entry.requestId, entry.id)
  const unmatched = operations.filter(operation => !lastAssistant.has(operation.requestId))
  const signature = `${chat.conversation?.conversationId}:${messages.at(-1)?.requestId ?? messages.at(-1)?.id}:${messages.at(-1)?.delivery}:${operations.map(item => `${item.id}:${item.undoneAt}`).join(',')}:${chat.sending}`
  const currentQuestion = messages.at(-1)?.role === 'assistant' && messages.at(-1)?.question ? messages.at(-1)?.id : null
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  const copyMessage = async (id: string, content: string) => {
    clearTimeout(copyTimer.current)
    try { await navigator.clipboard.writeText(content); setCopyFeedback({ id, text: '已复制' }) }
    catch { setCopyFeedback({ id, text: '暂时无法复制，可选中文字复制' }) }
    copyTimer.current = setTimeout(() => setCopyFeedback(null), 2200)
  }

  useLayoutEffect(() => {
    following.current = true
    prependAnchor.current = null
  }, [chat.conversation?.conversationId])

  useLayoutEffect(() => {
    const anchor = prependAnchor.current
    if (!anchor || !log.current || anchor.conversationId !== chat.conversation?.conversationId) return
    log.current.scrollTop = anchor.top + log.current.scrollHeight - anchor.height
    prependAnchor.current = null
  }, [messages.length, chat.conversation?.oldestSeq, chat.conversation?.conversationId])

  useEffect(() => {
    if (!active || !following.current || !log.current) return
    log.current.scrollTo({ top: log.current.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
  }, [signature, active])

  useEffect(() => {
    if (!active || !log.current) return
    const element = log.current
    const observer = new IntersectionObserver(entries => {
      const ids = entries.filter(entry => entry.isIntersecting && entry.intersectionRatio >= .75).map(entry => (entry.target as HTMLElement).dataset.operationId!).filter(Boolean)
      if (ids.length) {
        for (const entry of entries) if (ids.includes((entry.target as HTMLElement).dataset.operationId!)) observer.unobserve(entry.target)
        void chat.markRead(ids)
      }
    }, { root: element, threshold: .75 })
    element.querySelectorAll('[data-operation-id][data-unread=true]').forEach(item => observer.observe(item))
    return () => observer.disconnect()
  }, [active, operations, chat.markRead])

  return <div ref={log} className="xixi-conversation" role="log" aria-label="与析熙的对话" aria-live={active ? 'polite' : 'off'} aria-relevant="additions text" onScroll={event => {
    const element = event.currentTarget
    following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 44
  }}>
    {chat.loading && <p className="xixi-status">正在读我们的对话</p>}
    {chat.conversation?.hasOlder && <button type="button" className="xixi-text-button xixi-load-older" disabled={chat.olderLoading || chat.busy} onClick={async () => {
      const element = log.current
      if (!element || !chat.conversation) return
      following.current = false
      prependAnchor.current = { height: element.scrollHeight, top: element.scrollTop, conversationId: chat.conversation.conversationId }
      if (!await chat.loadOlder()) prependAnchor.current = null
    }}>{chat.olderLoading ? '正在读取' : '更早的对话'}</button>}
    {chat.olderError && <p className="xixi-status" role="alert">{chat.olderError}</p>}
    {chat.loadError && <p className="xixi-status">{chat.loadError}<button type="button" className="xixi-text-button" onClick={() => void chat.refresh()}>重试读取</button></p>}
    {!chat.loading && !chat.loadError && messages.length === 0 && <p className="xixi-empty">我在，慢慢说</p>}
    {messages.map(entry => <article className="xixi-message" data-role={entry.role} data-message-id={entry.id} data-delivery={entry.delivery} data-retracted={Boolean(entry.retractedAt)} key={entry.role === 'user' && entry.requestId ? `user:${entry.requestId}` : entry.id}>
      <span>{entry.role === 'user' ? '你' : '析熙'}</span>
      {entry.retractedAt ? <p>已撤回</p> : entry.role === 'assistant' ? <MessageMarkdown content={entry.content} /> : <p>{entry.content}</p>}
      {!entry.retractedAt && <div className="xixi-message-actions">
        <button className="xixi-message-copy" type="button" title="复制" aria-label={entry.role === 'user' ? '复制你的消息' : '复制析熙的消息'} onClick={() => void copyMessage(entry.id, entry.content)}><CopyIcon /><span>复制</span></button>
        {entry.role === 'user' && <button className="xixi-message-retract" type="button" title="撤回并将原文放回输入框，已执行的安排仍可单独撤销" disabled={!active || Boolean(chat.retracting) || (chat.busy && !chat.sending)} onClick={async () => {
          if (await chat.retractMessage(entry)) { draftRevision.current += 1; onRetracted(entry.content) }
        }}><ReturnIcon /><span>{chat.retracting === entry.id ? '撤回中' : '撤回'}</span></button>}
        {copyFeedback?.id === entry.id && <small role="status">{copyFeedback.text}</small>}
      </div>}
      {entry.delivery && <div className="xixi-delivery" role="status">{entry.delivery === 'sending' ? '已发送 · 正在等析熙' : <><span>回复还没完成</span><button type="button" className="xixi-text-button" disabled={chat.busy} onClick={async () => {
        const revision = draftRevision.current
        if (entry.requestId && await chat.retryMessage(entry.requestId) && revision === draftRevision.current) onSent(entry.content)
      }}>重试</button></>}</div>}
      {entry.question && !entry.retractedAt && <div className="xixi-quick-options" role="group" aria-label="选择回答，也可以在下方输入">
        {entry.question.options.map(option => <button type="button" key={option} disabled={!active || chat.busy || entry.id !== currentQuestion} onClick={async () => {
          const revision = draftRevision.current
          if (await chat.send(option, context) && revision === draftRevision.current) onSent(option)
        }}>{option}</button>)}
      </div>}
      {entry.requestId && lastAssistant.get(entry.requestId) === entry.id && operations.filter(operation => operation.requestId === entry.requestId).map(operation => <Receipt key={operation.id} operation={operation} chat={chat} />)}
      {entry.requestId && lastAssistant.get(entry.requestId) === entry.id && chat.conversation?.companionActions?.filter(action => action.requestId === entry.requestId).map(action => <div className="xixi-receipt" key={action.id}><strong>{action.label}</strong><button type="button" className="xixi-text-button" onClick={() => window.dispatchEvent(new CustomEvent('astaria-open-companion', { detail: { tab: action.kind === 'wish' ? 'wishes' : 'scenarios', targetId: action.targetId } }))}>查看 ↗</button></div>)}
    </article>)}
    {unmatched.map(operation => <Receipt key={operation.id} operation={operation} chat={chat} />)}
    {children}
    {!chat.loading && !chat.status?.configured && <p className="xixi-status"><button className="xixi-text-button" type="button" onClick={onSettings}>连接 DeepSeek</button><span>在设置里安全导入密钥</span></p>}
    {chat.sending && <div className="xixi-thinking" role="status" aria-label="析熙正在想"><span /><span /><span /></div>}
  </div>
}

function Receipt({ operation, chat }: { operation: Operation; chat: XixiConversation }) {
  return <div className="xixi-receipt" data-operation-id={operation.id} data-unread={!operation.readAt}>
    <header><strong>{operation.summary}</strong>{operation.undoneAt
      ? <small>已撤销</small>
      : operation.undoable === false ? null : <button type="button" className="xixi-text-button xixi-undo" disabled={chat.busy} onClick={() => void chat.undo(operation.id)}><ReturnIcon /><span>{chat.undoing === operation.id ? '撤销中' : '撤销'}</span></button>}</header>
    {Boolean(operation.details?.length) && <ul className="xixi-receipt-details">{operation.details!.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
  </div>
}

function ReturnIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3 2 6l3 3M2.5 6H9a4 4 0 0 1 0 8H7" /></svg> }
function CopyIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5" /><path d="M10 5V3.5A1.5 1.5 0 0 0 8.5 2h-5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg> }
