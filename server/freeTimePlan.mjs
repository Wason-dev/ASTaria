import { ValidationError, knownKeys, text, identifier, choice, day, dateTime } from './validation.mjs'

const fail = (message, status = 400) => { throw new ValidationError(message, status) }
const started = week => Boolean(week.startDate || week.sessionIds?.length || week.completedAt)

/** Editable content never accepts progress supplied by a browser or model. */
export function planWeeksValue(input, previous = [], { persisted = false } = {}) {
  if (input === undefined) return structuredClone(previous)
  if (!Array.isArray(input) || input.length > 52) fail('长期计划最多 52 周')
  const weeks = input.map(item => {
    knownKeys(item, persisted ? ['week', 'title', 'details', 'status', 'taskId', 'sessionIds', 'completedAt', 'startDate', 'requiredSessions'] : ['week', 'title', 'details'], '长期计划阶段')
    if (!Number.isSafeInteger(item.week) || item.week < 1 || item.week > 52) fail('长期计划周号应为 1–52 的整数')
    const old = previous.find(week => week.week === item.week)
    const result = { ...(old ? structuredClone(old) : {}), week: item.week,
      title: text(item.title, '每周主题', 160), details: text(item.details ?? old?.details ?? '', '本周学习内容', 3000, { empty: true }) }
    if (persisted) {
      if (item.status !== undefined) result.status = choice(item.status, ['pending', 'active', 'completed'], '阶段状态')
      if (item.taskId !== undefined) result.taskId = identifier(item.taskId)
      if (item.startDate !== undefined) result.startDate = day(item.startDate)
      if (item.completedAt !== undefined) result.completedAt = dateTime(item.completedAt)
      if (item.requiredSessions !== undefined) {
        if (!Number.isSafeInteger(item.requiredSessions) || item.requiredSessions < 1 || item.requiredSessions > 14) fail('阶段学习次数应在 1–14 之间')
        result.requiredSessions = item.requiredSessions
      }
      if (item.sessionIds !== undefined) {
        if (!Array.isArray(item.sessionIds) || item.sessionIds.length > 5000) fail('阶段安排记录过多')
        result.sessionIds = item.sessionIds.map(id => identifier(id))
      }
      if (result.status === 'completed' && (!result.completedAt || !result.requiredSessions)) fail('已完成阶段缺少完成记录')
    }
    return result
  }).sort((a, b) => a.week - b.week)
  if (new Set(weeks.map(item => item.week)).size !== weeks.length) fail('长期计划周号不可重复')
  if (persisted) {
    const ids = weeks.flatMap(item => item.sessionIds ?? [])
    if (new Set(ids).size !== ids.length) fail('长期计划安排不可跨阶段重复')
  } else {
    const begun = previous.filter(started)
    if (begun.some(old => !weeks.some(item => item.week === old.week))) fail('已开始的阶段需要保留，以免丢失安排与学习进度', 409)
    const lastStarted = Math.max(0, ...begun.map(item => item.week))
    if (weeks.some(item => item.week <= lastStarted && !previous.some(old => old.week === item.week))) fail('请把新增阶段放在已开始阶段之后', 409)
  }
  return weeks
}

export const currentPlanWeek = goal => goal.planWeeks?.find(week => week.status !== 'completed')
export const sessionPlanWeek = (goal, sessionId) => goal.planWeeks?.find(week => week.sessionIds?.includes(sessionId))
export const freeTimeTaskNotes = goal => {
  const week = currentPlanWeek(goal)
  const notes = `余时长期目标：${goal.title}${goal.targetNote ? `\n${goal.targetNote}` : ''}${week ? `\n第 ${week.week} 周：${week.title}${week.details ? `\n${week.details}` : ''}` : ''}`
  if (notes.length <= 2000) return notes
  // Tasks hold a bounded preview; the goal retains the full stage details.
  const suffix = '\n…完整学习内容见余时计划。'
  return notes.slice(0, 2000 - suffix.length).replace(/[\uD800-\uDBFF]$/u, '').trimEnd() + suffix
}

/** Completion is explicit. The clock, a missed slot, or a content edit cannot advance a plan. */
export function refreshPlanProgress(goal, history, stamp) {
  if (!goal.planWeeks?.length) return false
  const completed = new Set(history.filter(item => item.goalId === goal.id).map(item => item.sessionId))
  let currentFound = false, changed = false
  for (const week of goal.planWeeks) {
    const done = (week.sessionIds ?? []).filter(id => completed.has(id)).length
    let status, completedAt = week.completedAt
    if (week.requiredSessions && done >= week.requiredSessions) {
      status = 'completed'; completedAt ??= stamp
    } else {
      status = currentFound ? 'pending' : 'active'
      completedAt = undefined; currentFound = true
    }
    if (week.status !== status || week.completedAt !== completedAt) changed = true
    week.status = status
    if (completedAt) week.completedAt = completedAt
    else delete week.completedAt
  }
  if (changed) { goal.version += 1; goal.updatedAt = stamp }
  return changed
}
