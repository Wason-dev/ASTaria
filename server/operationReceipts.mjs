import { receiptNotesForRequest, receiptJournals } from './receiptExplanations.mjs'
const receiptDeadline = value => value.length === 10 ? value : new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).format(new Date(value))

const childrenOf = (operation, operations) => operations.filter(child => child.parentOperationId === operation.id &&
  child.requestId === operation.requestId && child.kind === 'planner' && operation.kind !== 'planner')

/** A task and its initial placement are one user action, with one undo target. */
export function publicOperation(operation, db, operations = db.listOperations(), requestNotes) {
  const parent = operation.parentOperationId && operations.find(item => item.id === operation.parentOperationId &&
    item.requestId === operation.requestId && item.kind !== 'planner')
  if (parent) return publicOperation(parent, db, operations, requestNotes)
  const { id, requestId, summary, createdAt, readAt, undoneAt, undoable, planChanges, changes = [] } = operation
  const children = childrenOf(operation, operations)
  const members = [operation, ...children]
  const explanations = operation.undoneAt ? [] : (requestNotes ?? receiptNotesForRequest(db, requestId)).filter(note => members.some(item => item.id === note.operationId && !item.undoneAt)).map(note => note.text)
  const created = changes.filter(change => change.table === 'tasks' && change.before === null && change.after)
  const scheduleCount = children.filter(child => !child.undoneAt).reduce((count, child) => count + (child.planChanges ?? []).filter(change => change.after).length, 0)
  const collection = created[0]?.after?.collection
  const title = created.length > 1 ? `创建 ${created.length} 项事项${collection && created.every(change => change.after.collection === collection) ? ` · ${collection}` : ''}` : summary
  return {
    id, requestId, summary: children.length && scheduleCount ? `${title} · 已安排 ${scheduleCount} 段时间` : scheduleHeading(title, planChanges),
    scheduledCount: scheduleCount,
    ...(explanations.length ? { explanations: [...new Set(explanations)] } : {}),
    createdAt, readAt: members.every(item => item.readAt) ? readAt : null, undoneAt, undoable,
    ...(children.length ? { relatedOperationIds: children.map(child => child.id) } : {}),
    ...(created.length ? { undoLabel: children.length ? '撤销创建与安排' : '撤销创建' } : {}),
    details: [
      ...changes.map(change => {
        if (change.table !== 'tasks') return '记忆已更新'
        const task = change.before === null ? db.getTask(change.id) ?? change.after : change.after ?? change.before
        return `${task?.title ?? '事项'}${task?.due ? ` · 截止 ${receiptDeadline(task.due)}` : ''}${task?.estimateMin ? ` · 预计 ${task.estimateMin} 分钟` : ''}`
      }),
      ...(planChanges ?? []).map(change => planDetail(change)),
      ...children.flatMap(child => (child.planChanges ?? []).map(change => {
        const taskId = change.after?.taskId ?? change.before?.taskId
        const task = db.getTask(taskId) ?? changes.find(item => item.table === 'tasks' && item.id === taskId)?.after
        return `${task?.title ? `${task.title} · ` : ''}${planDetail(change)}${child.undoneAt && !undoneAt ? ' · 时段已撤销' : ''}`
      })),
      ...children.flatMap(child => {
        const note = /；(\d+ 项未估时事项先按\d+分钟预留（可调整）)$/u.exec(child.summary)?.[1]
        return note ? [note] : []
      }),
    ].filter(Boolean),
    createdTasks: created.flatMap(change => {
      const task = db.getTask(change.id)
      return task && !task.deletedAt ? [{ id: task.id, title: task.title, collection: task.collection, due: task.due, estimateMin: task.estimateMin, updatedAt: task.updatedAt }] : []
    }),
  }
}

function planDetail(change) {
  return change.after ? `${change.after.date} ${change.after.start}–${change.after.end}` : change.before ? `移除 ${change.before.date} ${change.before.start}–${change.before.end}` : ''
}

function scheduleHeading(summary, planChanges = []) {
  // Keep durable summaries intact, including receipts from earlier versions.
  // Shorten only the known scheduling format whose times are all in details;
  // retain suffixes such as the provisional-duration explanation.
  const match = /^((?:自动)?安排 \d+ 段任务时间)：(\d{4}-\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2}(?:、\d{4}-\d{2}-\d{2} \d{2}:\d{2}–\d{2}:\d{2})*)(.*)$/u.exec(summary)
  if (!match) return summary
  const details = new Set(planChanges.filter(change => change.after).map(planDetail))
  return match[2].split('、').every(time => details.has(time)) ? `${match[1]}${match[3]}` : summary
}

export function publicOperations(operations, db) {
  const groupedChildren = new Set(operations.flatMap(operation => childrenOf(operation, operations).map(child => child.id)))
  const journals = receiptJournals(db, operations.map(operation => operation.requestId))
  const notes = new Map([...journals].map(([id, outcomes]) => [id, outcomes.flatMap(outcome => outcome.notes ?? [])]))
  return operations.filter(operation => !groupedChildren.has(operation.id)).map(operation => {
    return publicOperation(operation, db, operations, notes.get(operation.requestId) ?? [])
  })
}
