import type { Routine } from './types.ts'

const DAY = 86_400_000
/** Calendar arithmetic uses date-only UTC values, avoiding DST and ISO-year parity. */
export function weekStart(date: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return undefined
  const value = new Date(`${date}T12:00:00Z`)
  if (!Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) return undefined
  value.setUTCDate(value.getUTCDate() - (value.getUTCDay() + 6) % 7)
  return value.toISOString().slice(0, 10)
}

export function routineOccursOn(routine: Pick<Routine, 'enabled' | 'weekdays' | 'weekCycle' | 'weekAnchor'>, date: string, weekday?: number) {
  const monday = weekStart(date)
  if (!routine.enabled || !monday || !routine.weekdays.includes(weekday ?? new Date(`${date}T12:00:00Z`).getUTCDay())) return false
  if (!routine.weekCycle || routine.weekCycle === 'weekly') return true
  const anchor = routine.weekAnchor && weekStart(routine.weekAnchor)
  if (!anchor || !['odd', 'even'].includes(routine.weekCycle)) return false
  const week = Math.round((Date.parse(monday) - Date.parse(anchor)) / (7 * DAY))
  return ((week % 2) + 2) % 2 === (routine.weekCycle === 'odd' ? 0 : 1)
}

export function weekCycleLabel(routine: Pick<Routine, 'weekCycle'>) {
  return routine.weekCycle === 'odd' ? '单周' : routine.weekCycle === 'even' ? '双周' : '每周'
}
