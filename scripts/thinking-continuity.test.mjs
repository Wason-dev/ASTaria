import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, HARD_INPUT_UNITS } from '../server/xixi.mjs'
import { contextUnits, fitContext } from '../server/contextBudget.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-22'
const NOW = new Date(`${DATE}T10:00:00+08:00`)
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = message => ({ choices: [{ message: { role: 'assistant', ...message } }] })
const reply = (content, reasoning_content) => response({ content, reasoning_content })
const input = text => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai' } })
const assertPairs = messages => {
  for (const [index, message] of messages.entries()) {
    if (message.role === 'tool') {
      const owner = messages.findIndex(candidate => candidate.tool_calls?.some(tool => tool.id === message.tool_call_id))
      assert.ok(owner >= 0 && owner < index && index <= owner + messages[owner].tool_calls.length, `orphaned tool result: ${message.tool_call_id}`)
    }
    if (!message.tool_calls?.length) continue
    const results = messages.slice(index + 1, index + 1 + message.tool_calls.length)
    assert.equal(results.length, message.tool_calls.length)
    assert.ok(results.every(result => result.role === 'tool'))
    assert.deepEqual(results.map(result => result.tool_call_id).sort(), message.tool_calls.map(tool => tool.id).sort())
  }
}

for (const reasoning of ['  \n  先核对真实安排\t\n再处理任务。  \n', '', ' \n\t ']) {
  test(`thinking transcript preserves exact reasoning ${JSON.stringify(reasoning)} through tools, final reply, next turn and backup`, async t => {
    const db = createDatabase(':memory:'); t.after(() => db.close())
    const task = db.createTask({ title: '物理课 1.2 单元前三题', estimateMin: 30, due: '2026-09-23' })
    const requests = [], finals = ' \n最终核对已经保存的事实。\t ', secondReasoning = `\n第二次读取 ${reasoning}\n `
    const firstCall = call('thinking-plan-read', 'read_planner', { date: DATE })
    const secondCall = call('thinking-task-read', 'read_tasks', { taskId: task.id })
    const responses = [response({ content: null, reasoning_content: reasoning, tool_calls: [firstCall] }),
      response({ content: null, reasoning_content: secondReasoning, tool_calls: [secondCall] }), reply('已经核对。', finals), reply('继续处理。', '继续的思考')]
    const xixi = createXixi({ db, now: () => NOW, complete: async request => { requests.push(structuredClone(request)); return responses.shift() } })
    assert.equal((await xixi.chat(input('查看今天的课表和物理作业'))).status, 'completed')
    assert.equal(requests.length, 3)
    const assertTranscript = request => {
      assertPairs(request.messages)
      const first = request.messages.find(message => message.tool_calls?.some(tool => tool.id === firstCall.id))
      const second = request.messages.find(message => message.tool_calls?.some(tool => tool.id === secondCall.id))
      assert.equal(first?.reasoning_content, reasoning)
      if (second) assert.equal(second.reasoning_content, secondReasoning)
      const planner = request.messages.find(message => message.tool_call_id === firstCall.id)
      const facts = JSON.parse(planner.content)
      assert.equal(facts.type, 'planner_read')
      assert.equal(facts.days[0].date, DATE)
      assert.ok(facts.days[0].capacity.remaining.length > 0)
      assert.ok(facts.days[0].routines.items.some(row => row.title === '晚自习'))
      assert.equal(facts.contextTruncated, undefined, 'a native read must not become an execution-only receipt')
    }
    assertTranscript(requests[1]); assertTranscript(requests[2])
    assert.equal((await xixi.chat(input('继续看看刚才的作业'))).status, 'completed')
    assertTranscript(requests[3])
    assert.equal(requests[3].messages.find(message => message.content === '已经核对。')?.reasoning_content, finals)
    const taskRead = JSON.parse(requests[3].messages.find(message => message.tool_call_id === secondCall.id).content)
    assert.equal(taskRead.tasks[0].id, task.id)
    assert.equal(taskRead.tasks[0].estimateMin, 30)

    const stored = db.listMessages('main', { limit: 100, forContext: true }).filter(message => message.role === 'assistant')
    assert.deepEqual(stored.map(message => message.reasoningContent), [reasoning, secondReasoning, finals, '继续的思考'])
    const restored = createDatabase(':memory:'); t.after(() => restored.close())
    restored.importData(db.exportData())
    assert.deepEqual(restored.listMessages('main', { limit: 100, forContext: true }).filter(message => message.role === 'assistant')
      .map(message => message.reasoningContent), stored.map(message => message.reasoningContent))
    let restoredRequest
    const resumed = createXixi({ db: restored, now: () => NOW, complete: async request => {
      restoredRequest = request
      return reply('恢复后继续。', '\n恢复后的思考 ')
    } })
    assert.equal((await resumed.chat(input('恢复后继续核对'))).status, 'completed')
    assertTranscript(restoredRequest)
    assert.equal(restoredRequest.messages.find(message => message.content === '已经核对。')?.reasoning_content, finals)
  })
}

