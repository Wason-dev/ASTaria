import type { Task } from '../domain/task.ts'

export type RoutineKind = 'class' | 'available' | 'break'
export type Routine = {
  id: string; title: string; kind: RoutineKind; weekdays: number[]
  start: string; end: string; location: string; items: string[]; enabled: boolean
}
/** A weekday snapshot; manual template saves refresh future dates, assistant edits require explicit synchronization. */
export type DayTemplateOverride = { date: string; sourceWeekday: number; routines: Routine[] }
export type WeekdayRoutineReplacement = {
  routineId: string; title: string; kind: RoutineKind; location?: string; items?: string[]
}
export type PlanBlock = { id: string; taskId: string; date: string; start: string; end: string; locked: boolean }
export type TaskPreparation = {
  items: string[]; preparation: string; needsSubmission: boolean; submittedAt: string | null
}
export type PlannerState = {
  revision: number; timetableConfirmed: boolean; routines: Routine[]; blocks: PlanBlock[]
  details: Record<string, TaskPreparation>; checked: Record<string, string[]>
  dayOverrides?: Record<string, DayTemplateOverride>
}
export type PlannerAction =
  | { type: 'save-routine'; routine: Routine }
  | { type: 'delete-routine'; id: string }
  | { type: 'import-routines'; routines: Routine[] }
  | { type: 'edit-weekday'; weekday: number; replacements: WeekdayRoutineReplacement[]; syncDates: string[] }
  | { type: 'set-day-template'; date: string; sourceWeekday: number }
  | { type: 'remove-day-template'; date: string }
  | { type: 'save-block'; block: PlanBlock }
  | { type: 'delete-block'; id: string }
  | { type: 'save-details'; taskId: string; details: TaskPreparation }
  | { type: 'check-item'; date: string; key: string; checked: boolean }
export type PlannerSnapshot = { state: PlannerState; tasks: Task[] }
export type MinuteRange = { start: number; end: number }
export type DayCapacity = {
  available: MinuteRange[]; free: MinuteRange[]; remaining: MinuteRange[]
  totalMin: number; scheduledMin: number; freeMin: number; remainingMin: number
  longestMin: number; unestimatedCount: number; conflicts: string[]
}
export type CarryItem = { key: string; label: string; sources: string[]; suggested: boolean; checked: boolean }
