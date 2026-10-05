import { createHash } from 'node:crypto'
import { validateModelSettings } from './modelSettings.mjs'
import { validateRouteJudgment } from './routeAnalysis.mjs'
import { planWeeksValue } from './freeTimePlan.mjs'
import { ValidationError, knownKeys, identifier, text, object, choice, dateTime, day, clockTime, taskInput, questionOptions, validateMemory } from './validation.mjs'
import { dayEventValue, validateDayEvents, validateDayExceptions, horizonGroupValue } from './planner.mjs'
import { BACKUP_MAX_BYTES, BACKUP_EXPORT_TOO_LARGE, BACKUP_IMPORT_TOO_LARGE, backupByteLength, serializeBackup } from '../src/xixi/backupLimits.ts'

const columns = {
  areas: ['id', 'document'], tasks: ['id', 'document'], events: ['id', 'document'], availability: ['id', 'document'], assignments: ['id', 'document'],
  conversations: ['id', 'title', 'createdAt', 'updatedAt', 'titleEdited'],
  messages: ['seq', 'id', 'conversationId', 'role', 'document'], memories: ['id', 'document'], operations: ['id', 'document'], turns: ['id', 'document'], summaries: ['id', 'document'],
  task_completion_history: ['id', 'taskId', 'beforeStatus', 'completionDoneAt', 'completedAt', 'closedAt'], state: ['key', 'value'],
}
const documentTables = new Set(['areas', 'tasks', 'events', 'availability', 'assignments', 'memories', 'operations', 'turns', 'summaries'])
const stateAllowed = key => ['activeConversation', 'deepseekModel', 'planner-v1', 'planner-v1-weekend-defaults-v1', 'companion-v1', 'preferences:app', 'preferences:model-connection', 'preferences:free-time-daily'].includes(key) || /^(task-undo-version:|generated-area:|deleted-conversation:|deleted-request:)/u.test(key)
const fail = message => { throw new ValidationError(message) }
const checksum = tables => createHash('sha256').update(JSON.stringify(tables)).digest('hex')
const integer = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(value) || value < min || value > max) fail('备份数字无效'); return value }
const array = (value, max = 10000) => { if (!Array.isArray(value) || value.length > max) fail('备份列表无效'); return value }
const bool = value => { if (typeof value !== 'boolean') fail('备份开关无效') }
const stamp = value => { dateTime(value); if (!value.includes('T')) fail('备份时间必须包含时区'); return value }
const optionalStamp = value => { if (value != null) stamp(value) }
const ids = value => array(value).forEach(item => identifier(item))
const parse = (value, label = '备份记录') => { try { return JSON.parse(value) } catch { fail(`${label}无法解析`) } }
function block(value) {
  knownKeys(value, ['id', 'taskId', 'title', 'date', 'start', 'end', 'locked', 'horizonGroupId', 'horizonGroupTitle'])
  identifier(value.id); identifier(value.taskId); day(value.date); clockTime(value.start); clockTime(value.end)
  if (value.start >= value.end) fail('备份时间段无效')
  if (value.locked !== undefined) bool(value.locked)
  if (value.title !== undefined) text(value.title, '任务名', 160)
  horizonGroupValue(value)
}
// Read-only snapshots may clip an older exact startAt placement at midnight;
// this is not a new editable planner block and cannot be adopted as a plan.
function snapshotBlock(value) {
  knownKeys(value, ['id', 'taskId', 'title', 'date', 'start', 'end', 'locked', 'horizonGroupId', 'horizonGroupTitle'])
  identifier(value.id); identifier(value.taskId); day(value.date); clockTime(value.start)
  if (value.end !== '24:00') clockTime(value.end)
  if (value.start >= value.end) fail('备份事实时间段无效')
  if (value.locked !== undefined) bool(value.locked)
  if (value.title !== undefined) text(value.title, '任务名', 160)
  horizonGroupValue(value)
}
function source(value) {
  knownKeys(value, ['kind', 'messageId', 'evidence', 'actionId'])
  choice(value.kind, ['user', 'conversation'], '来源')
  if (value.kind === 'conversation') { identifier(value.messageId); text(value.evidence, '原话', 2000) }
  if (value.evidence !== undefined) text(value.evidence, '原话', 2000)
  if (value.actionId !== undefined) identifier(value.actionId)
}
export function validateCompanionState(value) {
  knownKeys(value, ['handoffs', 'wishes', 'freeTimeGoals', 'freeTimeHistory', 'scenarios'])
  const unique = (rows, key) => { if (new Set(rows.map(item => item[key])).size !== rows.length) fail('备份记录标识重复') }
  for (const item of array(value.handoffs, 2000)) {
    knownKeys(item, ['taskId', 'progress', 'obstacle', 'nextStep', 'materials', 'version', 'source', 'createdAt', 'updatedAt'])
    identifier(item.taskId); integer(item.version, 1); source(item.source); stamp(item.createdAt); stamp(item.updatedAt)
    for (const key of ['progress', 'obstacle', 'nextStep']) text(item[key], key, 1500, { empty: true })
    array(item.materials, 20).forEach(material => text(material, '材料', 300))
  }
  unique(value.handoffs, 'taskId')
  for (const item of array(value.wishes, 500)) {
    knownKeys(item, ['id', 'content', 'evidence', 'minutes', 'minutesEstimated', 'items', 'expiresAt', 'status', 'version', 'source', 'createdAt', 'updatedAt', 'clarification'])
    identifier(item.id); text(item.content, '牵挂', 600); text(item.evidence, '原话', 2000); integer(item.minutes, 5, 720)
    if (item.minutesEstimated !== undefined) bool(item.minutesEstimated)
    if (item.clarification !== undefined) {
      knownKeys(item.clarification, ['motivation', 'firstStep'])
      for (const value of Object.values(item.clarification)) text(value, '心愿澄清', 600, { empty: true })
    }
    array(item.items, 20).forEach(condition => text(condition, '条件', 300)); optionalStamp(item.expiresAt)
    choice(item.status, ['active', 'paused', 'deleted'], '牵挂状态'); integer(item.version, 1); source(item.source); stamp(item.createdAt); stamp(item.updatedAt)
  }
  unique(value.wishes, 'id')
  for (const item of array(value.freeTimeGoals ?? [], 500)) {
    knownKeys(item, ['id', 'title', 'evidence', 'priority', 'minPerWeek', 'sessionMin', 'sessionMax', 'targetDate', 'targetNote', 'taskId', 'fromWishId', 'status', 'version', 'source', 'createdAt', 'updatedAt', 'planWeeks', 'lastActionId'])
    identifier(item.id); text(item.title, '余时目标名称', 160); text(item.evidence, '原话', 2000)
    choice(item.priority, ['high', 'normal', 'low'], '余时目标优先级'); integer(item.minPerWeek, 0, 14)
    integer(item.sessionMin, 5, 720); integer(item.sessionMax, 5, 720); if (item.sessionMax < item.sessionMin) fail('余时目标时长范围无效')
    choice(item.status, ['active', 'paused', 'deleted'], '余时目标状态'); integer(item.version, 1); source(item.source); stamp(item.createdAt); stamp(item.updatedAt)
    if (item.targetDate != null) day(item.targetDate)
    if (item.targetNote !== undefined) text(item.targetNote, '阶段目标', 1500, { empty: true })
    for (const key of ['taskId', 'fromWishId', 'lastActionId']) if (item[key] !== undefined) identifier(item[key])
    if (item.planWeeks !== undefined) planWeeksValue(item.planWeeks, [], { persisted: true })
  }
  unique(value.freeTimeGoals ?? [], 'id')
  for (const item of array(value.freeTimeHistory ?? [], 5000)) {
    knownKeys(item, ['sessionId', 'goalId', 'date', 'minutes', 'feedback', 'nextStep', 'completedAt'])
    identifier(item.sessionId); identifier(item.goalId); day(item.date); integer(item.minutes, 1, 1440)
    choice(item.feedback, ['smooth', 'stuck', 'continue'], '学习反馈'); text(item.nextStep, '下次接着做', 1500, { empty: true }); stamp(item.completedAt)
  }
  unique(value.freeTimeHistory ?? [], 'sessionId')
  for (const item of array(value.scenarios, 100)) {
    knownKeys(item, ['id', 'version', 'status', 'baseRevision', 'date', 'days', 'mode', 'budgetMin', 'bufferMin', 'timezone', 'plans', 'removedBlockIds', 'unscheduled', 'warnings', 'taskVersions', 'source', 'createdAt', 'metrics', 'operationId', 'appliedAt', 'decision', 'routeAnalysis'])
    identifier(item.id); integer(item.version, 1); integer(item.baseRevision); day(item.date); integer(item.days, 1, 7)
    choice(item.mode, ['rebalance', 'rest', 'light'], '推演方式'); choice(item.status, ['preview', 'applied', 'discarded', 'undone'], '方案状态')
    integer(item.budgetMin, item.decision ? 5 : 15, 720); integer(item.bufferMin, 0, 60); text(item.timezone, '时区', 100)
    try { new Intl.DateTimeFormat('en', { timeZone: item.timezone }) } catch { fail('备份时区无效') }
    array(item.plans, 64).forEach(block); ids(item.removedBlockIds); unique(item.plans, 'id')
    for (const pending of array(item.unscheduled, 64)) { knownKeys(pending, ['taskId', 'title', 'remainingMin', 'reason']); identifier(pending.taskId); text(pending.title, '任务名', 160); text(pending.reason, '原因', 600); if (pending.remainingMin !== null) integer(pending.remainingMin, 0, 525600) }
    array(item.warnings, 100).forEach(warning => text(warning, '提示', 1000)); object(item.taskVersions)
    for (const [id, updatedAt] of Object.entries(item.taskVersions)) { identifier(id); stamp(updatedAt) }
    source(item.source); stamp(item.createdAt); optionalStamp(item.appliedAt); if (item.operationId !== undefined) identifier(item.operationId)
    knownKeys(item.metrics, ['scheduledMin', 'unscheduledMin', 'bufferMin']); Object.values(item.metrics).forEach(value => integer(value))
    if (item.decision !== undefined) {
      const decision = item.decision
      knownKeys(decision, ['taskId', 'title', 'strategy', 'recurrence', 'todayMin', 'effortMin', 'baseline'])
      identifier(decision.taskId); text(decision.title, '任务名', 160)
      choice(decision.strategy, ['today', 'split', 'defer', 'model'], '决策路径'); choice(decision.recurrence, ['once', 'weekly'], '持续条件')
      integer(decision.todayMin, 5, 720); if (decision.effortMin !== null) integer(decision.effortMin)
      array(decision.baseline, 3000).forEach(snapshotBlock)
      if (item.days !== 7 || item.plans.some(plan => plan.taskId !== decision.taskId)) fail('备份决策方案任务或日期范围无效')
      if ((decision.strategy === 'model') !== (item.routeAnalysis !== undefined)) fail('备份模型路线缺少对应判断')
    }
    if (item.routeAnalysis !== undefined) {
      const route = item.routeAnalysis
      knownKeys(route, ['question', 'current', 'candidate', 'benefits', 'costs', 'risks', 'recovery', 'observations', 'assumptions', 'trends', 'kind', 'conditional', 'facts'])
      text(route.question, '具体选择', 2000); choice(route.kind, ['model-judgment'], '路线来源')
      if (route.conditional !== true || item.decision?.strategy !== 'model') fail('备份模型路线必须保留条件说明')
      const { question, kind, conditional, facts, ...judgment } = route
      validateRouteJudgment(judgment)
      knownKeys(facts, ['task', 'dates', 'baseline', 'candidate', 'timeline', 'availableWindows', 'effortMin', 'heldMin', 'remainingMin', 'bufferMin', 'baseRevision', 'asOf', 'exactStartProtected', 'verified'])
      knownKeys(facts.task, ['id', 'title', 'due', 'estimateMin', 'status']); identifier(facts.task.id); text(facts.task.title, '任务名', 160)
      if (facts.task.due !== undefined) dateTime(facts.task.due)
      if (facts.task.estimateMin !== undefined && (typeof facts.task.estimateMin !== 'number' || !Number.isFinite(facts.task.estimateMin) || facts.task.estimateMin <= 0)) fail('备份路线估时无效')
      choice(facts.task.status, ['todo', 'doing'], '任务状态'); array(facts.dates, 7).forEach(day)
      if (facts.dates.length !== 7 || new Set(facts.dates).size !== 7) fail('备份路线日期范围无效')
      array(facts.baseline, 3000).forEach(snapshotBlock); array(facts.candidate, 64).forEach(block)
      for (const window of array(facts.availableWindows, 10000)) {
        knownKeys(window, ['date', 'start', 'end']); day(window.date); clockTime(window.start); clockTime(window.end)
        if (window.start >= window.end || !facts.dates.includes(window.date)) fail('备份路线空闲窗口无效')
      }
      for (const row of array(facts.timeline, 7)) {
        knownKeys(row, ['date', 'availableMin', 'freeMin', 'remainingMin', 'scheduledMin', 'blocks', 'deadlines']); day(row.date)
        for (const field of ['availableMin', 'freeMin', 'remainingMin', 'scheduledMin']) if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) fail('备份路线时间容量无效')
        for (const entry of array(row.blocks, 10000)) {
          knownKeys(entry, ['id', 'title', 'date', 'taskId', 'start', 'end', 'kind', 'locked'])
          identifier(entry.id); text(entry.title, '安排名称', 160); clockTime(entry.start)
          // A clipped legacy placement can end at midnight in the timeline.
          if (entry.end !== '24:00') clockTime(entry.end)
          if (entry.start >= entry.end) fail('备份路线事实时段无效')
          choice(entry.kind, ['class', 'available', 'break', 'task'], '安排类型')
          if (entry.taskId !== undefined) identifier(entry.taskId)
          if (entry.date !== undefined) day(entry.date)
          if (entry.locked !== undefined) bool(entry.locked)
        }
        for (const entry of array(row.deadlines, 10000)) { knownKeys(entry, ['taskId', 'title', 'due']); identifier(entry.taskId); text(entry.title, '任务名', 160); dateTime(entry.due) }
      }
      for (const key of ['effortMin', 'remainingMin']) if (facts[key] !== null) integer(facts[key])
      for (const key of ['heldMin', 'bufferMin', 'baseRevision']) integer(facts[key])
      stamp(facts.asOf); bool(facts.exactStartProtected); array(facts.verified, 12).forEach(value => text(value, '核验事实', 600))
      if (facts.task.id !== item.decision.taskId || facts.baseRevision !== item.baseRevision || JSON.stringify(facts.candidate) !== JSON.stringify(item.plans)) fail('备份路线事实与方案不一致')
    }
  }
  unique(value.scenarios, 'id')
}

