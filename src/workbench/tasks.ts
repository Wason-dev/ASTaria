import type { Task } from '../domain/task'
import { SEED_AREAS } from '../domain/task'
import { agendaDate, isOpenTask, localDay } from '../home/agenda'
import { deadlineTime } from './deadlines'
import type { PlanBlock } from '../planner/types'
import { minuteOf } from '../planner/model'

export type WorkbenchSchedule = Pick<PlanBlock, 'taskId' | 'date' | 'start' | 'end'> & { id?: string }

function isOverdue(task: Task, now: Date) {
  return (deadlineTime(task.due) ?? Infinity) <= now.getTime()
}

function blockMinutes(block: WorkbenchSchedule) {
  const start = minuteOf(block.start), end = minuteOf(block.end)
  return Number.isFinite(start) && Number.isFinite(end) && start < 1440 && end > start ? { start, end } : undefined
}

function validBlocks(task: Task, blocks: readonly WorkbenchSchedule[], completedFreeTimeSessions: Readonly<Record<string, string>> = {}) {
  return blocks.filter(block => block.taskId === task.id && /^\d{4}-\d{2}-\d{2}$/u.test(block.date) && agendaDate(block.date) && blockMinutes(block))
    .filter(block => !task.freeTimeGoalId || (typeof block.id === 'string' && block.id.length > 0
      && !(Object.hasOwn(completedFreeTimeSessions, block.id) && typeof completedFreeTimeSessions[block.id] === 'string')))
}

/** Return the most relevant concrete planner block for a task. */
export function taskSchedule(task: Task, now: Date, blocks: readonly WorkbenchSchedule[] = [], completedFreeTimeSessions: Readonly<Record<string, string>> = {}): WorkbenchSchedule | undefined {
  const today = localDay(now), minute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000
  const candidates = validBlocks(task, blocks, completedFreeTimeSessions).filter(block => !task.freeTimeGoalId || block.date >= today)
  if (!candidates.length) return undefined
  return [...candidates].sort((a, b) => {
    const aTime = blockMinutes(a)!, bTime = blockMinutes(b)!
    const rank = (block: WorkbenchSchedule, time: { start: number; end: number }) => {
      if (block.date === today && time.start <= minute && minute < time.end) return 0
      // An unfinished session from today can still be done today. Historical
      // sessions do not turn an ongoing goal into an accumulating overdue task.
      if (task.freeTimeGoalId && block.date === today && time.end <= minute) return 1
      if (block.date === today && time.start > minute) return task.freeTimeGoalId ? 2 : 1
      if (block.date > today) return task.freeTimeGoalId ? 3 : 2
      return 3
    }
    const aRank = rank(a, aTime), bRank = rank(b, bTime)
    return aRank - bRank || (!task.freeTimeGoalId && aRank === 3
      ? b.date.localeCompare(a.date) || bTime.end - aTime.end || bTime.start - aTime.start
      : a.date.localeCompare(b.date) || aTime.start - bTime.start || aTime.end - bTime.end)
  })[0]
}

/**
 * Workbench readiness follows concrete planner blocks when present. A block
 * becomes visible twenty minutes before its start (inclusive), remains visible
 * while running. A task with another future block waits for that block; if all
 * blocks ended, unfinished work stays visible to resume. Future-day blocks stay
 * in later until their day arrives. A deadline alone never delays availability;
 * future start-date intentions and someday tasks still remain in later.
 */
/** Explicit semantic type, independent from whether the work is scheduled.
 * Unknown legacy records are not classified by words in their title. */
export function isDateMarker(task: Task) {
  return task.kind === 'reminder'
}

export function taskGroups(tasks: readonly Task[], now: Date, blocks: readonly WorkbenchSchedule[] = [], completedFreeTimeSessions: Readonly<Record<string, string>> = {}) {
  const today = localDay(now), currentMinute = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60 + now.getMilliseconds() / 60000
  const later: Task[] = [], available: Task[] = []
  for (const task of tasks.filter(task => isOpenTask(task))) {
    if (isDateMarker(task)) continue
    if (task.relations?.some(relation => relation.kind === 'task' && relation.relation === 'after' && tasks.find(item => item.id === relation.id)?.status !== 'done')) { later.push(task); continue }
    const schedule = taskSchedule(task, now, blocks, completedFreeTimeSessions)
    // Long-running free-time goals enter the workbench through persisted sessions;
    // an unscheduled backing task remains in the goal workflow.
    if (task.freeTimeGoalId && !schedule) continue
    const start = agendaDate(task.startAt)
    const due = agendaDate(task.due)
    const unclassifiedDate = task.source === 'ai' && !task.kind && Boolean(task.due) && !task.estimateMin && !schedule && task.status !== 'doing'
    const futureDate = start ? localDay(start) > today : task.fuzzyWindow === 'someday'
    const shouldWait = unclassifiedDate || (schedule
      ? schedule.date > today || (schedule.date === today && currentMinute < blockMinutes(schedule)!.start - 20)
      : start && task.startAt?.includes('T')
        ? localDay(start) > today || now.getTime() < start.getTime() - 20 * 60000
        : futureDate && task.status !== 'doing' && !(task.fuzzyWindow === 'today' && !start) && !(due && localDay(due) <= today))
    ;(shouldWait ? later : available).push(task)
  }
  const activeNow = (task: Task) => validBlocks(task, blocks, completedFreeTimeSessions).some(block => block.date === today && blockMinutes(block)!.start <= currentMinute && currentMinute < blockMinutes(block)!.end)
  const sort = (a: Task, b: Task) => Number(activeNow(b)) - Number(activeNow(a))
    || Number(isOverdue(b, now)) - Number(isOverdue(a, now))
    || Number(b.status === 'doing') - Number(a.status === 'doing')
    || (deadlineTime(a.due) ?? Infinity) - (deadlineTime(b.due) ?? Infinity)
    || b.importance - a.importance || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  available.sort(sort); later.sort(sort)
  const completed = tasks.filter(task => !task.deletedAt && task.status === 'done')
    .sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt))
  return { available, later, completed }
}

