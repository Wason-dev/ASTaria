import type { Task } from '../domain/task'

export type DeadlineUrgency = 'overdue' | 'urgent' | 'soon' | 'upcoming' | 'later'

export type DeadlineItem = {
  task: Task
  urgency: DeadlineUrgency
  remainingLabel: string
  dateLabel: string
  deadlineMs: number
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

type ParsedDeadline = { date: Date; dateOnly: boolean; deadlineMs: number }

function open(task: Task): boolean {
  return !task.deletedAt && (task.status === 'todo' || task.status === 'doing')
}

function localDate(year: number, month: number, day: number): Date {
  const date = new Date(0)
  date.setFullYear(year, month - 1, day)
  date.setHours(0, 0, 0, 0)
  return date
}

/** Date-only deadlines expire after their entire local calendar day. */
function parseDeadline(value?: string): ParsedDeadline | undefined {
  if (!value) return undefined
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:?\d{2})?)?$/.exec(value)
  if (!match) return undefined
  const [year, month, day] = match.slice(1, 4).map(Number)
  const calendarDate = localDate(year, month, day)
  if (calendarDate.getFullYear() !== year || calendarDate.getMonth() !== month - 1 || calendarDate.getDate() !== day) return undefined
  const dateOnly = match[4] === undefined
  if (dateOnly) {
    const end = new Date(calendarDate)
    end.setDate(end.getDate() + 1)
    return { date: calendarDate, dateOnly, deadlineMs: end.getTime() }
  }
  if (Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6] ?? 0) > 59) return undefined
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? { date, dateOnly, deadlineMs: date.getTime() } : undefined
}

/** Share the same effective deadline with recommendations and the Upcoming rail. */
export function deadlineTime(value?: string): number | undefined {
  return parseDeadline(value)?.deadlineMs
}

/** UTC is only used as a calendar-day ordinal, never to interpret a deadline. */
function calendarDay(date: Date): number {
  const ordinal = new Date(0)
  ordinal.setUTCFullYear(date.getFullYear(), date.getMonth(), date.getDate())
  ordinal.setUTCHours(0, 0, 0, 0)
  return ordinal.getTime() / DAY
}

function durationLabel(milliseconds: number): string {
  if (milliseconds < MINUTE) return '不到1分钟'
  const minutes = Math.floor(milliseconds / MINUTE)
  if (milliseconds < HOUR) return `${minutes}分钟`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (milliseconds < DAY) return `${hours}小时${remainingMinutes ? `${remainingMinutes}分钟` : ''}`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  const remainder = remainingHours ? `${remainingHours}小时` : remainingMinutes ? `${remainingMinutes}分钟` : ''
  return `${days}天${remainder}`
}

function remainingLabel(deadline: ParsedDeadline, now: Date): string {
  const remaining = deadline.deadlineMs - now.getTime()
  if (remaining === 0) return '刚刚到期'
  if (deadline.dateOnly) {
    const days = calendarDay(deadline.date) - calendarDay(now)
    if (days < 0) return `逾期${-days}天`
    if (days === 0) return '今天截止'
    if (days === 1) return '明天截止'
    return `还有${days}天`
  }
  return `${remaining < 0 ? '逾期' : '剩'}${durationLabel(Math.abs(remaining))}`
}

function dateLabel(deadline: ParsedDeadline, now: Date): string {
  const date = deadline.date
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`
  const time = deadline.dateOnly ? '全天' : `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${year}${date.getMonth() + 1}月${date.getDate()}日 · ${time}`
}

function urgency(deadline: ParsedDeadline, now: Date): DeadlineUrgency {
  const remaining = deadline.deadlineMs - now.getTime()
  if (remaining <= 0) return 'overdue'
  if (remaining <= DAY || (deadline.dateOnly && calendarDay(deadline.date) === calendarDay(now))) return 'urgent'
  if (remaining <= 3 * DAY) return 'soon'
  if (remaining <= 7 * DAY) return 'upcoming'
  return 'later'
}

/** Includes overdue and distant deadlines so the upcoming rail never hides urgency. */
export function upcomingDeadlines(tasks: readonly Task[], now: Date): DeadlineItem[] {
  if (!Number.isFinite(now.getTime())) return []
  const items: DeadlineItem[] = []
  for (const task of tasks) {
    if (!open(task)) continue
    const deadline = parseDeadline(task.due)
    if (!deadline) continue
    items.push({ task, urgency: urgency(deadline, now), remainingLabel: remainingLabel(deadline, now), dateLabel: dateLabel(deadline, now), deadlineMs: deadline.deadlineMs })
  }
  return items.sort((a, b) => a.deadlineMs - b.deadlineMs
    || b.task.importance - a.task.importance
    || a.task.createdAt.localeCompare(b.task.createdAt)
    || a.task.id.localeCompare(b.task.id))
}

/** Missing deadlines are unscheduled; nonempty invalid deadlines need confirmation. */
export function unconfirmedDeadlineCount(tasks: readonly Task[]): number {
  return tasks.filter(task => open(task) && Boolean(task.due?.trim()) && !parseDeadline(task.due)).length
}
