import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createDatabase } from '../server/database.mjs'
import { validateTaskDraft, validateTaskPatch, day, dateTime, DomainError } from '../server/validation.mjs'

const timestamp = '2026-09-18T03:00:00.000Z'
const draft = (title = '物理报告') => ({ title, source: 'manual', area: 'phy2', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: ['anywhere'], status: 'todo' })
const taskDocument = (id = 'task-1', overrides = {}) => ({ ...draft(), id, createdAt: timestamp, updatedAt: timestamp, deletedAt: null, ...overrides })
const withDatabase = fn => () => {
  const db = createDatabase(':memory:')
  try { return fn(db) } finally { db.close() }
}
const userMessage = db => db.appendMessage({ id: 'user-1', conversationId: 'main', requestId: 'turn-1', role: 'user', content: '我喜欢35分钟专注' })
const memoryDocument = (overrides = {}) => ({ id: 'memory-1', content: '喜欢35分钟专注', scope: 'global', sourceMessageId: 'user-1', kind: 'preference', createdAt: timestamp, updatedAt: timestamp, deletedAt: null, ...overrides })

test('task CRUD protects identity, supports nullable patch fields and indexed filters', withDatabase(db => {
  const task = db.createTask({ ...draft(), due: '2026-09-20T18:00:00+08:00', startAt: '2026-09-19T09:00:00+08:00' })
  const saved = db.updateTask(task.id, { id: 'malicious', createdAt: '2000-01-01', status: 'done' })
  assert.equal(saved.id, task.id)
  assert.equal(saved.createdAt, task.createdAt)
  assert.ok(saved.doneAt)
  assert.equal(db.listTasks({ area: 'phy2', status: 'done', inbox: false }).length, 1)
  assert.equal(db.listTasks({ status: 'todo' }).length, 0)
  const cleared = db.updateTask(task.id, { status: 'todo', due: null, startAt: null })
  assert.equal(cleared.doneAt, undefined)
  assert.equal(cleared.due, undefined)
  assert.equal(cleared.startAt, undefined)
}))

test('deleting a task cleans schedule assignments in the same transaction', withDatabase(db => {
  const task = db.createTask(draft())
  db.saveAssignment({ taskId: task.id, blockId: '2026-09-18:P3', plannedMin: 35, reason: '空课', status: 'accepted' })
  db.deleteTask(task.id)
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.listTasks({ includeDeleted: true }).length, 1)
  assert.deepEqual(db.listAssignments(), [])
  assert.throws(() => db.saveAssignment({ taskId: task.id, blockId: 'P4', plannedMin: 35, reason: '' }), /任务不存在/u)
}))

test('invalid task data is rejected before persistence', withDatabase(db => {
  for (const patch of [{ title: '' }, { estimateMin: -1 }, { status: 'unknown' }, { due: '2026-02-30' }, { due: '2026-09-18T09:00' }, { area: 'non-existent' }, { secret: 'value' }]) {
    assert.throws(() => db.createTask({ ...draft(), ...patch }), DomainError)
  }
  assert.equal(db.listTasks().length, 0)
}))

test('date validation rejects normalized calendar errors and retains local day values', () => {
  assert.equal(day('2028-02-29'), '2028-02-29')
  assert.equal(dateTime('2026-09-18'), '2026-09-18')
  assert.equal(dateTime('2026-09-18T00:30:00+08:00'), '2026-09-18T00:30:00+08:00')
  for (const value of ['2026-02-29', '2026-09-18T24:00:00Z', '2026-09-18T12:60:00Z', 'Fri Sep 18 2026']) assert.throws(() => dateTime(value), DomainError)
  assert.equal(validateTaskDraft({ title: '标题' }).status, 'todo')
  assert.equal(validateTaskPatch({ due: null }).due, undefined)
})

test('calendar ranges and availability remain local-date values', withDatabase(db => {
  const event = db.createEvent({ title: '考试周', kind: 'exam-week', startDate: '2026-09-21', endDate: '2026-09-25', allDay: true, affectsScheduling: true })
  assert.equal(db.listEvents('2026-09-23', '2026-09-23')[0].id, event.id)
  assert.equal(db.listEvents('2025-09-23', '2025-09-23').length, 0)
  assert.throws(() => db.createEvent({ title: '错误', startDate: '2026-09-25', endDate: '2026-09-21' }), /早于/u)
  db.deleteEvent(event.id)
  assert.deepEqual(db.listEvents(), [])
  db.saveAvailability('2026-09-18', '23:00')
  assert.equal(db.getAvailability('2026-09-18').until, '23:00')
  assert.equal(db.getAvailability('2026-09-17'), null)
  assert.throws(() => db.saveAvailability('2026-09-18', '25:00'), DomainError)
}))

