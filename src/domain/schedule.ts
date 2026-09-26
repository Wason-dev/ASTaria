import type { Task } from './task'

export type Weekday = '周一' | '周二' | '周三' | '周四' | '周五'
export type ScheduleSlot = { period: string; start: string; end: string; subject: string; kind: 'class' | 'free' | 'national' | 'blank' }

export const PERIODS: Array<[string, string, string]> = []
export const WEEKDAYS: Weekday[] = ['周一', '周二', '周三', '周四', '周五']

export const weekSchedule = (_day: Weekday): ScheduleSlot[] => []

export type Recommendation = { task: Task; reason: string; slot: ScheduleSlot }
export type AssignmentStatus = 'suggested' | 'accepted' | 'moved' | 'skipped' | 'done'
export type AssignmentFeedback = 'too-hard-now' | 'no-time' | 'not-in-mood' | 'wrong-context'
export type Assignment = { id: string; taskId: string; blockId: string; plannedMin: number; reason: string; status: AssignmentStatus; feedback?: AssignmentFeedback; updatedAt: string }

export function recommendTask(_tasks: Task[], _day: Weekday | null): Recommendation | null {
  return null
}
