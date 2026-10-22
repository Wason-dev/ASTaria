import { publicExecutionIssue } from './executionIssue'
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import type { XixiConversation, XixiContext } from './useXixiConversation'
import type { ChatAttachment, ChatMessage, ChatReasoningRound, ChatStreamDraft, CompanionAction, Operation, ReceiptTask, SavedReasoning, SourceMetadata } from './types'
import { isSourceMetadataList, sourceURL, uniqueSourceMetadata } from './sourceMetadata'
import { MessageMarkdown } from './MessageMarkdown'
import { documentSummary, isDocumentAttachment } from './documentAttachment'
import { conversationTimeline } from './conversationTimeline'
import type { ConversationRow } from './conversationTimeline'
import { receiptEntries } from './receiptCollections'
import type { ReceiptEntry } from './receiptCollections'
import { CollectionIcon } from '../ui/CollectionIcon'
import { deadlineLabel } from '../home/agenda'
import { ReceiptDeadline } from './ReceiptDeadline'
import { isReceiptEstimateMessage, isReceiptEstimateRequest, receiptEstimateRequest, receiptEstimateSaveIssue } from './receiptTaskSettings'
import { taskStore } from '../stores/taskStore'
import type { PlannerState } from '../planner/types'
import { localDay } from '../home/agenda'
import { localApi } from './api'
import { chatThinkingHeadline } from './stream'
import './conversation.css'

