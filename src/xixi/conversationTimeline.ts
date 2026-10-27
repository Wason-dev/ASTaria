import type { ChatMessage, CompanionAction, ConversationState, Operation } from './types.ts'
import { sameSnapshot } from '../stores/sameSnapshot.ts'

export type ConversationRow = { message: ChatMessage; operations: Operation[]; companionActions: CompanionAction[] }

/** Receipts belong to their request, even while replying or after a withdrawal. */
export function conversationTimeline(conversation: ConversationState | null, previous: ConversationRow[] = []): ConversationRow[] {
  const rows = (conversation?.messages ?? []).filter(message => message.role !== 'tool' && !(message.role === 'assistant' && message.retractedAt))
    .map(message => ({ message, operations: [] as Operation[], companionActions: [] as CompanionAction[] }))
  const anchors = new Map<string, ConversationRow>()
  for (const row of rows) {
    const { requestId, role } = row.message
    if (requestId && (role === 'assistant' || anchors.get(requestId)?.message.role !== 'assistant')) anchors.set(requestId, row)
  }
  // The API also carries operations from unloaded history. Never move those
  // to the latest reply: they become visible when their own turn is loaded.
  for (const operation of new Map((conversation?.operations ?? []).map(item => [item.id, item])).values()) anchors.get(operation.requestId)?.operations.push(operation)
  for (const action of new Map((conversation?.companionActions ?? []).map(item => [item.id, item])).values()) anchors.get(action.requestId)?.companionActions.push(action)
  // Reuse unchanged rows across receipt updates and history pagination. Compare
  // complete snapshots: equal IDs or text lengths do not imply equal content.
  // The caller owns the previous committed result; no global history is kept.
  if (!previous.length) return rows
  const prior = new Map(previous.map(row => [row.message.id, row]))
  const shared = rows.map(row => {
    const old = prior.get(row.message.id)
    if (!old) return row
    if (sameSnapshot(old.message, row.message)) row.message = old.message
    row.operations = shareItems(old.operations, row.operations)
    row.companionActions = shareItems(old.companionActions, row.companionActions)
    return row.message === old.message && row.operations === old.operations && row.companionActions === old.companionActions ? old : row
  })
  return shared.length === previous.length && shared.every((row, index) => row === previous[index]) ? previous : shared
}

function shareItems<T extends { id: string }>(previous: T[], next: T[]): T[] {
  if (!previous.length && !next.length) return previous
  const prior = new Map(previous.map(item => [item.id, item]))
  const shared = next.map(item => {
    const old = prior.get(item.id)
    return old && sameSnapshot(old, item) ? old : item
  })
  return shared.length === previous.length && shared.every((item, index) => item === previous[index]) ? previous : shared
}

export function mergeConversation(current: ConversationState | null, next: ConversationState): ConversationState {
  if (!current || current.conversationId !== next.conversationId) return next
  const withdrawn = new Set(next.messages.filter(item => item.retractedAt && item.requestId).map(item => item.requestId))
  const messages = [...new Map([...current.messages, ...next.messages].map(item => [item.id, item])).values()].filter(item => !(item.role === 'assistant' && withdrawn.has(item.requestId))).sort((a, b) => a.seq - b.seq)
  const companionActions = [...new Map([...(current.companionActions ?? []), ...(next.companionActions ?? [])].map(item => [item.id, item])).values()]
    .filter(item => !messages.some(message => message.requestId === item.requestId && message.retractedAt))
  const hasEarlier = (current.oldestSeq ?? Infinity) < (next.oldestSeq ?? Infinity)
  const merged = { ...next, messages, companionActions, ...(hasEarlier ? { oldestSeq: current.oldestSeq, hasOlder: current.hasOlder } : {}) }
  // A polling response may be identical even after older history was loaded.
  // Keep the React snapshot stable without dropping withdrawals or receipts.
  return sameSnapshot(current, merged) ? current : merged
}

/** Replace the whole visible action, including receipts cached by older clients. */
export function mergeOperationReceipt(current: ConversationState | null, operation: Operation): ConversationState | null {
  if (!current) return current
  const related = new Set([operation.id, ...(operation.relatedOperationIds ?? [])])
  return { ...current, operations: [...current.operations.filter(item => !related.has(item.id)), operation] }
}

/** A saved tool-round paragraph is not completion. Only the durable turn state
 * (or a verified terminal chat result) can retire an uncertain send. */
export function completedChatRequests(state: ConversationState): Set<string> {
  const ids = new Set(state.messages.filter(message => message.requestStatus === 'completed' && !message.retractedAt && message.requestId)
    .map(message => message.requestId!))
  if ('status' in state && state.status === 'completed' && 'requestId' in state && typeof state.requestId === 'string'
    && !state.messages.some(message => message.requestId === state.requestId && message.retractedAt)) ids.add(state.requestId)
  return ids
}