function validateDocument(table, document) {
  if (table === 'messages') {
    knownKeys(document, ['id', 'conversationId', 'role', 'content', 'requestId', 'taskId', 'toolCallId', 'toolCalls', 'reasoningContent', 'question', 'sourceMessageIds', 'createdAt', 'excludeFromContext', 'retractedAt', 'contextRetractedAt'])
    identifier(document.conversationId); choice(document.role, ['user', 'assistant', 'tool'], '消息角色'); stamp(document.createdAt); bool(document.excludeFromContext)
    for (const key of ['requestId', 'taskId', 'toolCallId']) if (document[key] !== undefined) identifier(document[key])
    optionalStamp(document.retractedAt); optionalStamp(document.contextRetractedAt)
    if (document.sourceMessageIds !== undefined) ids(document.sourceMessageIds)
    if (document.reasoningContent !== undefined) { choice(document.role, ['assistant'], '思考内容角色'); text(document.reasoningContent, '思考内容', 2000000, { empty: true }) }
    if (document.question !== undefined) questionOptions(document.question)
    if (document.toolCalls !== undefined) for (const call of array(document.toolCalls, 12)) {
      knownKeys(call, ['id', 'type', 'function']); identifier(call.id); choice(call.type, ['function'], '工具类型')
      knownKeys(call.function, ['name', 'arguments']); identifier(call.function.name); text(call.function.arguments, '工具参数', 64000, { empty: true })
      // A malformed provider call can be a legitimate failed historical turn.
      // Its string is retained for audit; restored failed turns cannot replay it.
    }
  } else if (table === 'memories') {
    knownKeys(document, ['id', 'content', 'scope', 'taskId', 'sourceMessageId', 'kind', 'expiresAt', 'createdAt', 'updatedAt', 'deletedAt', 'replacesId', 'replacedBy', 'evidence', 'lifetime'])
    validateMemory(document); stamp(document.createdAt); stamp(document.updatedAt); optionalStamp(document.deletedAt)
    for (const key of ['replacesId', 'replacedBy']) if (document[key] !== undefined) identifier(document[key])
    if (document.evidence !== undefined) text(document.evidence, '原话', 2000)
    if (document.lifetime !== undefined) { choice(document.lifetime, ['temporary', 'long-term', 'inference'], '记忆类型'); if (document.lifetime !== 'long-term' && !document.expiresAt) fail('临时记忆缺少有效期') }
  } else if (table === 'summaries') {
    knownKeys(document, ['conversationId', 'text', 'throughSeq', 'sourceMessageIds', 'updatedAt'])
    identifier(document.conversationId); text(document.text, '摘要', 16000, { empty: true }); integer(document.throughSeq); ids(document.sourceMessageIds); stamp(document.updatedAt)
  } else if (table === 'turns') {
    knownKeys(document, ['requestId', 'conversationId', 'text', 'context', 'userMessageId', 'status', 'ownerPid', 'ownerToken', 'createdAt', 'updatedAt', 'error', 'result', 'progress', 'retractedAt'])
    identifier(document.requestId); identifier(document.conversationId); identifier(document.userMessageId); text(document.text, '请求', 16000)
    knownKeys(document.context, ['timezone', 'page', 'taskId', 'date', 'wishId', 'freeTimeGoalId']); text(document.context.timezone, '时区', 100)
    if (document.context.freeTimeGoalId !== undefined) identifier(document.context.freeTimeGoalId)
    if (document.context.wishId !== undefined) identifier(document.context.wishId)
    if (document.context.taskId !== undefined) identifier(document.context.taskId)
    if (document.context.date !== undefined) day(document.context.date)
    if (document.context.page !== undefined) text(document.context.page, '页面', 100)
    choice(document.status, ['completed', 'failed'], '请求状态'); stamp(document.createdAt); stamp(document.updatedAt); optionalStamp(document.retractedAt)
    if (document.error !== undefined) text(document.error, '请求错误', 2000)
    if (document.progress !== undefined) { object(document.progress); if (JSON.stringify(document.progress).length > 256000) fail('执行进度过大') }
    if (document.result !== undefined) { knownKeys(document.result, ['requestId', 'conversationId', 'status', 'error', 'execution']); identifier(document.result.requestId); identifier(document.result.conversationId); choice(document.result.status, ['completed', 'failed'], '请求结果'); if (document.result.error !== undefined) text(document.result.error, '请求错误', 2000); if (document.result.execution !== undefined) { object(document.result.execution); if (JSON.stringify(document.result.execution).length > 256000) fail('执行结果过大') } }
  } else if (table === 'operations') {
    knownKeys(document, ['id', 'requestId', 'summary', 'kind', 'changes', 'createdAt', 'readAt', 'undoneAt', 'undoable', 'requestedChanges', 'removedAssignments', 'memoryId', 'requestedActions', 'plannerBefore', 'plannerAfterRevision', 'planChanges', 'parentOperationId', 'taskPlannerBefore', 'taskPlannerAfterRevision'])
    identifier(document.requestId); text(document.summary, '操作摘要', 2000); stamp(document.createdAt); optionalStamp(document.readAt); optionalStamp(document.undoneAt)
    if (document.parentOperationId !== undefined) identifier(document.parentOperationId)
    if (document.kind !== undefined) choice(document.kind, ['planner', 'forget', 'restored'], '操作类型')
    if (document.undoable !== undefined) bool(document.undoable)
    for (const change of array(document.changes, 50)) {
      knownKeys(change, ['table', 'id', 'before', 'after']); choice(change.table, ['tasks', 'memories'], '操作表'); identifier(change.id)
      for (const entry of [change.before, change.after]) if (entry !== null) {
        object(entry); if (entry.id !== change.id) fail('操作记录标识不一致')
        if (change.table === 'tasks') taskInput(entry); else validateDocument('memories', entry)
      }
    }
    if (document.requestedChanges !== undefined) array(document.requestedChanges, 50)
    if (document.removedAssignments !== undefined) array(document.removedAssignments, 10000)
    if (document.requestedActions !== undefined) for (const action of array(document.requestedActions, 128)) {
      choice(action.type, ['save-block', 'delete-block', 'save-details', 'set-day-template', 'remove-day-template', 'set-day-exception', 'clear-day-exception', 'edit-weekday', 'save-day-event', 'delete-day-event'], '操作类型')
      if (action.type === 'set-day-exception') { knownKeys(action, ['type', 'date', 'endDate', 'kind', 'sourceWeekday']); day(action.date); if (action.endDate !== undefined) day(action.endDate); choice(action.kind, ['holiday', 'cancelled', 'rescheduled', 'restored']); if (action.kind === 'rescheduled') integer(action.sourceWeekday, 0, 6) }
      if (action.type === 'clear-day-exception') { knownKeys(action, ['type', 'date']); day(action.date) }
      if (action.type === 'save-day-event') { knownKeys(action, ['type', 'event']); dayEventValue(action.event) }
      if (action.type === 'delete-day-event') { knownKeys(action, ['type', 'id']); identifier(action.id) }
    }
    if (document.plannerBefore !== undefined) { object(document.plannerBefore); validateDayEvents(document.plannerBefore.dayEvents); validateDayExceptions(document.plannerBefore.dayExceptions) }
    if (document.plannerAfterRevision !== undefined) integer(document.plannerAfterRevision)
    if (document.taskPlannerBefore !== undefined) { object(document.taskPlannerBefore); validateDayEvents(document.taskPlannerBefore.dayEvents); validateDayExceptions(document.taskPlannerBefore.dayExceptions); integer(document.taskPlannerAfterRevision) }
    if (document.planChanges !== undefined) for (const change of array(document.planChanges, 128)) { knownKeys(change, ['id', 'before', 'after']); identifier(change.id); if (change.before !== null) block(change.before); if (change.after !== null) block(change.after) }
  }
}

