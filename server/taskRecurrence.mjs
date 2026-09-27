import { ValidationError, knownKeys, day, text } from './validation.mjs'

export const MAX_OCCURRENCES = 32

/** Expand a bounded calendar instruction, never infer dates from prose or
 * multiply an undated workload. Each result remains independently editable. */
export function expandRecurringTaskDrafts(drafts, { today, seriesIdFor }) {
  const expanded = []
  const undated = new Set()
  for (const draft of drafts) {
    if (draft.repeat !== undefined || draft.startAt !== undefined || draft.schedule !== undefined) continue
    const signature = JSON.stringify(Object.fromEntries(Object.entries(draft).sort(([a], [b]) => a.localeCompare(b))))
    if (undated.has(signature)) throw new ValidationError('同批重复的无日期事项无法表达每天一次；请使用repeat日期范围和星期，或给每份明确日期，不要将多天压成无日期任务')
    undated.add(signature)
  }
  if (drafts.some(draft => draft.repeat) && drafts.some(draft => draft.schedule)) {
    throw new ValidationError('重复事项与指定钟点事项请分两次创建；每种安排保留各自的完整条件')
  }
  for (const [index, draft] of drafts.entries()) {
    if (draft.repeat === undefined) { expanded.push(draft); continue }
    const { repeat, ...fields } = draft
    knownKeys(repeat, ['from', 'to', 'weekdays', 'preferredWindow', 'allowFallback', 'placement'], '重复安排')
    const from = day(repeat.from, '重复开始日期'), to = day(repeat.to, '重复结束日期')
    if (from < today) throw new ValidationError('重复安排应从今天或未来开始，请按本轮日期展开')
    const first = Date.parse(`${from}T00:00:00Z`), last = Date.parse(`${to}T00:00:00Z`)
    if (last < first || last - first > 30 * 86400000) throw new ValidationError('重复安排范围需为1至31天')
    if (!Array.isArray(repeat.weekdays) || !repeat.weekdays.length || repeat.weekdays.length > 7 ||
      new Set(repeat.weekdays).size !== repeat.weekdays.length || repeat.weekdays.some(value => !Number.isInteger(value) || value < 0 || value > 6)) {
      throw new ValidationError('重复安排的星期需为互不重复的0至6，0表示周日')
    }
    if (typeof repeat.allowFallback !== 'boolean') throw new ValidationError('重复安排需明确是否允许同日其他空档')
    const placement = repeat.placement ?? 'start'
    if (!['start', 'end'].includes(placement)) throw new ValidationError('重复安排位置应为start或end')
    const preferredWindow = repeat.preferredWindow === undefined ? undefined : text(repeat.preferredWindow, '优先窗口', 160)
    if (fields.startAt !== undefined || fields.scheduleWindow !== undefined) throw new ValidationError('重复安排的日期和窗口由repeat统一指定，不要混用startAt或scheduleWindow')
    if (!Number.isInteger(fields.estimateMin) || fields.estimateMin < 1 || fields.estimateMin > 1440) throw new ValidationError('重复安排需要每次的明确分钟数')
    if (fields.status !== undefined && !['todo', 'doing'].includes(fields.status)) throw new ValidationError('重复安排只能创建未完成事项')
    const seriesId = seriesIdFor(index)
    const before = expanded.length
    for (let at = first; at <= last; at += 86400000) {
      const date = new Date(at)
      if (!repeat.weekdays.includes(date.getUTCDay())) continue
      const occurrenceDate = date.toISOString().slice(0, 10)
      expanded.push({ ...fields, startAt: occurrenceDate,
        occurrence: { seriesId, date: occurrenceDate, ...(preferredWindow ? { preferredWindow } : {}),
          allowFallback: repeat.allowFallback, placement } })
    }
    if (expanded.length === before) throw new ValidationError('重复日期范围内没有所选星期，请修正日期或星期')
    if (expanded.length > MAX_OCCURRENCES) throw new ValidationError(`单次重复安排最多展开${MAX_OCCURRENCES}项`)
  }
  if (expanded.length > MAX_OCCURRENCES) throw new ValidationError(`单次重复安排最多展开${MAX_OCCURRENCES}项`)
  return expanded
}