test('context pressure preserves native thinking and detailed read results before older prose', () => {
  const tool = call('full-read', 'read_planner', { date: DATE, section: 'tasks', offset: 0, limit: 1 })
  const facts = { type: 'planner_read', revision: 2, days: [{ date: DATE, section: 'tasks', tasks: {
    items: [{ id: 'physics', title: '物理作业', estimateMin: 30, notes: '详细题目与提交要求。'.repeat(160),
      preparation: { preparation: '准备实验记录', items: ['课本', '笔记'], needsSubmission: true, submittedAt: null } }],
    total: 1, offset: 0, nextOffset: null, truncated: false,
  } }] }
  const transcript = [
    { role: 'user', content: '早些时候讨论的事情。'.repeat(2000) },
    { role: 'assistant', content: '旧的背景说明。'.repeat(2000) },
    { role: 'user', content: '现在读取物理作业的完整题目。' },
    { role: 'assistant', content: null, reasoning_content: ' \n先完整读取题目，再回答。\t ', tool_calls: [tool] },
    { role: 'tool', tool_call_id: tool.id, content: JSON.stringify(facts) },
  ]
  const limit = contextUnits(transcript.slice(2)) + 350
  const fitted = fitContext(transcript, [], limit)
  assert.ok(contextUnits(fitted) <= limit)
  assertPairs(fitted)
  assert.equal(fitted.find(message => message.tool_calls)?.reasoning_content, transcript[3].reasoning_content)
  const detail = JSON.parse(fitted.find(message => message.role === 'tool').content)
  assert.equal(detail.days[0].tasks.items[0].notes, facts.days[0].tasks.items[0].notes)
  assert.equal(detail.contextTruncated, undefined)
})

test('thinking tool pairs cannot be collapsed into a receipt checkpoint to fit an impossible budget', () => {
  const tool = call('large-thinking-write', 'create_tasks', { tasks: [{ title: '写入', notes: '说明'.repeat(6000) }] })
  const transcript = [{ role: 'user', content: '保存这项任务' },
    { role: 'assistant', content: null, reasoning_content: '', tool_calls: [tool] },
    { role: 'tool', tool_call_id: tool.id, content: JSON.stringify({ ok: true, operation: { id: 'saved', summary: '保存任务', changes: [] } }) }]
  const original = structuredClone(transcript)
  assert.throws(() => fitContext(transcript, [], 1000), /CONTEXT_TOO_LARGE/)
  assert.deepEqual(transcript, original)
})

