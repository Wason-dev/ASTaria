import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { localApi } from './api'
import type { ChatMessage, ChatResult, ConversationState, ConversationSummary, LocalStatus, Operation } from './types'
import type { ResponsePhase } from '../prototype/responseEffects'
import { mergeConversation } from './conversationTimeline'

export type XixiContext = { page: 'home' | 'workbench' | 'calendar' | 'timetable'; taskId?: string; date?: string; timezone: string }
type PendingMessage = { requestId: string; conversationId: string; text: string; context: XixiContext; createdAt?: string; seq?: number }
type OutgoingMessage = PendingMessage & { delivery: 'sending' | 'failed' }
const SELECTED_KEY = 'astaria-xixi-conversation-v1'
const PENDING_KEY = 'astaria-xixi-pending-v1'

function selectedConversation() { try { return sessionStorage.getItem(SELECTED_KEY) || null } catch { return null } }
function pendingRequests(): PendingMessage[] {
  const value: unknown = JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]')
  if (!Array.isArray(value)) throw new Error('无法读取发送记录，请保留原文后重新打开页面')
  return value.filter((item): item is PendingMessage => Boolean(item && typeof item.requestId === 'string' && typeof item.conversationId === 'string' && typeof item.text === 'string' && item.context && typeof item.context.page === 'string'))
}
function restoredOutgoing(): OutgoingMessage[] {
  try { return pendingRequests().map(item => ({ ...item, delivery: 'failed' })) } catch { return [] }
}
export function useXixiConversation(onTasksChanged: () => void, onNotice: (message: string) => void) {
  const [conversation, setConversation] = useState<ConversationState | null>(null)
  const [outgoing, setOutgoing] = useState<OutgoingMessage[]>(restoredOutgoing)
  const [status, setStatus] = useState<LocalStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [responsePhase, setResponsePhase] = useState<ResponsePhase>('idle')
  const responseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const visualRequest = useRef<string | null>(null)
  const [changingTopic, setChangingTopic] = useState(false)
  const [topics, setTopics] = useState<ConversationSummary[]>([])
  const [topicsLoading, setTopicsLoading] = useState(false)
  const [topicsError, setTopicsError] = useState('')
  const [topicActionError, setTopicActionError] = useState('')
  const [olderLoading, setOlderLoading] = useState(false)
  const [olderError, setOlderError] = useState('')
  const [undoing, setUndoing] = useState<string | null>(null)
  const [retracting, setRetracting] = useState<string | null>(null)
  const mounted = useRef(true)
  const busy = useRef(false)
  const revision = useRef(0)
  const topicsRevision = useRef(0)
  const selectedId = useRef(selectedConversation())
  const readingOlder = useRef(false)
  const activeRequest = useRef<string | null>(null)
  const cancelledRequests = useRef(new Set<string>())
  const retractInFlight = useRef(false)
  const changed = useRef(onTasksChanged)
  const notice = useRef(onNotice)
  changed.current = onTasksChanged
  notice.current = onNotice

  const acceptRetractions = useCallback((next: ConversationState) => {
    const withdrawn = new Set(next.messages.filter(item => item.retractedAt && item.requestId).map(item => item.requestId!))
    if (!withdrawn.size) return
    for (const id of withdrawn) cancelledRequests.current.add(id)
    try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingRequests().filter(item => !withdrawn.has(item.requestId)))) } catch { /* Server-side withdrawal also prevents retry. */ }
    setOutgoing(items => items.filter(item => !withdrawn.has(item.requestId)))
  }, [])

  const refreshStatus = useCallback(async () => {
    try {
      const next = await localApi<LocalStatus>('/status')
      if (mounted.current) setStatus(next)
    } catch {
      if (mounted.current) setStatus(null)
    }
  }, [])

  const refresh = useCallback(async () => {
    if (busy.current || retractInFlight.current) return
    const currentRevision = ++revision.current
    try {
      const id = selectedId.current
      const next = await localApi<ConversationState>(`/conversation${id ? `?id=${encodeURIComponent(id)}` : ''}`)
      if (!mounted.current || busy.current || revision.current !== currentRevision) return
      selectedId.current = next.conversationId
      try { sessionStorage.setItem(SELECTED_KEY, next.conversationId) } catch { /* Pending writes have a separate checked persistence step. */ }
      acceptRetractions(next)
      setConversation(current => mergeConversation(current, next))
      setLoadError('')
    } catch (reason) {
      if (mounted.current && revision.current === currentRevision) setLoadError(message(reason, '暂时无法读取对话，请重试'))
    } finally {
      if (mounted.current && revision.current === currentRevision) setLoading(false)
    }
  }, [acceptRetractions])

  useEffect(() => {
    mounted.current = true
    void refresh()
    void refreshStatus()
    const poll = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, 5000)
    const visible = () => {
      if (document.visibilityState === 'visible') { void refresh(); void refreshStatus() }
    }
    document.addEventListener('visibilitychange', visible)
    return () => {
      mounted.current = false
      revision.current += 1
      clearInterval(poll)
      clearTimeout(responseTimer.current)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [refresh, refreshStatus])

  const send = useCallback(async (text: string, context: XixiContext) => {
    const content = text.trim()
    if (!content || busy.current || retractInFlight.current) return false
    if (!conversation) { setError('先连接本机服务，读取对话后再发给我'); return false }
    if (!status?.configured) { setError('先在设置里连接 API 或本地模型，写下的内容会留在这里'); return false }
    let request: PendingMessage
    try {
      const pending = pendingRequests()
      const previous = pending.find(item => item.text === content && item.conversationId === conversation.conversationId && item.context.page === context.page && item.context.taskId === context.taskId && item.context.date === context.date)
      request = previous ?? { requestId: crypto.randomUUID(), conversationId: conversation.conversationId, text: content, context, createdAt: new Date().toISOString(), seq: Math.max(0, ...conversation.messages.map(item => item.seq), ...pending.filter(item => item.conversationId === conversation.conversationId).map(item => item.seq ?? 0)) + 1 }
      if (!previous) sessionStorage.setItem(PENDING_KEY, JSON.stringify([...pending, request]))
    } catch {
      setError('暂时无法保存发送记录，请允许浏览器会话存储后重试，原文还在')
      return false
    }
    busy.current = true
    activeRequest.current = request.requestId
    revision.current += 1
    setSending(true)
    visualRequest.current = request.requestId
    clearTimeout(responseTimer.current)
    setResponsePhase('thinking')
    setError('')
    setOutgoing(items => [...items.filter(item => item.requestId !== request.requestId), { ...request, delivery: 'sending' }])
    try {
      const { requestId, conversationId, text: messageText, context: messageContext } = request
      const result = await localApi<ChatResult>('/chat', { requestId, conversationId, text: messageText, context: messageContext })
      if (!mounted.current || cancelledRequests.current.has(request.requestId)) return false
      setConversation(current => mergeConversation(current, result))
      acceptRetractions(result)
      if (cancelledRequests.current.has(request.requestId)) return false
      if (result.operations.length) changed.current()
      if (result.status === 'failed') {
        setResponsePhase('idle')
        setOutgoing(items => items.map(item => item.requestId === request.requestId ? { ...item, delivery: 'failed' } : item))
        setError(result.error || '刚才没有完成，原文还在，可以重试')
        return false
      }
      // Never discard the retry ID for a failed or uncertain turn. Completed
      // turns remain idempotent on the server if this cleanup is interrupted.
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingRequests().filter(item => item.requestId !== request.requestId))) } catch { /* Retaining a completed ID is safe. */ }
      setOutgoing(items => items.filter(item => item.requestId !== request.requestId))
      const operations = result.operations.filter(operation => operation.requestId === result.requestId && !operation.undoneAt)
      if (operations.length) notice.current(operations.at(-1)!.summary)
      const companionAction = result.companionActions?.filter(item => item.requestId === result.requestId).at(-1)
      if (companionAction) { changed.current(); notice.current(companionAction.label) }
      setResponsePhase('replying')
      responseTimer.current = setTimeout(() => { if (mounted.current) setResponsePhase('idle') }, 4200)
      return true
    } catch (reason) {
      if (mounted.current && !cancelledRequests.current.has(request.requestId)) {
        setResponsePhase('idle')
        setOutgoing(items => items.map(item => item.requestId === request.requestId ? { ...item, delivery: 'failed' } : item))
        setError(message(reason, '暂时没有收到回复，原文还在，可以重试'))
      }
      return false
    } finally {
      if (activeRequest.current === request.requestId) {
        activeRequest.current = null
        busy.current = false
        if (mounted.current) setSending(false)
      }
    }
  }, [conversation, status?.configured, acceptRetractions])

  const retryMessage = useCallback(async (requestId: string) => {
    const request = outgoing.find(item => item.requestId === requestId)
    if (!request || request.conversationId !== conversation?.conversationId) return false
    return send(request.text, request.context)
  }, [outgoing, conversation?.conversationId, send])

  const retractMessage = useCallback(async (entry: ChatMessage) => {
    if (retractInFlight.current || entry.role !== 'user' || entry.retractedAt || !conversation || (busy.current && !activeRequest.current)) return false
    const conversationId = conversation.conversationId
    retractInFlight.current = true
    revision.current += 1
    setRetracting(entry.id)
    setError('')
    try {
      const next = entry.id.startsWith('optimistic:')
        ? await localApi<ConversationState>('/messages/retract', { requestId: entry.requestId, conversationId })
        : await localApi<ConversationState>(`/messages/${encodeURIComponent(entry.id)}/retract`, {})
      if (!mounted.current) return false
      if (entry.requestId) {
        if (visualRequest.current === entry.requestId) { clearTimeout(responseTimer.current); visualRequest.current = null; setResponsePhase('idle') }
        cancelledRequests.current.add(entry.requestId)
        try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingRequests().filter(item => item.requestId !== entry.requestId))) } catch { /* The server also rejects retries of withdrawn turns. */ }
        setOutgoing(items => items.filter(item => item.requestId !== entry.requestId))
        if (activeRequest.current === entry.requestId) { activeRequest.current = null; busy.current = false; setSending(false); clearTimeout(responseTimer.current); setResponsePhase('idle') }
      }
      if (selectedId.current === conversationId) setConversation(current => {
        const retained = current && { ...current, messages: current.messages.filter(item => !(item.role === 'assistant' && item.requestId && item.requestId === entry.requestId)) }
        return mergeConversation(retained, next)
      })
      return true
    } catch (reason) {
      if (mounted.current) setError(message(reason, '暂时没有撤回，消息仍在，可以重试'))
      return false
    } finally {
      retractInFlight.current = false
      if (mounted.current) setRetracting(null)
    }
  }, [conversation])

  const newTopic = useCallback(async () => {
    if (busy.current || retractInFlight.current) return false
    clearTimeout(responseTimer.current); setResponsePhase('idle')
    busy.current = true
    revision.current += 1
    setChangingTopic(true)
    setError('')
    setTopicActionError('')
    try {
      const next = await localApi<ConversationState>('/conversations', {})
      if (mounted.current) {
        selectedId.current = next.conversationId
        try { sessionStorage.setItem(SELECTED_KEY, next.conversationId) } catch { /* Current selection remains in memory. */ }
        setConversation(next); setLoadError(''); setOlderError('')
        return true
      }
      return false
    } catch (reason) {
      if (mounted.current) setTopicActionError(message(reason, '暂时没能另开话题，请重试'))
      return false
    } finally {
      busy.current = false
      if (mounted.current) setChangingTopic(false)
    }
  }, [])

  const undo = useCallback(async (id: string) => {
    if (busy.current || retractInFlight.current) return
    busy.current = true
    revision.current += 1
    setUndoing(id)
    setError('')
    try {
      const operation = await localApi<Operation>(`/operations/${encodeURIComponent(id)}/undo`, {})
      if (!mounted.current) return
      setConversation(current => current && ({ ...current, operations: current.operations.map(item => item.id === id ? operation : item) }))
      changed.current()
      notice.current('刚才的变更已撤销')
    } catch (reason) {
      if (mounted.current) setError(message(reason, '暂时无法撤销，请重试'))
    } finally {
      busy.current = false
      if (mounted.current) setUndoing(null)
    }
  }, [])

  const loadTopics = useCallback(async () => {
    const requestRevision = ++topicsRevision.current
    setTopicsLoading(true)
    setTopicsError('')
    try {
      const next = await localApi<ConversationSummary[]>('/conversations')
      if (mounted.current && topicsRevision.current === requestRevision) setTopics(next)
    } catch (reason) {
      if (mounted.current && topicsRevision.current === requestRevision) setTopicsError(message(reason, '暂时无法读取对话记录'))
    } finally {
      if (mounted.current && topicsRevision.current === requestRevision) setTopicsLoading(false)
    }
  }, [])

  const selectTopic = useCallback(async (id: string) => {
    if (busy.current || retractInFlight.current) return false
    clearTimeout(responseTimer.current); setResponsePhase('idle')
    busy.current = true
    revision.current += 1
    setChangingTopic(true)
    setError('')
    setTopicActionError('')
    try {
      const next = await localApi<ConversationState>('/conversations/select', { id })
      if (!mounted.current) return false
      selectedId.current = next.conversationId
      try { sessionStorage.setItem(SELECTED_KEY, next.conversationId) } catch { /* Current selection remains in memory. */ }
      acceptRetractions(next)
      setConversation(next)
      setLoadError('')
      setOlderError('')
      return true
    } catch (reason) {
      if (mounted.current) setTopicActionError(message(reason, '暂时没能打开这段对话'))
      return false
    } finally {
      busy.current = false
      if (mounted.current) setChangingTopic(false)
    }
  }, [acceptRetractions])

  const renameTopic = useCallback(async (id: string, title: string) => {
    const nextTitle = title.trim()
    if (busy.current || retractInFlight.current) return false
    if (!nextTitle || nextTitle.length > 80) { setTopicActionError('对话名称需要 1–80 个字符'); return false }
    busy.current = true
    revision.current += 1
    topicsRevision.current += 1
    setTopicsLoading(false)
    setChangingTopic(true)
    setTopicActionError('')
    try {
      const next = await localApi<ConversationSummary>('/conversations/rename', { conversationId: id, title: nextTitle })
      if (!mounted.current) return false
      setTopics(items => items.map(item => item.id === id ? next : item))
      notice.current('对话名称已更新')
      return true
    } catch (reason) {
      if (mounted.current) setTopicActionError(message(reason, '暂时没能重命名这段对话'))
      return false
    } finally {
      busy.current = false
      if (mounted.current) setChangingTopic(false)
    }
  }, [])

  const deleteTopic = useCallback(async (id: string) => {
    if (busy.current || retractInFlight.current) return false
    const currentId = selectedId.current
    busy.current = true
    revision.current += 1
    topicsRevision.current += 1
    setTopicsLoading(false)
    setChangingTopic(true)
    setTopicActionError('')
    try {
      const next = await localApi<ConversationState>('/conversations/delete', { conversationId: id })
      if (!mounted.current) return false
      setTopics(items => items.filter(item => item.id !== id))
      try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(pendingRequests().filter(item => item.conversationId !== id))) } catch { /* Deleted conversations cannot accept a retry on the server. */ }
      setOutgoing(items => items.filter(item => item.conversationId !== id))
      if (currentId === id) {
        selectedId.current = next.conversationId
        try { sessionStorage.setItem(SELECTED_KEY, next.conversationId) } catch { /* Current selection remains in memory. */ }
        acceptRetractions(next)
        setConversation(next)
        setLoadError('')
        setOlderError('')
      }
      await loadTopics()
      notice.current('这段对话已删除')
      return true
    } catch (reason) {
      if (mounted.current) { const detail = message(reason, '暂时没能删除这段对话'); setTopicActionError(detail.includes('至少保留') && !detail.includes('另开') ? `${detail}，请先另开话题` : detail) }
      return false
    } finally {
      busy.current = false
      if (mounted.current) setChangingTopic(false)
    }
  }, [acceptRetractions, loadTopics])

  const loadOlder = useCallback(async () => {
    if (readingOlder.current || !conversation?.hasOlder || conversation.oldestSeq == null) return false
    const id = conversation.conversationId
    readingOlder.current = true
    setOlderLoading(true)
    setOlderError('')
    try {
      const next = await localApi<ConversationState>(`/conversation?id=${encodeURIComponent(id)}&before=${conversation.oldestSeq}`)
      if (!mounted.current || selectedId.current !== id) return false
      acceptRetractions(next)
      setConversation(current => {
        if (!current || current.conversationId !== id) return current
        return { ...mergeConversation(next, current), oldestSeq: next.oldestSeq, hasOlder: next.hasOlder }
      })
      return true
    } catch (reason) {
      if (mounted.current && selectedId.current === id) setOlderError(message(reason, '更早的记录暂时没读到，请重试'))
      return false
    } finally {
      readingOlder.current = false
      if (mounted.current) setOlderLoading(false)
    }
  }, [conversation, acceptRetractions])

  const markRead = useCallback(async (ids: string[]) => {
    if (!ids.length) return
    try {
      await localApi<{ ok: true }>('/operations/read', { ids })
      if (mounted.current) setConversation(current => current && ({ ...current, operations: current.operations.map(operation => ids.includes(operation.id) ? { ...operation, readAt: new Date().toISOString() } : operation) }))
    } catch { /* Unread receipts remain available and can be marked on the next view. */ }
  }, [])

  const visibleConversation = useMemo(() => {
    if (!conversation) return null
    const messages = [...conversation.messages]
    for (const item of outgoing.filter(item => item.conversationId === conversation.conversationId)) {
      const index = messages.findIndex(entry => entry.role === 'user' && entry.requestId === item.requestId)
      if (index >= 0) {
        if (!messages[index].retractedAt) messages[index] = { ...messages[index], delivery: item.delivery }
      } else messages.push({ id: `optimistic:${item.requestId}`, seq: item.seq ?? Math.max(0, ...messages.map(entry => entry.seq)) + 1, role: 'user', content: item.text, createdAt: item.createdAt ?? '', requestId: item.requestId, taskId: item.context.taskId, delivery: item.delivery })
    }
    return { ...conversation, messages: messages.sort((a, b) => a.seq - b.seq) }
  }, [conversation, outgoing])

  return { conversation: visibleConversation, status, loading, loadError, error, sending, responsePhase, changingTopic, undoing, retracting, topics, topicsLoading, topicsError, topicActionError, clearTopicActionError: () => setTopicActionError(''), olderLoading, olderError, busy: sending || changingTopic || Boolean(undoing) || Boolean(retracting), send, retryMessage, retractMessage, undo, newTopic, refresh, refreshStatus, markRead, loadTopics, selectTopic, renameTopic, deleteTopic, loadOlder }
}

function message(reason: unknown, fallback: string) { return reason instanceof Error ? reason.message : fallback }
export type XixiConversation = ReturnType<typeof useXixiConversation>
