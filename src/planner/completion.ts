import type { Task } from '../domain/task.ts'
import type { PlanBlock, PlannerState } from './types.ts'

export function isFreeTimeSessionTask(task: Task) {
  return Boolean(task.freeTimeGoalId) && (task.status === 'todo' || task.status === 'doing')
}

function completedAt(state: PlannerState, sessionId: string) {
  const values = state.completedFreeTimeSessions
  return values && Object.hasOwn(values, sessionId) && typeof values[sessionId] === 'string' ? values[sessionId] : undefined
}

export function planBlockCompleted(task: Task | undefined, state: PlannerState, block?: PlanBlock) {
  if (!task) return false
  if (!isFreeTimeSessionTask(task)) return task.status === 'done'
  return Boolean(block?.taskId === task.id && completedAt(state, block.id))
}

/** Daily cards summarize only that day's sessions, never the whole ongoing goal. */
export function taskDayCompletion(task: Task, state: PlannerState, date: string, blocks: readonly PlanBlock[] = state.blocks) {
  if (!isFreeTimeSessionTask(task)) return { done: task.status === 'done', label: task.status === 'done' ? '已完成' : '' }
  const sessions = blocks.filter(block => block.taskId === task.id && block.date === date)
  const completed = sessions.filter(block => planBlockCompleted(task, state, block)).length
  const done = sessions.length > 0 && completed === sessions.length
  return { done, label: done ? '本日已完成' : completed ? `已完成 ${completed}/${sessions.length} 次` : '' }
}

/** Resolve against persisted blocks so an unsaved draft can never be checked in. */
export function freeTimeCompletionAction(task: Task, state: PlannerState, blockId?: string) {
  if (!isFreeTimeSessionTask(task)) return null
  const block = state.blocks.find(item => item.id === blockId && item.taskId === task.id)
  if (!block) return null
  const timestamp = completedAt(state, block.id)
  return timestamp
    ? { path: '/companion/free-time/reopen', input: { sessionId: block.id, expectedCompletedAt: timestamp }, completed: true }
    : { path: '/companion/free-time/complete', input: { sessionId: block.id, expectedSession: { taskId: block.taskId, date: block.date, start: block.start, end: block.end } }, completed: false }
}