type Props = {
  chat: XixiConversation
  active: boolean
  onSettings: () => void
  context: XixiContext
  onSent: (text: string) => void
  onRetracted: (text: string, attachments?: ChatAttachment[]) => void
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
  const estimateLock = useRef(false)
  const [estimating, setEstimating] = useState(false)
  // Stable event callbacks read the latest host state without making every
  // saved row depend on the per-token chat object or the focus/input context.
  const latest = useRef({ chat, active, context, onSent, onRetracted })
  useLayoutEffect(() => { latest.current = { chat, active, context, onSent, onRetracted } })
  const requestEstimate = useCallback(async (task: ReceiptTask, minutes: number) => {
    const { chat, active, context } = latest.current
    if (!active || chat.busy || estimateLock.current) return false
    estimateLock.current = true
    setEstimating(true)
    try {
      const request = receiptEstimateRequest(task, minutes, context)
      // Use the existing conversation and durable request/retry path. This is
      // a receipt action, so it must not call onSent or clear the input draft.
      const completed = await chat.send(request.text, request.context)
      if (!completed && !latest.current.chat.status?.configured) throw new Error(latest.current.chat.status
        ? '析熙尚未连接模型，请在设置中连接 API 或本地模型后重试'
        : '本机服务暂时无法连接，请恢复连接并读取对话后重试')
      if (completed) {
        // A completed reply can contain only an estimate edit or no write at
        // all. Check saved data rather than treating the transport as a commit.
        let saved: ReceiptTask | null, planner: PlannerState
        try { [saved, planner] = await Promise.all([taskStore.getTask(task.id), localApi<PlannerState>('/planner')]) }
        catch { throw new Error('回复已结束，但实际保存结果暂时无法核对；请重新读取聊天和日程后重试') }
        const issue = receiptEstimateSaveIssue(saved, minutes, planner.blocks)
        if (issue) throw new Error(issue)
      }
      return completed
    } finally {
      estimateLock.current = false
      setEstimating(false)
    }
  }, [])
  const conversationId = chat.conversation?.conversationId
  const sourceMessages = chat.conversation?.messages ?? EMPTY_MESSAGES
  const operations = chat.conversation?.operations ?? EMPTY_OPERATIONS
  const companionActions = chat.conversation?.companionActions ?? EMPTY_COMPANION_ACTIONS
  const receiptDay = localDay(new Date())
  const previousTimeline = useRef<{ conversationId?: string; rows: ConversationRow[] } | null>(null)
  // Depend on immutable source arrays, not the chat wrapper recreated by each
  // stream token. Publish the sharing baseline only after React commits it.
  const rows = useMemo(() => {
    const previous = previousTimeline.current
    return conversationTimeline(conversationId === undefined ? null : {
      conversationId, messages: sourceMessages, operations, companionActions,
    }, previous?.conversationId === conversationId ? previous?.rows : undefined)
  }, [conversationId, sourceMessages, operations, companionActions])
  useLayoutEffect(() => { previousTimeline.current = { conversationId, rows } }, [conversationId, rows])
  const messages = useMemo(() => rows.map(row => row.message), [rows])
  const signature = useMemo(() => `${conversationId}:${messages.at(-1)?.requestId ?? messages.at(-1)?.id}:${messages.at(-1)?.delivery}:${operations.map(item => `${item.id}:${item.undoneAt}`).join(',')}:${chat.sending}`, [conversationId, messages, operations, chat.sending])
  const stream = chat.stream?.conversationId === chat.conversation?.conversationId ? chat.stream : null
  const receiptRequest = stream ? messages.find(entry => entry.requestId === stream.requestId && isReceiptEstimateMessage(entry)) : undefined
  const currentActivity = stream?.activities?.at(-1)
  const currentTool = currentActivity?.id.startsWith('tool:') && currentActivity.state !== 'done' ? currentActivity : null
  const thinkingHeadline = stream ? chatThinkingHeadline(stream) : null
  const streamSignature = `${stream?.requestId}:${stream?.round}:${stream?.reasoningContent.length}:${stream?.content.length}:${stream?.phase}:${stream?.activities?.map(item => `${item.id}:${item.state}`).join(',')}`
  const setReasoningExpanded = useCallback((id: string, expanded: boolean) => setExpandedReasoning(current => ({ ...current, [id]: expanded })), [])
  useEffect(() => () => clearTimeout(copyTimer.current), [])
  useEffect(() => {
    if (!chat.sending || !stream) return
    // The same request moves from the live bubble to a saved reply (or a
    // failed user bubble). Keep its expansion choice across those remounts.
    setExpandedReasoning(current => current[stream.requestId] === undefined ? { ...current, [stream.requestId]: false } : current)
  }, [chat.sending, stream?.requestId])
  const copyMessage = useCallback(async (id: string, content: string) => {
    clearTimeout(copyTimer.current)
    try { await navigator.clipboard.writeText(content); setCopyFeedback({ id, text: '已复制' }) }
    catch { setCopyFeedback({ id, text: '暂时无法复制，可选中文字复制' }) }
    copyTimer.current = setTimeout(() => setCopyFeedback(null), 2200)
  }, [])
  const actions = useMemo<HistoryActions>(() => ({
    copyMessage, setReasoningExpanded, requestEstimate,
    undo: id => latest.current.chat.undo(id),
    refresh: () => latest.current.chat.refresh(),
    retract: async entry => {
      const { chat, onRetracted } = latest.current
      if (await chat.retractMessage(entry)) { draftRevision.current += 1; if (!isReceiptEstimateMessage(entry)) onRetracted(entry.content, entry.attachments) }
    },
    retry: async entry => {
      const { chat, onSent } = latest.current
      const revision = draftRevision.current
      if (entry.requestId && await chat.retryMessage(entry.requestId) && revision === draftRevision.current && !isReceiptEstimateRequest(entry.content)) onSent(entry.content)
    },
    answer: async option => {
      const { chat, context, onSent } = latest.current
      const revision = draftRevision.current
      if (await chat.send(option, context) && revision === draftRevision.current) onSent(option)
    },
  }), [copyMessage, setReasoningExpanded, requestEstimate])

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
  }, [active, operations, rows, chat.markRead])

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
    <SavedHistory rows={rows} conversationId={conversationId} receiptDay={receiptDay} sendingRequestId={chat.sending ? stream?.requestId : undefined}
      interruptedReasoning={chat.interruptedReasoning} expandedReasoning={expandedReasoning} copyFeedback={copyFeedback}
      active={active} busy={chat.busy} sending={chat.sending} retracting={chat.retracting} undoing={chat.undoing} estimating={estimating} actions={actions} />
    {children}
    {!chat.loading && !chat.status?.configured && <p className="xixi-status"><button className="xixi-text-button" type="button" onClick={onSettings}>连接模型</button><span>在设置里选择 API 或本地模型</span></p>}
      {chat.sending && stream && <article className="xixi-message xixi-stream" data-role="assistant" aria-live="off" data-round={stream.round}>
      <span>析熙 <small>生成中</small></span>
      {(stream.phase === 'thinking' || stream.reasoningContent) && <Reasoning key={stream.requestId} expanded={expandedReasoning[stream.requestId] ?? false} onExpandedChange={expanded => setReasoningExpanded(stream.requestId, expanded)} content={stream.reasoningContent} rounds={stream.reasoningRounds} currentRound={stream.round} streaming={stream.phase === 'thinking'} live />}
      {stream?.content && <MessageMarkdown content={stream.content} />}
      {stream.sources && <Sources sources={stream.sources} />}
      <div className="xixi-stream-status" role="status" aria-live={active ? 'polite' : 'off'} data-state={currentTool?.state ?? stream.phase}>
        <div className="xixi-thinking" aria-hidden="true"><span /><span /><span /></div>
        <span className="xixi-stream-status-copy"><strong data-thinking-headline={Boolean(thinkingHeadline && !currentTool)}>{currentTool?.state === 'failed' ? '正在核对未完成的操作' : currentTool?.title ?? (stream.phase === 'executing' ? '正在处理安排' : stream.phase === 'replying' || stream.content ? '正在回复' : thinkingHeadline ?? '正在思考')}</strong>
          {currentTool?.state === 'running' && <small>{currentTool.detail}</small>}</span>
        {receiptRequest && <button type="button" className="xixi-text-button" disabled={!active || Boolean(chat.retracting)}
          title="取消本次请求，已经保存的安排仍可在回执中撤销" onClick={() => void actions.retract(receiptRequest)}>取消调整</button>}
      </div>
    </article>}
  </div>
}

