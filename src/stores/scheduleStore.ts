import type { Assignment, AssignmentFeedback, AssignmentStatus } from '../domain/schedule'
import { localApi } from '../xixi/api'
import { ensureLocalMigration, notifyLocalDataChange } from './migration'

export type DailyAvailability = { date: string; until: string; updatedAt: string }
type AssignmentInput = { taskId: string; blockId: string; plannedMin: number; reason: string; status?: AssignmentStatus; feedback?: AssignmentFeedback }
export interface ScheduleStore {
  getAvailability(date: string): Promise<DailyAvailability | null>
  saveAvailability(date: string, until: string): Promise<DailyAvailability>
  saveAssignment(input: AssignmentInput): Promise<Assignment>
  listAssignments(): Promise<Assignment[]>
}
export class LocalScheduleStore implements ScheduleStore {
  async getAvailability(date: string) {
    await ensureLocalMigration()
    return localApi<DailyAvailability | null>(`/availability?date=${encodeURIComponent(date)}`)
  }
  async saveAvailability(date: string, until: string) {
    await ensureLocalMigration()
    const availability = await localApi<DailyAvailability>('/availability', { date, until })
    notifyLocalDataChange()
    return availability
  }
  async saveAssignment(input: AssignmentInput) {
    await ensureLocalMigration()
    const assignment = await localApi<Assignment>('/assignments', input)
    notifyLocalDataChange()
    return assignment
  }
  async listAssignments() {
    await ensureLocalMigration()
    return localApi<Assignment[]>('/assignments')
  }
}
export const scheduleStore: ScheduleStore = new LocalScheduleStore()
