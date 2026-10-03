import type { DayException, PlannerState } from './types'

export const exceptionLabels: Record<DayException['kind'], string> = {
  holiday: '假期', cancelled: '临时停课', rescheduled: '临时调课', restored: '已恢复原安排',
}

const weekdays = ['日', '一', '二', '三', '四', '五', '六']

export function dayExceptionLabel(state: PlannerState, date: string): string {
  const exception = state.dayExceptions?.[date]
  if (exception) return `${exceptionLabels[exception.kind]}${exception.kind === 'rescheduled' ? ` · 周${weekdays[exception.sourceWeekday ?? 0]}课表` : ''}`
  const override = state.dayOverrides?.[date]
  return override ? `临时按周${weekdays[override.sourceWeekday]}课表` : ''
}