const EMPTY_MESSAGES: ChatMessage[] = []
const EMPTY_OPERATIONS: Operation[] = []
const EMPTY_COMPANION_ACTIONS: CompanionAction[] = []

type HistoryActions = {
  copyMessage: (id: string, content: string) => Promise<void>
  setReasoningExpanded: (id: string, expanded: boolean) => void
  requestEstimate: (task: ReceiptTask, minutes: number) => Promise<boolean>
  retract: (entry: ChatMessage) => Promise<void>
  retry: (entry: ChatMessage) => Promise<void>
  answer: (option: string) => Promise<void>
  undo: XixiConversation['undo']
  refresh: XixiConversation['refresh']
}

type HistoryProps = {
  rows: ConversationRow[]; conversationId?: string; receiptDay: string; sendingRequestId?: string
  interruptedReasoning: XixiConversation['interruptedReasoning']; expandedReasoning: Record<string, boolean>
  copyFeedback: { id: string; text: string } | null
  active: boolean; busy: boolean; sending: boolean; retracting: string | null; undoing: string | null; estimating: boolean
  actions: HistoryActions
}

// Streaming text, composer drafts and focus ticks do not enter this subtree.
const SavedHistory = memo(function SavedHistory({ rows, conversationId, receiptDay, sendingRequestId, interruptedReasoning, expandedReasoning, copyFeedback, active, busy, sending, retracting, undoing, estimating, actions }: HistoryProps) {
  const messagesByRequest = useMemo(() => {
    const groups = new Map<string, ChatMessage[]>()
    for (const { message } of rows) {
      if (!message.requestId || message.retractedAt) continue
      const group = groups.get(message.requestId)
      if (group) group.push(message)
      else groups.set(message.requestId, [message])
    }
    return groups
  }, [rows])
  const last = rows.at(-1)?.message
  const currentQuestion = last?.role === 'assistant' && last.question ? last.id : null
  return rows.map(row => {
    const entry = row.message
    const interrupted = entry.requestId ? interruptedReasoning?.[entry.requestId] : undefined
    const requestMessages = entry.requestId ? messagesByRequest.get(entry.requestId) ?? EMPTY_MESSAGES : [entry]
    const reasoningOwner = requestMessages.findLast(item => item.role === 'assistant')?.id ?? entry.id
    // An older page may put the saved marker on the user before its final
    // reply is loaded. Reasoning availability belongs to the whole request.
    const reasoningContent = interrupted?.reasoningContent ?? requestMessages.findLast(item => item.reasoningContent?.trim())?.reasoningContent
    const showReasoning = !entry.retractedAt && reasoningOwner === entry.id && !(sendingRequestId && sendingRequestId === entry.requestId)
      && Boolean(reasoningContent || requestMessages.some(item => item.hasSavedReasoning))
    return <SavedMessage key={entry.role === 'user' && entry.requestId ? `user:${entry.requestId}` : entry.id}
      row={row} conversationId={conversationId} receiptDay={row.operations.length ? receiptDay : undefined} interrupted={showReasoning ? interrupted : undefined} reasoningContent={showReasoning ? reasoningContent : undefined} showReasoning={showReasoning}
      expanded={showReasoning && (expandedReasoning[entry.requestId ?? entry.id] ?? false)} copyFeedback={copyFeedback?.id === entry.id ? copyFeedback.text : undefined}
      busy={busy} retractDisabled={!active || Boolean(retracting) || (busy && !sending)} retracting={retracting === entry.id}
      questionDisabled={!active || busy || entry.id !== currentQuestion} receiptDisabled={!active || busy || estimating}
      undoing={row.operations.some(operation => operation.id === undoing) ? undoing : null} actions={actions} />
  })
})