export function scheduleDisplay(block: WorkbenchSchedule, now: Date) {
  const date = agendaDate(block.date)
  if (!date) return `安排 ${block.start}–${block.end}`
  const day = localDay(date) === localDay(now) ? '今天' : localDay(date) === localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) ? '明天' : `${date.getFullYear() !== now.getFullYear() ? `${date.getFullYear()}年` : ''}${date.getMonth() + 1}月${date.getDate()}日`
  return `${day} ${block.start}–${block.end}`
}

export function scheduleStatusLabel(block: WorkbenchSchedule, now: Date): string | undefined {
  if (block.date < localDay(now)) return '原安排已结束，可继续'
  if (block.date > localDay(now)) return undefined
  const times = blockMinutes(block)
  if (!times) return undefined
  const minute = now.getHours() * 60 + now.getMinutes()
  if (minute >= times.start && minute < times.end) return '当前安排，可以开始'
  if (minute < times.start) return minute >= times.start - 20 ? '即将开始' : '按日历时段开始'
  return '原安排已结束，可继续'
}

/** A factual fallback label, never a comparative or model-authored reason. */
export function recommendationReason(task: Task, now: Date) {
  if (isOverdue(task, now)) return '已过截止时间'
  if (task.status === 'doing') return '进行中'
  if (deadlineTime(task.due) !== undefined) return `截止 ${task.due!.slice(0, 10).replaceAll('-', '/')}`
  if (task.due) return '截止日期待确认'
  return task.estimateMin ? `预计 ${task.estimateMin} 分钟` : '尚未估时'
}

export function taskArea(task: Task) {
  return SEED_AREAS.find(area => area.id === task.area)?.name ?? (task.area ? '其他分类' : '未分类')
}

/** Preview examples never enter the task store. */
export function previewTasks(now: Date): Task[] {
  const stamp = now.toISOString(), today = localDay(now)
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1)
  const afterDays = (count: number) => { const date = new Date(now); date.setDate(date.getDate() + count); return localDay(date) }
  const base: Task = { id: '', title: '', area: null, source: 'manual', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo', createdAt: stamp, updatedAt: stamp, deletedAt: null }
  return [
    { ...base, id: 'preview-physics', title: '整理物理实验报告', area: 'physics', due: new Date(now.getTime() + 3 * 60 * 60_000).toISOString(), fuzzyWindow: 'today', estimateMin: 70, notes: '先复核实验数据，再写出误差分析和结论' },
    { ...base, id: 'preview-reading', title: '读完今天的英文材料', area: 'english', due: today, fuzzyWindow: 'today', estimateMin: 35, notes: '标出论点和支持它的两条证据' },
    { ...base, id: 'preview-math', title: '把两道错题重新做一遍', area: 'math', fuzzyWindow: 'today', estimateMin: 25, notes: '先不看答案，保留完整过程' },
    { ...base, id: 'preview-project', title: '梳理个人项目的下一步', area: 'projects', estimateMin: 20, notes: '只选一个今天能够推进的小步骤' },
    { ...base, id: 'preview-future', title: '准备明天的小组讨论', due: localDay(tomorrow), startAt: localDay(tomorrow), estimateMin: 30 },
    { ...base, id: 'preview-overdue', title: '补交社团活动记录', due: afterDays(-1), estimateMin: 15, notes: '核对活动时间和参与记录' },
    { ...base, id: 'preview-week', title: '整理项目阶段进展', due: afterDays(5), startAt: afterDays(3), estimateMin: 45, area: 'projects' },
    { ...base, id: 'preview-done', title: '整理课堂笔记', status: 'done', doneAt: stamp },
  ]
}
