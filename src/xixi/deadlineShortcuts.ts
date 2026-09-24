import { agendaDate, localDay, shiftDay } from '../home/agenda.ts'
import { TASK_RECEIPT_CAPABILITIES } from '../domain/receiptCapabilities.ts'

export const DEADLINE_TIME_SHORTCUTS = TASK_RECEIPT_CAPABILITIES.deadline.timeShortcuts

export function deadlineShortcuts(now: Date) {
  return TASK_RECEIPT_CAPABILITIES.deadline.dateShortcuts.map((label, days) => ({ label, date: localDay(shiftDay(now, days)) }))
}

export function deadlineParts(due?: string) {
  const parsed = agendaDate(due)
  if (!parsed) return { date: '', time: '' }
  return { date: localDay(parsed), time: due?.includes('T') ? `${String(parsed.getHours()).padStart(2, '0')}:${String(parsed.getMinutes()).padStart(2, '0')}` : '' }
}

/** Date shortcuts keep an existing explicit clock time; an undated task stays date-only. */
export function deadlineOnDay(date: string, time = '') {
  if (!date) return null
  const parsed = agendaDate(date)
  if (!parsed || localDay(parsed) !== date) throw new Error('请选择有效的截止日期')
  if (!time) return date
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(time)) throw new Error('请选择有效的截止时刻')
  const result = new Date(`${date}T${time}`)
  if (Number.isNaN(result.getTime())) throw new Error('请选择有效的截止时刻')
  return result.toISOString()
}

export function plansAfterDeadline(due: string | null, taskId: string, blocks: Array<{ taskId: string; date: string; end: string }>) {
  const parsed = agendaDate(due ?? undefined)
  if (!parsed || !due) return 0
  const limit = due.length === 10 ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate() + 1).getTime() : parsed.getTime()
  return blocks.filter(block => block.taskId === taskId && new Date(`${block.date}T${block.end}`).getTime() > limit).length
}
