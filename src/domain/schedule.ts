import type { Task } from './task'

export type Weekday = '周一' | '周二' | '周三' | '周四' | '周五'
export type ScheduleSlot = { period: string; start: string; end: string; subject: string; kind: 'class' | 'free' | 'national' | 'blank' }

export const PERIODS: Array<[string, string, string]> = [['P0','07:40','07:50'],['P1','08:00','08:40'],['P2','08:45','09:25'],['P3','09:35','10:15'],['P4','10:20','11:00'],['P5','11:05','11:55'],['午休','12:00','12:40'],['P6','12:45','13:25'],['P7','13:30','14:10'],['P8','14:15','14:55'],['P9','15:00','15:40'],['P10','15:45','16:25']]
export const WEEKDAYS: Weekday[] = ['周一', '周二', '周三', '周四', '周五']
const SUBJECTS: Record<Weekday, string[]> = { 周一:['晨会','数学','Bus1','空课','语文','L&L','英语','Phy2','空课','空课','空课','空课'], 周二:['—','地理','英语','空课','空课','空课','空课','英语','英语','艺术','体育','空课'], 周三:['—','Phy2','Phy2','空课','数学','空课','空课','历史','PD','Bus1','信息与技术','信息与技术'], 周四:['—','Phy2','数学','空课','AgenticAI','AgenticAI','英语','心理健康','L&L','物理','空课','空课'], 周五:['—','语文','空课','空课','数学','思想政治','体育','Class Meeting','空课','空课','空课','空课'] }
const NATIONAL = new Set(['地理','语文','历史','艺术','体育','思想政治','信息与技术','物理'])

export const weekSchedule = (day: Weekday): ScheduleSlot[] => SUBJECTS[day].map((subject, index) => { const [period, start, end] = PERIODS[index]; const kind = subject === '空课' ? 'free' : subject === '—' ? 'blank' : NATIONAL.has(subject) ? 'national' : 'class'; return { period, start, end, subject, kind } })

export type Recommendation = { task: Task; reason: string; slot: ScheduleSlot }
export type AssignmentStatus = 'suggested' | 'accepted' | 'moved' | 'skipped' | 'done'
export type AssignmentFeedback = 'too-hard-now' | 'no-time' | 'not-in-mood' | 'wrong-context'
export type Assignment = { id: string; taskId: string; blockId: string; plannedMin: number; reason: string; status: AssignmentStatus; feedback?: AssignmentFeedback; updatedAt: string }

export function recommendTask(tasks: Task[], day: Weekday): Recommendation | null {
  const free = weekSchedule(day).filter((slot) => slot.kind === 'free' && (day !== '周四' || tasks.some((task) => task.energy === 'light')))
  const candidates = tasks.filter((task) => task.status === 'todo' && !task.inbox && task.estimateMin && (!task.context.some((tag) => tag === 'desk-4090' || tag === 'desk-mac' || tag === 'physical'))).sort((a, b) => (b.importance - a.importance) || ((a.due ?? '9999').localeCompare(b.due ?? '9999')))
  const task = candidates.find((item) => day !== '周四' || item.energy === 'light')
  if (!task || !free.length) return null
  const slot = free.find((item) => Number(item.end.slice(0, 2)) * 60 + Number(item.end.slice(3)) - (Number(item.start.slice(0, 2)) * 60 + Number(item.start.slice(3))) >= (task.estimateMin ?? 0)) ?? free[0]
  const dueReason = task.due ? `，DDL 是 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(new Date(task.due))}` : ''
  return { task, slot, reason: `${slot.period} ${slot.start}–${slot.end} 有空${dueReason}，先用这一块推进它。` }
}