export function createBackupStore({ db, transaction, validate }) {
  const running = () => db.prepare("SELECT COUNT(*) count FROM turns WHERE json_extract(document,'$.status')='running'").get().count > 0
  function exportData() {
    return transaction(() => {
      if (running()) throw new ValidationError('析熙还在处理消息，请等回复结束再备份', 409)
      const tables = Object.fromEntries(Object.entries(columns).map(([table, fields]) => [table, db.prepare(`SELECT ${fields.join(',')} FROM ${table}`).all().filter(row => table !== 'state' || stateAllowed(row.key))]))
      const backup = { format: 'astaria-backup', version: 1, createdAt: new Date().toISOString(), tables, checksum: checksum(tables) }
      if (backupByteLength(serializeBackup(backup)) > BACKUP_MAX_BYTES) throw new ValidationError(BACKUP_EXPORT_TOO_LARGE, 413)
      return backup
    })
  }
  function importData(input) {
    knownKeys(input, ['format', 'version', 'createdAt', 'tables', 'checksum'], '备份')
    if (input.format !== 'astaria-backup' || input.version !== 1) fail('不是支持的 ASTaria 备份')
    stamp(input.createdAt)
    if (backupByteLength(serializeBackup(input)) > BACKUP_MAX_BYTES) throw new ValidationError(BACKUP_IMPORT_TOO_LARGE, 413)
    knownKeys(input.tables, Object.keys(columns), '备份数据表')
    if (Object.keys(input.tables).length !== Object.keys(columns).length || checksum(input.tables) !== input.checksum) fail('备份缺失或校验不一致')
    for (const [table, fields] of Object.entries(columns)) {
      const rows = input.tables[table]
      if (!Array.isArray(rows) || rows.length > 100000) fail('备份记录数量无效')
      for (const row of rows) {
        knownKeys(row, fields, '备份记录')
        if (Object.keys(row).length !== fields.length || Object.values(row).some(value => value !== null && typeof value !== 'string' && !Number.isSafeInteger(value))) fail('备份字段无效')
        if ('id' in row && table !== 'task_completion_history') identifier(row.id)
        if (documentTables.has(table) || table === 'messages') {
          let document
          try { document = JSON.parse(row.document) } catch { fail('备份记录无法解析') }
          if (!document || typeof document !== 'object' || Array.isArray(document)) fail('备份记录格式无效')
          const recordId = table === 'availability' ? document.date : table === 'summaries' ? document.conversationId : table === 'turns' ? document.requestId : document.id
          if (recordId !== row.id) fail('备份记录标识不一致')
          validateDocument(table, document)
          if (table === 'messages') {
            if (!Number.isSafeInteger(row.seq) || row.seq < 1 || document.conversationId !== row.conversationId || document.role !== row.role) fail('备份对话索引无效')
            text(document.content ?? '', '备份消息', 64000, { empty: true })
          }
          if (table === 'turns' && document.status === 'running') fail('备份含未完成的请求，请使用完整备份')
        }
        if (table === 'state') {
          if (!stateAllowed(row.key) || typeof row.value !== 'string') fail('备份包含不支持的设置')
          if (row.key.startsWith('deleted-')) { identifier(row.key.split(':').slice(1).join(':')); if (row.value.startsWith('{')) object(parse(row.value)); else stamp(row.value) }
          else if (!['activeConversation', 'deepseekModel'].includes(row.key)) {
            const value = parse(row.value, '备份设置'); object(value)
            if (row.key === 'companion-v1') validateCompanionState(value)
            if (row.key === 'preferences:model-connection') validateModelSettings(value)
            if (row.key === 'preferences:free-time-daily') {
              knownKeys(value, ['date', 'completedAt', 'policyVersion'], '余时每日安排记录')
              day(value.date); stamp(value.completedAt)
              if (value.policyVersion !== undefined) integer(value.policyVersion, 1)
            }
          }
        }
        if (table === 'conversations') { text(row.title, '对话名', 120); stamp(row.createdAt); stamp(row.updatedAt); choice(row.titleEdited, [0, 1], '对话标题状态') }
        if (table === 'task_completion_history') { integer(row.id, 1); identifier(row.taskId); choice(row.beforeStatus, ['todo', 'doing', 'done', 'dropped'], '完成前状态'); stamp(row.completionDoneAt); stamp(row.completedAt); optionalStamp(row.closedAt) }
      }
    }
    const openCompletions = new Set()
    for (const row of input.tables.task_completion_history) {
      if (row.closedAt !== null) continue
      if (openCompletions.has(row.taskId)) fail('备份中同一任务有多条未撤回的完成记录，请使用有效备份')
      openCompletions.add(row.taskId)
    }
    return transaction(() => {
      if (running()) throw new ValidationError('析熙还在处理消息，请等回复结束再恢复', 409)
      const priorRevision = JSON.parse(db.prepare("SELECT value FROM state WHERE key='planner-v1'").get()?.value ?? '{}').revision ?? 0
      const oldRequests = db.prepare('SELECT id FROM turns').all()
      const previousVersions = new Map(db.prepare('SELECT id,document FROM tasks').all().map(row => [row.id, JSON.parse(row.document).updatedAt]))
      const previousMemories = new Map(db.prepare('SELECT id,document FROM memories').all().map(row => [row.id, JSON.parse(row.document).updatedAt]))
      const priorHidden = new Set(db.prepare("SELECT id FROM messages WHERE json_extract(document,'$.excludeFromContext')=1").all().map(row => row.id))
      const priorTombstones = db.prepare("SELECT key,value FROM state WHERE key LIKE 'deleted-conversation:%' OR key LIKE 'deleted-request:%'").all()
      const priorConversations = db.prepare('SELECT id FROM conversations').all()
      for (const table of ['messages', ...Object.keys(columns).filter(table => table !== 'messages')]) db.prepare(`DELETE FROM ${table}`).run()
      for (const [table, fields] of Object.entries(columns)) {
        const insert = db.prepare(`INSERT INTO ${table} (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')})`)
        for (const row of input.tables[table]) insert.run(...fields.map(key => row[key]))
      }
      if (db.prepare('PRAGMA foreign_key_check').all().length) fail('备份对话关联不完整')
      validate()
      const stampNow = new Date().toISOString(), tombstone = db.prepare('INSERT OR REPLACE INTO state(key,value) VALUES(?,?)')
      for (const row of priorTombstones) tombstone.run(row.key, row.value)
      const deletedConversations = new Set(db.prepare("SELECT key FROM state WHERE key LIKE 'deleted-conversation:%'").all().map(row => row.key.slice('deleted-conversation:'.length)))
      const deletedRequests = new Set(db.prepare("SELECT key FROM state WHERE key LIKE 'deleted-request:%'").all().map(row => row.key.slice('deleted-request:'.length)))
      const messages = db.prepare('SELECT id,seq,document FROM messages').all().map(row => ({ ...JSON.parse(row.document), seq: row.seq }))
      const byMessage = new Map(messages.map(message => [message.id, message]))
      const hidden = new Set([...priorHidden, ...messages.filter(message => message.excludeFromContext || message.retractedAt || message.contextRetractedAt || deletedConversations.has(message.conversationId) || deletedRequests.has(message.requestId)).map(message => message.id)])
      let expanded = true
      while (expanded) {
        expanded = false
        const requests = new Set(messages.filter(message => hidden.has(message.id)).map(message => message.requestId).filter(Boolean))
        for (const message of messages) if (requests.has(message.requestId) || message.sourceMessageIds?.some(id => hidden.has(id))) {
          if (!hidden.has(message.id)) { hidden.add(message.id); expanded = true }
        }
      }
      const saveDocument = (table, id, document) => db.prepare(`UPDATE ${table} SET document=? WHERE id=?`).run(JSON.stringify(document), id)
      for (const message of messages) {
        if (!hidden.has(message.id) && message.sourceMessageIds?.some(id => !byMessage.has(id) || byMessage.get(id).seq >= message.seq)) fail('备份消息来源不完整或顺序无效')
        if (hidden.has(message.id)) { const { seq: unused, ...document } = message; saveDocument('messages', message.id, { ...document, excludeFromContext: true, contextRetractedAt: document.contextRetractedAt ?? stampNow }) }
      }
      const advance = (old, restored) => new Date(Math.max(Date.now(), Date.parse(old ?? 0) || 0, Date.parse(restored) || 0) + 1).toISOString()
      for (const row of db.prepare('SELECT id,document FROM tasks').all()) {
        const task = JSON.parse(row.document); task.updatedAt = advance(previousVersions.get(row.id), task.updatedAt); saveDocument('tasks', row.id, task)
      }
      db.prepare("DELETE FROM state WHERE key LIKE 'task-undo-version:%'").run()
      for (const row of db.prepare('SELECT id,document FROM memories').all()) {
        const memory = JSON.parse(row.document), sourceMessage = byMessage.get(memory.sourceMessageId)
        if (!sourceMessage || sourceMessage.role !== 'user' || hidden.has(memory.sourceMessageId)) memory.deletedAt = stampNow
        else if (memory.evidence && !sourceMessage.content.includes(memory.evidence)) fail('备份记忆原话不匹配')
        memory.updatedAt = advance(previousMemories.get(row.id), memory.updatedAt); saveDocument('memories', row.id, memory)
      }
      for (const row of db.prepare('SELECT id,document FROM summaries').all()) {
        const summary = JSON.parse(row.document)
        if (!db.prepare('SELECT 1 FROM conversations WHERE id=?').get(summary.conversationId) || summary.sourceMessageIds.some(id => !byMessage.has(id) || hidden.has(id) || byMessage.get(id).conversationId !== summary.conversationId || byMessage.get(id).seq > summary.throughSeq)) db.prepare('DELETE FROM summaries WHERE id=?').run(row.id)
      }
      for (const row of db.prepare('SELECT id,document FROM turns').all()) {
        const turn = JSON.parse(row.document), user = byMessage.get(turn.userMessageId)
        if (!user || user.role !== 'user' || user.conversationId !== turn.conversationId || user.requestId !== turn.requestId || turn.text !== user.content) fail('备份请求与原话不一致')
        // An interrupted tool loop from a different database epoch is never
        // resumed. The original message remains available for a fresh request.
        if (turn.status === 'failed' || hidden.has(user.id)) turn.retractedAt = turn.retractedAt ?? stampNow
        delete turn.ownerPid; delete turn.ownerToken; saveDocument('turns', row.id, turn)
      }
      for (const row of db.prepare('SELECT id,document FROM operations').all()) {
        const operation = JSON.parse(row.document)
        const safe = { id: operation.id, requestId: operation.requestId, summary: operation.summary, kind: 'restored', changes: [],
          createdAt: operation.createdAt, readAt: operation.readAt ?? null, undoneAt: operation.undoneAt ?? null, undoable: false,
          ...(operation.planChanges ? { planChanges: operation.planChanges } : {}) }
        if (messages.some(message => message.requestId === operation.requestId && hidden.has(message.id))) safe.summary = '已失效来源的历史变更'
        saveDocument('operations', row.id, safe)
      }
      const companionRow = db.prepare("SELECT value FROM state WHERE key='companion-v1'").get()
      if (companionRow) {
        const value = JSON.parse(companionRow.value)
        const keep = item => {
          if (item.source.kind !== 'conversation') return true
          const sourceMessage = byMessage.get(item.source.messageId)
          if (!sourceMessage || hidden.has(sourceMessage.id)) return false
          if (sourceMessage.role !== 'user' || !sourceMessage.content.includes(item.source.evidence)) fail('备份陪伴记录原话不匹配')
          return true
        }
        value.handoffs = value.handoffs.filter(item => keep(item) && db.prepare('SELECT 1 FROM tasks WHERE id=?').get(item.taskId)).map(item => ({ ...item, version: integer(item.version + 1, 1), updatedAt: stampNow }))
        value.wishes = value.wishes.filter(keep).map(item => ({ ...item, version: integer(item.version + 1, 1), updatedAt: stampNow }))
        value.freeTimeGoals = (value.freeTimeGoals ?? []).filter(keep).map(item => ({ ...item, version: integer(item.version + 1, 1), updatedAt: stampNow }))
        value.freeTimeHistory = (value.freeTimeHistory ?? []).filter(item => value.freeTimeGoals.some(goal => goal.id === item.goalId))
        value.scenarios = value.scenarios.filter(keep).map(item => ({ ...item, version: integer(item.version + 1, 1), status: item.status === 'preview' ? 'discarded' : item.status }))
        tombstone.run('companion-v1', JSON.stringify(value))
      }
      for (const conversationId of deletedConversations) {
        db.prepare('DELETE FROM messages WHERE conversationId=?').run(conversationId)
        db.prepare('DELETE FROM conversations WHERE id=?').run(conversationId)
        db.prepare('DELETE FROM summaries WHERE id=?').run(conversationId)
        db.prepare("DELETE FROM turns WHERE json_extract(document,'$.conversationId')=?").run(conversationId)
      }
      const activeConversation = db.prepare("SELECT value FROM state WHERE key='activeConversation'").get()?.value
      if (activeConversation && !db.prepare('SELECT 1 FROM conversations WHERE id=?').get(activeConversation)) db.prepare("DELETE FROM state WHERE key='activeConversation'").run()
      const restoredConversations = new Set(db.prepare('SELECT id FROM conversations').all().map(row => row.id))
      for (const row of priorConversations) if (!restoredConversations.has(row.id)) tombstone.run(`deleted-conversation:${row.id}`, stampNow)
      const schedule = db.prepare("SELECT value FROM state WHERE key='planner-v1'").get()
      if (schedule) {
        const value = JSON.parse(schedule.value)
        value.revision = Math.max(priorRevision, value.revision) + 1
        if (!Number.isSafeInteger(value.revision)) fail('备份日程版本无效')
        db.prepare("UPDATE state SET value=? WHERE key='planner-v1'").run(JSON.stringify(value))
      }
      const restoredRequests = new Set(input.tables.turns.map(row => row.id))
      for (const row of oldRequests) if (!restoredRequests.has(row.id)) tombstone.run(`deleted-request:${row.id}`, JSON.stringify({ restoredAt: new Date().toISOString() }))
      return { restored: true, restoredAt: new Date().toISOString() }
    })
  }
  return { exportData, importData }
}