for (const provider of ['deepseek', 'local']) test(`${provider}: large old thinking archives before live task facts, while a short choice still reads, creates and schedules with an intact current transcript`, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  if (provider === 'local') db.setPreference('model-connection', { provider: 'local', cloudModel: 'deepseek-flash',
    local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-local-model' } })
  const hardLimit = provider === 'local' ? 24_000 : HARD_INPUT_UNITS
  for (let index = 0; index < 20; index++) db.createTask({ title: `现有资料 ${String(index + 1).padStart(2, '0')}`, estimateMin: 20 })
  const old = input('先核对旧资料的标题，再问我要记录哪一件事')
  const turn = db.beginTurn(old), oldUser = db.getMessage(turn.userMessageId)
  const previousTask = db.listTasks()[0]
  const previousCall = call('archived-title-write', 'update_task', { taskId: previousTask.id, patch: { title: '临时旧标题' } })
  const longReasoning = ` \n${'这是之前回合的长思考，原文必须留在数据库。'.repeat(3500)}\t `
  assert.ok(contextUnits(longReasoning) > HARD_INPUT_UNITS, 'the historical thought alone exceeds the dispatch budget')
  const oldAssistant = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'assistant',
    content: '', reasoningContent: longReasoning, toolCalls: [previousCall], sourceMessageIds: [oldUser.id] })
  const operation = db.applyOperation({ id: 'archived-title-operation', requestId: old.requestId, summary: '临时修改旧资料标题',
    changes: [{ table: 'tasks', id: previousTask.id, before: previousTask, after: { ...previousTask, title: '临时旧标题' } }] })
  const oldReceipt = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'tool', toolCallId: previousCall.id,
    content: JSON.stringify({ ok: true, operation }), sourceMessageIds: [oldUser.id, oldAssistant.id] })
  const options = ['记录化学复习，预计 30 分钟', '记录资料整理，明天截止，预计 30 分钟', '暂时不新增事项']
  const question = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'assistant',
    content: '旧资料已核对。接下来记录哪一件？', question: { options }, reasoningContent: ' \n旧回合的最后思考\t ',
    sourceMessageIds: [oldUser.id, oldAssistant.id, oldReceipt.id] })
  db.finishTurn(old.requestId, { status: 'completed' })
  const undone = db.undoOperation(operation.id)
  assert.ok(undone.undoneAt)
  const originals = db.listMessages('main', { limit: 100 })
  const originalTaskIds = db.listTasks().map(task => task.id).sort()
  const current = input('第二个'), requests = []
  const reads = [call('current-plan-read', 'read_planner', { date: DATE }), call('current-task-read', 'read_tasks', {})]
  const create = call('current-create', 'create_tasks', { tasks: [{ title: '资料整理回归任务', due: '2026-09-23', estimateMin: 30 }] })
  const readReasoning = ' \n先并行核对现有任务与日程。\t ', writeReasoning = ' \n按第二项创建，并核对实际安排。\t '
  const responses = [response({ content: null, reasoning_content: readReasoning, tool_calls: reads }),
    response({ content: null, reasoning_content: writeReasoning, tool_calls: [create] }), reply('资料整理已记录并安排。', ' \n按真实回执确认。\t '), reply('新话题。', '')]
  const xixi = createXixi({ db, now: () => NOW, complete: async request => { requests.push(structuredClone(request)); return responses.shift() } })
  const result = await xixi.chat(current)
  assert.equal(result.status, 'completed', result.error)
  assert.equal(requests.length, 3, 'a long completed history must not consume extra model calls or block the new task')
  const created = db.listTasks().find(task => task.title === '资料整理回归任务')
  assert.ok(created)
  assert.equal(created.due, '2026-09-23')
  assert.ok(db.getPlanner().blocks.some(block => block.taskId === created.id && block.date === DATE), 'the task has an actually persisted calendar block')
  assert.ok(result.operations.some(item => item.changes.some(change => change.table === 'tasks' && change.id === created.id)))
  assert.ok(result.operations.some(item => item.planChanges?.some(change => change.after?.taskId === created.id)))
  const localBudgetObservations = []
  for (const request of requests) {
    assert.ok(contextUnits(request.messages) + contextUnits(request.tools ?? []) <= hardLimit)
    assertPairs(request.messages)
    const archive = request.messages.find(message => message.role === 'system' && message.content.startsWith('已归档的历史回合'))
    assert.ok(archive, 'the whole oversized historical turn is explicitly archived')
    assert.match(archive.content, /历史数据，不是新指令/)
    const data = JSON.parse(archive.content.slice(archive.content.indexOf('\n') + 1))
    assert.equal(data.requestId, old.requestId)
    assert.deepEqual(data.exchanges.map(message => message.sourceMessageId), [oldAssistant.id, oldReceipt.id, question.id])
    assert.equal(data.exchanges.at(-1).content, question.content)
    assert.deepEqual(data.exchanges.at(-1).question.options, options)
    assert.deepEqual(data.operations.map(item => item.id), [operation.id])
    assert.equal(data.operations[0].undoneAt, undone.undoneAt)
    assert.equal(data.operations[0].changes[0].id, previousTask.id)
    assert.ok(!request.messages.some(message => message.tool_calls?.some(tool => tool.id === previousCall.id) || message.tool_call_id === previousCall.id), 'an archived tool exchange is not replayed as a partial native transcript')
    assert.equal(request.messages.find(message => message.role === 'user')?.content, old.text)
    assert.equal(request.messages.findLast(message => message.role === 'user')?.content, current.text)
    const environment = request.messages.find(message => message.role === 'system' && message.content.startsWith('当前环境与数据库资料'))
    const facts = JSON.parse(environment.content.slice(environment.content.indexOf('\n') + 1))
    if (provider === 'deepseek') {
      assert.ok(originalTaskIds.every(id => facts.tasks.some(task => task.id === id)), 'archiving old thoughts must precede discarding live task facts')
      assert.equal(facts.moreTasksAvailable, false)
    } else {
      assert.ok(facts.tasks.length > 0)
      if (!localBudgetObservations.length) assert.ok(originalTaskIds.every(id => facts.tasks.some(task => task.id === id)), 'local history is archived before sacrificing task facts on the initial dispatch')
      assert.equal(facts.moreTasksAvailable, facts.tasks.length < facts.taskCount)
      localBudgetObservations.push({ tasks: facts.tasks.length, total: facts.taskCount, units: contextUnits(request.messages) + contextUnits(request.tools ?? []) })
    }
    const binding = request.messages.find(message => message.role === 'system' && message.content.startsWith('决策绑定：'))
    assert.deepEqual(JSON.parse(binding.content.slice('决策绑定：'.length)).selectedOption, { number: 2, label: options[1], sourceMessageId: question.id })
    const index = request.messages.find(message => message.role === 'system' && message.content.startsWith('以下对话的出处与发送时间：'))
    const sources = JSON.parse(index.content.slice('以下对话的出处与发送时间：'.length))
    const native = request.messages.filter(message => message.role !== 'system')
    assert.equal(sources.length, native.length, 'historical system archives must not shift the native provenance index')
    for (const [position, source] of sources.entries()) {
      const stored = db.getMessage(source.id)
      assert.equal(source.role, native[position].role)
      if (stored.role === 'tool') assert.equal(stored.toolCallId, native[position].tool_call_id)
    }
  }
  const currentMessages = db.listMessages('main', { limit: 100 }).filter(message => message.requestId === current.requestId)
  for (const request of requests.slice(1)) {
    for (const message of request.messages.filter(message => message.role === 'tool')) {
      const stored = currentMessages.find(item => item.toolCallId === message.tool_call_id)
      assert.equal(message.content, stored.content, 'current read/write results must remain byte-for-byte identical to the durable transcript')
    }
    assert.equal(request.messages.find(message => message.tool_calls?.some(tool => tool.id === reads[0].id))?.reasoning_content, readReasoning)
    assert.deepEqual(request.messages.find(message => message.tool_calls?.some(tool => tool.id === reads[0].id))?.tool_calls, reads)
  }
  assert.equal(requests[2].messages.find(message => message.tool_calls?.some(tool => tool.id === create.id))?.reasoning_content, writeReasoning)
  assert.deepEqual(requests[2].messages.find(message => message.tool_calls?.some(tool => tool.id === create.id))?.tool_calls, [create])
  const final = currentMessages.at(-1)
  assert.ok([...originals, ...currentMessages.slice(0, -1)].every(message => final.sourceMessageIds.includes(message.id)), 'the next response depends on each archive source and each retained native message itself')
  assert.deepEqual(db.listMessages('main', { limit: 100 }).filter(message => message.requestId === old.requestId), originals, 'archiving never edits the durable history')
  const restored = createDatabase(':memory:'); t.after(() => restored.close())
  restored.importData(db.exportData())
  assert.equal(restored.getMessage(oldAssistant.id).reasoningContent, longReasoning)
  assert.equal(restored.getMessage(oldReceipt.id).content, oldReceipt.content)

  db.retractMessage(oldUser.id)
  assert.ok(db.getMessage(final.id).contextRetractedAt, 'archive sources must still propagate retraction to dependent new responses')
  assert.equal(db.getMessage(final.id).excludeFromContext, true)
  assert.equal(db.listMessages('main', { forContext: true }).length, 0)
  assert.ok(db.listTasks().some(task => task.id === created.id), 'retracting chat context must not undo committed business data')
  assert.ok(db.getPlanner().blocks.some(block => block.taskId === created.id))
  assert.equal((await xixi.chat(input('换个话题'))).status, 'completed')
  assert.ok(!requests.at(-1).messages.some(message => message.content?.startsWith('已归档的历史回合') || message.content?.includes(question.content)))
  if (provider === 'local') t.diagnostic(`Local 16k soft / 24k hard budget by round: ${JSON.stringify(localBudgetObservations)}`)
})