test('area rename and custom creation preserve distinct identity', withDatabase(db => {
  const area = db.createArea('科研', 'deep')
  assert.equal(db.renameArea(area.id, '研究').name, '研究')
  assert.equal(db.listAreas().length, 14)
  assert.throws(() => db.renameArea('missing', '研究'), /找不到/u)
}))

test('migration is insert-only, ignores orphan assignments, and never overwrites newer records', withDatabase(db => {
  const old = taskDocument()
  const rows = { tasks: [old], assignments: [{ id: 'orphan', taskId: 'missing', blockId: 'P1', plannedMin: 20, reason: '', updatedAt: timestamp }] }
  assert.equal(db.importLegacy(rows).tasks, 1)
  db.updateTask(old.id, { title: '已在另一浏览器修改' })
  assert.equal(db.importLegacy(rows).tasks, 0)
  assert.equal(db.getTask(old.id).title, '已在另一浏览器修改')
  assert.equal(db.listAssignments().length, 0)
  db.deleteTask(old.id)
  db.importLegacy(rows)
  assert.equal(db.listTasks().length, 0)
}))

test('invalid migration rolls back the entire batch', withDatabase(db => {
  assert.throws(() => db.importLegacy({ tasks: [taskDocument(), taskDocument('task-2', { due: 'yesterday' })] }), DomainError)
  assert.equal(db.listTasks().length, 0)
  assert.throws(() => db.importLegacy({ apiKey: 'never-migrate-credentials' }), /不支持/u)
}))

test('legacy category names replace generated defaults once and preserve subsequent edits', withDatabase(db => {
  db.listAreas()
  const legacy = { id: 'phy2', name: '我的物理', defaultEnergy: 'deep', createdAt: timestamp, updatedAt: timestamp, deletedAt: null }
  assert.equal(db.importLegacy({ areas: [legacy] }).areas, 1)
  assert.equal(db.listAreas().find(area => area.id === 'phy2').name, '我的物理')
  db.renameArea('phy2', '新分类名称')
  assert.equal(db.importLegacy({ areas: [legacy] }).areas, 0)
  assert.equal(db.listAreas().find(area => area.id === 'phy2').name, '新分类名称')
  db.renameArea('math', '自己改的数学')
  assert.equal(db.importLegacy({ areas: [{ ...legacy, id: 'math', name: '旧数学' }] }).areas, 0)
  assert.equal(db.listAreas().find(area => area.id === 'math').name, '自己改的数学')
}))

test('transaction nesting rolls back outer errors and rejects async work', withDatabase(db => {
  assert.throws(() => db.transaction(() => { db.createTask(draft()); db.transaction(() => db.createArea('临时')); throw new Error('rollback') }), /rollback/u)
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.listAreas().length, 13)
  assert.throws(() => db.transaction(async () => db.createTask(draft())), /同步/u)
  assert.equal(db.listTasks().length, 0)
  assert.throws(() => db.transaction(() => { db.createTask(draft()); return Promise.resolve() }), /异步/u)
  assert.equal(db.listTasks().length, 0)
}))

test('messages have stable sequence, cursor order and idempotent ids', withDatabase(db => {
  const active = db.getActiveConversation()
  assert.equal(db.getActiveConversation().id, active.id)
  const input = { id: 'm1', conversationId: active.id, role: 'user', content: '第一条' }
  const first = db.appendMessage(input)
  assert.equal(db.getActiveConversation().title, '第一条')
  assert.equal(db.appendMessage(input).seq, first.seq)
  const second = db.appendMessage({ conversationId: active.id, role: 'assistant', content: '第二条' })
  const third = db.appendMessage({ conversationId: active.id, role: 'user', content: '第三条' })
  assert.deepEqual(db.listMessages(active.id, { limit: 2 }).map(item => item.id), [second.id, third.id])
  assert.deepEqual(db.listMessages(active.id, { before: second.seq }).map(item => item.id), [first.id])
  assert.throws(() => db.appendMessage({ ...input, content: '另一个内容' }), /不同内容/u)
  const next = db.createConversation({ title: '新话题' })
  assert.equal(db.getActiveConversation().id, next.id)
  assert.equal(db.selectConversation(active.id).id, active.id)
  assert.equal(db.getActiveConversation().id, active.id)
  assert.equal(db.listConversations().length, 2)
  assert.throws(() => db.selectConversation('missing'), /找不到/u)
}))

