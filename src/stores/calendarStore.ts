import type { CalendarEvent } from '../domain/calendar'
import { localApi } from '../xixi/api'
import { ensureLocalMigration, notifyLocalDataChange } from './migration'

export interface CalendarStore {
  listEvents(from?: string, to?: string): Promise<CalendarEvent[]>
  createEvent(input: Omit<CalendarEvent, 'id' | 'updatedAt' | 'deletedAt'>): Promise<CalendarEvent>
  deleteEvent(id: string): Promise<void>
}
export class LocalCalendarStore implements CalendarStore {
  async listEvents(from?: string, to?: string) {
    await ensureLocalMigration()
    const query = new URLSearchParams()
    if (from) query.set('from', from)
    if (to) query.set('to', to)
    return localApi<CalendarEvent[]>(`/events?${query}`)
  }
  async createEvent(input: Omit<CalendarEvent, 'id' | 'updatedAt' | 'deletedAt'>) {
    await ensureLocalMigration()
    const event = await localApi<CalendarEvent>('/events/create', input)
    notifyLocalDataChange()
    return event
  }
  async deleteEvent(id: string) {
    await ensureLocalMigration()
    await localApi('/events/delete', { id })
    notifyLocalDataChange()
  }
}
export const calendarStore: CalendarStore = new LocalCalendarStore()
