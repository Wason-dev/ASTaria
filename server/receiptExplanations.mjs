import { ValidationError, knownKeys, identifier, text } from './validation.mjs'

export const RECEIPT_NOTES_SCHEMA = {
  type: 'array', maxItems: 16,
  description: '金色回执的简短自然说明：结合已读课表解释安排原因，或未排上的真实缺口和可行选择。不是模板，不复制时间清单。',
  items: { type: 'object', additionalProperties: false, properties: {
    operationId: { type: 'string' }, text: { type: 'string', maxLength: 600 },
  }, required: ['operationId', 'text'] },
}

export function validateReceiptNotes(notes = [], operations, requestId) {
  if (!Array.isArray(notes) || notes.length > 16) throw new ValidationError('回执说明最多16项')
  const seen = new Set()
  return notes.map(note => {
    knownKeys(note, ['operationId', 'text'], '回执说明')
    const operationId = identifier(note.operationId)
    if (!operations.some(item => item.id === operationId && item.requestId === requestId && !item.undoneAt) || seen.has(operationId)) {
      throw new ValidationError('回执说明只能对应本轮仍有效的操作，不可重复')
    }
    seen.add(operationId)
    return { operationId, text: text(note.text, '安排理由', 600) }
  })
}

/** One bounded scan per conversation, shared across all operations in a read.
 * The durable tool journal already follows backup/retry/source-retraction rules. */
export function receiptJournals(db, requestIds) {
  const ids = [...new Set(requestIds)], conversations = new Map(), result = new Map()
  const turns = typeof db.getTurnReferences === 'function' ? db.getTurnReferences(ids) : ids.map(id => db.getTurn?.(id)).filter(Boolean)
  for (const turn of turns) {
    if (!turn.conversationId || turn.retractedAt) continue
    if (!conversations.has(turn.conversationId)) conversations.set(turn.conversationId, db.listMessages(turn.conversationId, { limit: 1000 }))
    const valid = conversations.get(turn.conversationId).filter(message => message.requestId === turn.requestId && !message.excludeFromContext && !message.retractedAt && !message.contextRetractedAt)
    const calls = new Set(valid.flatMap(message => message.toolCalls ?? []).filter(call => ['finish_response', 'ask_user'].includes(call.function?.name)).map(call => call.id))
    result.set(turn.requestId, valid.filter(message => message.role === 'tool' && calls.has(message.toolCallId)).flatMap(message => {
      try { const outcome = JSON.parse(message.content); return outcome.ok && outcome.type === 'receipt_explanation' ? [outcome] : [] } catch { return [] }
    }))
  }
  return result
}

export function receiptNotesForRequest(db, requestId) {
  return (receiptJournals(db, [requestId]).get(requestId) ?? []).flatMap(outcome => outcome.notes ?? [])
}

export function receiptNoteBasis(db, notes) {
  const operations = db.listOperations(), state = db.getPlanner()
  return Object.fromEntries(notes.map(note => {
    const operation = operations.find(item => item.id === note.operationId)
    const members = [operation, ...operations.filter(item => item.parentOperationId === operation?.id)]
    const ids = [...new Set(members.flatMap(item => [
      ...(item?.changes ?? []).filter(change => change.table === 'tasks').map(change => change.id),
      ...(item?.planChanges ?? []).map(change => change.after?.taskId ?? change.before?.taskId),
    ]).filter(Boolean))]
    return [note.operationId, { revision: state.revision, tasks: ids.map(id => ({ id, updatedAt: db.getTask(id)?.updatedAt })) }]
  }))
}

/** Stale explanations remain in historical receipts; they are not presented as
 * a current recommendation. Never generate template prose to fill that gap. */
export function currentSchedulingExplanations(db) {
  const result = {}, state = db.getPlanner(), operations = db.listOperations()
  const active = new Map(operations.filter(operation => !operation.undoneAt).map(operation => [operation.id, operation]))
  const journals = receiptJournals(db, [...active.values()].slice(0, 100).map(operation => operation.requestId))
  for (const outcomes of journals.values()) for (const outcome of outcomes) for (const note of outcome.notes ?? []) {
    const basis = outcome.basis?.[note.operationId]
    if (!active.has(note.operationId) || basis?.revision !== state.revision || !Array.isArray(basis.tasks)) continue
    if (basis.tasks.some(item => db.getTask(item.id)?.updatedAt !== item.updatedAt)) continue
    for (const { id } of basis.tasks) result[id] = [...new Set([...(result[id] ?? []), note.text])]
  }
  return result
}
