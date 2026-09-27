export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'ValidationError'
    this.status = status
  }
}

export function object(value, label = '输入') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError(`${label}格式不正确`)
  return value
}

export function knownKeys(input, allowed, label = '输入') {
  object(input, label)
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ValidationError(`${label}包含不支持的字段`)
  return input
}

export function text(value, label, max = 2000, { optional = false, empty = false } = {}) {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) {
    throw new ValidationError(`${label}不能为空，且最多 ${max} 个字符`)
  }
  return value.trim()
}

export function identifier(value, label = '标识') {
  const id = text(value, label, 200)
  if (/[\u0000-\u001f\u007f]/u.test(id)) throw new ValidationError(`${label}包含无效字符`)
  return id
}

export function questionOptions(input) {
  object(input, '快捷选项')
  knownKeys(input, ['options'], '快捷选项')
  if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 4) throw new ValidationError('快捷问题需要 2–4 个选项')
  const options = input.options.map(option => text(option, '选项', 80))
  if (new Set(options).size !== options.length) throw new ValidationError('快捷问题的选项需要互不相同')
  return { options }
}

export function choice(value, options, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback
  if (!options.includes(value)) throw new ValidationError(`${label}不正确`)
  return value
}

export function number(value, label, min, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new ValidationError(`${label}必须在 ${min}–${max} 之间`)
  }
  return value
}

function boolean(value, label, fallback) {
  if (value === undefined && fallback !== undefined) return fallback
  if (typeof value !== 'boolean') throw new ValidationError(`${label}必须是布尔值`)
  return value
}

export function day(value, label = '日期') {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new ValidationError(`${label}请使用 YYYY-MM-DD`)
  const date = new Date(`${value}T00:00:00Z`)
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new ValidationError(`${label}不存在`)
  return value
}

export function dateTime(value, label = '时间', { optional = false } = {}) {
  if (value === undefined && optional) return undefined
  if (typeof value !== 'string') throw new ValidationError(`${label}格式不正确`)
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return day(value, label)
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    throw new ValidationError(`${label}需要明确日期和时区`)
  }
  day(value.slice(0, 10), label)
  const time = value.slice(11, 19).split(':').map(Number)
  if (time[0] > 23 || time[1] > 59 || (time[2] ?? 0) > 59 || !Number.isFinite(Date.parse(value))) throw new ValidationError(`${label}不存在`)
  return value
}

export function clockTime(value, label = '时刻') {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) throw new ValidationError(`${label}请使用 HH:mm`)
  return value
}

export function jsonValue(value, label, max = 32000) {
  let serialized
  try { serialized = JSON.stringify(value) } catch { throw new ValidationError(`${label}格式不正确`) }
  if (serialized === undefined || serialized.length > max) throw new ValidationError(`${label}内容过长或格式不正确`)
  return JSON.parse(serialized)
}

