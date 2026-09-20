import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createXixi } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const sign = value => { value.checksum = createHash('sha256').update(JSON.stringify(value.tables)).digest('hex'); return value }
const setup = t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const task = db.createTask({ title: '报告', estimateMin: 35, due: '2027-09-20' })
  const conversation = db.getActiveConversation(), requestId = randomUUID()
  const turn = db.beginTurn({ requestId, conversationId: conversation.id, text: '我想去看海，报告写到结论了', context: { timezone: 'Asia/Shanghai', page: 'home' } })
  const source = db.getMessage(turn.userMessageId)
  db.appendMessage({ conversationId: conversation.id, requestId, role: 'assistant', content: '记住了', sourceMessageIds: [source.id] })
  db.finishTurn(requestId, { status: 'completed', result: { requestId, conversationId: conversation.id, status: 'completed' } })
  const memory = db.rememberMemory({ content: '想看海', sourceMessageId: source.id, evidence: '想去看海', scope: 'global', kind: 'preference', lifetime: 'long-term' })
  db.saveSummary(conversation.id, { text: '还没决定哪天看海', throughSeq: source.seq, sourceMessageIds: [source.id] })
  db.saveAvailability('2027-09-19', '22:00')
  db.createEvent({ title: '考试周', kind: 'exam-week', startDate: '2027-09-19', endDate: '2027-09-23' })
  db.createArea('项目', 'deep')
  db.saveAssignment({ taskId: task.id, blockId: 'slot', plannedMin: 35, reason: '工作日', status: 'accepted' })
  db.applyPlannerOperation({ id: randomUUID(), requestId, summary: '安排报告', actions: [{ type: 'save-block', block: { id: 'report', taskId: task.id, date: '2027-09-19', start: '09:00', end: '09:35', locked: false } }], expectedRevision: db.getPlanner().revision })
  const companion = createCompanion({ db, now: () => new Date('2027-09-19T08:00:00+08:00') })
  const provenance = { kind: 'conversation', messageId: source.id, evidence: '想去看海' }
  companion.saveWish({ content: '看海', evidence: '想去看海' }, provenance)
  companion.saveHandoff({ taskId: task.id, progress: '写到结论', obstacle: '', nextStep: '', materials: [] }, { ...provenance, evidence: '报告写到结论了' })
  companion.previewScenario({ date: '2027-09-19', mode: 'light' }, provenance)
  return { db, task, conversation, source, memory, companion, requestId }
}

test('complete backup roundtrip restores every document family, invalidates prior mutation tokens and archives old undo', t => {
  const f = setup(t)
  f.db.updateTask(f.task.id, { status: 'done' })
  const backup = f.db.exportData()
  for (const name of ['tasks', 'areas', 'events', 'availability', 'assignments', 'conversations', 'messages', 'memories', 'operations', 'turns', 'summaries', 'task_completion_history', 'state']) assert.ok(backup.tables[name].length > 0, name)
  const beforeTask = f.db.getTask(f.task.id), beforeMemory = f.db.listMemories()[0]
  f.db.importData(backup)
  assert.equal(f.db.getTask(f.task.id).status, 'done')
  assert.notEqual(f.db.getTask(f.task.id).updatedAt, beforeTask.updatedAt)
  assert.notEqual(f.db.listMemories()[0].updatedAt, beforeMemory.updatedAt)
  assert.equal(f.db.listEvents().length, 1)
  assert.equal(f.db.listAssignments().length, 1)
  assert.equal(f.db.getSummary(f.conversation.id).sourceMessageIds[0], f.source.id)
  assert.equal(f.db.getTurn(f.requestId).status, 'completed')
  assert.equal(f.db.getTurn(f.requestId).ownerToken, undefined)
  assert.equal(f.db.listOperations()[0].undoable, false)
  assert.throws(() => f.db.undoOperation(f.db.listOperations()[0].id))
  assert.equal(f.companion.listState().scenarios[0].status, 'discarded')
  assert.equal(f.companion.listState().handoffs[0].version, 2)
  // Exporting a restored archive remains a valid backup for later moves.
  assert.equal(f.db.importData(f.db.exportData()).restored, true)
})

