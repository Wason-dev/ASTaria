import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { createPlannerStore } from './planner.mjs'
import { createBackupStore } from './backup.mjs'
import { validatePreferences } from './preferences.mjs'
import {
  ValidationError, object, knownKeys, text, identifier, choice, number, day, dateTime, clockTime,
  jsonValue, taskInput, eventInput, assignmentInput, validateMemory, questionOptions,
} from './validation.mjs'

const SEED_AREAS = [
  ['math', '数学', 'deep'], ['chinese', '语文', 'deep'], ['english', '英语', 'deep'],
  ['physics', '物理', 'deep'], ['work', '工作', 'deep'],
  ['life', '生活', 'light'], ['projects', '项目', 'deep'],
]
const now = () => new Date().toISOString()
const nextTimestamp = previous => {
  const prior = previous ? Date.parse(previous) : Number.NaN
  return new Date(Math.max(Date.now(), Number.isFinite(prior) ? prior + 1 : 0)).toISOString()
}
const clean = value => JSON.parse(JSON.stringify(value))
const same = (a, b) => isDeepStrictEqual(clean(a), clean(b))
const fail = (message, status = 400) => { throw new ValidationError(message, status) }
const BUSINESS_TABLES = new Set(['tasks', 'areas', 'events', 'availability', 'assignments'])
const DOCUMENT_TABLES = new Set([...BUSINESS_TABLES, 'memories', 'operations', 'turns', 'summaries'])
const processAlive = pid => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/** Opening is explicit; importing this module never touches a user's data. */
export function createDatabase(filename) {
  if (filename !== ':memory:') {
    text(filename, '数据库路径', 4096)
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 })
    chmodSync(dirname(filename), 0o700)
  }
  const db = new DatabaseSync(filename)
  const ownerToken = randomUUID()
  if (filename !== ':memory:') chmodSync(filename, 0o600)
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS areas (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS availability (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS assignments (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS turns (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS summaries (id TEXT PRIMARY KEY, document TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_completion_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      taskId TEXT NOT NULL,
      beforeStatus TEXT NOT NULL,
      completionDoneAt TEXT NOT NULL,
      completedAt TEXT NOT NULL,
      closedAt TEXT
    );
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL,
      conversationId TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
      document TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tasks_active_created ON tasks(json_extract(document, '$.deletedAt'), json_extract(document, '$.createdAt'));
    CREATE INDEX IF NOT EXISTS tasks_status ON tasks(json_extract(document, '$.status'));
    CREATE INDEX IF NOT EXISTS assignments_task ON assignments(json_extract(document, '$.taskId'));
    CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversationId, seq);
    CREATE INDEX IF NOT EXISTS messages_request ON messages(json_extract(document, '$.requestId'));
    CREATE INDEX IF NOT EXISTS memories_source ON memories(json_extract(document, '$.sourceMessageId'));
    CREATE INDEX IF NOT EXISTS task_completion_task ON task_completion_history(taskId, id);
    CREATE UNIQUE INDEX IF NOT EXISTS task_completion_open ON task_completion_history(taskId) WHERE closedAt IS NULL;
  `)

  let depth = 0
  function transaction(fn) {
    if (typeof fn !== 'function' || fn.constructor.name === 'AsyncFunction') fail('数据库事务需要同步函数')
    const savepoint = `astaria_${depth++}`
    db.exec(depth === 1 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
    try {
      const result = fn()
      if (result && typeof result.then === 'function') fail('数据库事务不能跨越异步操作')
      db.exec(depth === 1 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`)
      return result
    } catch (error) {
      db.exec(depth === 1 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}`)
      throw error
    } finally { depth-- }
  }
  transaction(() => {
    const columns = new Set(db.prepare('PRAGMA table_info(conversations)').all().map(column => column.name))
    if (!columns.has('updatedAt')) db.exec('ALTER TABLE conversations ADD COLUMN updatedAt TEXT')
    if (!columns.has('titleEdited')) db.exec('ALTER TABLE conversations ADD COLUMN titleEdited INTEGER NOT NULL DEFAULT 0')
    db.exec(`UPDATE conversations SET updatedAt = COALESCE(
      (SELECT MAX(json_extract(document, '$.createdAt')) FROM messages WHERE conversationId = conversations.id), createdAt)
      WHERE updatedAt IS NULL;
      PRAGMA user_version = 3;`)
  })
  const planner = createPlannerStore({ db, transaction, getTask: id => get('tasks', id), listTasks })
  function assertTable(table) {
    if (!DOCUMENT_TABLES.has(table)) fail('不支持的数据表')
  }
  function get(table, id) {
    assertTable(table)
    const row = db.prepare(`SELECT document FROM ${table} WHERE id = ?`).get(identifier(id))
    return row ? JSON.parse(row.document) : null
  }
  function put(table, id, document, ignore = false) {
    assertTable(table)
    if (table === 'tasks') return transaction(() => {
      const previous = get('tasks', id)
      if (ignore && previous) return 0
      // updatedAt is also the browser's optimistic concurrency token. Every
      // committed write advances it, including AI/undo writes in the same ms.
      if (previous && Date.parse(document.updatedAt) <= Date.parse(previous.updatedAt)) {
        document.updatedAt = nextTimestamp(previous.updatedAt)
      }
      if (previous && previous.status !== 'done' && document.status === 'done') document.doneAt = document.updatedAt
      const changes = putDocument(table, id, document, ignore)
      if (changes) {
        db.prepare('DELETE FROM state WHERE key = ?').run(`task-undo-version:${id}`)
        recordTaskCompletion(previous, document)
        if (document.deletedAt) planner.removeTask(id)
        else planner.syncRecurringTaskPlan(previous, document)
      }
      return changes
    })
    return putDocument(table, id, document, ignore)
  }
  function putDocument(table, id, document, ignore) {
    if (table === 'tasks') assertOccurrenceUnique(document)
    const result = db.prepare(ignore
      ? `INSERT OR IGNORE INTO ${table} (id, document) VALUES (?, ?)`
      : `INSERT INTO ${table} (id, document) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET document = excluded.document`
    ).run(identifier(id), JSON.stringify(document))
    return result.changes
  }
  function assertOccurrenceUnique(task) {
    if (!task.occurrence || task.deletedAt) return
    const duplicate = db.prepare(`SELECT id FROM tasks WHERE id != ?
      AND json_extract(document, '$.deletedAt') IS NULL
      AND json_extract(document, '$.occurrence.seriesId') = ?
      AND json_extract(document, '$.occurrence.date') = ? LIMIT 1`)
      .get(task.id, task.occurrence.seriesId, task.occurrence.date)
    if (duplicate) fail(`这个重复系列在${task.occurrence.date}已有实例，请修改原实例，不要在同一天重复生成`, 409)
  }
  function remove(table, id) {
    assertTable(table)
    if (table === 'tasks') return transaction(() => {
      const previous = get('tasks', id)
      db.prepare('DELETE FROM tasks WHERE id = ?').run(identifier(id))
      db.prepare('DELETE FROM state WHERE key = ?').run(`task-undo-version:${id}`)
      recordTaskCompletion(previous, null)
      planner.removeTask(id)
    })
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(identifier(id))
  }
  function all(table) {
    assertTable(table)
    return db.prepare(`SELECT document FROM ${table}`).all().map(row => JSON.parse(row.document))
  }
  function fullTask(input) {
    const value = { ...taskInput(input), id: identifier(input.id), createdAt: dateTime(input.createdAt, '创建时间'), updatedAt: dateTime(input.updatedAt, '修改时间') }
    if (value.area && !get('areas', value.area)) {
      ensureSeedArea(value.area)
      if (!get('areas', value.area)) fail('任务分类不存在')
    }
    if (value.status === 'done' && !value.doneAt) value.doneAt = value.updatedAt
    if (value.status !== 'done') delete value.doneAt
    return clean(value)
  }
  function listTasks(filter = {}) {
    knownKeys(filter, ['includeDeleted', 'inbox', 'area', 'status', 'visibleAt'], '任务筛选')
    for (const key of ['inbox', 'includeDeleted']) if (filter[key] !== undefined && typeof filter[key] !== 'boolean') fail('任务筛选开关格式不正确')
    if (filter.area !== undefined) identifier(filter.area, '分类')
    if (filter.status !== undefined) choice(filter.status, ['todo', 'doing', 'done', 'dropped'], '任务状态')
    const conditions = [], params = []
    if (!filter.includeDeleted) conditions.push("json_extract(document, '$.deletedAt') IS NULL")
    for (const key of ['inbox', 'area', 'status']) {
      if (filter[key] === undefined) continue
      conditions.push(`json_extract(document, '$.${key}') = ?`)
      params.push(typeof filter[key] === 'boolean' ? Number(filter[key]) : filter[key])
    }
    if (filter.visibleAt) {
      dateTime(filter.visibleAt, '可见时间')
      conditions.push("(json_extract(document, '$.surfaceAt') IS NULL OR json_extract(document, '$.surfaceAt') <= ? OR json_extract(document, '$.due') <= ?)")
      params.push(filter.visibleAt, filter.visibleAt)
    }
    return db.prepare(`SELECT document FROM tasks${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY json_extract(document, '$.createdAt') DESC, id`).all(...params).map(row => JSON.parse(row.document))
  }
  function createTask(draft) {
    const timestamp = now()
    const task = fullTask({ ...taskInput(draft), id: randomUUID(), createdAt: timestamp, updatedAt: timestamp })
    put('tasks', task.id, task)
    return task
  }
  function updateTask(id, patch, expectedUpdatedAt) {
    return transaction(() => {
      const current = get('tasks', id)
      if (!current) fail('找不到这条任务', 404)
      if (expectedUpdatedAt !== undefined && current.updatedAt !== expectedUpdatedAt) fail('事项已在其他窗口更新，请重新读取后再修改', 409)
      const updatedAt = nextTimestamp(current.updatedAt)
      const task = fullTask({ ...current, ...taskInput(patch, { partial: true }), id: current.id, createdAt: current.createdAt, updatedAt })
      put('tasks', id, task)
      if (task.deletedAt) cleanAssignments(id)
      return task
    })
  }
  function recordTaskCompletion(before, after) {
    const taskId = after?.id ?? before?.id
    if (!taskId) return
    let active = db.prepare('SELECT id FROM task_completion_history WHERE taskId = ? AND closedAt IS NULL').get(taskId)
    const append = (task, beforeStatus) => db.prepare(`INSERT INTO task_completion_history
      (taskId,beforeStatus,completionDoneAt,completedAt) VALUES (?,?,?,?)`)
      .run(taskId, beforeStatus, task.doneAt ?? task.updatedAt, task.updatedAt)
    // Existing completed tasks may predate this history. Preserve their known
    // completion date before any edit/reopen, with a safe actionable fallback.
    if (before?.status === 'done' && !active) {
      const result = append(before, 'todo')
      active = { id: result.lastInsertRowid }
    }
    if (after?.status === 'done' && before?.status !== 'done') {
      if (active) db.prepare('UPDATE task_completion_history SET closedAt = ? WHERE id = ?').run(now(), active.id)
      append(after, before?.status ?? 'todo')
    } else if (active && after?.status !== 'done') {
      db.prepare('UPDATE task_completion_history SET closedAt = ? WHERE id = ?').run(now(), active.id)
    }
  }
  function reopenTask(id, expectedUpdatedAt) {
    return transaction(() => {
      const taskId = identifier(id, '任务标识')
      const expected = dateTime(expectedUpdatedAt, '任务版本')
      const current = get('tasks', taskId)
      if (!current) fail('找不到这条任务', 404)
      if (current.deletedAt) fail('已删除的任务不能重新打开', 409)
      if (current.status !== 'done') fail('这条任务尚未完成', 409)
      if (current.updatedAt !== expected) fail('任务已在其他窗口修改，请刷新后重试', 409)
      const history = db.prepare(`SELECT beforeStatus FROM task_completion_history
        WHERE taskId = ? AND closedAt IS NULL`).get(taskId)
      const restoredStatus = history && ['todo', 'doing'].includes(history.beforeStatus) ? history.beforeStatus : 'todo'
      const task = fullTask({ ...current, status: restoredStatus, doneAt: undefined, updatedAt: nextTimestamp(current.updatedAt) })
      delete task.doneAt
      put('tasks', taskId, task)
      return task
    })
  }
  function listTaskCompletionHistory(taskId) {
    return db.prepare(`SELECT id,taskId,beforeStatus,completionDoneAt,completedAt,closedAt
      FROM task_completion_history WHERE taskId = ? ORDER BY id`).all(identifier(taskId, '任务标识'))
  }
  function restoreTaskSnapshot(taskId, snapshot) {
    const current = get('tasks', taskId)
    const active = db.prepare('SELECT id FROM task_completion_history WHERE taskId = ? AND closedAt IS NULL').get(taskId)
    if (current?.status === 'done' && snapshot.status !== 'done' && active) {
      db.prepare('UPDATE task_completion_history SET closedAt = ? WHERE id = ?').run(now(), active.id)
    } else if (snapshot.status === 'done' && current?.status !== 'done') {
      const doneAt = snapshot.doneAt ?? snapshot.updatedAt
      const historical = db.prepare(`SELECT id FROM task_completion_history
        WHERE taskId = ? AND completionDoneAt = ? ORDER BY id DESC LIMIT 1`).get(taskId, doneAt)
      if (historical) db.prepare('UPDATE task_completion_history SET closedAt = NULL WHERE id = ?').run(historical.id)
      else db.prepare(`INSERT INTO task_completion_history
        (taskId,beforeStatus,completionDoneAt,completedAt) VALUES (?,?,?,?)`)
        .run(taskId, 'todo', doneAt, snapshot.updatedAt)
    }
    const restored = { ...clean(snapshot), updatedAt: nextTimestamp(current?.updatedAt ?? snapshot.updatedAt) }
    // Completion evidence retains its original date while the optimistic token
    // advances. A durable alias lets the next undo recognize this exact restored
    // snapshot; every ordinary task write clears that alias again.
    putDocument('tasks', taskId, restored)
    if (restored.deletedAt) planner.removeTask(taskId)
    db.prepare('INSERT OR REPLACE INTO state (key,value) VALUES (?,?)').run(`task-undo-version:${taskId}`,
      JSON.stringify({ updatedAt: restored.updatedAt, sourceUpdatedAt: snapshot.updatedAt }))
    return get('tasks', taskId)
  }
  function matchesUndoSnapshot(table, id, current, expected) {
    if (same(current, expected)) return true
    if (table !== 'tasks' || !current || !expected) return false
    const row = db.prepare('SELECT value FROM state WHERE key = ?').get(`task-undo-version:${id}`)
    if (!row) return false
    const restored = JSON.parse(row.value)
    return current.updatedAt === restored.updatedAt && same({ ...current, updatedAt: restored.sourceUpdatedAt }, expected)
  }
  function cleanAssignments(taskId) {
    db.prepare("DELETE FROM assignments WHERE json_extract(document, '$.taskId') = ?").run(taskId)
  }
  function listAreas() {
    transaction(() => { for (const [id] of SEED_AREAS) ensureSeedArea(id) })
    return all('areas').filter(area => !area.deletedAt).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }
  function ensureSeedArea(id) {
    const seed = SEED_AREAS.find(area => area[0] === id)
    if (!seed || get('areas', id)) return
    const [, name, defaultEnergy] = seed
    const timestamp = now()
    const area = { id, name, defaultEnergy, createdAt: timestamp, updatedAt: timestamp, deletedAt: null }
    if (put('areas', id, area, true)) {
      db.prepare('INSERT OR REPLACE INTO state (key,value) VALUES (?,?)').run(`generated-area:${id}`, JSON.stringify(area))
    }
  }
  function fullArea(input) {
    return { id: identifier(input.id), name: text(input.name, '分类名称', 100), defaultEnergy: choice(input.defaultEnergy, ['deep', 'light'], '分类精力', 'deep'), createdAt: dateTime(input.createdAt, '创建时间'), updatedAt: dateTime(input.updatedAt, '修改时间'), deletedAt: input.deletedAt == null ? null : dateTime(input.deletedAt, '删除时间') }
  }
  function createArea(name, defaultEnergy = 'deep') {
    const timestamp = now()
    const area = fullArea({ id: `custom-${randomUUID()}`, name, defaultEnergy, createdAt: timestamp, updatedAt: timestamp })
    put('areas', area.id, area)
    return area
  }
  function renameArea(id, name) {
    const current = get('areas', id)
    if (!current) fail('找不到这个分类', 404)
    const area = fullArea({ ...current, name, updatedAt: now() })
    put('areas', id, area)
    db.prepare('DELETE FROM state WHERE key = ?').run(`generated-area:${id}`)
    return area
  }
  function fullEvent(input) {
    return clean({ ...eventInput(input), id: identifier(input.id), updatedAt: dateTime(input.updatedAt, '修改时间'), deletedAt: input.deletedAt == null ? null : dateTime(input.deletedAt, '删除时间') })
  }
  function listEvents(from, to) {
    if (from) day(from)
    if (to) day(to)
    return all('events').filter(event => !event.deletedAt && (!from || event.endDate >= from) && (!to || event.startDate <= to)).sort((a, b) => a.startDate.localeCompare(b.startDate))
  }
  function createEvent(input) {
    const event = fullEvent({ ...input, id: randomUUID(), updatedAt: now(), deletedAt: null })
    put('events', event.id, event)
    return event
  }
  function deleteEvent(id) {
    const current = get('events', id)
    if (current) put('events', id, { ...current, updatedAt: now(), deletedAt: now() })
  }
  function fullAvailability(input) {
    return { date: day(input.date), until: clockTime(input.until), updatedAt: dateTime(input.updatedAt, '修改时间') }
  }
  function saveAvailability(date, until) {
    const value = fullAvailability({ date, until, updatedAt: now() })
    put('availability', value.date, value)
    return value
  }
  function fullAssignment(input) {
    const value = clean({ ...assignmentInput(input), id: identifier(input.id), updatedAt: dateTime(input.updatedAt, '修改时间') })
    const task = get('tasks', value.taskId)
    if (!task || task.deletedAt) fail('安排关联的任务不存在', 409)
    return value
  }
  function saveAssignment(input) {
    const value = fullAssignment({ ...input, id: randomUUID(), updatedAt: now() })
    put('assignments', value.id, value)
    return value
  }
  function importLegacy(payload) {
    object(payload, '迁移数据')
    for (const key of Object.keys(payload)) if (!BUSINESS_TABLES.has(key)) fail(`迁移不支持字段：${key}`)
    return transaction(() => {
      const counts = {}
      for (const table of ['areas', 'tasks', 'events', 'availability', 'assignments']) {
        const rows = payload[table] ?? []
        if (!Array.isArray(rows) || rows.length > 10000) fail('单次迁移每类最多 10000 条')
        counts[table] = 0
        for (const row of rows) {
          object(row, '迁移记录')
          const id = identifier(table === 'availability' ? row.date : row.id)
          const existing = get(table, id)
          if (existing) {
            // A generated placeholder is not a user edit. The first real legacy
            // category replaces it, even when another browser loaded defaults first.
            const generated = table === 'areas' ? db.prepare('SELECT value FROM state WHERE key = ?').get(`generated-area:${id}`) : null
            if (generated && same(existing, JSON.parse(generated.value))) {
              put('areas', id, fullArea(row))
              db.prepare('DELETE FROM state WHERE key = ?').run(`generated-area:${id}`)
              counts.areas++
            }
            continue
          }
          // Historic orphan assignments are deliberately omitted, never revived.
          if (table === 'assignments' && (!get('tasks', row.taskId) || get('tasks', row.taskId).deletedAt)) continue
          const validate = { tasks: fullTask, areas: fullArea, events: fullEvent, availability: fullAvailability, assignments: fullAssignment }[table]
          counts[table] += Number(put(table, id, validate(row), true))
        }
      }
      return counts
    })
  }

  function ensureConversation(id) {
    return transaction(() => {
      identifier(id, '对话标识')
      if (db.prepare('SELECT 1 FROM state WHERE key = ?').get(`deleted-conversation:${id}`)) fail('这段对话已删除，请选择其他对话', 410)
      const existing = db.prepare('SELECT id,title,createdAt,updatedAt FROM conversations WHERE id = ?').get(id)
      if (existing) return existing
      const timestamp = now()
      db.prepare('INSERT INTO conversations (id,title,createdAt,updatedAt) VALUES (?,?,?,?)').run(id, '与析熙的对话', timestamp, conversationTimestamp())
      return db.prepare('SELECT id,title,createdAt,updatedAt FROM conversations WHERE id = ?').get(id)
    })
  }
  function createConversation({ title = '与析熙的对话' } = {}) {
    return transaction(() => {
      const timestamp = now()
      const conversation = { id: randomUUID(), title: text(title, '对话名称', 120), createdAt: timestamp, updatedAt: conversationTimestamp() }
      db.prepare('INSERT INTO conversations (id,title,createdAt,updatedAt) VALUES (?,?,?,?)').run(conversation.id, conversation.title, timestamp, conversation.updatedAt)
      db.prepare("INSERT INTO state (key,value) VALUES ('activeConversation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(conversation.id)
      return conversation
    })
  }
  function getActiveConversation() {
    return transaction(() => {
      const state = db.prepare("SELECT value FROM state WHERE key = 'activeConversation'").get()
      if (state && db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(state.value)) return ensureConversation(state.value)
      const latest = listConversations()[0]
      return latest ? selectConversation(latest.id) : createConversation()
    })
  }
  function getModel() {
    const stored = db.prepare("SELECT value FROM state WHERE key = 'deepseekModel'").get()?.value
    return ['deepseek-flash', 'deepseek-v4-pro'].includes(stored) ? stored : 'deepseek-flash'
  }
  function setModel(model) {
    choice(model, ['deepseek-flash', 'deepseek-v4-pro'], '模型')
    db.prepare("INSERT INTO state (key,value) VALUES ('deepseekModel',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(model)
    return model
  }
  function listConversations() {
    return db.prepare('SELECT id,title,createdAt,updatedAt FROM conversations ORDER BY updatedAt DESC, createdAt DESC, rowid DESC').all()
  }
  function conversationTimestamp() {
    // All activity writers hold the database transaction. Advance across every
    // conversation so same-ms writes (also from another connection) retain their
    // actual order instead of falling back to an older conversation's creation.
    const latest = db.prepare('SELECT MAX(updatedAt) AS updatedAt FROM conversations').get().updatedAt
    return nextTimestamp(latest)
  }
  function touchConversation(id) {
    const previous = db.prepare('SELECT updatedAt FROM conversations WHERE id = ?').get(id)
    if (!previous) fail('找不到这段对话', 404)
    const timestamp = conversationTimestamp()
    db.prepare('UPDATE conversations SET updatedAt = ? WHERE id = ?').run(timestamp, id)
  }
  function selectConversation(id) {
    return transaction(() => {
      const conversation = db.prepare('SELECT id,title,createdAt,updatedAt FROM conversations WHERE id = ?').get(identifier(id))
      if (!conversation) fail('找不到这段对话', 404)
      db.prepare("INSERT INTO state (key,value) VALUES ('activeConversation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(id)
      return conversation
    })
  }
  function renameConversation(id, title) {
    return transaction(() => {
      const conversationId = identifier(id, '对话标识')
      const current = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId)
      if (!current) fail('找不到这段对话', 404)
      const nextTitle = text(typeof title === 'string' ? title.trim() : title, '对话名称', 80)
      db.prepare('UPDATE conversations SET title = ?, titleEdited = 1 WHERE id = ?').run(nextTitle, conversationId)
      touchConversation(conversationId)
      return listConversations().find(item => item.id === conversationId)
    })
  }
  function deleteConversation(id) {
    return transaction(() => {
      const conversationId = identifier(id, '对话标识')
      const current = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId)
      if (!current) fail('找不到这段对话', 404)
      const count = Number(db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count)
      if (count <= 1) fail('至少保留一个对话', 409)
      const messages = db.prepare("SELECT id,json_extract(document, '$.requestId') AS requestId FROM messages WHERE conversationId = ?").all(conversationId)
      const messageIds = messages.map(message => message.id)
      const requestIds = new Set(messages.map(message => message.requestId).filter(Boolean))
      for (const turn of all('turns')) if (turn.conversationId === conversationId) requestIds.add(turn.requestId)
      // Keep only identifier tombstones, so other browsers and already running
      // model calls cannot recreate a conversation that the user has deleted.
      const deletedAt = now()
      const tombstone = db.prepare('INSERT OR REPLACE INTO state (key,value) VALUES (?,?)')
      tombstone.run(`deleted-conversation:${conversationId}`, deletedAt)
      for (const requestId of requestIds) tombstone.run(`deleted-request:${requestId}`, deletedAt)
      const excludedIds = excludeMessageSources(messageIds, { retractedAt: deletedAt })
      for (const memory of all('memories')) if (excludedIds.has(memory.sourceMessageId)) remove('memories', memory.id)
      const deleteOperations = db.prepare("DELETE FROM operations WHERE json_extract(document, '$.requestId') = ?")
      for (const requestId of requestIds) {
        deleteOperations.run(requestId)
        remove('turns', requestId)
      }
      db.prepare('DELETE FROM summaries WHERE id = ?').run(conversationId)
      db.prepare('DELETE FROM messages WHERE conversationId = ?').run(conversationId)
      db.prepare('DELETE FROM conversations WHERE id = ?').run(conversationId)
      const active = db.prepare("SELECT value FROM state WHERE key = 'activeConversation'").get()?.value
      let selectedId = active
      if (active === conversationId || !active || !db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(active)) {
        selectedId = listConversations()[0].id
        db.prepare("INSERT INTO state (key,value) VALUES ('activeConversation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(selectedId)
      }
      return { deletedId: conversationId, activeConversationId: selectedId }
    })
  }
  function decodeMessage(row) {
    return row ? { ...JSON.parse(row.document), seq: Number(row.seq) } : null
  }
  function getMessage(id) {
    return decodeMessage(db.prepare('SELECT seq,document FROM messages WHERE id = ?').get(identifier(id)))
  }
  function listMessages(conversationId, { limit = 80, before, forContext = false } = {}) {
    identifier(conversationId)
    number(limit, '消息数量', 1, 1000)
    if (!Number.isInteger(limit)) fail('消息数量必须是整数')
    if (before !== undefined) number(before, '消息序号', 1, Number.MAX_SAFE_INTEGER)
    return db.prepare(`SELECT seq,document FROM messages WHERE conversationId = ?${before === undefined ? '' : ' AND seq < ?'}${forContext ? " AND json_extract(document,'$.excludeFromContext') = 0" : ''} ORDER BY seq DESC LIMIT ?`)
      .all(conversationId, ...(before === undefined ? [] : [before]), limit).reverse().map(decodeMessage)
  }
  function hasSavedReasoning(conversationId, requestId) {
    return Boolean(db.prepare(`SELECT 1 FROM messages WHERE json_extract(document, '$.requestId') = ?
      AND conversationId = ? AND role = 'assistant'
      AND COALESCE(json_extract(document, '$.retractedAt'), '') = ''
      AND COALESCE(json_extract(document, '$.contextRetractedAt'), '') = ''
      AND COALESCE(json_extract(document, '$.excludeFromContext'), 0) = 0
      AND length(json_extract(document, '$.reasoningContent')) > 0 LIMIT 1`)
      .get(identifier(requestId, '请求标识'), identifier(conversationId, '对话标识')))
  }
  function appendMessage(input) {
    return transaction(() => appendMessageRecord(input))
  }
  function assertTurnWritable(requestId, sourceMessageIds = []) {
    if (!Array.isArray(sourceMessageIds)) fail('消息来源列表不正确')
    if (requestId && db.prepare('SELECT 1 FROM state WHERE key = ?').get(`deleted-request:${requestId}`)) fail('这段对话已删除，回复已停止', 410)
    const turn = requestId ? get('turns', requestId) : null
    if (turn?.retractedAt) fail('这条消息已撤回，不再继续处理', 409)
    if (sourceMessageIds.some(id => {
      const message = getMessage(id)
      return !message || message.retractedAt || message.contextRetractedAt
    })) fail('相关消息已撤回或删除，这次回复已停止，请重新发送', 409)
  }
  function appendMessageRecord(input) {
    object(input, '消息')
    assertTurnWritable(input.requestId, input.sourceMessageIds)
    if (input.question !== undefined && (input.role !== 'assistant' || input.toolCalls?.length)) fail('快捷问题只能附在完整的析熙消息中')
    if (input.reasoningContent != null && (input.role !== 'assistant' || typeof input.reasoningContent !== 'string' || input.reasoningContent.length > 2000000)) fail('模型思考内容格式不正确')
    let sourceMessageIds
    if (input.sourceMessageIds !== undefined) {
      if (!Array.isArray(input.sourceMessageIds) || input.sourceMessageIds.length > 10000) fail('消息来源列表不正确')
      sourceMessageIds = [...new Set(input.sourceMessageIds.map(id => identifier(id, '消息来源')))]
      for (const id of sourceMessageIds) if (!getMessage(id)) fail('消息来源不存在')
    }
    const message = clean({
      id: input.id ? identifier(input.id) : randomUUID(), conversationId: identifier(input.conversationId, '对话标识'),
      role: choice(input.role, ['user', 'assistant', 'tool'], '消息角色'),
      content: text(input.content ?? '', '消息内容', 64000, { empty: true }),
      requestId: input.requestId === undefined ? undefined : identifier(input.requestId, '请求标识'),
      taskId: input.taskId === undefined ? undefined : identifier(input.taskId, '任务标识'),
      toolCallId: input.toolCallId === undefined ? undefined : identifier(input.toolCallId, '工具调用标识'),
      toolCalls: input.toolCalls === undefined ? undefined : jsonValue(input.toolCalls, '工具调用', 64000),
      // DeepSeek thinking mode returns reasoning_content alongside the
      // assistant message. Keep the exact transcript and replay later tool turns;
      // the UI receives a separate, bounded view of model-returned reasoning.
      reasoningContent: input.reasoningContent ?? undefined,
      question: input.question === undefined ? undefined : questionOptions(input.question),
      sourceMessageIds,
      createdAt: now(), excludeFromContext: Boolean(sourceMessageIds?.some(id => getMessage(id).excludeFromContext)),
    })
    const previous = getMessage(message.id)
    if (previous) {
      const { seq, createdAt, excludeFromContext, ...stored } = previous
      const { createdAt: unused, excludeFromContext: unused2, ...incoming } = message
      if (!same(stored, incoming)) fail('消息标识已用于不同内容', 409)
      return previous
    }
    ensureConversation(message.conversationId)
    const result = db.prepare('INSERT INTO messages(id,conversationId,role,document) VALUES(?,?,?,?)').run(message.id, message.conversationId, message.role, JSON.stringify(message))
    if (message.role === 'user') {
      const users = db.prepare("SELECT COUNT(*) AS count FROM messages WHERE conversationId = ? AND role = 'user'").get(message.conversationId)
      if (users.count === 1) db.prepare("UPDATE conversations SET title = ? WHERE id = ? AND title = '与析熙的对话' AND titleEdited = 0").run(message.content.replace(/\s+/gu, ' ').slice(0, 32) || '与析熙的对话', message.conversationId)
    }
    touchConversation(message.conversationId)
    return { ...message, seq: Number(result.lastInsertRowid) }
  }
  function searchMessages(query, { taskId, limit = 12 } = {}) {
    const term = text(query, '检索词', 160)
    number(limit, '检索数量', 1, 100)
    if (!Number.isInteger(limit)) fail('检索数量必须是整数')
    const match = `%${term.replace(/[\\%_]/gu, '\\$&')}%`
    return db.prepare(`SELECT seq,document FROM messages WHERE json_extract(document,'$.excludeFromContext') = 0 AND json_extract(document,'$.content') LIKE ? ESCAPE '\\'${taskId ? " AND json_extract(document,'$.taskId') = ?" : ''} ORDER BY seq DESC LIMIT ?`)
      .all(match, ...(taskId ? [identifier(taskId)] : []), limit).map(decodeMessage)
  }
  function saveSummary(conversationId, input) {
    return transaction(() => saveSummaryRecord(conversationId, input))
  }
  function saveSummaryRecord(conversationId, input) {
    object(input, '摘要')
    if (!db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(identifier(conversationId))) fail('找不到这段对话', 404)
    const summary = {
      conversationId: identifier(conversationId), text: text(input.text, '摘要', 16000, { empty: true }),
      throughSeq: number(input.throughSeq, '摘要消息范围', 0, Number.MAX_SAFE_INTEGER),
      sourceMessageIds: input.sourceMessageIds, updatedAt: now(),
    }
    if (!Number.isInteger(summary.throughSeq)) fail('摘要消息范围必须是整数')
    if (!Array.isArray(summary.sourceMessageIds) || summary.sourceMessageIds.length > 10000) fail('摘要来源不正确')
    for (const id of summary.sourceMessageIds) {
      const source = getMessage(identifier(id))
      if (!source || source.conversationId !== conversationId || source.excludeFromContext || source.seq > summary.throughSeq) fail('摘要来源不可用')
    }
    put('summaries', conversationId, summary)
    return summary
  }
  function fullMemory(input) {
    const memory = clean({ ...validateMemory(input), id: identifier(input.id), createdAt: dateTime(input.createdAt, '创建时间'), updatedAt: dateTime(input.updatedAt, '修改时间'), deletedAt: input.deletedAt == null ? null : dateTime(input.deletedAt, '删除时间'), replacesId: input.replacesId === undefined ? undefined : identifier(input.replacesId), replacedBy: input.replacedBy === undefined ? undefined : identifier(input.replacedBy) })
    const source = getMessage(memory.sourceMessageId)
    if (!source || source.role !== 'user' || source.excludeFromContext) fail('记忆需要有效的用户原话作为来源')
    if (input.evidence !== undefined) {
      memory.evidence = text(input.evidence, '记忆原话', 2000)
      if (!source.content.includes(memory.evidence)) fail('记忆原话需要来自来源消息')
    }
    if (input.lifetime !== undefined) {
      memory.lifetime = choice(input.lifetime, ['temporary', 'long-term', 'inference'], '记忆有效类型')
      if (memory.lifetime === 'temporary' && !memory.expiresAt) fail('临时记忆需要明确有效期')
      if (memory.lifetime === 'inference' && !memory.expiresAt) fail('待确认推测需要有效期')
    }
    if (memory.taskId && (!get('tasks', memory.taskId) || get('tasks', memory.taskId).deletedAt)) fail('记忆关联的任务不存在')
    return memory
  }
  function listMemories({ scope, taskId, query } = {}) {
    if (scope) choice(scope, ['global', 'task'], '记忆范围')
    return all('memories').filter(memory => !memory.deletedAt && !memory.replacedBy && (!memory.expiresAt || memory.expiresAt > now()) && (!scope || memory.scope === scope) && (!taskId || memory.taskId === taskId) && (!query || memory.content.toLocaleLowerCase().includes(query.toLocaleLowerCase()))).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  function rememberMemory(input) {
    return transaction(() => {
      const timestamp = now()
      const memory = fullMemory({ ...input, id: input.id ?? randomUUID(), createdAt: timestamp, updatedAt: timestamp, deletedAt: null })
      if (get('memories', memory.id)) fail('记忆标识已经存在', 409)
      if (memory.replacesId) {
        const previous = get('memories', memory.replacesId)
        if (!previous || previous.deletedAt || previous.replacedBy) fail('要替代的记忆不存在', 404)
        put('memories', previous.id, { ...previous, replacedBy: memory.id, updatedAt: timestamp })
      }
      put('memories', memory.id, memory)
      return memory
    })
  }
  function retireFreeTimeTask(taskId, at = new Date()) {
    return transaction(() => {
      const task = get('tasks', identifier(taskId))
      if (!task || task.deletedAt) return
      const instant = block => new Date(`${block.date}T${block.start}:00`).getTime()
      const current = planner.getPlanner()
      const removable = current.blocks.filter(block => block.taskId === taskId && !block.locked && instant(block) >= at.getTime())
      for (const block of removable) planner.updatePlanner({ type: 'delete-block', id: block.id }, planner.getPlanner().revision)
      const retained = planner.getPlanner().blocks.filter(block => block.taskId === taskId)
      // Locked and already-running arrangements remain under the user's
      // control. If none remain actionable, archive the internal backing task.
      if (!retained.some(block => new Date(`${block.date}T${block.end}:00`).getTime() > at.getTime()) && ['todo', 'doing'].includes(task.status)) updateTask(taskId, { status: 'dropped', freeTimeGoalId: null })
      else if (task.freeTimeGoalId) updateTask(taskId, { freeTimeGoalId: null })
    })
  }
  function excludeMessageSources(sourceId, { retractedAt, targetRequestId } = {}) {
      const messages = db.prepare('SELECT seq,document FROM messages').all().map(decodeMessage)
      const initialIds = new Set(Array.isArray(sourceId) ? sourceId : [sourceId])
      const sourceIds = new Set(initialIds)
      const requestIds = new Set(messages.filter(message => initialIds.has(message.id) && message.requestId).map(message => message.requestId))
      // Follow both turn membership and explicit provenance until no descendant
      // remains: a later search result or assistant paraphrase can contain it too.
      let expanded = true
      while (expanded) {
        expanded = false
        for (const message of messages) {
          if (sourceIds.has(message.id) || (message.requestId && requestIds.has(message.requestId)) || message.sourceMessageIds?.some(id => sourceIds.has(id))) {
            if (!sourceIds.has(message.id)) { sourceIds.add(message.id); expanded = true }
            if (message.requestId && !requestIds.has(message.requestId)) { requestIds.add(message.requestId); expanded = true }
          }
        }
      }
      for (const message of messages.filter(item => sourceIds.has(item.id))) {
        const { seq, ...document } = message
        const isTarget = initialIds.has(message.id) || (targetRequestId && message.requestId === targetRequestId)
        db.prepare('UPDATE messages SET document = ? WHERE id = ?').run(JSON.stringify({ ...document, excludeFromContext: true,
          ...(retractedAt ? { contextRetractedAt: retractedAt, ...(isTarget ? { retractedAt } : {}) } : {}) }), message.id)
      }
      const timestamp = now()
      for (const candidate of all('memories')) {
        if (sourceIds.has(candidate.sourceMessageId)) put('memories', candidate.id, { ...candidate, deletedAt: timestamp, updatedAt: timestamp })
      }
      const companionRow = db.prepare("SELECT value FROM state WHERE key = 'companion-v1'").get()
      if (companionRow) {
        const companion = JSON.parse(companionRow.value)
        const removedGoals = (companion.freeTimeGoals ?? []).filter(item => sourceIds.has(item.source?.messageId))
        const removedGoalIds = new Set(removedGoals.map(item => item.id))
        for (const goal of removedGoals) if (goal.taskId) retireFreeTimeTask(goal.taskId)
        for (const key of ['handoffs', 'wishes', 'freeTimeGoals', 'scenarios']) companion[key] = (companion[key] ?? []).filter(item => !sourceIds.has(item.source?.messageId))
        companion.freeTimeHistory = (companion.freeTimeHistory ?? []).filter(item => !removedGoalIds.has(item.goalId))
        db.prepare("UPDATE state SET value = ? WHERE key = 'companion-v1'").run(JSON.stringify(companion))
      }
      for (const summary of all('summaries')) {
        if (summary.sourceMessageIds.some(id => sourceIds.has(id))) remove('summaries', summary.conversationId)
      }
      return sourceIds
  }
  function forgetMemory(id) {
    return transaction(() => {
      const memory = get('memories', id)
      if (!memory) fail('找不到这条记忆', 404)
      excludeMessageSources(memory.sourceMessageId)
      return get('memories', id)
    })
  }

  function retractMessage(id) {
    return transaction(() => {
      const source = getMessage(identifier(id, '消息标识'))
      if (!source) fail('这条消息尚未保存，请稍后再撤回', 404)
      if (source.role !== 'user') fail('只能撤回自己发送的消息', 400)
      if (source.retractedAt) return source
      const retractedAt = now()
      excludeMessageSources(source.id, { retractedAt, targetRequestId: source.requestId })
      const turn = source.requestId ? get('turns', source.requestId) : null
      if (turn) {
        const error = '这条消息已撤回，不再继续处理'
        put('turns', turn.requestId, { ...turn, retractedAt, status: 'failed', error, updatedAt: retractedAt,
          result: { requestId: turn.requestId, conversationId: turn.conversationId, status: 'failed', error } })
      }
      const firstVisible = db.prepare("SELECT document FROM messages WHERE conversationId = ? AND role = 'user' AND json_extract(document, '$.retractedAt') IS NULL ORDER BY seq LIMIT 1").get(source.conversationId)
      const title = firstVisible ? JSON.parse(firstVisible.document).content.replace(/\s+/gu, ' ').slice(0, 32) : '与析熙的对话'
      db.prepare('UPDATE conversations SET title = ? WHERE id = ? AND titleEdited = 0').run(title || '与析熙的对话', source.conversationId)
      touchConversation(source.conversationId)
      return getMessage(source.id)
    })
  }
  function retractRequest({ requestId, conversationId }) {
    return transaction(() => {
      const turn = get('turns', identifier(requestId, '请求标识'))
      if (!turn || turn.conversationId !== identifier(conversationId, '对话标识')) fail('这条消息尚未保存，请稍后再撤回', 404)
      return retractMessage(turn.userMessageId)
    })
  }

  function listOperations({ requestId, unreadOnly = false } = {}) {
    return all('operations').filter(operation => (!requestId || operation.requestId === requestId) && (!unreadOnly || !operation.readAt)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  function applyOperation(input) {
    object(input, '操作')
    identifier(input.id, '操作标识')
    const operation = clean({ id: input.id, requestId: identifier(input.requestId, '请求标识'), summary: text(input.summary, '操作摘要', 2000), changes: input.changes, createdAt: now(), readAt: null, undoneAt: null })
    if (!Array.isArray(operation.changes) || !operation.changes.length || operation.changes.length > 50) fail('单次操作需要 1–50 项变更')
    const previous = get('operations', operation.id)
    if (previous) {
      if (!same({ requestId: previous.requestId, summary: previous.summary, changes: previous.requestedChanges ?? previous.changes }, { requestId: operation.requestId, summary: operation.summary, changes: operation.changes })) fail('操作标识已用于不同内容', 409)
      return previous
    }
    return transaction(() => {
      assertTurnWritable(operation.requestId)
      const requestedChanges = clean(operation.changes)
      const linksOccurrencePlan = operation.changes.some(change => change.table === 'tasks' && change.before?.occurrence &&
        change.after?.occurrence && !change.after.deletedAt && change.before.occurrence.date !== change.after.occurrence.date)
      const taskPlannerBefore = linksOccurrencePlan ? planner.getPlanner() : null
      const touched = new Set()
      const removedAssignments = []
      for (const change of operation.changes) {
        object(change, '变更')
        choice(change.table, ['tasks', 'memories'], '变更类型')
        identifier(change.id)
        if (touched.has(`${change.table}:${change.id}`)) fail('同一操作不可重复修改同一记录')
        touched.add(`${change.table}:${change.id}`)
        if (change.before !== null) object(change.before, '变更前记录')
        const current = get(change.table, change.id)
        if (!same(current, change.before)) fail('事项已被修改，请重新读取后再安排', 409)
        if (change.table === 'memories' && change.after === null) fail('请通过遗忘操作移除记忆')
        if (change.after !== null) {
          object(change.after)
          if (change.after.id !== change.id) fail('变更标识不一致')
          const validated = change.table === 'tasks' ? fullTask(change.after) : fullMemory(change.after)
          if (!same(validated, change.after)) fail('变更数据不完整')
          put(change.table, change.id, validated)
          change.after = validated
        } else remove(change.table, change.id)
        if (change.table === 'tasks' && (change.after === null || change.after.deletedAt)) {
          removedAssignments.push(...all('assignments').filter(assignment => assignment.taskId === change.id))
          cleanAssignments(change.id)
        }
      }
      if (!same(requestedChanges, operation.changes)) operation.requestedChanges = requestedChanges
      if (taskPlannerBefore && planner.getPlanner().revision !== taskPlannerBefore.revision) {
        operation.taskPlannerBefore = taskPlannerBefore
        operation.taskPlannerAfterRevision = planner.getPlanner().revision
      }
      if (removedAssignments.length) operation.removedAssignments = removedAssignments
      put('operations', operation.id, operation)
      return operation
    })
  }
  function undoOperation(id) {
    return transaction(() => {
      const operation = get('operations', id)
      if (!operation) fail('找不到这项操作', 404)
      // Older clients may still hold the former automatic-schedule receipt.
      // Its undo always targets the same creation action as the merged receipt.
      if (operation.parentOperationId) {
        const parent = get('operations', operation.parentOperationId)
        if (!parent || parent.kind === 'planner' || parent.requestId !== operation.requestId || parent.id === id) fail('无法确认这项安排的来源，请重新读取变更记录', 409)
        return restoreOperation(parent.id)
      }
      return restoreOperation(id)
    })
  }
  function restoreOperation(id) {
    return transaction(() => {
      const operation = get('operations', id)
      if (!operation) fail('找不到这项操作', 404)
      if (operation.undoable === false) fail('这条记录不支持撤销：遗忘操作不会恢复已忘记的记忆，恢复备份中的历史变更只供回溯', 409)
      if (operation.undoneAt) return operation
      if (operation.kind === 'planner') {
        planner.restorePlanner(operation.plannerBefore, operation.plannerAfterRevision)
        const updated = { ...operation, undoneAt: now() }
        put('operations', id, updated)
        return updated
      }
      for (const change of operation.changes) if (!matchesUndoSnapshot(change.table, change.id, get(change.table, change.id), change.after)) fail('事项后来有新的修改，无法直接撤销', 409)
      // A forgotten source must never return through an older undo record.
      for (const change of operation.changes) if (change.table === 'memories' && change.before !== null) fullMemory(change.before)
      for (const assignment of operation.removedAssignments ?? []) if (get('assignments', assignment.id)) fail('关联安排后来有新的修改，无法直接撤销', 409)
      // Initial scheduling belongs to the creation action. Undo both inside
      // this transaction, retaining the planner's normal revision checks so
      // a later manual schedule edit can never be rolled back accidentally.
      for (const child of listOperations({ requestId: operation.requestId }).filter(item => item.parentOperationId === id && !item.undoneAt)) {
        restoreOperation(child.id)
      }
      const plannerState = planner.getPlanner()
      for (const change of operation.changes) {
        if (change.table === 'tasks' && change.before === null && (
          all('assignments').some(assignment => assignment.taskId === change.id) ||
          plannerState.blocks.some(block => block.taskId === change.id) || Object.hasOwn(plannerState.details, change.id)
        )) fail('事项后来有新的安排或准备信息，无法直接撤销', 409)
      }
      for (const change of [...operation.changes].reverse()) {
        if (change.before === null) {
          remove(change.table, change.id)
          if (change.table === 'tasks') cleanAssignments(change.id)
        } else if (change.table === 'tasks') restoreTaskSnapshot(change.id, change.before)
        else put(change.table, change.id, clean(change.before))
      }
      for (const assignment of operation.removedAssignments ?? []) put('assignments', assignment.id, fullAssignment(assignment))
      if (operation.taskPlannerBefore) planner.restorePlanner(operation.taskPlannerBefore, operation.taskPlannerAfterRevision)
      const updated = { ...operation, undoneAt: now() }
      put('operations', id, updated)
      return updated
    })
  }
  function applyPlannerOperation(input, { scenario = false } = {}) {
    knownKeys(input, ['id', 'requestId', 'summary', 'actions', 'expectedRevision', 'parentOperationId'], '安排操作')
    const id = identifier(input.id, '操作标识'), requestId = identifier(input.requestId, '请求标识')
    const summary = text(input.summary, '操作摘要', 2000)
    const expectedRevision = input.expectedRevision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) fail('安排版本不正确')
    const limit = scenario ? 128 : 8
    if (!Array.isArray(input.actions) || !input.actions.length || input.actions.length > limit) fail(`单次操作需要 1–${limit} 项安排变更`)
    const requestedActions = jsonValue(input.actions, '安排变更', 100000)
    for (const action of requestedActions) choice(action?.type, ['save-block', 'delete-block', 'save-details', 'set-day-template', 'remove-day-template', 'edit-weekday', 'save-day-event', 'delete-day-event'], '析熙安排操作')
    return transaction(() => {
      assertTurnWritable(requestId)
      const parentOperationId = input.parentOperationId === undefined ? undefined : identifier(input.parentOperationId, '来源操作标识')
      if (parentOperationId) {
        const parent = get('operations', parentOperationId)
        if (!parent || parent.requestId !== requestId || parent.kind === 'planner' || parent.undoneAt ||
          !requestedActions.every(action => action.type === 'save-block' && parent.changes.some(change => change.table === 'tasks' && change.before === null && change.after && change.id === action.block.taskId))) {
          fail('自动安排需要关联本轮新建的事项', 409)
        }
      }
      const previous = get('operations', id)
      if (previous) {
        if (previous.kind !== 'planner' || previous.parentOperationId !== parentOperationId || !same(
          { requestId: previous.requestId, summary: previous.summary, actions: previous.requestedActions, expectedRevision: previous.plannerBefore.revision },
          { requestId, summary, actions: requestedActions, expectedRevision },
        )) fail('操作标识已用于不同内容', 409)
        return previous
      }
      const plannerBefore = planner.getPlanner()
      if (plannerBefore.revision !== expectedRevision) fail('安排已在其他窗口更新，请刷新后重试', 409)
      const state = planner.updatePlannerBatch(requestedActions, expectedRevision)
      const operation = {
        id, requestId, summary, kind: 'planner', changes: [], requestedActions, plannerBefore,
        ...(parentOperationId ? { parentOperationId } : {}),
        planChanges: [...new Set(requestedActions.flatMap(action => action.type === 'save-block' ? [action.block.id] : action.type === 'delete-block' ? [action.id] : []))]
          .map(blockId => ({ id: blockId, before: plannerBefore.blocks.find(block => block.id === blockId) ?? null,
            after: state.blocks.find(block => block.id === blockId) ?? null })),
        plannerAfterRevision: state.revision, undoable: true, createdAt: now(), readAt: null, undoneAt: null,
      }
      put('operations', id, operation)
      return operation
    })
  }
  function markOperationsRead(ids) {
    if (!Array.isArray(ids) || ids.length > 1000) fail('操作标识列表不正确')
    return transaction(() => {
      const timestamp = now()
      const related = new Set(ids)
      for (const id of ids) {
        const operation = get('operations', id)
        if (!operation) continue
        const parent = operation.parentOperationId ? get('operations', operation.parentOperationId) : operation
        if (!parent || parent.kind === 'planner' || parent.requestId !== operation.requestId) continue
        related.add(parent.id)
        for (const child of listOperations({ requestId: parent.requestId }).filter(item => item.parentOperationId === parent.id)) related.add(child.id)
      }
      for (const id of related) {
        const operation = get('operations', id)
        if (operation) put('operations', id, { ...operation, readAt: timestamp })
      }
    })
  }
  function recordForgottenOperation(input) {
    const id = identifier(input.id, '操作标识')
    const requestId = identifier(input.requestId, '请求标识')
    const memoryId = identifier(input.memoryId, '记忆标识')
    return transaction(() => {
      assertTurnWritable(requestId)
      const previous = get('operations', id)
      if (previous) {
        if (previous.requestId !== requestId || previous.kind !== 'forget' || previous.memoryId !== memoryId) fail('操作标识已用于不同内容', 409)
        return previous
      }
      forgetMemory(memoryId)
      const operation = { id, requestId, memoryId, kind: 'forget', summary: '已忘记一条记忆', changes: [], undoable: false, createdAt: now(), readAt: null, undoneAt: null }
      put('operations', id, operation)
      return operation
    })
  }
  function recoverAbandonedTurns() {
    for (const turn of all('turns')) {
      if (turn.status === 'running' && !processAlive(turn.ownerPid)) put('turns', turn.requestId, { ...turn, status: 'failed', error: '本地服务重新启动，可重试这条消息', updatedAt: now() })
    }
  }
  function beginTurn(input) {
    object(input, '对话请求')
    const requestId = identifier(input.requestId, '请求标识')
    const conversationId = identifier(input.conversationId, '对话标识')
    const content = text(input.text, '消息', 16000)
    const context = jsonValue(input.context ?? {}, '当前上下文', 16000)
    return transaction(() => {
      recoverAbandonedTurns()
      const previous = get('turns', requestId)
      const otherRunning = all('turns').find(turn => turn.conversationId === conversationId && turn.status === 'running' && turn.requestId !== requestId)
      if (otherRunning) fail('析熙正在回复这段对话，请等她说完', 409)
      if (previous) {
        if (previous.conversationId !== conversationId || previous.text !== content || !same(previous.context, context)) fail('请求标识已用于不同内容', 409)
        if (previous.retractedAt) return { ...previous, claimed: false }
        if (previous.status === 'failed') {
          const retry = { ...previous, status: 'running', ownerPid: process.pid, ownerToken, error: undefined, updatedAt: now() }
          put('turns', requestId, retry)
          return { ...clean(retry), claimed: true }
        }
        return { ...previous, claimed: false }
      }
      assertTurnWritable(requestId)
      const userMessageId = input.userMessageId ? identifier(input.userMessageId) : `${requestId}:user`
      appendMessage({ id: userMessageId, conversationId, requestId, role: 'user', content, taskId: context.taskId })
      const turn = { requestId, conversationId, text: content, context, userMessageId, status: 'running', ownerPid: process.pid, ownerToken, createdAt: now(), updatedAt: now() }
      put('turns', requestId, turn)
      return { ...turn, claimed: true }
    })
  }
  function finishTurn(requestId, input) {
    return transaction(() => finishTurnRecord(requestId, input))
  }
  function updateTurnProgress(requestId, progress) {
    return transaction(() => {
      const current = get('turns', identifier(requestId))
      if (!current) fail('找不到这次对话', 404)
      if (current.retractedAt) return current
      if (current.ownerToken !== ownerToken) fail('这次对话正在其他本地服务处理中', 409)
      const next = clean({ ...current, progress: jsonValue(progress, '执行进度', 256000), updatedAt: now() })
      put('turns', requestId, next)
      return next
    })
  }
  function finishTurnRecord(requestId, input) {
    const current = get('turns', requestId)
    if (!current) {
      assertTurnWritable(requestId)
      fail('找不到这次对话', 404)
    }
    if (current.retractedAt) return current
    if (current.ownerToken !== ownerToken) fail('这次对话正在其他本地服务处理中', 409)
    const status = choice(input.status, ['completed', 'failed'], '请求状态')
    const turn = clean({ ...current, status, result: input.result === undefined ? undefined : jsonValue(input.result, '请求结果', 256000), error: input.error === undefined ? undefined : text(input.error, '错误说明', 2000), updatedAt: now() })
    put('turns', requestId, turn)
    return turn
  }

  transaction(() => {
    recoverAbandonedTurns()
  })

  function correctMemory(id, input) {
    knownKeys(input, ['content', 'expectedUpdatedAt'], '记忆更正')
    return transaction(() => {
      const previous = get('memories', identifier(id))
      if (!previous || previous.deletedAt || previous.replacedBy || (previous.expiresAt && previous.expiresAt <= now())) fail('这条记忆已失效，请重新读取', 409)
      if (previous.updatedAt !== input.expectedUpdatedAt) fail('记忆已在其他窗口更新，请重新读取', 409)
      const content = text(input.content, '更正后的记忆', 600)
      const source = appendMessage({ conversationId: getActiveConversation().id, role: 'user', content: `更正记忆：${content}` })
      return rememberMemory({ content, scope: previous.scope, kind: previous.kind, taskId: previous.taskId, expiresAt: previous.expiresAt,
        lifetime: previous.lifetime, evidence: content, sourceMessageId: source.id, replacesId: previous.id })
    })
  }
  const backup = createBackupStore({ db, transaction, validate: () => {
    for (const task of all('tasks')) { fullTask(task); assertOccurrenceUnique(task) }
    for (const area of all('areas')) fullArea(area)
    for (const event of all('events')) fullEvent(event)
    for (const entry of all('availability')) fullAvailability(entry)
    for (const assignment of all('assignments')) fullAssignment(assignment)
    for (const memory of all('memories')) validateMemory(memory)
    const preference = db.prepare("SELECT value FROM state WHERE key='preferences:app'").get()
    if (preference) validatePreferences(JSON.parse(preference.value))
    planner.validateStoredState()
  } })

  function close() {
    transaction(() => {
      for (const turn of all('turns')) {
        if (turn.status === 'running' && turn.ownerToken === ownerToken) put('turns', turn.requestId, { ...turn, status: 'failed', error: '本地服务已关闭，可重试这条消息', updatedAt: now() })
      }
    })
    db.close()
  }

  // Namespaced JSON stores are internal service interfaces, never generic SQL
  // or arbitrary state access exposed to the browser/model.
  const readState = key => {
    const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key)
    return row ? JSON.parse(row.value) : null
  }
  const writeState = (key, value, limit) => {
    const checked = jsonValue(value, '本地设置', limit)
    db.prepare('INSERT INTO state(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(checked))
    return checked
  }

  return {
    close, transaction, getModel, setModel, correctMemory, retireFreeTimeTask,
    exportData: backup.exportData, importData: backup.importData,
    getPreference: key => readState(`preferences:${identifier(key)}`),
    setPreference: (key, value) => writeState(`preferences:${identifier(key)}`, value, 64000),
    getCompanionState: () => readState('companion-v1') ?? { handoffs: [], wishes: [], freeTimeGoals: [], scenarios: [] },
    saveCompanionState: value => writeState('companion-v1', value, 2_000_000),
    getPlanner: planner.getPlanner, updatePlanner: planner.updatePlanner,
    listTasks, getTask: id => get('tasks', id), createTask, updateTask, reopenTask, listTaskCompletionHistory, deleteTask: id => updateTask(id, { deletedAt: now() }),
    listAreas, createArea, renameArea, listEvents, createEvent, deleteEvent,
    getAvailability: date => get('availability', day(date)), saveAvailability,
    saveAssignment, listAssignments: () => all('assignments').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    importLegacy, getActiveConversation, createConversation, listConversations, selectConversation, renameConversation, deleteConversation, ensureConversation, listMessages, hasSavedReasoning, appendMessage, getMessage, searchMessages,
    assertTurnWritable, retractMessage, retractRequest,
    getSummary: conversationId => get('summaries', conversationId), saveSummary,
    listMemories, rememberMemory, forgetMemory,
    listOperations, applyOperation, applyPlannerOperation, undoOperation, markOperationsRead, recordForgottenOperation,
    getTurn: requestId => get('turns', requestId), beginTurn, finishTurn, updateTurnProgress,
  }
}