test('hard-budget fitting preserves native thinking prose and duplicate tool results or fails without rewriting them', () => {
  const reads = [call('thinking-read-a', 'read_planner', { date: DATE }), call('thinking-read-b', 'read_planner', { date: DATE })]
  const result = JSON.stringify({ type: 'planner_read', revision: 3, days: [{ date: DATE,
    tasks: { items: [{ id: 'source-task', title: '资料任务', notes: '必须保留的详细资料。'.repeat(160) }], total: 1, truncated: false } }] })
  const retained = { role: 'assistant', content: '保留的旧答复。'.repeat(160), reasoning_content: '' }
  const current = [{ role: 'user', content: '继续核对完整资料' },
    { role: 'assistant', content: null, reasoning_content: ' \n读取原文\t ', tool_calls: reads },
    ...reads.map(tool => ({ role: 'tool', tool_call_id: tool.id, content: result }))]
  const transcript = [{ role: 'user', content: '可收起的旧背景。'.repeat(3000) }, retained, ...current]
  const original = structuredClone(transcript)
  const fitted = fitContext(transcript, [], contextUnits([retained, ...current]) + 500)
  assertPairs(fitted)
  assert.deepEqual(fitted.find(message => message.content === retained.content), retained)
  assert.deepEqual(fitted.slice(-current.length), current, 'identical current thinking reads cannot become duplicate-result pointers')
  assert.throws(() => fitContext(current, [], contextUnits(current) - 300), /CONTEXT_TOO_LARGE/)
  assert.deepEqual(transcript, original)
})