type SavedMessageProps = {
  row: ConversationRow; conversationId?: string; receiptDay?: string; interrupted?: ChatStreamDraft; reasoningContent?: string; showReasoning: boolean
  expanded: boolean; copyFeedback?: string; busy: boolean; retractDisabled: boolean; retracting: boolean
  questionDisabled: boolean; receiptDisabled: boolean; undoing: string | null; actions: HistoryActions
}

const SavedMessage = memo(function SavedMessage({ row, conversationId, receiptDay, interrupted, reasoningContent, showReasoning, expanded, copyFeedback, busy, retractDisabled, retracting, questionDisabled, receiptDisabled, undoing, actions }: SavedMessageProps) {
  const { message: entry, operations: receipts, companionActions } = row
  const reasoningId = entry.requestId ?? entry.id
  const receiptRequest = isReceiptEstimateMessage(entry)
  const showDelivery = entry.delivery && (!receiptRequest || entry.delivery === 'failed')
  if (receiptRequest && !showDelivery && !showReasoning && !receipts.length && !companionActions.length) return null
  return <article className="xixi-message" data-role={receiptRequest ? 'action' : entry.role} data-message-id={entry.id} data-delivery={entry.delivery} data-retracted={Boolean(entry.retractedAt)}>
      {!receiptRequest && <span>{entry.role === 'user' ? '你' : '析熙'}</span>}
      {entry.role === 'assistant' && showReasoning && <Reasoning expanded={expanded} onExpandedChange={expanded => actions.setReasoningExpanded(reasoningId, expanded)} content={reasoningContent} rounds={interrupted?.reasoningRounds} currentRound={interrupted?.phase === 'thinking' ? interrupted.round : undefined} interrupted={Boolean(interrupted)} live={Boolean(interrupted)} requestId={entry.requestId} conversationId={conversationId} />}
      {!receiptRequest && (entry.retractedAt ? <p>已撤回</p> : <>
        {entry.attachments?.length ? <div className="xixi-message-attachments" aria-label="消息中的附件">{entry.attachments.map((attachment, index) => isDocumentAttachment(attachment)
          ? <div className="xixi-attachment-chip xixi-document-card" key={`${attachment.name}:${index}`} title={attachment.name}>
              <svg className="xixi-document-icon" viewBox="0 0 20 24" aria-hidden="true"><path d="M4 1h8l5 5v17H2V1h2m8 0v6h5M6 12h7m-7 4h7" /></svg>
              <span>{attachment.name}<small>{documentSummary(attachment)}</small></span>
            </div>
          : <img decoding="async" key={`${attachment.name}:${index}`} src={attachment.data} alt={`${attachment.name}，已发送给析熙`} />)}</div> : null}
        {entry.content && (entry.role === 'assistant' ? <MessageMarkdown content={entry.content} /> : <p>{entry.content}</p>)}
        {entry.role === 'assistant' && !entry.excludeFromContext && entry.sources && <Sources sources={entry.sources} />}
      </>)}
      {!receiptRequest && !entry.retractedAt && (entry.content || entry.role === 'user') && <div className="xixi-message-actions">
        <button className="xixi-message-copy" type="button" title="复制" aria-label={entry.role === 'user' ? '复制你的消息' : '复制析熙的消息'} onClick={() => void actions.copyMessage(entry.id, entry.content)}><CopyIcon /><span>复制</span></button>
        {entry.role === 'user' && <button className="xixi-message-retract" type="button" title="撤回并将原文放回输入框，已执行的安排仍可单独撤销" disabled={retractDisabled} onClick={() => void actions.retract(entry)}><ReturnIcon /><span>{retracting ? '撤回中' : '撤回'}</span></button>}
        {copyFeedback && <small role="status">{copyFeedback}</small>}
      </div>}
      {showDelivery && <div className="xixi-delivery" role="status">{entry.delivery === 'sending' ? '已发送 · 正在等析熙' : <><span>{receiptRequest ? '估时调整尚未完成' : '回复还没完成'}</span><button type="button" className="xixi-text-button" disabled={busy} onClick={() => void actions.retry(entry)}>重试</button></>}</div>}
      {entry.role === 'user' && showReasoning && <Reasoning expanded={expanded} onExpandedChange={expanded => actions.setReasoningExpanded(reasoningId, expanded)} content={reasoningContent} rounds={interrupted?.reasoningRounds} currentRound={interrupted?.phase === 'thinking' ? interrupted.round : undefined} interrupted={Boolean(interrupted)} live={Boolean(interrupted)} requestId={entry.requestId} conversationId={conversationId} />}
      {entry.question && !entry.retractedAt && <div className="xixi-quick-options" role="group" aria-label="选择回答，也可以在下方输入">
        {entry.question.options.map(option => <button type="button" key={option} disabled={questionDisabled} onClick={() => void actions.answer(option)}>{option}</button>)}
      </div>}
      {!entry.retractedAt && entry.executionNotice && <div className="xixi-execution-notice" role="status" aria-label="执行状态">
        {entry.executionNotice.replyUnavailable && <p>回复生成中断，已保存的操作见下方回执。</p>}
        {entry.executionNotice.issues.length > 0 && <><strong>尚未完成</strong><ul>{entry.executionNotice.issues.map(issue => <li key={issue}>{publicExecutionIssue(issue)}</li>)}</ul></>}
      </div>}
      {receiptEntries(receipts).map(entry => entry.kind === 'operation' ? <Receipt key={entry.id} operation={entry.operation} receiptDay={receiptDay} busy={busy} undoing={undoing === entry.id} disabled={receiptDisabled} actions={actions} /> : <CollectionReceipt key={entry.id} entry={entry} receiptDay={receiptDay} busy={busy} undoing={undoing} disabled={receiptDisabled} actions={actions} />)}
      {companionActions.map(action => <div className="xixi-receipt" key={action.id}><strong>{action.label}</strong><button type="button" className="xixi-text-button" onClick={() => window.dispatchEvent(new CustomEvent('astaria-open-companion', { detail: { tab: action.kind === 'wish' || action.kind === 'goal' ? 'wishes' : 'scenarios', targetId: action.targetId } }))}>查看 ↗</button></div>)}
    </article>
})

