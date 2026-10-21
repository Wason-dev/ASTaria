import { knownKeys, ValidationError } from '../../server/validation.mjs'

const changesReminders = path => path === '/api/chat' || path === '/api/preferences' || path === '/api/planner'
  || path === '/api/data/import' || /^\/api\/(?:tasks|events|operations|companion)\//u.test(path)

/** Acknowledged database mutations and foreground events replace reservations.
 * Reads never introduce a polling timer or ask for notification permission. */
export function mobilePlatformRequests({ call, reminders, updateStatus }) {
  const refresh = () => { void reminders.scheduleRefresh().catch(() => {}) }
  return async (path, input, options = {}) => {
    if (path === '/api/desktop/updates' && input === undefined) return updateStatus()
    if (path === '/api/desktop/reminders' && input === undefined) return reminders.status()
    if (path === '/api/desktop/reminders/enabled' && input !== undefined) {
      knownKeys(input, ['enabled'])
      if (typeof input.enabled !== 'boolean') throw new ValidationError('提醒开关状态不正确')
      return reminders.setEnabled(input.enabled)
    }
    if (['/api/desktop/reminders/refresh', '/api/desktop/reminders/test'].includes(path) && input !== undefined) {
      knownKeys(input, [])
      return path.endsWith('/test') ? reminders.test() : reminders.refresh()
    }
    const onEvent = options.onEvent ? event => {
      // The session emits a completed activity only after a durable checkpoint.
      if (event.type === 'operations' || (event.type === 'activity' && event.activity?.state === 'done' && event.activity?.id?.startsWith('tool:'))) refresh()
      options.onEvent(event)
    } : undefined
    const value = await call(path, input, { ...options, onEvent })
    if (input !== undefined && changesReminders(path.split('?')[0])) refresh()
    return value
  }
}