test('invalid JSON, hostile operation tables and malformed companion/summaries/turns all roll back', t => {
  const f = setup(t), original = f.db.exportData(), beforeTask = f.db.getTask(f.task.id)
  const mutations = [
    backup => { backup.tables.tasks[0].document = '{broken' },
    backup => { const op = JSON.parse(backup.tables.operations[0].document); op.changes = [{ table: 'tasks; DROP TABLE tasks;', id: 'x', before: null, after: null }]; backup.tables.operations[0].document = JSON.stringify(op) },
    backup => { backup.tables.state.find(row => row.key === 'companion-v1').value = JSON.stringify({ handoffs: null, wishes: [], scenarios: [] }) },
    backup => { const doc = JSON.parse(backup.tables.summaries[0].document); doc.sourceMessageIds = {}; backup.tables.summaries[0].document = JSON.stringify(doc) },
    backup => { const doc = JSON.parse(backup.tables.turns[0].document); doc.context = 'invalid'; backup.tables.turns[0].document = JSON.stringify(doc) },
    backup => { const doc = JSON.parse(backup.tables.messages[0].document); doc.sourceMessageIds = ['missing-source']; backup.tables.messages[0].document = JSON.stringify(doc) },
    // This fails only after all tables were inserted, testing transactional rollback.
    backup => { const doc = JSON.parse(backup.tables.assignments[0].document); doc.taskId = 'missing-task'; backup.tables.assignments[0].document = JSON.stringify(doc) },
  ]
  for (const mutate of mutations) {
    const corrupted = structuredClone(original); mutate(corrupted); sign(corrupted)
    assert.throws(() => f.db.importData(corrupted))
    assert.deepEqual(f.db.getTask(f.task.id), beforeTask)
    assert.deepEqual(f.db.getSummary(f.conversation.id), JSON.parse(original.tables.summaries[0].document))
    assert.equal(f.companion.listState().wishes.length, 1)
  }
})

test('restoring an earlier backup preserves later local forgetting across memory, source, summary and companion', async t => {
  const f = setup(t), backup = f.db.exportData()
  f.db.forgetMemory(f.memory.id)
  f.db.importData(backup)
  assert.equal(f.db.listMemories().length, 0)
  assert.equal(f.db.listMessages(f.conversation.id, { forContext: true }).length, 0)
  assert.equal(f.db.getSummary(f.conversation.id), null)
  assert.equal(f.companion.listState().wishes.length, 0)
  assert.equal(f.companion.listState().handoffs.length, 0)
  const requests = []
  const xixi = createXixi({ db: f.db, complete: async payload => { requests.push(payload); return { choices: [{ message: { content: '好' } }] } } })
  await xixi.chat({ requestId: randomUUID(), conversationId: f.conversation.id, text: '新话题', context: { timezone: 'Asia/Shanghai' } })
  assert.doesNotMatch(JSON.stringify(requests), /还没决定哪天看海|想去看海|报告写到结论了/)
})

test('valid raw deletion tombstones roundtrip and a previously deleted conversation cannot resurrect from backup', t => {
  const f = setup(t), backup = f.db.exportData()
  f.db.createConversation()
  f.db.deleteConversation(f.conversation.id)
  const deletedBackup = f.db.exportData()
  assert.equal(f.db.importData(deletedBackup).restored, true)
  assert.equal(f.db.importData(backup).restored, true)
  assert.ok(!f.db.listConversations().some(item => item.id === f.conversation.id))
  assert.equal(f.db.listMessages(f.conversation.id).length, 0)
  assert.equal(f.db.getSummary(f.conversation.id), null)
  assert.throws(() => f.db.ensureConversation(f.conversation.id), /删除/)
  assert.ok(f.db.getActiveConversation().id)
})

test('failed historical tool turns remain visible but cannot replay after restore', t => {
  const f = setup(t), requestId = randomUUID()
  const turn = f.db.beginTurn({ requestId, conversationId: f.conversation.id, text: '一次失败的安排', context: { timezone: 'Asia/Shanghai' } })
  f.db.appendMessage({ conversationId: f.conversation.id, requestId, role: 'assistant', content: '', toolCalls: [{ id: 'invalid-call', type: 'function', function: { name: 'create_tasks', arguments: '{invalid' } }], sourceMessageIds: [turn.userMessageId] })
  f.db.finishTurn(requestId, { status: 'failed', error: '响应中断' })
  f.db.importData(f.db.exportData())
  assert.ok(f.db.getTurn(requestId).retractedAt)
  assert.equal(f.db.beginTurn({ requestId, conversationId: f.conversation.id, text: '一次失败的安排', context: { timezone: 'Asia/Shanghai' } }).claimed, false)
})

test('running work rejects both import and export without stopping the turn', t => {
  const f = setup(t), backup = f.db.exportData(), requestId = randomUUID()
  f.db.beginTurn({ requestId, conversationId: f.conversation.id, text: '正在做', context: { timezone: 'Asia/Shanghai' } })
  assert.throws(() => f.db.exportData(), /处理消息/)
  assert.throws(() => f.db.importData(backup), /处理消息/)
  assert.equal(f.db.getTurn(requestId).status, 'running')
})