const TASK_FIELDS = ['title', 'notes', 'area', 'source', 'inbox', 'due', 'startAt', 'estimateMin', 'occurrence', 'freeTimeGoalId', 'subSteps', 'surfaceAt', 'leadDays', 'importance', 'energy', 'context', 'fuzzyWindow', 'status', 'doneAt', 'deletedAt']
export function taskInput(input, { partial = false } = {}) {
  object(input, '任务')
  const value = {}
  const has = key => !partial || Object.hasOwn(input, key)
  for (const key of Object.keys(input)) {
    if (!TASK_FIELDS.includes(key) && !['id', 'createdAt', 'updatedAt'].includes(key)) throw new ValidationError(`任务包含未知字段：${key}`)
  }
  if (has('title')) value.title = text(input.title, '任务名称', 160)
  if (has('notes')) value.notes = text(input.notes, '任务备注', 2000, { optional: true, empty: true })
  if (has('area')) value.area = input.area == null ? null : identifier(input.area, '分类')
  if (has('source')) value.source = choice(input.source, ['manual', 'ai', 'import', 'recurring'], '来源', 'manual')
  if (has('inbox')) value.inbox = boolean(input.inbox, '收件箱', true)
  for (const key of ['due', 'startAt', 'surfaceAt', 'doneAt']) {
    if (has(key)) value[key] = input[key] == null ? undefined : dateTime(input[key], key)
  }
  if (has('estimateMin')) value.estimateMin = input.estimateMin == null ? undefined : number(input.estimateMin, '预计用时', 1, 525600)
  if (has('freeTimeGoalId')) value.freeTimeGoalId = input.freeTimeGoalId == null ? undefined : identifier(input.freeTimeGoalId, '余时目标标识')
  if (has('occurrence')) {
    if (input.occurrence == null) value.occurrence = undefined
    else {
      knownKeys(input.occurrence, ['seriesId', 'date', 'preferredWindow', 'allowFallback', 'placement'], '重复实例')
      value.occurrence = { seriesId: identifier(input.occurrence.seriesId, '重复系列'), date: day(input.occurrence.date),
        ...(input.occurrence.preferredWindow === undefined ? {} : { preferredWindow: text(input.occurrence.preferredWindow, '优先窗口', 160) }),
        allowFallback: boolean(input.occurrence.allowFallback, '允许同日其他空档'),
        placement: choice(input.occurrence.placement, ['start', 'end'], '窗口位置', 'start') }
    }
  }
  if (has('subSteps')) {
    if (input.subSteps !== undefined && (!Array.isArray(input.subSteps) || input.subSteps.length > 100)) throw new ValidationError('子步骤最多 100 项')
    value.subSteps = input.subSteps === undefined ? undefined : jsonValue(input.subSteps, '子步骤')
  }
  if (has('leadDays')) value.leadDays = number(input.leadDays, '提前天数', 0, 365, 3)
  if (has('importance')) value.importance = choice(input.importance, [1, 2, 3], '重要程度', 2)
  if (has('energy')) value.energy = choice(input.energy, ['deep', 'light'], '精力', 'deep')
  if (has('context')) {
    const context = input.context ?? ['anywhere']
    if (!Array.isArray(context) || context.length > 5) throw new ValidationError('任务情境不正确')
    value.context = [...new Set(context.map(item => choice(item, ['anywhere', 'library', 'desk-4090', 'desk-mac', 'physical'], '任务情境')))]
  }
  if (has('fuzzyWindow')) value.fuzzyWindow = input.fuzzyWindow == null ? undefined : choice(input.fuzzyWindow, ['today', 'this-week', 'someday'], '时间范围')
  if (has('status')) value.status = choice(input.status, ['todo', 'doing', 'done', 'dropped'], '任务状态', 'todo')
  if (has('deletedAt')) value.deletedAt = input.deletedAt == null ? null : dateTime(input.deletedAt, '删除时间')
  if (!partial && value.occurrence) {
    if (!Number.isInteger(value.estimateMin) || value.estimateMin < 1 || value.estimateMin > 1440) throw new ValidationError('重复实例需要1至1440分钟的每次明确用时')
    if (value.startAt && value.startAt !== value.occurrence.date) throw new ValidationError('重复实例的开始日期需与occurrence.date一致；改期请一起更新该实例日期')
  }
  return value
}

export function eventInput(input) {
  knownKeys(input, ['id', 'updatedAt', 'deletedAt', 'title', 'kind', 'startDate', 'endDate', 'allDay', 'source', 'affectsScheduling', 'note'], '日历事项')
  const startDate = day(input.startDate, '开始日期')
  const endDate = day(input.endDate, '结束日期')
  if (endDate < startDate) throw new ValidationError('结束日期不能早于开始日期')
  if (input.allDay !== undefined && input.allDay !== true) throw new ValidationError('当前日历事项仅支持全天事件')
  return {
    title: text(input.title, '日历事项名称', 160),
    kind: choice(input.kind, ['exam-week', 'holiday', 'institution', 'activity', 'other'], '日历事项类型', 'other'),
    startDate, endDate, allDay: true,
    source: choice(input.source, ['manual', 'school', 'ai', 'import'], '日历事项来源', 'manual'),
    affectsScheduling: boolean(input.affectsScheduling, '影响安排', false),
    note: text(input.note, '日历备注', 2000, { optional: true, empty: true }),
  }
}

export function assignmentInput(input) {
  knownKeys(input, ['id', 'updatedAt', 'taskId', 'blockId', 'plannedMin', 'reason', 'status', 'feedback'], '安排')
  return {
    taskId: identifier(input.taskId, '任务标识'), blockId: identifier(input.blockId, '时间块'),
    plannedMin: number(input.plannedMin, '安排用时', 1, 1440),
    reason: text(input.reason, '安排依据', 2000, { empty: true }),
    status: choice(input.status, ['suggested', 'accepted', 'moved', 'skipped', 'done'], '安排状态', 'suggested'),
    feedback: input.feedback === undefined ? undefined : choice(input.feedback, ['too-hard-now', 'no-time', 'not-in-mood', 'wrong-context'], '安排反馈'),
  }
}

export function validateMemory(input) {
  object(input, '记忆')
  const scope = choice(input.scope, ['global', 'task'], '记忆范围', 'global')
  return {
    content: text(input.content, '记忆内容', 2000),
    scope,
    taskId: scope === 'task' ? identifier(input.taskId, '记忆任务标识') : undefined,
    sourceMessageId: identifier(input.sourceMessageId, '记忆来源'),
    kind: choice(input.kind, ['preference', 'project', 'context'], '记忆类型', 'preference'),
    expiresAt: input.expiresAt == null ? undefined : dateTime(input.expiresAt, '记忆有效期'),
  }
}

export const validateTaskDraft = input => taskInput(input)
export const validateTaskPatch = input => taskInput(input, { partial: true })
export const assertId = identifier
export { ValidationError as DomainError }