test('search escapes wildcard characters and filters task context', withDatabase(db => {
  db.appendMessage({ conversationId: 'main', role: 'user', content: '报告做到50%', taskId: 'physics' })
  db.appendMessage({ conversationId: 'main', role: 'user', content: '另一个报告', taskId: 'math' })
  assert.equal(db.searchMessages('%').length, 1)
  assert.equal(db.searchMessages('报告', { taskId: 'physics' }).length, 1)
  assert.equal(db.searchMessages('_').length, 0)
}))

test('memory requires a user source and validates task scope and expiry', withDatabase(db => {
  userMessage(db)
  db.appendMessage({ id: 'assistant-1', conversationId: 'main', role: 'assistant', content: '我觉得你喜欢熬夜' })
  assert.throws(() => db.rememberMemory({ ...memoryDocument(), sourceMessageId: 'assistant-1' }), /用户原话/u)
  assert.throws(() => db.rememberMemory({ ...memoryDocument(), sourceMessageId: 'missing' }), /用户原话/u)
  assert.throws(() => db.rememberMemory({ ...memoryDocument(), scope: 'task', taskId: 'missing' }), /任务不存在/u)
  db.rememberMemory({ ...memoryDocument(), expiresAt: '2000-01-01T00:00:00Z' })
  assert.equal(db.listMemories().length, 0)
}))

test('memory replacement is atomic and old preference is excluded', withDatabase(db => {
  userMessage(db)
  const previous = db.rememberMemory(memoryDocument())
  const next = db.rememberMemory({ ...memoryDocument({ id: 'memory-2', content: '改成25分钟专注' }), replacesId: previous.id })
  assert.deepEqual(db.listMemories().map(item => item.id), [next.id])
  assert.throws(() => db.rememberMemory({ ...memoryDocument({ id: 'memory-3' }), replacesId: previous.id }), /不存在/u)
  assert.equal(db.listMemories().length, 1)
}))

test('forgetting excludes source turn from context and search and invalidates summaries', withDatabase(db => {
  const source = userMessage(db)
  db.appendMessage({ conversationId: 'main', requestId: 'turn-1', role: 'assistant', content: '记住了35分钟' })
  db.appendMessage({ conversationId: 'main', requestId: 'turn-2', role: 'user', content: '物理报告' })
  const memory = db.rememberMemory(memoryDocument())
  db.saveSummary('main', { text: '用户喜欢35分钟专注', throughSeq: source.seq, sourceMessageIds: [source.id] })
  db.forgetMemory(memory.id)
  assert.equal(db.listMemories().length, 0)
  assert.equal(db.listMessages('main').length, 3)
  assert.equal(db.listMessages('main', { forContext: true }).length, 1)
  assert.equal(db.searchMessages('35分钟').length, 0)
  assert.equal(db.getSummary('main'), null)
  assert.throws(() => db.rememberMemory(memoryDocument({ id: 'revived' })), /有效的用户原话/u)
  assert.throws(() => db.saveSummary('main', { text: '复活', throughSeq: source.seq, sourceMessageIds: [source.id] }), /不可用/u)
}))

test('forget follows provenance into later retrievals and assistant paraphrases', withDatabase(db => {
  const source = userMessage(db)
  const memory = db.rememberMemory(memoryDocument())
  db.appendMessage({ id: 'later-user', conversationId: 'main', requestId: 'later-turn', role: 'user', content: '之前说过什么' })
  const retrieval = db.appendMessage({ id: 'retrieval', conversationId: 'main', requestId: 'later-turn', role: 'tool', content: '喜欢35分钟', sourceMessageIds: [source.id] })
  db.appendMessage({ id: 'paraphrase', conversationId: 'other', requestId: 'derived-turn', role: 'assistant', content: '你的专注偏好是35分钟', sourceMessageIds: [retrieval.id] })
  db.forgetMemory(memory.id)
  assert.deepEqual(db.listMessages('main', { forContext: true }), [])
  assert.deepEqual(db.listMessages('other', { forContext: true }), [])
  assert.equal(db.listMessages('main').length, 3)
  const late = db.appendMessage({ conversationId: 'main', role: 'assistant', content: '忘记完成', sourceMessageIds: [retrieval.id] })
  assert.equal(late.excludeFromContext, true)
}))

