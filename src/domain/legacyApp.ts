import { agendaDate, localDay } from '../home/agenda'
import type { Weekday } from './schedule'

const WEEKDAY_LABELS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const
const WORKDAYS: Weekday[] = ['周一', '周二', '周三', '周四', '周五']

/** The legacy app uses the same local calendar-day key as the spatial home. */
export function localDateKey(date: Date): string {
  return localDay(date)
}

/** Returns null on weekends because the built-in timetable has no weekend rows. */
export function weekdayForDate(date: Date): Weekday | null {
  const label = WEEKDAY_LABELS[date.getDay()]
  return WORKDAYS.includes(label as Weekday) ? label as Weekday : null
}

export function weekdayLabel(date: Date): (typeof WEEKDAY_LABELS)[number] {
  return WEEKDAY_LABELS[date.getDay()]
}

export function legacyDateHeading(date: Date) {
  return `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · ${weekdayLabel(date)}`
}

export type LegacyWeekDay = { label: Weekday; date: number; isToday: boolean }

/** Monday through Friday for the week containing the supplied local date. */
export function legacyWeekDays(date: Date): LegacyWeekDay[] {
  const mondayOffset = (date.getDay() + 6) % 7
  const monday = new Date(date.getFullYear(), date.getMonth(), date.getDate() - mondayOffset, 12)
  return WORKDAYS.map((label, index) => {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index, 12)
    return { label, date: day.getDate(), isToday: localDateKey(day) === localDateKey(date) }
  })
}

export function calendarTaskMatches(due: string | undefined, year: number, month: number, day: number): boolean {
  const date = agendaDate(due)
  return Boolean(date && date.getFullYear() === year && date.getMonth() === month && date.getDate() === day)
}

export function calendarEventMatches(startDate: string, endDate: string, year: number, month: number, day: number): boolean {
  const start = agendaDate(startDate)
  const end = agendaDate(endDate)
  const target = new Date(year, month, day, 12)
  return Boolean(start && end && start.getTime() <= target.getTime() && target.getTime() <= end.getTime())
}
