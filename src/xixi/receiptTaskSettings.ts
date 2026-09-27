import { TASK_RECEIPT_CAPABILITIES } from '../domain/receiptCapabilities.ts'

export const ESTIMATE_SHORTCUTS = TASK_RECEIPT_CAPABILITIES.estimate.minuteShortcuts
export const ESTIMATE_MIN = TASK_RECEIPT_CAPABILITIES.estimate.customMin
export const ESTIMATE_MAX = TASK_RECEIPT_CAPABILITIES.estimate.customMax

export function parseReceiptEstimate(value: string): number {
  const minutes = Number(value)
  if (!value.trim() || !Number.isInteger(minutes) || minutes < ESTIMATE_MIN || minutes > ESTIMATE_MAX) throw new Error(`请输入 ${ESTIMATE_MIN}–${ESTIMATE_MAX} 的整数分钟`)
  return minutes
}

export function receiptScheduledMinutes(taskId: string, blocks: Array<{ taskId: string; start: string; end: string }>): number {
  const minute = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  return blocks.filter(block => block.taskId === taskId).reduce((total, block) => total + Math.max(0, minute(block.end) - minute(block.start)), 0)
}
