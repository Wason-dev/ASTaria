import type { ChatMessage, CompanionAction, ConversationState, Operation } from './types.ts'
import { sameSnapshot } from '../stores/sameSnapshot.ts'

export type ConversationRow = { message: ChatMessage; operations: Operation[]; companionActions: CompanionAction[] }

/** Receipts belong to their request, even while replying or after a withdrawal. */
export function conversationTimeline(conversation: ConversationState | null): ConversationRow[] {
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
  return rows
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