for (const boundary of ['assistant', 'tool']) test(`a summary ending at a native ${boundary} message retains the entire thinking turn and its paired results`, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const old = input('先核对已有资料'), turn = db.beginTurn(old), user = db.getMessage(turn.userMessageId)
  const tool = call('summary-boundary-read', 'read_tasks', {})
  const reasoning = ' \n摘要边界不能裁掉这段思考。\t '
  const assistant = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'assistant', content: '', reasoningContent: reasoning, toolCalls: [tool] })
  const receipt = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'tool', toolCallId: tool.id, content: JSON.stringify({ tasks: [], count: 0 }) })
  const final = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'assistant', content: '旧回合已核对。', reasoningContent: ' \t旧回合最后一段\n' })
  db.finishTurn(old.requestId, { status: 'completed' })
  const cutoff = boundary === 'assistant' ? assistant : receipt
  const originals = db.listMessages('main', { limit: 100 })
  db.saveSummary('main', { text: JSON.stringify({ goal: '先核对已有资料', openItems: [] }), throughSeq: cutoff.seq,
    sourceMessageIds: originals.filter(message => message.seq <= cutoff.seq).map(message => message.id) })
  let dispatched
  const xixi = createXixi({ db, now: () => NOW, complete: async request => { dispatched = structuredClone(request); return reply('继续。', '') } })
  assert.equal((await xixi.chat(input('继续核对'))).status, 'completed')
  assertPairs(dispatched.messages)
  assert.equal(dispatched.messages.find(message => message.role === 'user')?.content, user.content)
  assert.equal(dispatched.messages.find(message => message.tool_calls?.some(call => call.id === tool.id))?.reasoning_content, reasoning)
  assert.deepEqual(dispatched.messages.find(message => message.tool_calls?.some(call => call.id === tool.id))?.tool_calls, [tool])
  assert.equal(dispatched.messages.find(message => message.tool_call_id === tool.id)?.content, receipt.content)
  assert.equal(dispatched.messages.find(message => message.content === final.content)?.reasoning_content, final.reasoningContent)
  assert.ok(!dispatched.messages.some(message => message.content?.startsWith('已归档的历史回合')), 'an intact small turn crossing a summary cutoff remains a complete native transcript')
  assert.deepEqual(db.listMessages('main', { limit: 100 }).filter(message => message.requestId === old.requestId), originals)
})

