const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const strings = (value: Record<string, unknown>, keys: string[]) => keys.every(key => typeof value[key] === 'string')
const task = (value: unknown) => record(value) && strings(value, ['id', 'title', 'status', 'createdAt', 'updatedAt']) && Array.isArray(value.context)

/** Guard the shared boot/poll payloads before consumers dereference their fields. */
export function validLocalResponse(path: string, value: unknown): boolean {
  const endpoint = path.replace(/^\/api/, '').split('?')[0]
  if (endpoint === '/tasks') return Array.isArray(value) && value.every(task)
  if (/^\/tasks\/[^/]+$/.test(endpoint) && !['/tasks/delete'].includes(endpoint)) return value === null || task(value)
  if (endpoint === '/areas') return Array.isArray(value) && value.every(item => record(item) && strings(item, ['id', 'name']))
  if (endpoint === '/status') return record(value) && typeof value.configured === 'boolean' && typeof value.model === 'string'
  if (endpoint === '/planner') return record(value) && Number.isInteger(value.revision) && Array.isArray(value.routines)
    && value.routines.every(item => record(item) && strings(item, ['id', 'title', 'start', 'end']) && Array.isArray(item.weekdays))
    && Array.isArray(value.blocks) && value.blocks.every(item => record(item) && strings(item, ['id', 'taskId', 'date', 'start', 'end']))
    && record(value.details) && record(value.checked)
  if (endpoint === '/preferences') return record(value) && ['focus', 'assistant', 'render', 'notifications', 'effect', 'scheduling'].every(key => record(value[key]))
    && record(value.focus) && Number.isFinite(value.focus.focusMin) && Number.isFinite(value.focus.restMin)
  return true
}
