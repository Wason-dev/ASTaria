import Dexie, { type Table } from 'dexie'
import type { CalendarEvent } from '../domain/calendar'

class CalendarDatabase extends Dexie {
  events!: Table<CalendarEvent, string>
  constructor() { super('astaria-calendar'); this.version(1).stores({ events: 'id, startDate, endDate, kind, updatedAt, deletedAt' }) }
}
const db = new CalendarDatabase()
export interface CalendarStore { listEvents(from?: string, to?: string): Promise<CalendarEvent[]>; createEvent(input: Omit<CalendarEvent, 'id' | 'updatedAt' | 'deletedAt'>): Promise<CalendarEvent>; deleteEvent(id: string): Promise<void> }
export class LocalCalendarStore implements CalendarStore {
  async listEvents(from?: string, to?: string) { const rows = await db.events.toArray(); return rows.filter((event) => !event.deletedAt && (!from || event.endDate >= from) && (!to || event.startDate <= to)).sort((a,b)=>a.startDate.localeCompare(b.startDate)).map((event)=>structuredClone(event)) }
  async createEvent(input: Omit<CalendarEvent, 'id' | 'updatedAt' | 'deletedAt'>) { const event: CalendarEvent = { ...input, id: crypto.randomUUID(), updatedAt: new Date().toISOString(), deletedAt: null }; await db.events.add(event); return structuredClone(event) }
  async deleteEvent(id: string) { const event = await db.events.get(id); if (event) await db.events.put({ ...event, deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }) }
}
export const calendarStore: CalendarStore = new LocalCalendarStore()