for (const boundary of ['assistant', 'tool']) test(`the 160-message window starting at an old ${boundary} archives the fragment instead of replaying a partial native turn`, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const old = input('消息窗口外的旧请求'), turn = db.beginTurn(old)
  const tool = call('window-boundary-read', 'read_tasks', {})
  const assistant = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'assistant', content: '',
    reasoningContent: ' \n这段思考只属于被窗口截断的旧回合。\t ', toolCalls: [tool] })
  const receipt = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'tool', toolCallId: tool.id, content: JSON.stringify({ tasks: [], count: 0 }) })
  const final = db.appendMessage({ conversationId: 'main', requestId: old.requestId, role: 'assistant', content: '窗口边界旧回合的最终答复。', reasoningContent: ' \t旧结束思考\n' })
  db.finishTurn(old.requestId, { status: 'completed' })
  const originals = db.listMessages('main', { limit: 100 })
  // Five complete later turns contribute 156/157 messages. Adding the current
  // user leaves exactly 160 rows beginning at the old assistant/tool boundary.
  const extraReads = boundary === 'assistant' ? [2, 1, 1, 1, 1] : [2, 2, 1, 1, 1]
  for (const [index, extra] of extraReads.entries()) {
    const later = input(`后来核对第 ${index + 1} 组资料`)
    db.beginTurn(later)
    for (let round = 0; round < 14; round++) {
      const calls = Array.from({ length: round < extra ? 2 : 1 }, (_, lane) => call(`window-${index}-${round}-${lane}`, 'read_tasks', {}))
      db.appendMessage({ conversationId: 'main', requestId: later.requestId, role: 'assistant', content: '', reasoningContent: '', toolCalls: calls })
      for (const call of calls) db.appendMessage({ conversationId: 'main', requestId: later.requestId, role: 'tool', toolCallId: call.id, content: '{"tasks":[],"count":0}' })
    }
    db.appendMessage({ conversationId: 'main', requestId: later.requestId, role: 'assistant', content: `第 ${index + 1} 组已核对。`, reasoningContent: '' })
    db.finishTurn(later.requestId, { status: 'completed' })
  }
  const current = input('继续')
  const first = boundary === 'assistant' ? assistant : receipt
  let dispatched, window
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    dispatched = structuredClone(request); window = db.listMessages('main', { limit: 160, forContext: true }); return reply('继续核对。', '')
  } })
  assert.equal((await xixi.chat(current)).status, 'completed')
  assert.equal(window[0].id, first.id)
  assert.ok(!window.some(message => message.id === turn.userMessageId))
  assertPairs(dispatched.messages)
  const archiveMessage = dispatched.messages.find(message => message.role === 'system' && message.content.startsWith('已归档的历史回合') && message.content.includes(old.requestId))
  assert.ok(archiveMessage)
  const archive = JSON.parse(archiveMessage.content.slice(archiveMessage.content.indexOf('\n') + 1))
  assert.deepEqual(archive.exchanges.map(message => message.sourceMessageId), originals.filter(message => message.seq >= first.seq).map(message => message.id))
  assert.equal(archive.exchanges.at(-1).content, final.content)
  assert.ok(!dispatched.messages.some(message => message.tool_call_id === tool.id || message.tool_calls?.some(call => call.id === tool.id)))
  assert.ok(!dispatched.messages.some(message => message.reasoning_content === assistant.reasoningContent || message.reasoning_content === final.reasoningContent), 'partial historical reasoning must never be replayed as native assistant state')
  assert.equal(dispatched.messages.findLast(message => message.role === 'user')?.content, current.text)
  const currentFinal = db.listMessages('main', { limit: 100 }).findLast(message => message.requestId === current.requestId && message.role === 'assistant')
  assert.ok([db.getTurn(current.requestId).userMessageId, ...archive.exchanges.map(message => message.sourceMessageId)].every(id => currentFinal.sourceMessageIds.includes(id)))
  assert.deepEqual(db.listMessages('main', { limit: 1000 }).filter(message => message.requestId === old.requestId), originals)
})