test('operation applies all task changes atomically, repeats safely and can undo', withDatabase(db => {
  const task = taskDocument()
  const input = { id: 'op-1', requestId: 'turn-1', summary: '添加物理报告', changes: [{ table: 'tasks', id: task.id, before: null, after: task }] }
  const operation = db.applyOperation(input)
  assert.deepEqual(db.applyOperation(input), operation)
  assert.equal(db.listTasks().length, 1)
  assert.equal(db.listOperations({ unreadOnly: true }).length, 1)
  db.markOperationsRead([operation.id])
  assert.equal(db.listOperations({ unreadOnly: true }).length, 0)
  assert.throws(() => db.applyOperation({ ...input, summary: '不同的操作' }), /不同内容/u)
  assert.ok(db.undoOperation(operation.id).undoneAt)
  assert.equal(db.listTasks().length, 0)
  assert.ok(db.undoOperation(operation.id).undoneAt)
}))

test('operation conflict rolls back earlier changes and undo protects later user edits', withDatabase(db => {
  const first = taskDocument('t1'), second = taskDocument('t2')
  assert.throws(() => db.applyOperation({ id: 'bad', requestId: 'turn-1', summary: '错误批次', changes: [
    { table: 'tasks', id: first.id, before: null, after: first },
    { table: 'tasks', id: second.id, before: second, after: { ...second, title: '修改' } },
  ] }), /已被修改/u)
  assert.equal(db.listTasks().length, 0)
  db.applyOperation({ id: 'good', requestId: 'turn-1', summary: '创建', changes: [{ table: 'tasks', id: first.id, before: null, after: first }] })
  db.updateTask(first.id, { title: '手动编辑' })
  assert.throws(() => db.undoOperation('good'), /新的修改/u)
  assert.equal(db.getTask(first.id).title, '手动编辑')
}))

test('undo restores assignments removed by a task deletion and protects later scheduling', withDatabase(db => {
  const task = db.createTask(draft())
  const assignment = db.saveAssignment({ taskId: task.id, blockId: 'P3', plannedMin: 35, reason: '专注' })
  db.applyOperation({ id: 'delete-task', requestId: 'turn-1', summary: '移除任务', changes: [{ table: 'tasks', id: task.id, before: task, after: { ...task, deletedAt: timestamp } }] })
  assert.equal(db.listAssignments().length, 0)
  db.undoOperation('delete-task')
  assert.deepEqual(db.listAssignments(), [assignment])
  const newTask = taskDocument('new-task')
  db.applyOperation({ id: 'create-task', requestId: 'turn-2', summary: '添加任务', changes: [{ table: 'tasks', id: newTask.id, before: null, after: newTask }] })
  db.saveAssignment({ taskId: newTask.id, blockId: 'P4', plannedMin: 35, reason: '后续安排' })
  assert.throws(() => db.undoOperation('create-task'), /新的安排/u)
  assert.ok(db.getTask(newTask.id))
}))

test('memory operation is validated and forgotten sources cannot be restored by undo', withDatabase(db => {
  userMessage(db)
  const before = db.rememberMemory(memoryDocument())
  const after = { ...before, content: '35分钟专注与5分钟休息' }
  db.applyOperation({ id: 'op-memory', requestId: 'turn-1', summary: '更新专注偏好', changes: [{ table: 'memories', id: before.id, before, after }] })
  db.forgetMemory(before.id)
  assert.throws(() => db.undoOperation('op-memory'), /新的修改/u)
  assert.equal(db.listMemories().length, 0)
}))

