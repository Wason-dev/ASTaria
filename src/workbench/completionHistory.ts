import type { Task } from '../domain/task'
import { agendaDate, localDay } from '../home/agenda'

export type CompletedTaskQuery = { mode: 'recent' | 'history'; query?: string; from?: string; to?: string; page?: number }

export function completionDate(task: Task): Date | undefined {
  return agendaDate(task.doneAt)
}

/** Recent means today and the preceding six local calendar days, not seven
 * 24-hour periods. Missing completion dates remain discoverable in history. */
export function completedTaskPage(tasks: readonly Task[], now: Date, query: CompletedTaskQuery) {
  const validNow = Number.isFinite(now.getTime())
  const today = validNow ? localDay(now) : ''
  const first = validNow ? new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6) : null
  const firstDay = first ? localDay(first) : ''
  const completed = tasks.filter(task => !task.deletedAt && task.status === 'done')
  const isRecent = (task: Task) => {
    const date = completionDate(task)
    return validNow && date !== undefined && date.getTime() <= now.getTime() && localDay(date) >= firstDay && localDay(date) <= today
  }
  const search = query.query?.trim().toLocaleLowerCase() ?? ''
  const invalidRange = Boolean(query.from && query.to && query.from > query.to)
  const filtered = completed.filter(task => {
    if (query.mode === 'recent') return isRecent(task)
    if (invalidRange || (search && !task.title.toLocaleLowerCase().includes(search))) return false
    const date = completionDate(task), day = date ? localDay(date) : undefined
    return (!query.from || (day !== undefined && day >= query.from)) && (!query.to || (day !== undefined && day <= query.to))
  }).sort((a, b) => {
    const left = completionDate(a)?.getTime(), right = completionDate(b)?.getTime()
    if (left === undefined || right === undefined) return left === right ? a.id.localeCompare(b.id) : left === undefined ? 1 : -1
    return right - left || a.id.localeCompare(b.id)
  })
  const pageSize = query.mode === 'recent' ? 6 : 8
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const requestedPage = Number.isFinite(query.page) ? Math.floor(query.page!) : 0
  const page = Math.min(pageCount - 1, Math.max(0, requestedPage))
  return {
    items: filtered.slice(page * pageSize, (page + 1) * pageSize),
    total: filtered.length, totalCompleted: completed.length, recentCount: completed.filter(isRecent).length,
    unknownDateCount: completed.filter(task => completionDate(task) === undefined).length,
    page, pageSize, pageCount, invalidRange,
  }
}
