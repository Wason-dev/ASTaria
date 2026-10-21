import { TASK_RECEIPT_CAPABILITIES } from '../domain/receiptCapabilities.ts'
import type { ChatMessage, ReceiptTask } from './types'
import type { XixiContext } from './useXixiConversation'

export const ESTIMATE_SHORTCUTS = TASK_RECEIPT_CAPABILITIES.estimate.minuteShortcuts
export const ESTIMATE_MIN = TASK_RECEIPT_CAPABILITIES.estimate.customMin
export const ESTIMATE_MAX = TASK_RECEIPT_CAPABILITIES.estimate.customMax
const ESTIMATE_REQUEST_INSTRUCTIONS = '请读取这个已有事项和最新日程，沿用原事项，保留已确认的日期、窗口和 DDL，检查冲突并按新的时长重新安排；保存后以真实回执说明结果。若放不下或需要改变其他已确认安排，请说明缺口并问我具体取舍。'

export function parseReceiptEstimate(value: string): number {
  const minutes = Number(value)
  if (!value.trim() || !Number.isInteger(minutes) || minutes < ESTIMATE_MIN || minutes > ESTIMATE_MAX) throw new Error(`请输入 ${ESTIMATE_MIN}–${ESTIMATE_MAX} 的整数分钟`)
  return minutes
}

export function receiptEstimateRequest(task: ReceiptTask, minutes: number, context: XixiContext): { text: string; context: XixiContext } {
  const estimateMin = parseReceiptEstimate(String(minutes))
  return {
    text: `请将已创建事项「${task.title}」的预估时间改为 ${estimateMin} 分钟。${ESTIMATE_REQUEST_INSTRUCTIONS}`,
    // The receipt identifies the task; unrelated objects and a browsed date
    // must not become the target or a new scheduling constraint.
    context: { page: context.page, taskId: task.id, timezone: context.timezone },
  }
}

/** Receipt-generated retries also leave the user's current draft alone. */
export function isReceiptEstimateRequest(text: string): boolean {
  const prefix = /^请将已创建事项「[\s\S]+」的预估时间改为 \d+ 分钟。/.exec(text)?.[0]
  return Boolean(prefix && text.slice(prefix.length) === ESTIMATE_REQUEST_INSTRUCTIONS)
}

/** These requests already have an exact generated format and the receipt's
 * task/request IDs. Keep them as execution context, not a user chat bubble.
 * Reuse the same classification for saved history, pending sends and retries. */
export function isReceiptEstimateMessage(message: Pick<ChatMessage, 'role' | 'content' | 'requestId' | 'taskId' | 'inputKind'>): boolean {
  return message.role === 'user' && Boolean(message.requestId && message.taskId) && (message.inputKind === 'receipt-estimate' || isReceiptEstimateRequest(message.content))
}

export function receiptScheduledMinutes(taskId: string, blocks: Array<{ taskId: string; start: string; end: string }>): number {
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  return blocks.filter(block => block.taskId === taskId).reduce((total, block) => total + Math.max(0, minute(block.end) - minute(block.start)), 0)
}

export function receiptEstimateSaveIssue(task: ReceiptTask | null, minutes: number, blocks: Array<{ taskId: string; start: string; end: string }>): string | null {
  if (!task || task.estimateMin !== minutes) return `回复已结束，但预估时间尚未确认保存为 ${minutes} 分钟；请查看聊天中的提示，继续核对或重试`
  const planned = receiptScheduledMinutes(task.id, blocks)
  if (planned !== minutes) return `预估时间与日程尚未同步（预估 ${minutes} 分钟，已排 ${planned} 分钟）；请查看聊天中的提示，继续核对或重试`
  return null
}
