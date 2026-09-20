import type { Task } from '../domain/task.ts'

export function localDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

/** Date-only values are local calendar days, never UTC midnight. */
export function agendaDate(value?: string): Date | undefined {
  if (!value) return undefined
  const day = /^(\d{4})-(\d{2})-(\d{2})(?:T|$)/.exec(value)
  if (!day) return undefined
  const [year, month, date] = day.slice(1).map(Number)
  const check = new Date(year, month - 1, date, 12)
  if (check.getFullYear() !== year || check.getMonth() !== month - 1 || check.getDate() !== date) return undefined
  const parsed = value.length === 10 ? new Date(year, month - 1, date) : new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}

export function isOpenTask(task: Task) {
  return !task.deletedAt && (task.status === 'todo' || task.status === 'doing')
}

function onDay(value: string | undefined, day: string) {
  const date = agendaDate(value)
  return date ? localDay(date) === day : false
}

/** A deadline marks its deadline day, not every preceding day as scheduled work. */
export function taskOnDay(task: Task, day: string, today: string): boolean {
  if (!isOpenTask(task)) return false
  return onDay(task.startAt, day) || onDay(task.due, day)
    || (day === today && (task.status === 'doing' || (task.fuzzyWindow === 'today' && !agendaDate(task.startAt))))
}

export function agendaItems(tasks: readonly Task[], day: string, today: string): Task[] {
  return tasks.filter(task => taskOnDay(task, day, today)).sort((a, b) =>
    Number(b.status === 'doing') - Number(a.status === 'doing')
    || (agendaDate(a.startAt)?.getTime() ?? agendaDate(a.due)?.getTime() ?? Infinity)
      - (agendaDate(b.startAt)?.getTime() ?? agendaDate(b.due)?.getTime() ?? Infinity)
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export function deadlineItems(tasks: readonly Task[]): Task[] {
  return tasks.filter(task => isOpenTask(task) && Boolean(task.due)).sort((a, b) =>
    (agendaDate(a.due)?.getTime() ?? Infinity) - (agendaDate(b.due)?.getTime() ?? Infinity)
    || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

export function isOverdue(task: Task, now: Date): boolean {
  const date = agendaDate(task.due)
  if (!date) return false
  return task.due?.length === 10 ? localDay(date) < localDay(now) : date.getTime() < now.getTime()
}

export function monthDays(month: Date): Date[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1, 12)
  const offset = (first.getDay() + 6) % 7
  return Array.from({ length: 42 }, (_, index) => new Date(first.getFullYear(), first.getMonth(), 1 - offset + index, 12))
}

export function shiftDay(date: Date, days: number): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, 12)
}

export function shiftMonth(date: Date, months: number): Date {
  const last = new Date(date.getFullYear(), date.getMonth() + months + 1, 0, 12).getDate()
  return new Date(date.getFullYear(), date.getMonth() + months, Math.min(date.getDate(), last), 12)
}

const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const shortDateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' })

export function dayTaskLabel(task: Task, day: string): string {
  const labels: string[] = []
  if (onDay(task.startAt, day)) labels.push(task.startAt?.length === 10 ? '安排' : `${timeFormat.format(agendaDate(task.startAt))} 开始`)
  if (onDay(task.due, day)) labels.push(task.due?.length === 10 ? '截止' : `${timeFormat.format(agendaDate(task.due))} 截止`)
  return labels.join(' · ') || (task.status === 'doing' ? '进行中' : '今日')
}

export function deadlineLabel(task: Task, now: Date): string {
  const date = agendaDate(task.due)
  if (!date) return '日期待确认'
  const day = localDay(date) === localDay(now) ? '今天' : shortDateFormat.format(date)
  const year = date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`
  const time = task.due?.length === 10 ? '' : ` ${timeFormat.format(date)}`
  return `${isOverdue(task, now) ? '已逾期 · ' : ''}${year}${day}${time}`
}
