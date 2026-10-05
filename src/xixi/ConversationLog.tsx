import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { XixiConversation, XixiContext } from './useXixiConversation'
import type { ChatReasoningRound, Operation, SavedReasoning } from './types'
import { MessageMarkdown } from './MessageMarkdown'
import { conversationTimeline } from './conversationTimeline'
import { ReceiptDeadline } from './ReceiptDeadline'
import { localApi } from './api'
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
  const [expandedReasoning, setExpandedReasoning] = useState<Record<string, boolean>>({})
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const draftRevision = useRef(0)
  const rows = conversationTimeline(chat.conversation)
  const messages = rows.map(row => row.message)
  const messagesByRequest = new Map<string, typeof messages>()
  for (const entry of messages) {
    if (!entry.requestId || entry.retractedAt) continue
    const group = messagesByRequest.get(entry.requestId)
    if (group) group.push(entry)
    else messagesByRequest.set(entry.requestId, [entry])
  }
  const operations = chat.conversation?.operations ?? []
  const signature = `${chat.conversation?.conversationId}:${messages.at(-1)?.requestId ?? messages.at(-1)?.id}:${messages.at(-1)?.delivery}:${operations.map(item => `${item.id}:${item.undoneAt}`).join(',')}:${chat.sending}`
  const stream = chat.stream?.conversationId === chat.conversation?.conversationId ? chat.stream : null
  const currentActivity = stream?.activities?.at(-1)
  const currentTool = currentActivity?.id.startsWith('tool:') && currentActivity.state !== 'done' ? currentActivity : null
  const streamSignature = `${stream?.requestId}:${stream?.round}:${stream?.reasoningContent.length}:${stream?.content.length}:${stream?.phase}:${stream?.activities?.map(item => `${item.id}:${item.state}`).join(',')}`
  const currentQuestion = messages.at(-1)?.role === 'assistant' && messages.at(-1)?.question ? messages.at(-1)?.id : null
  const setReasoningExpanded = (id: string, expanded: boolean) => setExpandedReasoning(current => ({ ...current, [id]: expanded }))
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  useEffect(() => {
    if (!chat.sending || !stream) return
    // The same request moves from the live bubble to a saved reply (or a
    // failed user bubble). Keep its expansion choice across those remounts.
    setExpandedReasoning(current => current[stream.requestId] === undefined ? { ...current, [stream.requestId]: false } : current)
  }, [chat.sending, stream?.requestId])
  const copyMessage = async (id: string, content: string) => {
    clearTimeout(copyTimer.current)
    try { await navigator.clipboard.writeText(content); setCopyFeedback({ id, text: '已复制' }) }
    catch { setCopyFeedback({ id, text: '暂时无法复制，可选中文字复制' }) }
    copyTimer.current = setTimeout(() => setCopyFeedback(null), 2200)
  }

  useLayoutEffect(() => {
    following.current = true
    prependAnchor.current = null
    setExpandedReasoning({})
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

  useLayoutEffect(() => {
    if (active && following.current && log.current && stream) log.current.scrollTop = log.current.scrollHeight
  }, [streamSignature, active, stream])

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
    {rows.map(({ message: entry, operations: receipts, companionActions }) => {
      const interrupted = entry.requestId ? chat.interruptedReasoning?.[entry.requestId] : undefined
      const reasoningId = entry.requestId ?? entry.id
      const requestMessages = entry.requestId ? messagesByRequest.get(entry.requestId) ?? [] : [entry]
      const reasoningOwner = requestMessages.findLast(item => item.role === 'assistant')?.id ?? entry.id
      // Pagination may load the saved-reasoning marker on the user before its
      // final reply. Availability belongs to the request, like its receipts.
      const reasoningContent = interrupted?.reasoningContent ?? requestMessages.findLast(item => item.reasoningContent?.trim())?.reasoningContent
      const showReasoning = !entry.retractedAt && reasoningOwner === entry.id && !(chat.sending && stream?.requestId === entry.requestId)
        && (reasoningContent || requestMessages.some(item => item.hasSavedReasoning))
      return <article className="xixi-message" data-role={entry.role} data-message-id={entry.id} data-delivery={entry.delivery} data-retracted={Boolean(entry.retractedAt)} key={entry.role === 'user' && entry.requestId ? `user:${entry.requestId}` : entry.id}>
      <span>{entry.role === 'user' ? '你' : '析熙'}</span>
      {entry.role === 'assistant' && showReasoning && <Reasoning expanded={expandedReasoning[reasoningId] ?? false} onExpandedChange={expanded => setReasoningExpanded(reasoningId, expanded)} content={reasoningContent} rounds={interrupted?.reasoningRounds} currentRound={interrupted?.phase === 'thinking' ? interrupted.round : undefined} interrupted={Boolean(interrupted)} live={Boolean(interrupted)} requestId={entry.requestId} conversationId={chat.conversation?.conversationId} />}
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
      {entry.role === 'user' && showReasoning && <Reasoning expanded={expandedReasoning[reasoningId] ?? false} onExpandedChange={expanded => setReasoningExpanded(reasoningId, expanded)} content={reasoningContent} rounds={interrupted?.reasoningRounds} currentRound={interrupted?.phase === 'thinking' ? interrupted.round : undefined} interrupted={Boolean(interrupted)} live={Boolean(interrupted)} requestId={entry.requestId} conversationId={chat.conversation?.conversationId} />}
      {entry.question && !entry.retractedAt && <div className="xixi-quick-options" role="group" aria-label="选择回答，也可以在下方输入">
        {entry.question.options.map(option => <button type="button" key={option} disabled={!active || chat.busy || entry.id !== currentQuestion} onClick={async () => {
          const revision = draftRevision.current
          if (await chat.send(option, context) && revision === draftRevision.current) onSent(option)
        }}>{option}</button>)}
      </div>}
      {receipts.map(operation => <Receipt key={operation.id} operation={operation} chat={chat} />)}
      {companionActions.map(action => <div className="xixi-receipt" key={action.id}><strong>{action.label}</strong><button type="button" className="xixi-text-button" onClick={() => window.dispatchEvent(new CustomEvent('astaria-open-companion', { detail: { tab: action.kind === 'wish' || action.kind === 'goal' ? 'wishes' : 'scenarios', targetId: action.targetId } }))}>查看 ↗</button></div>)}
    </article>})}
    {children}
    {!chat.loading && !chat.status?.configured && <p className="xixi-status"><button className="xixi-text-button" type="button" onClick={onSettings}>连接模型</button><span>在设置里选择 API 或本地模型</span></p>}
      {chat.sending && stream && <article className="xixi-message xixi-stream" data-role="assistant" aria-live="off" data-round={stream.round}>
      <span>析熙 <small>生成中</small></span>
      {stream?.reasoningContent && <Reasoning key={stream.requestId} expanded={expandedReasoning[stream.requestId] ?? false} onExpandedChange={expanded => setReasoningExpanded(stream.requestId, expanded)} content={stream.reasoningContent} rounds={stream.reasoningRounds} currentRound={stream.round} streaming={stream.phase === 'thinking'} live />}
      {stream?.content && <MessageMarkdown content={stream.content} />}
      <div className="xixi-stream-status" role="status" aria-live={active ? 'polite' : 'off'} data-state={currentTool?.state ?? stream.phase}>
        <div className="xixi-thinking" aria-hidden="true"><span /><span /><span /></div>
        <span className="xixi-stream-status-copy"><strong>{currentTool?.state === 'failed' ? '正在核对未完成的操作' : currentTool?.title ?? (stream.phase === 'executing' ? '正在处理安排' : stream.phase === 'replying' ? '正在回复' : '正在思考')}</strong>
          {currentTool?.state === 'running' && <small>{currentTool.detail}</small>}</span>
      </div>
    </article>}
  </div>
}

function CopyReasoning({ content, requestId, conversationId, label }: { content?: string; requestId?: string; conversationId?: string; label: string }) {
  const [copying, setCopying] = useState(false)
  const [feedback, setFeedback] = useState('')
  const savedText = useRef<{ key: string; content: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    if (copying) return
    setCopying(true)
    setFeedback('')
    clearTimeout(timer.current)
    try {
      let text = content ?? ''
      if (requestId && conversationId) {
        const key = `${conversationId}:${requestId}`
        if (savedText.current?.key !== key) {
          const result = await localApi<{ reasoningContent: string }>(`/conversation/reasoning?conversationId=${encodeURIComponent(conversationId)}&requestId=${encodeURIComponent(requestId)}`)
          savedText.current = { key, content: result.reasoningContent }
        }
        text = savedText.current.content
      }
      // Cached retries and live thoughts reach writeText directly in the click
      // handler, preserving activation in browsers that reject an async fetch.
      await navigator.clipboard.writeText(text)
      savedText.current = null
      setFeedback('已复制')
    } catch (error) {
      setFeedback(error instanceof Error && error.name === 'NotAllowedError' && savedText.current
        ? '已读取完整思考，请再点一次复制'
        : error instanceof Error && error.name !== 'NotAllowedError' ? error.message : '暂时无法复制，请重试')
    }
    finally { setCopying(false); timer.current = setTimeout(() => setFeedback(''), 3500) }
  }
  return <span className="xixi-reasoning-copy"><button type="button" className="xixi-text-button" disabled={copying} onClick={() => void copy()}>{copying ? '正在读取' : label}</button>{feedback && <small role="status">{feedback}</small>}</span>
}

function Reasoning({ content = '', rounds, currentRound, expanded, onExpandedChange, streaming = false, live = false, interrupted = false, requestId, conversationId }: {
  expanded: boolean; onExpandedChange: (expanded: boolean) => void
  content?: string; rounds?: ChatReasoningRound[]; currentRound?: number; streaming?: boolean; live?: boolean; interrupted?: boolean; requestId?: string; conversationId?: string
}) {
  const [saved, setSaved] = useState<SavedReasoning | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reload, setReload] = useState(0)
  const scroll = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const id = useId()
  useEffect(() => {
    if (!expanded || live || !requestId || !conversationId) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      try {
        const next = await localApi<SavedReasoning>(`/conversation/reasoning?conversationId=${encodeURIComponent(conversationId)}&requestId=${encodeURIComponent(requestId)}`)
        if (cancelled) return
        setSaved(next)
        setLoadError('')
        // A refreshed page can still be watching an active turn. Read only;
        // never restart the chat just to recover its saved reasoning.
        if (next.status === 'running') timer = setTimeout(() => void read(), 2500)
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : '暂时无法读取思考过程')
      }
    }
    void read()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [expanded, live, requestId, conversationId, reload])
  const visibleContent = saved?.reasoningContent ?? content
  const visibleRounds = saved?.rounds ?? rounds
  useLayoutEffect(() => {
    if (expanded && streaming && following.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
  }, [visibleContent, expanded, streaming])
  return <section className="xixi-reasoning" data-expanded={expanded}>
    <div className="xixi-reasoning-header">
      <button type="button" className="xixi-reasoning-toggle" aria-expanded={expanded} aria-controls={id} onClick={() => onExpandedChange(!expanded)}>
        <svg viewBox="0 0 12 12" aria-hidden="true"><path d="m4 2 4 4-4 4" /></svg>
        <span>{streaming ? '思考中' : interrupted ? '思考过程 · 回复中断' : '思考过程'}</span>
      </button>
      <CopyReasoning content={visibleContent} requestId={live ? undefined : requestId} conversationId={conversationId} label={live ? interrupted ? '复制已接收思考' : '复制本次全部思考' : '复制完整思考'} />
    </div>
    <div className="xixi-reasoning-collapse" id={id} inert={!expanded} aria-hidden={!expanded}>
      <div><div ref={scroll} className="xixi-reasoning-content" tabIndex={expanded ? 0 : -1} role="region" aria-label="模型提供的思考过程" onScroll={event => {
        const element = event.currentTarget
        following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24
      }}>
        {visibleRounds?.length ? visibleRounds.map((part, index) => <div className="xixi-reasoning-round" key={part.id}>
          <small>第 {index + 1} 段 · {live && streaming && part.round === currentRound ? '思考中' : interrupted && currentRound !== undefined && part.round === currentRound ? '已中断' : '已结束'}</small>
          <p>{part.content}</p>
        </div>) : visibleContent ? <p>{visibleContent}</p> : !loadError && <p>正在读取已保存的思考</p>}
        {loadError && <div className="xixi-reasoning-error" role="status">{loadError}<button type="button" className="xixi-text-button" onClick={() => setReload(value => value + 1)}>重试读取</button></div>}
      </div></div>
    </div>
  </section>
}

function Receipt({ operation, chat }: { operation: Operation; chat: XixiConversation }) {
  return <div className="xixi-receipt" data-operation-id={operation.id} data-unread={!operation.readAt}>
    <header><strong>{operation.summary}</strong>{operation.undoneAt
      ? <small>已撤销</small>
      : operation.undoable === false ? null : <button type="button" className="xixi-text-button xixi-undo" disabled={chat.busy} onClick={() => void chat.undo(operation.id)}><ReturnIcon /><span>{chat.undoing === operation.id ? '撤销中' : operation.undoLabel ?? '撤销'}</span></button>}</header>
    {Boolean(operation.details?.length) && <ul className="xixi-receipt-details">{operation.details!.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
    {!operation.undoneAt && operation.createdTasks?.map(task => <ReceiptDeadline key={task.id} task={task} disabled={chat.busy} multiple={operation.createdTasks!.length > 1} onSaved={chat.refresh} />)}
  </div>
}

function ReturnIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3 2 6l3 3M2.5 6H9a4 4 0 0 1 0 8H7" /></svg> }
function CopyIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5" /><path d="M10 5V3.5A1.5 1.5 0 0 0 8.5 2h-5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg> }
