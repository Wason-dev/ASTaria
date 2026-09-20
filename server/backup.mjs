import { createHash } from 'node:crypto'
import { ValidationError, knownKeys, identifier, text, object, choice, dateTime, day, clockTime, taskInput, questionOptions, validateMemory } from './validation.mjs'

const columns = {
  areas: ['id', 'document'], tasks: ['id', 'document'], events: ['id', 'document'], availability: ['id', 'document'], assignments: ['id', 'document'],
  conversations: ['id', 'title', 'createdAt', 'updatedAt', 'titleEdited'],
  messages: ['seq', 'id', 'conversationId', 'role', 'document'], memories: ['id', 'document'], operations: ['id', 'document'], turns: ['id', 'document'], summaries: ['id', 'document'],
  task_completion_history: ['id', 'taskId', 'beforeStatus', 'completionDoneAt', 'completedAt', 'closedAt'], state: ['key', 'value'],
}
const documentTables = new Set(['areas', 'tasks', 'events', 'availability', 'assignments', 'memories', 'operations', 'turns', 'summaries'])
const stateAllowed = key => ['activeConversation', 'deepseekModel', 'planner-v1', 'planner-v1-weekend-defaults-v1', 'companion-v1', 'preferences:app'].includes(key) || /^(task-undo-version:|generated-area:|deleted-conversation:|deleted-request:)/u.test(key)
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
  knownKeys(value, ['id', 'taskId', 'title', 'date', 'start', 'end', 'locked'])
  identifier(value.id); identifier(value.taskId); day(value.date); clockTime(value.start); clockTime(value.end)
  if (value.start >= value.end) fail('备份时间段无效')
  if (value.locked !== undefined) bool(value.locked)
  if (value.title !== undefined) text(value.title, '任务名', 160)
}
function source(value) {
  knownKeys(value, ['kind', 'messageId', 'evidence', 'actionId'])
  choice(value.kind, ['user', 'conversation'], '来源')
  if (value.kind === 'conversation') { identifier(value.messageId); text(value.evidence, '原话', 2000) }
  if (value.evidence !== undefined) text(value.evidence, '原话', 2000)
  if (value.actionId !== undefined) identifier(value.actionId)
}
function companion(value) {
  knownKeys(value, ['handoffs', 'wishes', 'scenarios'])
  const unique = (rows, key) => { if (new Set(rows.map(item => item[key])).size !== rows.length) fail('备份记录标识重复') }
  for (const item of array(value.handoffs, 2000)) {
    knownKeys(item, ['taskId', 'progress', 'obstacle', 'nextStep', 'materials', 'version', 'source', 'createdAt', 'updatedAt'])
    identifier(item.taskId); integer(item.version, 1); source(item.source); stamp(item.createdAt); stamp(item.updatedAt)
    for (const key of ['progress', 'obstacle', 'nextStep']) text(item[key], key, 1500, { empty: true })
    array(item.materials, 20).forEach(material => text(material, '材料', 300))
  }
  unique(value.handoffs, 'taskId')
  for (const item of array(value.wishes, 500)) {
    knownKeys(item, ['id', 'content', 'evidence', 'minutes', 'minutesEstimated', 'items', 'expiresAt', 'status', 'version', 'source', 'createdAt', 'updatedAt'])
    identifier(item.id); text(item.content, '牵挂', 600); text(item.evidence, '原话', 2000); integer(item.minutes, 5, 720)
    if (item.minutesEstimated !== undefined) bool(item.minutesEstimated)
    array(item.items, 20).forEach(condition => text(condition, '条件', 300)); optionalStamp(item.expiresAt)
    choice(item.status, ['active', 'paused', 'deleted'], '牵挂状态'); integer(item.version, 1); source(item.source); stamp(item.createdAt); stamp(item.updatedAt)
  }
  unique(value.wishes, 'id')
  for (const item of array(value.scenarios, 100)) {
    knownKeys(item, ['id', 'version', 'status', 'baseRevision', 'date', 'days', 'mode', 'budgetMin', 'bufferMin', 'timezone', 'plans', 'removedBlockIds', 'unscheduled', 'warnings', 'taskVersions', 'source', 'createdAt', 'metrics', 'operationId', 'appliedAt'])
    identifier(item.id); integer(item.version, 1); integer(item.baseRevision); day(item.date); integer(item.days, 1, 7)
    choice(item.mode, ['rebalance', 'rest', 'light'], '推演方式'); choice(item.status, ['preview', 'applied', 'discarded', 'undone'], '方案状态')
    integer(item.budgetMin, 15, 720); integer(item.bufferMin, 0, 60); text(item.timezone, '时区', 100)
    try { new Intl.DateTimeFormat('en', { timeZone: item.timezone }) } catch { fail('备份时区无效') }
    array(item.plans, 64).forEach(block); ids(item.removedBlockIds); unique(item.plans, 'id')
    for (const pending of array(item.unscheduled, 64)) { knownKeys(pending, ['taskId', 'title', 'remainingMin', 'reason']); identifier(pending.taskId); text(pending.title, '任务名', 160); text(pending.reason, '原因', 600); if (pending.remainingMin !== null) integer(pending.remainingMin, 0, 525600) }
    array(item.warnings, 100).forEach(warning => text(warning, '提示', 1000)); object(item.taskVersions)
    for (const [id, updatedAt] of Object.entries(item.taskVersions)) { identifier(id); stamp(updatedAt) }
    source(item.source); stamp(item.createdAt); optionalStamp(item.appliedAt); if (item.operationId !== undefined) identifier(item.operationId)
    knownKeys(item.metrics, ['scheduledMin', 'unscheduledMin', 'bufferMin']); Object.values(item.metrics).forEach(value => integer(value))
  }
  unique(value.scenarios, 'id')
}

