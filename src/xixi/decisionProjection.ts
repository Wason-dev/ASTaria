import type { CompanionScenario, ScenarioPlan } from './companionTypes'

export type DecisionProjection = {
  /** Actual first-week plans. Future repetitions are a conditional calculation only. */
  baseline: ScenarioPlan[]
  candidate: ScenarioPlan[]
  baselineMin: number
  candidateMin: number
  deltaMin: number
  /** Baseline minus candidate: negative means the start day gains work. */
  freedTodayMin: number
  /** Candidate minus baseline: negative means the next day loses work. */
  tomorrowAddedMin: number
  occurrences: number
  conditional: boolean
  unknownEffort: boolean
  /** The last actual candidate date, not an inferred completion date. */
  lastPlannedDate?: string
}

const DAY_MS = 86_400_000

// These are calendar keys, not local instants. UTC keeps their distance stable
// across DST changes and does not change which local date the key represents.
function calendarDay(key: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) return null
  const value = Date.parse(`${key}T00:00:00.000Z`)
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 10) !== key) return null
  return value / DAY_MS
}

function minuteOfDay(time: string): number | null {
  if (time === '24:00') return 1440
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) return null
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}

function allocatedMinutes(plan: ScenarioPlan): number {
  const start = minuteOfDay(plan.start), end = minuteOfDay(plan.end)
  return start === null || end === null ? 0 : Math.max(0, end - start)
}

/** Compare allocated time, never completed work, grades or future outcomes.
 * Offset is inclusive: 0 = the start day, 6 = a full week, 364 = 365 days.
 * A weekly assumption repeats the first seven calendar days without creating
 * extra plans or writing to the real schedule.
 */
export function decisionProjection(scenario: CompanionScenario, offset: number): DecisionProjection {
  const horizon = Number.isFinite(offset) ? Math.max(0, Math.min(365, Math.floor(offset))) : 0
  const firstDay = calendarDay(scenario.date)
  const decision = scenario.decision
  const conditional = decision?.recurrence === 'weekly'
  const occurrences = conditional ? Math.floor(horizon / 7) + 1 : 1
  const unknownEffort = decision?.effortMin == null || !Number.isFinite(decision.effortMin) || decision.effortMin <= 0
  const dayOffset = (plan: ScenarioPlan) => {
    const date = calendarDay(plan.date)
    return date === null || firstDay === null ? -1 : date - firstDay
  }
  const firstWeek = (plans: readonly ScenarioPlan[]) => plans
    .filter(plan => decision && plan.taskId === decision.taskId && dayOffset(plan) >= 0 && dayOffset(plan) < 7 && allocatedMinutes(plan) > 0)
    .map(plan => ({ ...plan }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.start.localeCompare(b.start) || a.id.localeCompare(b.id))

  const baseline = firstWeek(decision?.baseline ?? [])
  const removed = new Set(scenario.removedBlockIds)
  // Locked or started plans are absent from removedBlockIds, so remain in the
  // candidate even when the selected strategy asks to postpone the task.
  const candidate = firstWeek([...baseline.filter(plan => !removed.has(plan.id)), ...scenario.plans])
  const projectedMinutes = (plans: ScenarioPlan[]) => plans.reduce((total, plan) => {
    const distance = dayOffset(plan)
    if (distance > horizon) return total
    const count = conditional ? Math.floor((horizon - distance) / 7) + 1 : 1
    return total + allocatedMinutes(plan) * count
  }, 0)
  const onDay = (plans: ScenarioPlan[], day: number) => plans.reduce((total, plan) => total + (dayOffset(plan) === day ? allocatedMinutes(plan) : 0), 0)
  const baselineMin = projectedMinutes(baseline), candidateMin = projectedMinutes(candidate)
  const lastPlannedDate = candidate.at(-1)?.date

  return {
    baseline, candidate, baselineMin, candidateMin,
    deltaMin: candidateMin - baselineMin,
    freedTodayMin: onDay(baseline, 0) - onDay(candidate, 0),
    tomorrowAddedMin: onDay(candidate, 1) - onDay(baseline, 1),
    occurrences, conditional, unknownEffort,
    ...(lastPlannedDate ? { lastPlannedDate } : {}),
  }
}
