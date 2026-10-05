import { routineOccursOn, weekStart } from '../src/planner/weekCycle.ts'
import { holidayRoutinesForDay } from '../src/planner/model.ts'
import { createHash } from 'node:crypto'
import { ValidationError, knownKeys, text, identifier, choice, day, dateTime, clockTime } from './validation.mjs'

const STATE_KEY = 'planner-v1'
const WEEKEND_DEFAULTS_MARKER = 'planner-v1-weekend-defaults-v1'
const WEEKEND_DEFAULT_ROUTINE_ID = 'default-weekend-availability'
const fail = (message, status = 400) => { throw new ValidationError(message, status) }
const activeTask = task => task && !task.deletedAt && ['todo', 'doing'].includes(task.status)
// Completion records time already used; only a dropped/deleted task releases it.
const occupiesTime = task => task && !task.deletedAt && task.status !== 'dropped'
const overlaps = (a, b) => a.start < b.end && b.start < a.end
const limits = { routines: 300, blocks: 3000, details: 5000, checked: 3660, dayOverrides: 3660, dayExceptions: 3660, dayEvents: 3000 }

export function defaultPlanner() {
  return {
    revision: 0, timetableConfirmed: false,
    routines: [
      { id: 'default-evening-study', title: '晚自习', kind: 'available', weekdays: [1, 2, 3, 4, 5], start: '18:00', end: '20:00', location: '学校', items: [], enabled: true },
      { id: WEEKEND_DEFAULT_ROUTINE_ID, title: '周末可安排时间', kind: 'available', weekdays: [0, 6], start: '09:00', end: '22:00', location: '', items: [], enabled: true },
    ],
    blocks: [], details: {}, checked: {}, dayOverrides: {}, dayExceptions: {}, dayEvents: [],
  }
}

function boolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label}必须是布尔值`)
  return value
}
function strings(value, label, count = 100, length = 160) {
  if (!Array.isArray(value) || value.length > count) fail(`${label}最多 ${count} 项`)
  const result = value.map(item => text(item, label, length))
  if (new Set(result).size !== result.length) fail(`${label}不可重复`)
  return result
}
function timeRange(start, end) {
  clockTime(start, '开始时刻'); clockTime(end, '结束时刻')
  if (start >= end) fail('结束时刻应晚于开始时刻，请将跨天安排拆成两天')
}
export function dayEventValue(input) {
  knownKeys(input, ['id', 'title', 'date', 'start', 'end', 'location', 'items'], '单日活动')
  const date = day(input.date)
  timeRange(input.start, input.end)
  localInstant(date, input.start); localInstant(date, input.end)
  return {
    id: identifier(input.id), title: text(input.title, '活动名称', 160), date,
    start: input.start, end: input.end, location: text(input.location, '地点', 160, { empty: true }),
    items: strings(input.items, '携带物品'),
  }
}
export function validateDayEvents(events) {
  // Old planner records and operation receipts have no single-date events.
  if (events === undefined) return
  if (!Array.isArray(events) || events.length > limits.dayEvents) fail('单日活动数量无效或过多')
  const values = events.map(dayEventValue)
  if (new Set(values.map(event => event.id)).size !== values.length) fail('单日活动标识不可重复')
}
function routineValue(input) {
  knownKeys(input, ['id', 'title', 'kind', 'weekdays', 'start', 'end', 'location', 'items', 'enabled', 'weekCycle', 'weekAnchor'], '固定安排')
  timeRange(input.start, input.end)
  const cycle = choice(input.weekCycle, ['weekly', 'odd', 'even'], '重复周次', 'weekly')
  if (cycle !== 'weekly' && (!input.weekAnchor || weekStart(input.weekAnchor) !== input.weekAnchor)) fail('隔周安排需要明确第1周的周一日期')
  if (input.weekAnchor !== undefined && weekStart(input.weekAnchor) !== input.weekAnchor) fail('基准周需要有效的周一日期')
  if (!Array.isArray(input.weekdays) || !input.weekdays.length || input.weekdays.length > 7 || input.weekdays.some(value => !Number.isInteger(value) || value < 0 || value > 6) || new Set(input.weekdays).size !== input.weekdays.length) fail('星期需要互不重复的 0–6，0 表示周日')
  return {
    id: identifier(input.id), title: text(input.title, '安排名称', 160), kind: choice(input.kind, ['class', 'available', 'break'], '安排类型'),
    ...(cycle !== 'weekly' ? { weekCycle: cycle, weekAnchor: input.weekAnchor } : {}),
    weekdays: [...input.weekdays].sort((a, b) => a - b), start: input.start, end: input.end,
    location: text(input.location, '地点', 160, { empty: true }), items: strings(input.items, '携带物品'), enabled: boolean(input.enabled, '启用状态'),
  }
}
function firstWeekValue(value) {
  const date = day(value)
  if (weekStart(date) !== date) fail('第1周需要选择有效的周一日期')
  return date
}
function routineForState(input, state) {
  if (state.firstWeekMonday && ['odd', 'even'].includes(input?.weekCycle)) {
    if (input.weekAnchor !== undefined && input.weekAnchor !== state.firstWeekMonday) fail('单双周安排应使用每周安排中统一的第1周日期')
    return routineValue({ ...input, weekAnchor: state.firstWeekMonday })
  }
  return routineValue(input)
}
function sourceWeekdayValue(value) {
  if (!Number.isInteger(value) || value < 0 || value > 6) fail('来源星期需要是 0–6，0 表示周日')
  return value
}
function weekdayReplacementValue(input) {
  knownKeys(input, ['routineId', 'title', 'kind', 'location', 'items'], '每周课程修改')
  return {
    routineId: identifier(input.routineId, '原安排标识'),
    title: text(input.title, '安排名称', 160),
    kind: choice(input.kind, ['class', 'available', 'break'], '安排类型'),
    ...(Object.hasOwn(input, 'location') ? { location: text(input.location, '地点', 160, { empty: true }) } : {}),
    ...(Object.hasOwn(input, 'items') ? { items: strings(input.items, '携带物品') } : {}),
  }
}
function weekdayRoutineId(originalId, weekday, usedIds) {
  // The bounded digest supports even a maximum-length original identifier.
  const base = `weekday-${weekday}-${createHash('sha256').update(originalId).digest('hex').slice(0, 24)}`
  let id = base, suffix = 0
  while (usedIds.has(id)) id = `${base}-${++suffix}`
  usedIds.add(id)
  return id
}
function validateDayOverrides(overrides) {
  // Older planner records and undo receipts predate this optional field.
  if (overrides === undefined) return
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > limits.dayOverrides) fail('单日调课记录无效或数量过多')
  for (const [date, override] of Object.entries(overrides)) {
    day(date)
    knownKeys(override, ['date', 'sourceWeekday', 'routines'], '单日调课')
    if (day(override.date) !== date) fail('单日调课日期与记录日期不一致')
    const sourceWeekday = sourceWeekdayValue(override.sourceWeekday)
    if (!Array.isArray(override.routines) || !override.routines.length || override.routines.length > limits.routines) fail('单日调课安排数量无效')
    if (new Set(override.routines.map(item => item?.id)).size !== override.routines.length) fail('单日调课安排标识重复')
    const routines = override.routines.map(routineValue)
    if (routines.some(routine => !routine.enabled || !routine.weekdays.includes(sourceWeekday)) || !routines.some(routine => routine.kind === 'class')) fail('单日调课需要有效的来源课程快照')
  }
}
export function validateDayExceptions(exceptions) {
  if (exceptions === undefined) return
  if (!exceptions || typeof exceptions !== 'object' || Array.isArray(exceptions) || Object.keys(exceptions).length > limits.dayExceptions) fail('日历例外记录无效或数量过多')
  for (const [date, exception] of Object.entries(exceptions)) {
    day(date)
    knownKeys(exception, ['date', 'kind', 'sourceWeekday', 'routines'], '日历例外')
    if (day(exception.date) !== date) fail('日历例外日期不一致')
    choice(exception.kind, ['holiday', 'cancelled', 'rescheduled', 'restored'], '日历例外类型')
    if (exception.kind === 'rescheduled') {
      sourceWeekdayValue(exception.sourceWeekday)
      if (!Array.isArray(exception.routines) || exception.routines.length > limits.routines) fail('调课快照无效')
      if (new Set(exception.routines.map(item => item?.id)).size !== exception.routines.length) fail('调课快照标识重复')
      for (const routine of exception.routines) routineValue(routine)
    } else if (exception.kind === 'holiday') {
      if (exception.sourceWeekday !== undefined) fail('假期不应包含来源课表')
      if (exception.routines !== undefined) {
        if (!Array.isArray(exception.routines) || exception.routines.length > limits.routines) fail('假期空档快照无效')
        if (new Set(exception.routines.map(item => item?.id)).size !== exception.routines.length) fail('假期空档标识重复')
        for (const routine of exception.routines) {
          if (routineValue(routine).kind === 'class') fail('假期空档不能包含课程')
        }
      }
    } else if (exception.sourceWeekday !== undefined || exception.routines !== undefined) fail('该例外不应包含来源课表')
  }
}
function datedRoutines(state, date) {
  const exception = state.dayExceptions?.[date]
  if (exception) return exception.kind === 'rescheduled' ? exception.routines
    : exception.kind === 'holiday' ? exception.routines ?? holidayRoutinesForDay(state, date)
      : exception.kind === 'restored' ? state.routines.filter(routine => routineOccursOn(routine, date)) : []
  return state.dayOverrides?.[date]?.routines ?? state.routines.filter(routine => routineOccursOn(routine, date))
}
function routinesOn(state, date) {
  const routines = datedRoutines(state, date)
  return [...routines, ...(state.dayEvents ?? []).filter(event => event.date === date).map(event => ({ ...event, kind: 'class', enabled: true }))]
}
export function horizonGroupValue(input) {
  if (input.horizonGroupId === undefined && input.horizonGroupTitle === undefined) return {}
  return { horizonGroupId: identifier(input.horizonGroupId, '弦轨组标识'), horizonGroupTitle: text(input.horizonGroupTitle, '弦轨组名称', 160) }
}
function blockValue(input) {
  knownKeys(input, ['id', 'taskId', 'date', 'start', 'end', 'locked', 'horizonGroupId', 'horizonGroupTitle'], '任务安排')
  timeRange(input.start, input.end)
  return { id: identifier(input.id), taskId: identifier(input.taskId, '任务标识'), date: day(input.date), start: input.start, end: input.end, locked: boolean(input.locked, '锁定状态'), ...horizonGroupValue(input) }
}
function detailsValue(input) {
  knownKeys(input, ['items', 'preparation', 'needsSubmission', 'submittedAt'], '任务准备')
  const needsSubmission = boolean(input.needsSubmission, '需要提交')
  let submittedAt = input.submittedAt
  if (submittedAt !== null) {
    dateTime(submittedAt, '提交时间')
    if (!submittedAt.includes('T')) fail('提交时间需要包含时刻和时区')
    submittedAt = new Date(submittedAt).toISOString()
    if (!needsSubmission) fail('不需要提交的任务应清空提交时间')
  }
  return { items: strings(input.items, '携带物品'), preparation: text(input.preparation, '准备说明', 4000, { empty: true }), needsSubmission, submittedAt }
}

// Planner clocks describe the machine's local day, never a UTC midnight key.
function localInstant(date, clock) {
  const value = new Date(`${date}T${clock}:00`)
  if (!Number.isFinite(value.getTime()) || value.getFullYear() !== Number(date.slice(0, 4)) || value.getMonth() + 1 !== Number(date.slice(5, 7)) || value.getDate() !== Number(date.slice(8, 10)) || value.getHours() !== Number(clock.slice(0, 2)) || value.getMinutes() !== Number(clock.slice(3))) fail('当地时区不存在这个时刻，请选择其他时间')
  return value.getTime()
}
const blockRange = block => ({ start: localInstant(block.date, block.start), end: localInstant(block.date, block.end) })
function taskRange(task) {
  if (!occupiesTime(task) || !task.startAt?.includes('T') || !Number.isFinite(task.estimateMin) || task.estimateMin <= 0) return null
  const start = Date.parse(task.startAt)
  return Number.isFinite(start) ? { start, end: start + task.estimateMin * 60_000 } : null
}
function dueLimit(due) {
  if (!due) return null
  if (due.length !== 10) return Date.parse(due)
  const value = new Date(`${due}T00:00:00`)
  value.setDate(value.getDate() + 1)
  return value.getTime()
}

export function createPlannerStore({ db, transaction, getTask, listTasks, now = () => new Date() }) {
  const read = db.prepare('SELECT value FROM state WHERE key = ?')
  const write = db.prepare('INSERT INTO state (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  // This is a durable, one-time migration rather than a fallback applied on
  // every read. That distinction lets a user remove the default weekend slot
  // without it coming back on the next browser start.
  const ensureWeekendDefaults = () => transaction(() => {
    const marker = read.get(WEEKEND_DEFAULTS_MARKER)
    const row = read.get(STATE_KEY)
    if (!row) {
      const state = defaultPlanner()
      write.run(STATE_KEY, JSON.stringify(state))
      write.run(WEEKEND_DEFAULTS_MARKER, JSON.stringify({ version: 1, migratedAt: new Date().toISOString() }))
      return state
    }
    const state = JSON.parse(row.value)
    if (marker) return state

    // Read the latest state in this transaction. Existing weekend availability
    // (including disabled/custom entries) is user intent and must be preserved.
    const hasWeekendAvailability = state.routines.some(routine =>
      routine.kind === 'available' && routine.weekdays.some(weekday => weekday === 0 || weekday === 6))
    if (!hasWeekendAvailability) {
      state.routines = [...state.routines, {
        id: WEEKEND_DEFAULT_ROUTINE_ID, title: '周末可安排时间', kind: 'available', weekdays: [0, 6],
        start: '09:00', end: '22:00', location: '', items: [], enabled: true,
      }]
      if (!Number.isSafeInteger(state.revision + 1)) fail('安排版本超出范围', 409)
      state.revision += 1
      write.run(STATE_KEY, JSON.stringify(state))
    }
    write.run(WEEKEND_DEFAULTS_MARKER, JSON.stringify({ version: 1, migratedAt: new Date().toISOString() }))
    return state
  })
  const getPlanner = () => {
    // After migration, ordinary reads do not need SQLite's write lock.
    // Read the marker first: another process may finish migration between reads.
    // Seeing its marker must never pair with a planner value read before it.
    if (!read.get(WEEKEND_DEFAULTS_MARKER)) return ensureWeekendDefaults()
    const row = read.get(STATE_KEY)
    return row ? JSON.parse(row.value) : ensureWeekendDefaults()
  }
  const save = state => {
    for (const key of Object.keys(limits)) if ((Array.isArray(state[key]) ? state[key].length : Object.keys(state[key] ?? {}).length) > limits[key]) fail('安排数量较多，请先整理历史记录')
    const serialized = JSON.stringify(state)
    if (serialized.length > 2_000_000) fail('安排内容过多，请先整理历史记录', 413)
    write.run(STATE_KEY, serialized)
    return state
  }
  const requireTask = (id, unfinished = false) => {
    const task = getTask(id)
    if (!task || task.deletedAt) fail('安排关联的任务不存在或已删除', 409)
    if (unfinished && !activeTask(task)) fail('已完成或已放下的任务不能继续安排', 409)
    return task
  }
  function fixedConflicts(routine, block) {
    return routine.enabled && routine.kind !== 'available' && overlaps(routine, block)
  }
  function validateRoutineOccupancy(routine, state) {
    if (!routine.enabled || routine.kind === 'available') return
    if (state.blocks.some(block => !state.dayOverrides?.[block.date] && !state.dayExceptions?.[block.date] && routineOccursOn(routine, block.date) && occupiesTime(getTask(block.taskId)) && fixedConflicts(routine, block))) fail('固定安排与已有任务时间重叠，请先调整任务安排', 409)
  }
  function validateBlock(block, state, { restoring = false } = {}) {
    const task = requireTask(block.taskId, !restoring)
    // A done block is still a record of occupied time. Dropped history remains
    // non-occupying, so restoring it does not introduce an active conflict.
    if (restoring && !occupiesTime(task)) return
    if (task.occurrence) {
      if (block.date !== task.occurrence.date) fail(`这次重复事项属于${task.occurrence.date}，不能挤到其他日期；明确改期请先更新该实例occurrenceDate，再修改原计划`, 409)
      if (state.blocks.some(other => other.id !== block.id && other.taskId === task.id)) {
        fail('这次重复事项只能保留当天一个完整时段；调整日程请沿用原计划ID', 409)
      }
    }
    const range = blockRange(block), deadline = dueLimit(task.due)
    if (deadline !== null && Number.isFinite(deadline) && range.end > deadline) fail('安排结束时间超过了任务截止时间', 409)
    if (routinesOn(state, block.date).some(routine => fixedConflicts(routine, block))) fail('这个时间已有课程、休息或固定活动', 409)
    if (state.blocks.some(other => other.id !== block.id && occupiesTime(getTask(other.taskId)) && overlaps(blockRange(other), range))) fail('这个时间已有其他任务安排', 409)
    const plannedTasks = new Set(state.blocks.filter(other => other.id !== block.id).map(other => other.taskId))
    plannedTasks.add(block.taskId)
    for (const other of listTasks()) {
      if (plannedTasks.has(other.id)) continue
      const existing = taskRange(other)
      if (existing && overlaps(range, existing)) fail('这个时间与已有任务的开始时间和预计用时冲突', 409)
    }
  }
  const localToday = () => {
    const value = now()
    const pad = number => String(number).padStart(2, '0')
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
  }
  function refreshFutureOverrides(state, weekdays) {
    if (!weekdays.size || !state.dayOverrides) return
    const today = localToday()
    const affected = Object.entries(state.dayOverrides).filter(([date, override]) => date >= today && weekdays.has(override.sourceWeekday))
    if (!affected.length) return
    for (const [date, override] of affected) {
      const routines = state.routines.filter(routine => routineOccursOn(routine, date, override.sourceWeekday)).map(routineValue)
      if (!routines.some(routine => routine.kind === 'class')) fail('请先移除未来的单日调课记录，再删除来源周的最后一节课程', 409)
      state.dayOverrides[date] = { ...override, routines }
    }
  }

  function applyPlannerAction(action, expectedRevision, deferBlockValidation = false) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('安排版本不正确')
    choice(action?.type, ['save-routine', 'delete-routine', 'import-routines', 'set-first-week-monday', 'edit-weekday', 'set-day-template', 'remove-day-template', 'set-day-exception', 'clear-day-exception', 'save-day-event', 'delete-day-event', 'save-block', 'delete-block', 'save-details', 'check-item'], '安排操作')
    knownKeys(action, ['type', ...({
      'save-routine': ['routine'], 'delete-routine': ['id'], 'import-routines': ['routines'],
      'set-first-week-monday': ['date'],
      'edit-weekday': ['weekday', 'replacements', 'syncDates'],
      'set-day-template': ['date', 'sourceWeekday'], 'remove-day-template': ['date'],
      'set-day-exception': ['date', 'endDate', 'kind', 'sourceWeekday'], 'clear-day-exception': ['date'],
      'save-day-event': ['event'], 'delete-day-event': ['id'],
      'save-block': ['block'], 'delete-block': ['id'], 'save-details': ['taskId', 'details'], 'check-item': ['date', 'key', 'checked'],
    }[action?.type] ?? [])], '安排操作')
    return transaction(() => {
      const state = getPlanner()
      if (state.revision !== expectedRevision) fail('安排已在其他窗口更新，请刷新后重试', 409)
      const before = JSON.stringify(state)
      switch (action.type) {
        case 'set-first-week-monday': {
          const anchor = firstWeekValue(action.date)
          const routines = state.routines.map(routine => ['odd', 'even'].includes(routine.weekCycle)
            ? { ...routine, weekAnchor: anchor } : routine)
          for (const routine of routines) validateRoutineOccupancy(routine, state)
          state.firstWeekMonday = anchor
          state.routines = routines
          // Dated overrides are explicit snapshots, not another repeating
          // template. Changing the shared week count must not rewrite them.
          break
        }
        case 'save-routine': {
          const routine = routineForState(action.routine, state)
          validateRoutineOccupancy(routine, state)
          const index = state.routines.findIndex(item => item.id === routine.id)
          const previous = index < 0 ? null : state.routines[index]
          if (index < 0) state.routines.push(routine); else state.routines[index] = routine
          refreshFutureOverrides(state, new Set([...(previous?.weekdays ?? []), ...routine.weekdays]))
          break
        }
        case 'import-routines': {
          if (!Array.isArray(action.routines) || action.routines.length > limits.routines) fail('导入的固定安排最多 300 项')
          const routines = action.routines.map(routine => routineForState(routine, state))
          if (new Set(routines.map(item => item.id)).size !== routines.length) fail('导入的安排标识不可重复')
          for (const routine of routines) validateRoutineOccupancy(routine, state)
          const imported = new Map(routines.map(item => [item.id, item]))
          const affectedWeekdays = new Set([...routines, ...state.routines.filter(item => imported.has(item.id))].flatMap(item => item.weekdays))
          state.routines = [...state.routines.filter(item => !imported.has(item.id)), ...routines]
          state.timetableConfirmed = true
          refreshFutureOverrides(state, affectedWeekdays)
          break
        }
        case 'delete-routine': {
          const id = identifier(action.id)
          if (!state.routines.some(item => item.id === id)) fail('找不到这条固定安排', 404)
          const previous = state.routines.find(item => item.id === id)
          state.routines = state.routines.filter(item => item.id !== id)
          refreshFutureOverrides(state, new Set(previous.weekdays))
          break
        }
        case 'edit-weekday': {
          const weekday = sourceWeekdayValue(action.weekday)
          if (!Array.isArray(action.replacements) || !action.replacements.length || action.replacements.length > 32) fail('每周课表修改需要 1–32 项原安排')
          const replacements = action.replacements.map(weekdayReplacementValue)
          if (new Set(replacements.map(item => item.routineId)).size !== replacements.length) fail('每周课表不可重复修改同一条安排')
          const syncDates = strings(action.syncDates, '同步调课日期', 31, 10).map(date => day(date))
          for (const date of syncDates) {
            if (!state.dayOverrides?.[date] || state.dayOverrides[date].sourceWeekday !== weekday) fail('只能同步已使用这个星期课表的单日调课，请刷新后重试', 409)
          }
          for (const replacement of replacements) {
            const routine = state.routines.find(item => item.id === replacement.routineId)
            if (!routine || !routine.enabled || !routine.weekdays.includes(weekday)) fail('原安排不属于这个星期的已启用课表，请刷新后重试', 409)
          }
          const byId = new Map(replacements.map(item => [item.routineId, item]))
          const usedIds = new Set(state.routines.map(item => item.id))
          state.routines = state.routines.flatMap(routine => {
            const replacement = byId.get(routine.id)
            if (!replacement) return [routine]
            const subjectChanged = routine.title !== replacement.title || routine.kind !== replacement.kind
            const updated = {
              ...routine, title: replacement.title, kind: replacement.kind,
              location: replacement.location ?? (subjectChanged ? '' : routine.location),
              items: replacement.items ?? (subjectChanged ? [] : routine.items),
            }
            if (updated.title === routine.title && updated.kind === routine.kind && updated.location === routine.location && JSON.stringify(updated.items) === JSON.stringify(routine.items)) return [routine]
            if (routine.weekdays.length === 1) return [updated]
            return [
              { ...routine, weekdays: routine.weekdays.filter(value => value !== weekday) },
              { ...updated, id: weekdayRoutineId(routine.id, weekday, usedIds), weekdays: [weekday] },
            ]
          })
          if (syncDates.length) {
            state.dayOverrides = { ...state.dayOverrides }
            for (const date of syncDates) {
              const routines = state.routines.filter(routine => routineOccursOn(routine, date, weekday)).map(routineValue)
              if (!routines.some(routine => routine.kind === 'class')) fail('同步单日调课需要来源周至少保留一节已启用的课程', 409)
              state.dayOverrides[date] = { date, sourceWeekday: weekday, routines }
            }
          }
          // Real timetable corrections keep existing tasks intact. Capacity
          // reports any conflicts, and subsequent task placements obey the
          // fully updated week and explicitly synchronized day snapshots.
          break
        }
        case 'set-day-template': {
          const date = day(action.date), sourceWeekday = sourceWeekdayValue(action.sourceWeekday)
          const routines = state.routines.filter(routine => routineOccursOn(routine, date, sourceWeekday)).map(routineValue)
          if (!routines.some(routine => routine.kind === 'class')) fail('来源星期还没有已启用的课程，请先录入或导入该星期的真实课表，再设置单日调课', 409)
          // Record the actual school day even when an existing task conflicts.
          // The capacity model exposes those conflicts; tasks are never moved.
          const override = { date, sourceWeekday, routines }
          if (JSON.stringify(state.dayOverrides?.[date]) !== JSON.stringify(override)) {
            state.dayOverrides = { ...state.dayOverrides, [date]: override }
          }
          if (state.dayExceptions?.[date]) delete state.dayExceptions[date]
          break
        }
        case 'remove-day-template': {
          const date = day(action.date)
          if (!state.dayOverrides?.[date]) fail('这一天没有单日调课记录', 404)
          delete state.dayOverrides[date]
          break
        }
        case 'set-day-exception': {
          const start = day(action.date), end = day(action.endDate ?? action.date)
          const kind = choice(action.kind, ['holiday', 'cancelled', 'rescheduled', 'restored'], '日历例外类型')
          if (end < start) fail('结束日期不能早于开始日期')
          if (kind !== 'rescheduled' && action.sourceWeekday !== undefined) fail('只有调课可以指定来源星期')
          const sourceWeekday = kind === 'rescheduled' ? sourceWeekdayValue(action.sourceWeekday) : undefined
          const dates = []
          const cursor = new Date(`${start}T12:00:00`)
          while (true) {
            const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
            if (date > end) break
            dates.push(date)
            if (dates.length > 31) fail('连续例外最多31天')
            cursor.setDate(cursor.getDate() + 1)
          }
          state.dayExceptions ??= {}
          for (const date of dates) {
            const exception = { date, kind, ...(kind === 'rescheduled' ? {
              sourceWeekday, routines: state.routines.filter(routine => routineOccursOn(routine, date, sourceWeekday)).map(routineValue),
            } : kind === 'holiday' ? { routines: holidayRoutinesForDay(state, date).map(routineValue) } : {}) }
            if (JSON.stringify(state.dayExceptions[date]) === JSON.stringify(exception) && !state.dayOverrides?.[date]) continue
            state.dayExceptions[date] = exception
            if (state.dayOverrides?.[date]) delete state.dayOverrides[date]
          }
          break
        }
        case 'clear-day-exception': {
          const date = day(action.date)
          if (!state.dayExceptions?.[date] && !state.dayOverrides?.[date]) fail('这一天没有日历例外', 404)
          if (state.dayExceptions) delete state.dayExceptions[date]
          if (state.dayOverrides) delete state.dayOverrides[date]
          break
        }
        case 'save-day-event': {
          const event = dayEventValue(action.event)
          const events = state.dayEvents ?? [], index = events.findIndex(item => item.id === event.id)
          // A reported fixed event is a fact, even outside known availability
          // or over an existing task. Keep tasks/locks and expose the conflict.
          state.dayEvents = index < 0 ? [...events, event] : events.map((item, position) => position === index ? event : item)
          break
        }
        case 'delete-day-event': {
          const id = identifier(action.id), events = state.dayEvents ?? []
          if (!events.some(event => event.id === id)) fail('找不到这条单日活动', 404)
          state.dayEvents = events.filter(event => event.id !== id)
          break
        }
        case 'save-block': {
          const block = blockValue(action.block)
          const index = state.blocks.findIndex(item => item.id === block.id), previous = state.blocks[index]
          // Older calendar forms do not know about grouping. Moving a block there
          // must not silently discard the user's saved membership.
          if (previous && block.horizonGroupId === undefined) Object.assign(block, horizonGroupValue(previous))
          const samePlacement = previous && ['taskId', 'date', 'start', 'end'].every(key => previous[key] === block[key])
          if (previous?.locked && !(samePlacement && !block.locked)) fail('先解锁这段安排，再修改时间或任务', 409)
          // Unlock must remain possible after external task edits introduce a conflict.
          if (!(previous?.locked && samePlacement && !block.locked)) {
            if (deferBlockValidation) requireTask(block.taskId, true)
            else validateBlock(block, state)
          }
          if (index < 0) state.blocks.push(block); else state.blocks[index] = block
          break
        }
        case 'delete-block': {
          const id = identifier(action.id), block = state.blocks.find(item => item.id === id)
          if (!block) fail('找不到这段安排', 404)
          if (block.locked) fail('先解锁这段安排，再移除', 409)
          state.blocks = state.blocks.filter(item => item.id !== id)
          break
        }
        case 'save-details': {
          const id = identifier(action.taskId)
          requireTask(id)
          state.details = { ...state.details, [id]: detailsValue(action.details) }
          break
        }
        case 'check-item': {
          const date = day(action.date), key = identifier(action.key, '物品标识'), checked = boolean(action.checked, '勾选状态')
          const values = state.checked[date] ?? []
          state.checked[date] = checked ? [...new Set([...values, key])] : values.filter(item => item !== key)
          if (state.checked[date].length > 500) fail('每天最多勾选 500 项物品')
          if (!state.checked[date].length) delete state.checked[date]
          break
        }
        default: fail('不支持的安排操作')
      }
      if (JSON.stringify(state) === before) return state
      if (!Number.isSafeInteger(state.revision + 1)) fail('安排版本超出范围', 409)
      state.revision += 1
      return save(state)
    })
  }
  const updatePlanner = (action, expectedRevision) => applyPlannerAction(action, expectedRevision)
  // Operation batches may exchange occupied slots or move an entire chain.
  // Apply their normal shape, task, lock and revision checks in order, but
  // validate saved placements against the final snapshot before committing.
  // The outer transaction makes intermediate overlapping placements invisible;
  // keeping every final explicit block also suppresses superseded startAt slots.
  function updatePlannerBatch(actions, expectedRevision) {
    if (!Array.isArray(actions) || !actions.length || actions.length > 128) fail('安排批次需要 1–128 项变更')
    return transaction(() => {
      let state = getPlanner()
      if (state.revision !== expectedRevision) fail('安排已在其他窗口更新，请刷新后重试', 409)
      const savedIds = new Set()
      for (const action of actions) {
        const blockId = action?.type === 'save-block' ? action.block?.id : action?.type === 'delete-block' ? action.id : null
        if (blockId && state.blocks.some(block => block.id === blockId && block.locked)) fail('这段安排已锁定，请先由你手动解锁', 409)
        state = applyPlannerAction(action, state.revision, true)
        if (action.type === 'save-block') savedIds.add(action.block.id)
      }
      for (const block of state.blocks) if (savedIds.has(block.id)) validateBlock(block, state)
      return state
    })
  }
  function removeTask(taskId) {
    return transaction(() => {
      const state = getPlanner()
      const blocks = state.blocks.filter(block => block.taskId !== taskId)
      if (blocks.length === state.blocks.length && !Object.hasOwn(state.details, taskId)) return
      state.blocks = blocks
      delete state.details[taskId]
      state.revision += 1
      save(state)
    })
  }
  // Date edits and their corresponding placement share one transaction. An
  // estimate is metadata, not permission to resize an existing calendar slot.
  function syncRecurringTaskPlan(before, after) {
    if (!before?.occurrence || !after.occurrence || after.deletedAt ||
      before.occurrence.date === after.occurrence.date) return
    const state = getPlanner(), blocks = state.blocks.filter(block => block.taskId === after.id)
    if (!blocks.length) return
    if (blocks.length !== 1) fail('这次重复事项的原安排不唯一，请先整理原计划再改期', 409)
    const original = blocks[0]
    if (original.locked) fail('这次重复事项的安排已锁定，请先解锁再改期', 409)
    const block = { ...original, date: after.occurrence.date }
    const windows = routinesOn(state, block.date).filter(routine => routine.enabled && routine.kind === 'available')
      .sort((a, b) => a.start.localeCompare(b.start)).reduce((ranges, routine) => {
        const previous = ranges.at(-1)
        if (previous && routine.start <= previous.end) previous.end = previous.end > routine.end ? previous.end : routine.end
        else ranges.push({ start: routine.start, end: routine.end })
        return ranges
      }, [])
    if (!windows.some(window => window.start <= block.start && window.end >= block.end)) {
      fail('目标日期没有可用的完整时段容纳这次重复事项，任务与原计划均保持不变；请先调整可用时间', 409)
    }
    validateBlock(block, state)
    return updatePlanner({ type: 'save-block', block }, state.revision)
  }
  // Only durable operation snapshots call this, never arbitrary browser input.
  function restorePlanner(snapshot, expectedRevision) {
    return transaction(() => {
      const current = getPlanner()
      if (current.revision !== expectedRevision) fail('安排后来有新的修改，无法直接撤销', 409)
      validateDayOverrides(snapshot.dayOverrides)
      validateDayExceptions(snapshot.dayExceptions)
      validateDayEvents(snapshot.dayEvents)
      for (const taskId of new Set([...snapshot.blocks.map(block => block.taskId), ...Object.keys(snapshot.details)])) requireTask(taskId)
      const currentBlocks = new Map(current.blocks.map(block => [block.id, block]))
      for (const block of snapshot.blocks) {
        const previous = currentBlocks.get(block.id)
        // Check time that undo reintroduces, using current task facts and the
        // final restored placement. Unchanged history must not prevent undoing
        // an unrelated preparation edit just because a task later changed.
        if (!previous || ['taskId', 'date', 'start', 'end'].some(key => previous[key] !== block[key])) {
          validateBlock(block, snapshot, { restoring: true })
        }
      }
      if (!Number.isSafeInteger(current.revision + 1)) fail('安排版本超出范围', 409)
      const restored = JSON.parse(JSON.stringify(snapshot))
      // A receipt created before the one-time weekend migration can carry a
      // legacy snapshot without the seeded slot. Once the migration is durable,
      // undoing that old receipt must not erase the user's default availability.
      const migratedWeekend = current.routines.find(routine => routine.id === WEEKEND_DEFAULT_ROUTINE_ID)
      if (migratedWeekend && !restored.routines.some(routine => routine.id === WEEKEND_DEFAULT_ROUTINE_ID)) {
        restored.routines.push(migratedWeekend)
      }
      return save({ ...restored, revision: current.revision + 1 })
    })
  }
  function validateState(state) {
    knownKeys(state, ['revision', 'timetableConfirmed', 'routines', 'blocks', 'details', 'checked', 'dayOverrides', 'dayExceptions', 'dayEvents', 'firstWeekMonday'], '备份日程')
    if (!Number.isSafeInteger(state.revision) || state.revision < 0) fail('备份日程版本无效')
    boolean(state.timetableConfirmed, '课表确认')
    if (state.firstWeekMonday !== undefined) firstWeekValue(state.firstWeekMonday)
    if (!Array.isArray(state.routines) || state.routines.length > limits.routines || !Array.isArray(state.blocks) || state.blocks.length > limits.blocks) fail('备份日程数量无效')
    if (new Set(state.routines.map(item => item?.id)).size !== state.routines.length || new Set(state.blocks.map(item => item?.id)).size !== state.blocks.length) fail('备份日程标识重复')
    for (const routine of state.routines) {
      routineValue(routine)
      if (state.firstWeekMonday && ['odd', 'even'].includes(routine.weekCycle) && routine.weekAnchor !== state.firstWeekMonday) fail('备份中的单双周安排与统一第1周日期不一致')
    }
    const occurrenceTasks = new Set()
    for (const block of state.blocks) {
      blockValue(block)
      const task = getTask(block.taskId)
      if (!task) fail('备份日程关联事项缺失')
      if (task.occurrence) {
        if (block.date !== task.occurrence.date || occurrenceTasks.has(task.id)) fail('备份中的重复实例与其单日唯一安排不一致')
        occurrenceTasks.add(task.id)
      }
    }
    if (!state.details || typeof state.details !== 'object' || Array.isArray(state.details) || Object.keys(state.details).length > limits.details) fail('备份准备信息无效')
    for (const [taskId, details] of Object.entries(state.details)) { identifier(taskId); detailsValue(details); if (!getTask(taskId)) fail('备份准备信息关联事项缺失') }
    if (!state.checked || typeof state.checked !== 'object' || Array.isArray(state.checked) || Object.keys(state.checked).length > limits.checked) fail('备份携带记录无效')
    for (const [date, items] of Object.entries(state.checked)) { day(date); strings(items, '携带记录') }
    validateDayOverrides(state.dayOverrides)
    validateDayExceptions(state.dayExceptions)
    validateDayEvents(state.dayEvents)
    if (JSON.stringify(state).length > 2_000_000) fail('安排内容过多，请先整理历史记录', 413)
  }
  function validateStoredState() {
    const stored = read.get(STATE_KEY)
    if (stored) validateState(JSON.parse(stored.value))
  }
  function validateSyncState() {
    const state = getPlanner()
    validateState(state)
    for (const block of state.blocks) validateBlock(block, state, { restoring: true })
    // A task's explicit startAt also occupies time when it has no planner block.
    const planned = new Set(state.blocks.map(block => block.taskId))
    const implicit = listTasks().filter(task => !planned.has(task.id)).map(task => ({ task, range: taskRange(task) }))
      .filter(item => item.range).sort((a, b) => a.range.start - b.range.start)
    for (let index = 0; index < implicit.length; index++) {
      const { task, range } = implicit[index], deadline = dueLimit(task.due)
      if (deadline !== null && Number.isFinite(deadline) && range.end > deadline) fail('事项结束时间超过了截止时间', 409)
      if (index && overlaps(implicit[index - 1].range, range)) fail('事项的开始时间和预计用时与其他事项冲突', 409)
      const cursor = new Date(range.start)
      cursor.setHours(0, 0, 0, 0)
      while (cursor.getTime() < range.end) {
        const date = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`
        if (routinesOn(state, date).some(routine => routine.enabled && routine.kind !== 'available'
          && overlaps(range, { start: localInstant(date, routine.start), end: localInstant(date, routine.end) }))) fail('事项的开始时间与课程、休息或固定活动冲突', 409)
        cursor.setDate(cursor.getDate() + 1)
      }
    }
  }
  return { getPlanner, updatePlanner, updatePlannerBatch, removeTask, syncRecurringTaskPlan, restorePlanner, validateStoredState, validateSyncState }
}
