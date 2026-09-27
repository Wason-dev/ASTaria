export type CalendarEventKind = 'exam-week' | 'holiday' | 'institution' | 'activity' | 'other'
export type CalendarEvent = {
  id: string
  title: string
  kind: CalendarEventKind
  startDate: string
  endDate: string
  allDay: true
  source: 'manual' | 'school' | 'ai' | 'import'
  affectsScheduling: boolean
  note?: string
  updatedAt: string
  deletedAt: string | null
}
