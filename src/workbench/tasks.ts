import type { Task } from '../domain/task'
import { SEED_AREAS } from '../domain/task'
import { agendaDate, isOpenTask, localDay } from '../home/agenda'
import { deadlineTime } from './deadlines'

function isOverdue(task: Task, now: Date) {
  return (deadlineTime(task.due) ?? Infinity) <= now.getTime()
}

export function taskGroups(tasks: readonly Task[], now: Date) {
  const today = localDay(now)
  const later: Task[] = [], available: Task[] = []
  for (const task of tasks.filter(isOpenTask)) {
    const start = agendaDate(task.startAt)
    const due = agendaDate(task.due)
    const future = start ? localDay(start) > today : due ? localDay(due) > today : task.fuzzyWindow === 'someday'
    ;(future && task.status !== 'doing' && !(task.fuzzyWindow === 'today' && !start) && !(due && localDay(due) <= today) ? later : available).push(task)
  }
  const sort = (a: Task, b: Task) => Number(isOverdue(b, now)) - Number(isOverdue(a, now))
    || Number(b.status === 'doing') - Number(a.status === 'doing')
    || (deadlineTime(a.due) ?? Infinity) - (deadlineTime(b.due) ?? Infinity)
    || b.importance - a.importance || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)
  available.sort(sort); later.sort(sort)
  const completed = tasks.filter(task => !task.deletedAt && task.status === 'done')
    .sort((a, b) => (b.doneAt ?? b.updatedAt).localeCompare(a.doneAt ?? a.updatedAt))
  return { available, later, completed }
}

export function recommendationReason(task: Task, now: Date) {
  if (isOverdue(task, now)) return '已过截止时间，先处理这一项'
  if (task.status === 'doing') return '接着上次的进度，少一次切换'
  if (deadlineTime(task.due) !== undefined) return '截止时间更近，先留出这一段时间'
  if (task.importance === 3) return '优先级较高，适合先开始'
  return '从已收下的事项里，先推进这一项'
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
    { ...base, id: 'preview-physics', title: '整理物理实验报告', area: 'phy2', due: new Date(now.getTime() + 3 * 60 * 60_000).toISOString(), fuzzyWindow: 'today', estimateMin: 70, notes: '先复核实验数据，再写出误差分析和结论' },
    { ...base, id: 'preview-reading', title: '读完今天的英文材料', area: 'english', due: today, fuzzyWindow: 'today', estimateMin: 35, notes: '标出论点和支持它的两条证据' },
    { ...base, id: 'preview-math', title: '把两道错题重新做一遍', area: 'math', fuzzyWindow: 'today', estimateMin: 25, notes: '先不看答案，保留完整过程' },
    { ...base, id: 'preview-project', title: '梳理个人项目的下一步', area: 'project-moss', estimateMin: 20, notes: '只选一个今天能够推进的小步骤' },
    { ...base, id: 'preview-future', title: '准备明天的小组讨论', due: localDay(tomorrow), startAt: localDay(tomorrow), estimateMin: 30 },
    { ...base, id: 'preview-overdue', title: '补交社团活动记录', due: afterDays(-1), estimateMin: 15, notes: '核对活动时间和参与记录' },
    { ...base, id: 'preview-week', title: '整理项目阶段进展', due: afterDays(5), startAt: afterDays(3), estimateMin: 45, area: 'project-moss' },
    { ...base, id: 'preview-done', title: '整理课堂笔记', status: 'done', doneAt: stamp },
  ]
}
