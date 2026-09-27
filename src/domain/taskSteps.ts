export type TaskStep = {
  id: string
  title: string
  detail?: string
  doneAt?: string
}

const fields = new Set(['id', 'title', 'detail', 'doneAt'])
const nonempty = (value: unknown, max: number): value is string => typeof value === 'string'
  && value.length <= max && value.trim().length > 0 && value === value.trim()

function completionTime(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/u.test(value)) return false
  const day = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(Date.parse(value)) && Number.isFinite(day.getTime())
    && day.toISOString().slice(0, 10) === value.slice(0, 10)
}

/** Legacy subSteps stay in storage; only unambiguous checklist records are shown. */
export function isTaskStep(value: unknown): value is TaskStep {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const step = value as Record<string, unknown>
  return Object.keys(step).every(key => fields.has(key))
    && nonempty(step.id, 200) && !/[\u0000-\u001f\u007f]/u.test(step.id)
    && nonempty(step.title, 160)
    && (step.detail === undefined || (typeof step.detail === 'string' && step.detail.length <= 600))
    && (step.doneAt === undefined || completionTime(step.doneAt))
}

export function taskSteps(task: { subSteps?: unknown[] }): TaskStep[] {
  if (!Array.isArray(task.subSteps)) return []
  const steps = task.subSteps.filter(isTaskStep)
  const counts = new Map<string, number>()
  for (const step of steps) counts.set(step.id, (counts.get(step.id) ?? 0) + 1)
  return steps.filter(step => counts.get(step.id) === 1)
}
