import type { Task } from '../domain/task'
import { agendaDate, isOpenTask, localDay } from '../home/agenda'
import { deadlineTime, upcomingDeadlines } from './deadlines'
import { recommendationReason, taskGroups } from './tasks'

export type BriefingRecommendation = {
  task: Task
  headline: string
  summary: string
  evidence: string[]
  suggestedMin: number
}

export type BriefingNotice = { id: string; title: string; body: string; taskIds: string[] }

export type WorkbenchBriefing = {
  availableCount: number
  dueSoonCount: number
  overdueCount: number
  completedTodayCount: number
  estimatedMin: number
  unestimatedCount: number
  recommendation: BriefingRecommendation | null
  notices: BriefingNotice[]
}

export type DeadlineContext = {
  effortLabel: string
  suggestion: string
  evidence: string[]
  tone: 'neutral' | 'attention' | 'urgent'
}

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

function estimate(task: Task): number | undefined {
  return typeof task.estimateMin === 'number' && Number.isFinite(task.estimateMin) && task.estimateMin > 0
    ? task.estimateMin : undefined
}

function focusLength(minutes: number): number {
  return Number.isFinite(minutes) && minutes > 0 ? Math.max(1, Math.round(minutes)) : 35
}

function spentTime(task: Task, getSpentMs: (id: string) => number): number {
  const milliseconds = getSpentMs(task.id)
  return Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : 0
}

function spentLabel(milliseconds: number): string {
  if (!milliseconds) return '尚未记录专注'
  return `累计专注 ${milliseconds < MINUTE ? '不到 1' : Math.floor(milliseconds / MINUTE)} 分钟`
}

function minutesLabel(minutes: number): string {
  return `${Math.ceil(minutes)} 分钟`
}

/** Time recorded across sessions is evidence of effort, never proof of remaining work. */
export function deadlineContext(task: Task, now: Date, focusMin: number, getSpentMs: (id: string) => number): DeadlineContext {
  const expected = estimate(task)
  const spent = spentTime(task, getSpentMs)
  const focus = focusLength(focusMin)
  const deadline = upcomingDeadlines([task], now)[0]
  const remaining = deadline ? deadline.deadlineMs - now.getTime() : undefined
  const evidence = [
    deadline ? `${deadline.dateLabel} · ${deadline.remainingLabel}`
      : task.due?.trim() ? '截止日期待确认' : '尚未设置明确截止',
    expected === undefined ? '用时尚未估计' : `原预计 ${minutesLabel(expected)}`,
    `${spentLabel(spent)}${spent > 0 ? '，包含历史记录' : ''}`,
    `以 ${minutesLabel(focus)} 为一轮估算，未包含休息，也不代表已安排时间`,
  ]
  const effortLabel = `${expected === undefined ? '用时待估' : `原预计 ${minutesLabel(expected)}`} · ${spentLabel(spent)}`
  if (remaining !== undefined && remaining <= 0) {
    return { effortLabel, evidence, tone: 'urgent', suggestion: '已过截止时间，先确认剩余工作和新的截止安排' }
  }
  if (expected !== undefined && remaining !== undefined && expected * MINUTE > remaining) {
    return { effortLabel, evidence, tone: 'urgent', suggestion: '原预计用时超过距截止的时间，建议先缩小范围或调整截止安排' }
  }
  const tone = remaining !== undefined && remaining <= DAY ? 'urgent' : expected === undefined || (expected !== undefined && spent >= expected * MINUTE) ? 'attention' : 'neutral'
  if (expected !== undefined && spent >= expected * MINUTE) {
    return { effortLabel, evidence, tone, suggestion: '累计专注已达到原估时，先核对进度，再调整预计用时' }
  }
  if (expected === undefined) {
    return { effortLabel, evidence, tone, suggestion: `先补一个用时估计，也可以先用 ${minutesLabel(focus)} 探索第一步` }
  }
  const rounds = Math.ceil(expected / focus)
  const suggestion = rounds > 1
    ? `原估时约合 ${rounds} 段专注，先推进 ${minutesLabel(focus)}，再核对进度`
    : `先留出 ${minutesLabel(Math.min(expected, focus))} 推进这一项，再核对进度`
  return { effortLabel, evidence, tone, suggestion }
}

export function buildWorkbenchBriefing(tasks: readonly Task[], now: Date, focusMin: number, getSpentMs: (id: string) => number): WorkbenchBriefing {
  if (!Number.isFinite(now.getTime())) {
    return { availableCount: 0, dueSoonCount: 0, overdueCount: 0, completedTodayCount: 0, estimatedMin: 0, unestimatedCount: 0, recommendation: null, notices: [] }
  }
  const { available, completed } = taskGroups(tasks, now)
  const open = tasks.filter(isOpenTask)
  const deadlines = upcomingDeadlines(tasks, now)
  const today = localDay(now)
  const recommended = available[0]
  const focus = focusLength(focusMin)
  const context = recommended ? deadlineContext(recommended, now, focus, getSpentMs) : undefined
  const notices: BriefingNotice[] = []
  const overEstimate = open.filter(task => {
    const expected = estimate(task)
    return expected !== undefined && spentTime(task, getSpentMs) >= expected * MINUTE
  })
  if (overEstimate.length) {
    notices.push({ id: 'review-estimates', title: `${overEstimate.length} 项值得核对进度`, body: '累计专注已达到原估时，可以打开事项确认剩余工作', taskIds: overEstimate.map(task => task.id) })
  }
  const unestimated = available.filter(task => estimate(task) === undefined)
  if (unestimated.length) {
    notices.push({ id: 'missing-estimates', title: `${unestimated.length} 项用时待估`, body: '暂未计入简报的已估用时，专注时长仍可自行调整', taskIds: unestimated.map(task => task.id) })
  }
  const unconfirmed = open.filter(task => deadlineTime(task.due) === undefined)
  if (unconfirmed.length) {
    notices.push({ id: 'missing-deadlines', title: `${unconfirmed.length} 项没有明确截止`, body: '这些事项仍保留在任务区，暂时不出现在 Upcoming', taskIds: unconfirmed.map(task => task.id) })
  }
  return {
    availableCount: available.length,
    dueSoonCount: deadlines.filter(item => item.deadlineMs > now.getTime() && item.deadlineMs - now.getTime() <= DAY).length,
    overdueCount: deadlines.filter(item => item.urgency === 'overdue').length,
    completedTodayCount: completed.filter(task => {
      const done = agendaDate(task.doneAt)
      return done !== undefined && localDay(done) === today
    }).length,
    estimatedMin: available.reduce((total, task) => total + (estimate(task) ?? 0), 0),
    unestimatedCount: unestimated.length,
    recommendation: recommended && context ? {
      task: recommended,
      headline: `先推进「${recommended.title}」`,
      summary: context.suggestion,
      evidence: [recommendationReason(recommended, now), ...context.evidence],
      suggestedMin: Math.min(estimate(recommended) ?? focus, focus),
    } : null,
    notices: notices.slice(0, 2),
  }
}