const Sources = memo(function Sources({ sources }: { sources: SourceMetadata[] }) {
  if (!isSourceMetadataList(sources)) return null
  const visible = uniqueSourceMetadata(sources)
  const readable = visible.filter(source => source.fetchStatus === 'ok').length
  const unverified = visible.length - readable
  const status = !visible.length ? '未读到网页正文' : !readable ? '未读到可用正文' : unverified ? `${readable} 页已读取 · ${unverified} 页未读到正文` : '正文已读取'
  const statusText = { ok: '正文已读取', empty: '正文为空 · 无法核实', failed: '读取失败 · 无法核实' }
  if (!visible.length) return <div className="xixi-source-empty" role="status" aria-label="网页读取状态">来源 · {status}</div>
  return <details className="xixi-sources">
    <summary aria-label={`展开或收起网页来源，${visible.length} 个，${status}`}><span>来源 {visible.length}</span><small>{status}</small></summary>
    <ul aria-label="网页来源">
      {visible.map(source => {
        const duplicateTitle = sourceURL(source.title) === sourceURL(source.url) || source.title === new URL(source.url).hostname
        return <li key={source.url} data-fetch-status={source.fetchStatus}>
          <a href={source.url} target="_blank" rel="noopener noreferrer" title={source.url}>{duplicateTitle ? new URL(source.url).host + new URL(source.url).pathname + new URL(source.url).search + new URL(source.url).hash : source.title}<span aria-hidden="true"> ↗</span></a>
          {!duplicateTitle && <span className="xixi-source-address">{source.url}</span>}
          <span className="xixi-source-meta"><span>{statusText[source.fetchStatus]}</span><time dateTime={source.fetchedAt}>{new Date(source.fetchedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time></span>
        </li>
      })}
    </ul>
  </details>
})

function CopyReasoning({ content, requestId, conversationId, label }: { content?: string; requestId?: string; conversationId?: string; label: string }) {
  const [copying, setCopying] = useState(false)
  const [feedback, setFeedback] = useState('')
  const savedText = useRef<{ key: string; content: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    if (copying || (!content && !(requestId && conversationId))) return
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
  return <span className="xixi-reasoning-copy"><button type="button" className="xixi-text-button" data-label={label} aria-label={label} disabled={copying || (!content && !(requestId && conversationId))} onClick={() => void copy()}><span role="status">{copying ? '正在读取' : feedback === '已复制' ? '已复制' : label}</span></button>{feedback && feedback !== '已复制' && <small role="status">{feedback}</small>}</span>
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
        </div>) : visibleContent ? <p>{visibleContent}</p> : !loadError && <p>{live ? '正在等待模型返回思考内容' : '正在读取已保存的思考'}</p>}
        {loadError && <div className="xixi-reasoning-error" role="status">{loadError}<button type="button" className="xixi-text-button" onClick={() => setReload(value => value + 1)}>重试读取</button></div>}
      </div></div>
    </div>
  </section>
}

// Date shortcuts use today's date. Invalidate on a host render after midnight
// without remounting an open editor or making every timer tick render it.
const MemoReceiptDeadline = memo(function ReceiptDeadlineForDay(props: ComponentProps<typeof ReceiptDeadline> & { receiptDay?: string }) {
  return <ReceiptDeadline {...props} />
})

type ReceiptProps = { operation: Operation; receiptDay?: string; busy: boolean; undoing: boolean; disabled: boolean; actions: HistoryActions }
function ReceiptUndo({ operation, busy, undoing, actions }: Pick<ReceiptProps, 'operation' | 'busy' | 'undoing' | 'actions'>) {
  return operation.undoneAt ? <small>已撤销</small> : operation.undoable === false ? null : <button type="button" className="xixi-text-button xixi-undo" disabled={busy} onClick={() => void actions.undo(operation.id)}><ReturnIcon /><span>{undoing ? '撤销中' : operation.undoLabel ?? '撤销'}</span></button>
}
function ReceiptTaskEditor({ task, receiptDay, disabled, actions }: { task: ReceiptTask; receiptDay?: string; disabled: boolean; actions: HistoryActions }) {
  const [open, setOpen] = useState(false), [visited, setVisited] = useState(false), id = useId()
  return <div className="xixi-receipt-task">
    <button type="button" className="xixi-text-button xixi-collection-toggle" aria-expanded={open} aria-controls={id} onClick={() => { setVisited(true); setOpen(value => !value) }}><span>{task.title}</span><small>{task.estimateMin ? `${task.estimateMin} 分钟` : '用时待估'} <span aria-hidden="true">{open ? '⌃' : '⌄'}</span></small></button>
    <div id={id} className="xixi-collection-reveal" data-open={open} inert={!open} aria-hidden={!open}><div>{visited && <MemoReceiptDeadline task={task} receiptDay={receiptDay} disabled={disabled} multiple onSaved={actions.refresh} onEstimate={actions.requestEstimate} />}</div></div>
  </div>
}
const Receipt = memo(function Receipt({ operation, receiptDay, busy, undoing, disabled, actions }: ReceiptProps) {
  const multiple = (operation.createdTasks?.length ?? 0) > 1
  const [open, setOpen] = useState(!multiple), id = useId()
  const title = multiple ? `创建 ${operation.createdTasks!.length} 项事项${operation.scheduledCount ? ` · 已安排 ${operation.scheduledCount} 段时间` : ''}` : operation.summary
  return <div className="xixi-receipt" data-operation-id={operation.id} data-unread={!operation.readAt}>
    <header>{multiple ? <button type="button" className="xixi-text-button" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>{title} {open ? '⌃' : '⌄'}</button> : <strong>{title}</strong>}<ReceiptUndo operation={operation} busy={busy} undoing={undoing} actions={actions} /></header>
    {!operation.undoneAt && operation.explanations?.map((reason, index) => <p key={index} className="xixi-receipt-reason">{reason}</p>)}
    <div id={id} className="xixi-collection-reveal" data-open={open} inert={!open} aria-hidden={!open}><div>
      {Boolean(operation.details?.length) && <ul className="xixi-receipt-details">{operation.details!.map((detail, index) => <li key={index}>{detail}</li>)}</ul>}
      {!operation.undoneAt && operation.createdTasks?.map(task => multiple ? <ReceiptTaskEditor key={task.id} task={task} receiptDay={receiptDay} disabled={disabled} actions={actions} /> : <MemoReceiptDeadline key={task.id} task={task} receiptDay={receiptDay} disabled={disabled} multiple={false} onSaved={actions.refresh} onEstimate={actions.requestEstimate} />)}
    </div></div>
  </div>
})
function CollectionReceipt({ entry, receiptDay, busy, undoing, disabled, actions }: { entry: Extract<ReceiptEntry, { kind: 'collection' }>; receiptDay?: string; busy: boolean; undoing: string | null; disabled: boolean; actions: HistoryActions }) {
  const [open, setOpen] = useState(false), [details, setDetails] = useState(false), id = useId()
  const scheduled = entry.operations.filter(operation => !operation.undoneAt).reduce((sum, operation) => sum + (operation.scheduledCount ?? 0), 0)
  const undone = entry.operations.filter(operation => operation.undoneAt).length
  const due = entry.due ? deadlineLabel({ due: entry.due } as import('../domain/task').Task, receiptDay ? new Date(`${receiptDay}T12:00:00`) : new Date()) : '未设 DDL'
  return <div className="xixi-receipt xixi-collection-receipt" data-receipt-collection={entry.id}>
    <button type="button" className="xixi-text-button xixi-collection-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}><span><CollectionIcon /> {entry.name}</span><small>{entry.tasks.length} 项 {open ? '⌃' : '⌄'}</small></button>
    <p className="xixi-collection-summary">{entry.due ? `截止 ${due}` : due}{scheduled > 0 && ` · 已安排 ${scheduled} 段`}{undone > 0 && ` · ${undone} 批已撤销`}</p>
    <div id={id} className="xixi-collection-reveal" data-open={open} inert={!open} aria-hidden={!open}><div>
      {[...new Set(entry.operations.filter(operation => !operation.undoneAt).flatMap(operation => operation.explanations ?? []))].map(reason => <p key={reason} className="xixi-receipt-reason">{reason}</p>)}
      <div className="xixi-collection-undos">{entry.operations.map((operation, index) => <div key={operation.id} data-operation-id={operation.id}><small>{entry.operations.length > 1 ? `第 ${index + 1} 批 · ` : ''}{operation.createdTasks?.length ?? 0} 项</small><ReceiptUndo operation={operation} busy={busy} undoing={undoing === operation.id} actions={actions} /></div>)}</div>
      {entry.tasks.map(task => <ReceiptTaskEditor key={task.id} task={task} receiptDay={receiptDay} disabled={disabled} actions={actions} />)}
      <button type="button" className="xixi-text-button" aria-expanded={details} onClick={() => setDetails(value => !value)}>{details ? '收起' : '查看'}保存明细</button>
      <div className="xixi-collection-reveal" data-open={details} inert={!details} aria-hidden={!details}><div><ul className="xixi-receipt-details">{entry.operations.flatMap(operation => operation.details ?? []).map((detail, index) => <li key={index}>{detail}</li>)}</ul></div></div>
    </div></div>
  </div>
}

function ReturnIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3 2 6l3 3M2.5 6H9a4 4 0 0 1 0 8H7" /></svg> }
function CopyIcon() { return <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="9" rx="1.5" /><path d="M10 5V3.5A1.5 1.5 0 0 0 8.5 2h-5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" /></svg> }