test('forgetting records an idempotent notification without making forgotten content undoable', withDatabase(db => {
  userMessage(db)
  db.rememberMemory(memoryDocument())
  const input = { id: 'forget-1', requestId: 'turn-2', memoryId: 'memory-1' }
  const operation = db.recordForgottenOperation(input)
  assert.equal(operation.undoable, false)
  assert.equal(db.listMemories().length, 0)
  assert.equal(db.listOperations({ unreadOnly: true }).length, 1)
  assert.deepEqual(db.recordForgottenOperation(input), operation)
  assert.throws(() => db.undoOperation(operation.id), /不会恢复/u)
}))

test('turn retries reuse user messages and refuse request id changes', withDatabase(db => {
  const input = { requestId: 'turn-1', conversationId: 'main', text: '创建任务', context: { page: 'home' } }
  const turn = db.beginTurn(input)
  assert.equal(turn.status, 'running')
  assert.equal(turn.claimed, true)
  assert.equal(db.beginTurn(input).claimed, false)
  assert.equal(db.beginTurn(input).userMessageId, turn.userMessageId)
  assert.equal(db.listMessages('main').length, 1)
  assert.throws(() => db.beginTurn({ ...input, text: '不同内容' }), /不同内容/u)
  db.finishTurn(input.requestId, { status: 'failed', error: '暂时离线' })
  assert.equal(db.beginTurn(input).status, 'running')
  assert.equal(db.listMessages('main').length, 1)
  db.finishTurn(input.requestId, { status: 'completed', result: { message: '记好了' } })
  assert.equal(db.beginTurn(input).status, 'completed')
  assert.equal(db.getTurn(input.requestId).result.message, '记好了')
}))

test('only one connection can claim a conversation and startup preserves live owners', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-db-owner-test-'))
  const filename = join(directory, 'database.sqlite')
  let first, second
  try {
    first = createDatabase(filename)
    const input = { requestId: 'owner-1', conversationId: 'main', text: '你好', context: {} }
    assert.equal(first.beginTurn(input).claimed, true)
    second = createDatabase(filename)
    assert.equal(second.getTurn(input.requestId).status, 'running')
    assert.equal(second.beginTurn(input).claimed, false)
    assert.throws(() => second.beginTurn({ ...input, requestId: 'owner-2' }), /正在回复/u)
    assert.throws(() => second.finishTurn(input.requestId, { status: 'completed' }), /其他本地服务/u)
    first.finishTurn(input.requestId, { status: 'completed', result: { reply: '你好' } })
    assert.equal(second.beginTurn({ ...input, requestId: 'owner-2' }).claimed, true)
  } finally {
    first?.close(); second?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('independent database connections share data and recover interrupted turns on restart', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-db-test-'))
  const filename = join(directory, 'database.sqlite')
  let first, second
  try {
    first = createDatabase(filename)
    const task = first.createTask(draft())
    first.beginTurn({ requestId: 'interrupted', conversationId: 'main', text: '稍等', context: {} })
    first.close()
    first = null
    second = createDatabase(filename)
    assert.equal(second.getTask(task.id).title, task.title)
    assert.equal(second.getTurn('interrupted').status, 'failed')
    assert.equal(statSync(filename).mode & 0o777, 0o600)
    assert.equal(statSync(directory).mode & 0o777, 0o700)
    first = createDatabase(filename)
    second.updateTask(task.id, { title: '跨浏览器同一份数据' })
    assert.equal(first.getTask(task.id).title, '跨浏览器同一份数据')
  } finally {
    first?.close()
    second?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})

test('abruptly terminated process releases its persisted turn for safe retry', () => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-db-crash-test-'))
  const filename = join(directory, 'database.sqlite')
  let reopened
  try {
    const script = `import {createDatabase} from ${JSON.stringify(new URL('../server/database.mjs', import.meta.url).href)};
      const db=createDatabase(process.argv[1]);
      db.beginTurn({requestId:'crashed-turn',conversationId:'main',text:'记录事项',context:{}});
      process.exit(0);`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, filename], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    reopened = createDatabase(filename)
    assert.equal(reopened.getTurn('crashed-turn').status, 'failed')
    assert.equal(reopened.beginTurn({ requestId: 'crashed-turn', conversationId: 'main', text: '记录事项', context: {} }).claimed, true)
    assert.equal(reopened.listMessages('main').length, 1)
  } finally {
    reopened?.close()
    rmSync(directory, { recursive: true, force: true })
  }
})