function validateDocument(table, document) {
  if (table === 'messages') {
    knownKeys(document, ['id', 'conversationId', 'role', 'content', 'requestId', 'taskId', 'toolCallId', 'toolCalls', 'question', 'sourceMessageIds', 'createdAt', 'excludeFromContext', 'retractedAt', 'contextRetractedAt'])
    identifier(document.conversationId); choice(document.role, ['user', 'assistant', 'tool'], '消息角色'); stamp(document.createdAt); bool(document.excludeFromContext)
    for (const key of ['requestId', 'taskId', 'toolCallId']) if (document[key] !== undefined) identifier(document[key])
    optionalStamp(document.retractedAt); optionalStamp(document.contextRetractedAt)
    if (document.sourceMessageIds !== undefined) ids(document.sourceMessageIds)
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
    knownKeys(document, ['requestId', 'conversationId', 'text', 'context', 'userMessageId', 'status', 'ownerPid', 'ownerToken', 'createdAt', 'updatedAt', 'error', 'result', 'retractedAt'])
    identifier(document.requestId); identifier(document.conversationId); identifier(document.userMessageId); text(document.text, '请求', 16000)
    knownKeys(document.context, ['timezone', 'page', 'taskId', 'date']); text(document.context.timezone, '时区', 100)
    if (document.context.taskId !== undefined) identifier(document.context.taskId)
    if (document.context.date !== undefined) day(document.context.date)
    if (document.context.page !== undefined) text(document.context.page, '页面', 100)
    choice(document.status, ['completed', 'failed'], '请求状态'); stamp(document.createdAt); stamp(document.updatedAt); optionalStamp(document.retractedAt)
    if (document.error !== undefined) text(document.error, '请求错误', 2000)
    if (document.result !== undefined) { knownKeys(document.result, ['requestId', 'conversationId', 'status', 'error']); identifier(document.result.requestId); identifier(document.result.conversationId); choice(document.result.status, ['completed', 'failed'], '请求结果'); if (document.result.error !== undefined) text(document.result.error, '请求错误', 2000) }
  } else if (table === 'operations') {
    knownKeys(document, ['id', 'requestId', 'summary', 'kind', 'changes', 'createdAt', 'readAt', 'undoneAt', 'undoable', 'requestedChanges', 'removedAssignments', 'memoryId', 'requestedActions', 'plannerBefore', 'plannerAfterRevision', 'planChanges'])
    identifier(document.requestId); text(document.summary, '操作摘要', 2000); stamp(document.createdAt); optionalStamp(document.readAt); optionalStamp(document.undoneAt)
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
    if (document.requestedActions !== undefined) for (const action of array(document.requestedActions, 128)) { choice(action.type, ['save-block', 'delete-block', 'save-details', 'set-day-template', 'remove-day-template', 'edit-weekday'], '操作类型') }
    if (document.plannerBefore !== undefined) object(document.plannerBefore)
    if (document.plannerAfterRevision !== undefined) integer(document.plannerAfterRevision)
    if (document.planChanges !== undefined) for (const change of array(document.planChanges, 128)) { knownKeys(change, ['id', 'before', 'after']); identifier(change.id); if (change.before !== null) block(change.before); if (change.after !== null) block(change.after) }
  }
}

export function createBackupStore({ db, transaction, validate }) {
  const running = () => db.prepare("SELECT COUNT(*) count FROM turns WHERE json_extract(document,'$.status')='running'").get().count > 0
  function exportData() {
    return transaction(() => {
      if (running()) throw new ValidationError('析熙还在处理消息，请等回复结束再备份', 409)
      const tables = Object.fromEntries(Object.entries(columns).map(([table, fields]) => [table, db.prepare(`SELECT ${fields.join(',')} FROM ${table}`).all().filter(row => table !== 'state' || stateAllowed(row.key))]))
      return { format: 'astaria-backup', version: 1, createdAt: new Date().toISOString(), tables, checksum: checksum(tables) }
    })
  }
  function importData(input) {
    knownKeys(input, ['format', 'version', 'createdAt', 'tables', 'checksum'], '备份')
    if (input.format !== 'astaria-backup' || input.version !== 1) fail('不是支持的 ASTaria 备份')
    stamp(input.createdAt)
    if (Buffer.byteLength(JSON.stringify(input)) > 32 * 1024 * 1024) fail('备份超过 32MB')
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
            if (row.key === 'companion-v1') companion(value)
          }
        }
        if (table === 'conversations') { text(row.title, '对话名', 120); stamp(row.createdAt); stamp(row.updatedAt); choice(row.titleEdited, [0, 1], '对话标题状态') }
        if (table === 'task_completion_history') { integer(row.id, 1); identifier(row.taskId); choice(row.beforeStatus, ['todo', 'doing', 'done', 'dropped'], '完成前状态'); stamp(row.completionDoneAt); stamp(row.completedAt); optionalStamp(row.closedAt) }
      }
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
