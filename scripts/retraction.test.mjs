import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createLocalService } from '../server/index.mjs'

const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const input = (text = '记下物理报告') => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', page: 'home' } })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture(t, complete = async () => reply('嗯')) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  return { db, xixi: createXixi({ db, complete }) }
}
function invoke(service, path, payload) {
  return new Promise(resolve => {
    const request = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
    request.url = `/api${path}`
    request.method = payload === undefined ? 'GET' : 'POST'
    request.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    request.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    const response = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } }
    service.middleware(request, response, () => resolve({ status: 404 }))
  })
}

test('retraction marks the source turn and descendants, clears memory and summary, and keeps an original archive', t => {
  const { db } = fixture(t)
  const request = input('我的偏好是蓝莓蛋糕')
  const turn = db.beginTurn(request)
  const user = db.getMessage(turn.userMessageId)
  const assistant = db.appendMessage({ conversationId: 'main', requestId: request.requestId, role: 'assistant', content: '蓝莓蛋糕，记住了', sourceMessageIds: [user.id] })
  db.finishTurn(request.requestId, { status: 'completed' })
  db.rememberMemory({ content: '喜欢蓝莓蛋糕', scope: 'global', kind: 'preference', sourceMessageId: user.id })
  const later = db.appendMessage({ conversationId: 'later', requestId: randomUUID(), role: 'user', content: '另一条问题' })
  db.appendMessage({ conversationId: 'later', requestId: later.requestId, role: 'assistant', content: '你喜欢蓝莓蛋糕', sourceMessageIds: [assistant.id] })
  db.saveSummary('main', { text: '喜欢蓝莓蛋糕', throughSeq: assistant.seq, sourceMessageIds: [user.id] })
  const retracted = db.retractMessage(user.id)
  assert.ok(retracted.retractedAt)
  assert.equal(retracted.content, request.text)
  assert.ok(db.getMessage(assistant.id).retractedAt)
  assert.equal(db.listMessages('main', { forContext: true }).length, 0)
  assert.equal(db.listMessages('later', { forContext: true }).length, 0)
  assert.equal(db.listMemories().length, 0)
  assert.equal(db.getSummary('main'), null)
  assert.equal(db.searchMessages('蓝莓蛋糕').length, 0)
  assert.equal(db.getTurn(request.requestId).status, 'failed')
  assert.equal(db.retractMessage(user.id).retractedAt, retracted.retractedAt)
})

test('only existing user messages can be retracted and fallback checks conversation', t => {
  const { db } = fixture(t)
  const request = input()
  const turn = db.beginTurn(request)
  const assistant = db.appendMessage({ conversationId: 'main', requestId: request.requestId, role: 'assistant', content: '好' })
  assert.throws(() => db.retractMessage('missing'), error => error.status === 404)
  assert.throws(() => db.retractMessage(assistant.id), /只能撤回/)
  assert.throws(() => db.retractRequest({ requestId: request.requestId, conversationId: 'other' }), error => error.status === 404)
  assert.throws(() => db.retractRequest({ requestId: randomUUID(), conversationId: 'main' }), error => error.status === 404)
  assert.equal(db.retractRequest(request).id, turn.userMessageId)
})

test('retract during model wait discards tool writes and blocks retry while allowing a new request', async t => {
  const waiting = deferred(), entered = deferred()
  let calls = 0
  const { db, xixi } = fixture(t, async () => {
    calls += 1
    if (calls === 1) { entered.resolve(); return waiting.promise }
    return reply('新消息收到了')
  })
  const request = input()
  const pending = xixi.chat(request)
  await entered.promise
  db.retractRequest(request)
  const next = await xixi.chat(input('换个话题'))
  assert.equal(next.status, 'completed')
  waiting.resolve(tool('create_tasks', { tasks: [{ title: '不应该创建' }] }))
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.match(result.error, /已撤回/)
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.listMessages('main').filter(message => message.requestId === request.requestId).length, 1)
  assert.equal((await xixi.chat(request)).status, 'failed')
  assert.equal(calls, 2)
})

test('retract after task commit keeps business changes and explicit undo working', async t => {
  const waiting = deferred(), entered = deferred()
  let calls = 0
  const { db, xixi } = fixture(t, async () => {
    if (++calls === 1) return tool('create_tasks', { tasks: [{ title: '已经保存的报告' }] })
    entered.resolve()
    return waiting.promise
  })
  const request = input()
  const pending = xixi.chat(request)
  await entered.promise
  const operation = db.listOperations({ requestId: request.requestId }).find(operation => operation.kind !== 'planner')
  assert.equal(db.listTasks().length, 1)
  db.retractRequest(request)
  waiting.resolve(reply('这个回复不应该落库'))
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.equal(result.operations.length, 2)
  assert.equal(db.listTasks().length, 1)
  assert.ok(db.listMessages('main').every(message => message.content !== '这个回复不应该落库'))
  db.undoOperation(operation.id)
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.getPlanner().blocks.length, 0)
})

test('retracted questions are hidden and HTTP fallback never reports unknown requests as success', async t => {
  const { db } = fixture(t)
  const service = createLocalService({ db, vault: { status: async () => true }, complete: async () => reply('unused') })
  const request = input('需要问我的原话')
  const turn = db.beginTurn(request)
  db.appendMessage({ conversationId: 'main', requestId: request.requestId, role: 'assistant', content: '你选哪个', question: { options: ['明天', '周五'] } })
  db.finishTurn(request.requestId, { status: 'completed' })
  const result = await invoke(service, `/messages/${encodeURIComponent(turn.userMessageId)}/retract`, {})
  assert.equal(result.status, 200)
  assert.equal(result.body.messages.length, 1)
  assert.equal(result.body.messages[0].content, '已撤回')
  assert.ok(result.body.messages[0].retractedAt)
  assert.doesNotMatch(JSON.stringify(result.body), /需要问我的原话|你选哪个|明天|周五/)
  const fallback = await invoke(service, '/messages/retract', { requestId: request.requestId, conversationId: request.conversationId })
  assert.equal(fallback.status, 200)
  const unknown = await invoke(service, '/messages/retract', { requestId: randomUUID(), conversationId: 'main' })
  assert.equal(unknown.status, 404)
  const replay = await invoke(service, '/chat', request)
  assert.equal(replay.body.status, 'failed')
  assert.match(replay.body.error, /已撤回/)
  const topics = await invoke(service, '/conversations')
  assert.doesNotMatch(JSON.stringify(topics.body), /需要问我的原话/)
})

test('independent SQLite connections cannot revive a retracted turn or append late writes', t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-retraction-test-'))
  const file = join(directory, 'test.sqlite')
  const first = createDatabase(file), second = createDatabase(file)
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }) })
  const request = input()
  const turn = first.beginTurn(request)
  second.retractMessage(turn.userMessageId)
  assert.equal(first.beginTurn(request).claimed, false)
  assert.ok(first.finishTurn(request.requestId, { status: 'completed' }).retractedAt)
  assert.equal(first.getTurn(request.requestId).status, 'failed')
  assert.throws(() => first.appendMessage({ conversationId: 'main', requestId: request.requestId, role: 'assistant', content: 'late' }), /已撤回/)
  assert.throws(() => first.applyOperation({ id: randomUUID(), requestId: request.requestId, summary: 'late', changes: [{ table: 'tasks', id: 'late', before: null, after: null }] }), /已撤回/)
})

test('a source retracted during an unrelated active model request stops its stale reply', async t => {
  const waiting = deferred(), entered = deferred()
  const { db, xixi } = fixture(t, async () => { entered.resolve(); return waiting.promise })
  const source = db.appendMessage({ conversationId: 'main', requestId: randomUUID(), role: 'user', content: '旧的敏感内容' })
  const request = input('根据上面安排')
  const pending = xixi.chat(request)
  await entered.promise
  db.retractMessage(source.id)
  waiting.resolve(tool('create_tasks', { tasks: [{ title: '基于已撤回内容的任务' }] }))
  const result = await pending
  assert.equal(result.status, 'failed')
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.listMessages('main').filter(message => message.role === 'assistant').length, 0)
})

test('summary arriving after source retraction cannot revive excluded text', async t => {
  const waiting = deferred(), entered = deferred()
  let calls = 0
  const { db, xixi } = fixture(t, async request => {
    calls += 1
    if (request.response_format) { entered.resolve(); return waiting.promise }
    return reply('新的回答')
  })
  let first
  for (let i = 0; i < 18; i += 1) {
    const requestId = randomUUID()
    const user = db.appendMessage({ conversationId: 'main', requestId, role: 'user', content: `历史第${i}项` })
    if (!first) first = user
    db.appendMessage({ conversationId: 'main', requestId, role: 'assistant', content: `回应${i}` })
  }
  const pending = xixi.chat(input('接着讨论'))
  await entered.promise
  db.retractMessage(first.id)
  waiting.resolve(reply(JSON.stringify({ goal: '被撤回内容', openItems: ['不应重新入库'] })))
  assert.equal((await pending).status, 'completed')
  assert.equal(db.getSummary('main'), null)
  assert.equal(calls, 2)
})

test('model selection persists across database connections and rejects unsupported models', t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-model-test-'))
  const file = join(directory, 'test.sqlite')
  const first = createDatabase(file), second = createDatabase(file)
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.equal(first.getModel(), 'deepseek-flash')
  assert.equal(first.setModel('deepseek-v4-pro'), 'deepseek-v4-pro')
  assert.equal(second.getModel(), 'deepseek-v4-pro')
  assert.throws(() => second.setModel('user-provided-remote-model'), error => error.status === 400)
  assert.equal(first.getModel(), 'deepseek-v4-pro')
  const reopened = createDatabase(file)
  assert.equal(reopened.getModel(), 'deepseek-v4-pro')
  reopened.close()
})

test('model API returns the shared choice and accepts only the allowlist', async t => {
  const { db } = fixture(t)
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => reply('unused') })
  const initial = await invoke(service, '/status')
  assert.equal(initial.body.model, 'deepseek-flash')
  assert.ok(initial.body.models.some(model => model.id === 'deepseek-v4-pro'))
  const selected = await invoke(service, '/settings/model', { model: 'deepseek-v4-pro' })
  assert.equal(selected.status, 200)
  assert.equal(selected.body.model, 'deepseek-v4-pro')
  assert.equal((await invoke(service, '/settings/model', { model: 'invalid' })).status, 400)
  assert.equal((await invoke(service, '/settings/model', { model: 'deepseek-flash', url: 'extra' })).status, 400)
  assert.equal(db.getModel(), 'deepseek-v4-pro')
})

test('retracting an older loaded message returns its tombstone without changing the latest page cursor', async t => {
  const { db } = fixture(t)
  const service = createLocalService({ db, vault: { status: async () => true }, complete: async () => reply('unused') })
  const request = input('很早的那条消息')
  const original = db.beginTurn(request)
  db.finishTurn(request.requestId, { status: 'completed' })
  for (let i = 0; i < 220; i += 1) db.appendMessage({ conversationId: 'main', requestId: randomUUID(), role: 'user', content: `后来的消息${i}` })
  const before = await invoke(service, '/conversation?id=main')
  assert.equal(before.body.messages.some(message => message.id === original.userMessageId), false)
  const response = await invoke(service, `/messages/${encodeURIComponent(original.userMessageId)}/retract`, {})
  assert.equal(response.status, 200)
  const target = response.body.messages.find(message => message.id === original.userMessageId)
  assert.equal(target.content, '已撤回')
  assert.ok(target.retractedAt)
  assert.equal(response.body.oldestSeq, before.body.oldestSeq)
  assert.equal(response.body.hasOlder, before.body.hasOlder)
  const fallback = await invoke(service, '/messages/retract', request)
  assert.equal(fallback.status, 400)
  const validFallback = await invoke(service, '/messages/retract', { requestId: request.requestId, conversationId: request.conversationId })
  assert.ok(validFallback.body.messages.find(message => message.id === original.userMessageId)?.retractedAt)
})

test('resuming an interrupted tool rechecks its original sources after the persisted snapshot was read', async t => {
  const { db } = fixture(t)
  const source = db.appendMessage({ conversationId: 'main', requestId: randomUUID(), role: 'user', content: '曾经提供的依据' })
  const request = input('根据那条消息创建任务')
  const turn = db.beginTurn(request)
  db.appendMessage({ conversationId: 'main', requestId: request.requestId, role: 'assistant', content: '',
    toolCalls: tool('create_tasks', { tasks: [{ title: '本应阻断的任务' }] }).choices[0].message.tool_calls,
    sourceMessageIds: [source.id, turn.userMessageId] })
  db.finishTurn(request.requestId, { status: 'failed' })
  const originalList = db.listMessages
  let retractAfterSnapshot = true
  db.listMessages = (id, options) => {
    const rows = originalList(id, options)
    if (options?.forContext && retractAfterSnapshot) {
      retractAfterSnapshot = false
      db.retractMessage(source.id)
    }
    return rows
  }
  const xixi = createXixi({ db, complete: async () => { throw new Error('provider must not run') } })
  const response = await xixi.chat(request)
  assert.equal(response.status, 'failed')
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.listOperations({ requestId: request.requestId }).length, 0)
})

test('conversation rename and delete are strict, persistent, scoped, and preserve tasks', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-conversations-test-'))
  const file = join(directory, 'test.sqlite')
  const first = createDatabase(file), second = createDatabase(file)
  t.after(() => { first.close(); second.close(); rmSync(directory, { recursive: true, force: true }) })
  const main = first.getActiveConversation()
  const other = first.createConversation({ title: '旧话题' })
  const task = first.createTask({ title: '不要随对话删除' })
  const retainedMessage = first.appendMessage({ conversationId: main.id, role: 'user', content: '留着这段' })
  first.rememberMemory({ content: '保留的记忆', scope: 'global', kind: 'context', sourceMessageId: retainedMessage.id })
  first.saveSummary(main.id, { text: '保留的摘要', throughSeq: retainedMessage.seq, sourceMessageIds: [retainedMessage.id] })
  const request = input('这段话只属于旧话题')
  request.conversationId = other.id
  const turn = first.beginTurn(request)
  first.finishTurn(request.requestId, { status: 'completed' })
  first.rememberMemory({ content: '旧话题记忆', scope: 'global', kind: 'context', sourceMessageId: turn.userMessageId })
  first.appendMessage({ conversationId: other.id, requestId: randomUUID(), role: 'assistant', content: '旧回答' })
  const source = first.getMessage(turn.userMessageId)
  first.saveSummary(other.id, { text: '要删的摘要', throughSeq: source.seq, sourceMessageIds: [source.id] })
  const operation = first.applyOperation({ id: randomUUID(), requestId: request.requestId, summary: '更新任务备注',
    changes: [{ table: 'tasks', id: task.id, before: task, after: { ...task, notes: '保留这次业务修改' } }] })
  const updatedBefore = second.listConversations().find(item => item.id === other.id).updatedAt
  const renamed = first.renameConversation(other.id, '  新标题  ')
  assert.equal(renamed.title, '新标题')
  assert.equal(second.listConversations().find(item => item.id === other.id).title, '新标题')
  assert.match(renamed.updatedAt, /^\d{4}-\d{2}/)
  assert.ok(renamed.updatedAt > updatedBefore)
  assert.equal(second.listConversations().find(item => item.id === other.id).updatedAt, renamed.updatedAt)
  assert.throws(() => first.renameConversation(other.id, '   '), error => error.status === 400)
  assert.throws(() => first.renameConversation(other.id, 'x'.repeat(81)), error => error.status === 400)
  assert.equal(first.renameConversation(other.id, ` ${'x'.repeat(80)} `).title.length, 80)
  const deleted = first.deleteConversation(other.id)
  assert.equal(deleted.deletedId, other.id)
  assert.equal(first.getTask(task.id).title, '不要随对话删除')
  assert.equal(first.getTask(task.id).notes, '保留这次业务修改')
  assert.equal(first.getMessage(turn.userMessageId), null)
  assert.equal(first.getTurn(request.requestId), null)
  assert.equal(first.listMemories().length, 1)
  assert.equal(first.listMemories()[0].sourceMessageId, retainedMessage.id)
  assert.equal(first.getSummary(other.id), null)
  assert.equal(first.getSummary(main.id).text, '保留的摘要')
  assert.ok(first.getMessage(retainedMessage.id))
  assert.equal(first.listOperations().some(item => item.id === operation.id), false)
  assert.equal(first.listConversations().some(item => item.id === other.id), false)
  assert.equal(first.getActiveConversation().id, deleted.activeConversationId)
  assert.equal(second.listConversations().some(item => item.id === other.id), false)
  assert.throws(() => second.ensureConversation(other.id), error => error.status === 410)
  assert.throws(() => second.beginTurn(request), error => error.status === 410)
})

test('deleting active conversation selects latest remaining and refuses the final conversation', t => {
  const { db } = fixture(t)
  const first = db.getActiveConversation()
  const second = db.createConversation({ title: '第二段' })
  const third = db.createConversation({ title: '第三段' })
  db.appendMessage({ conversationId: first.id, role: 'user', content: '最近的对话' })
  db.selectConversation(third.id)
  const deleted = db.deleteConversation(third.id)
  assert.equal(deleted.activeConversationId, first.id)
  assert.equal(db.getActiveConversation().id, first.id)
  db.deleteConversation(second.id)
  assert.equal(db.getActiveConversation().id, first.id)
  assert.throws(() => db.deleteConversation(first.id), error => error.status === 409)
})

test('conversation activity keeps real write order when creation and messages share a millisecond', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-19T08:00:00.000Z') })
  const { db } = fixture(t)
  const first = db.getActiveConversation()
  t.mock.timers.setTime(Date.now() + 1)
  const second = db.createConversation({ title: '第二段' })
  const third = db.createConversation({ title: '第三段' })
  db.appendMessage({ conversationId: first.id, role: 'user', content: '这条消息才是最新活动' })
  assert.deepEqual(db.listConversations().map(item => item.id), [first.id, third.id, second.id])
  db.selectConversation(third.id)
  assert.equal(db.deleteConversation(third.id).activeConversationId, first.id)
  db.renameConversation(second.id, '刚刚改了名称')
  assert.deepEqual(db.listConversations().map(item => item.id), [second.id, first.id])
  const newest = db.createConversation({ title: '现在才创建' })
  assert.deepEqual(db.listConversations().map(item => item.id), [newest.id, second.id, first.id])
})

test('conversation endpoints enforce exact fields and cascade only selected data', async t => {
  const { db } = fixture(t)
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => reply('unused') })
  const first = db.getActiveConversation()
  const second = db.createConversation({ title: '可删' })
  const badRename = await invoke(service, '/conversations/rename', { conversationId: second.id, title: '可以', extra: true })
  assert.equal(badRename.status, 400)
  const badDelete = await invoke(service, '/conversations/delete', { conversationId: second.id, title: '多余' })
  assert.equal(badDelete.status, 400)
  const rename = await invoke(service, '/conversations/rename', { conversationId: second.id, title: ' 新名称 ' })
  assert.equal(rename.status, 200)
  assert.equal(rename.body.title, '新名称')
  assert.match(rename.body.updatedAt, /^\d{4}-\d{2}/)
  const listed = await invoke(service, '/conversations')
  assert.equal(listed.status, 200)
  assert.deepEqual(Object.keys(listed.body[0]).sort(), ['createdAt', 'id', 'title', 'updatedAt'])
  assert.equal(db.listConversations().find(item => item.id === second.id).title, '新名称')
  const deletion = await invoke(service, '/conversations/delete', { conversationId: second.id })
  assert.equal(deletion.status, 200)
  assert.equal(deletion.body.conversationId, first.id)
  const final = await invoke(service, '/conversations/delete', { conversationId: first.id })
  assert.equal(final.status, 409)
  assert.equal((await invoke(service, '/conversations/rename', { conversationId: first.id, title: null })).status, 400)
  assert.equal((await invoke(service, '/conversations/delete', { conversationId: 'absent' })).status, 404)
  assert.equal((await invoke(service, '/conversations/rename', { conversationId: 'absent', title: '不存在' })).status, 404)
})

test('manual conversation names survive later messages and retractions', t => {
  const { db } = fixture(t)
  const conversation = db.getActiveConversation()
  db.renameConversation(conversation.id, '与析熙的对话')
  const first = db.appendMessage({ conversationId: conversation.id, role: 'user', content: '这个不该变成标题' })
  assert.equal(db.getActiveConversation().title, '与析熙的对话')
  db.renameConversation(conversation.id, '我自己的名字')
  db.retractMessage(first.id)
  assert.equal(db.getActiveConversation().title, '我自己的名字')
})

test('conversation deletion excludes derived context but preserves unrelated data in other conversations', t => {
  const { db } = fixture(t)
  const source = db.appendMessage({ conversationId: 'source', role: 'user', requestId: 'old-request', content: '要移除的旧偏好' })
  db.rememberMemory({ content: '旧偏好', sourceMessageId: source.id })
  const question = db.appendMessage({ conversationId: 'derived', role: 'user', requestId: 'derived-request', content: '之前说过什么' })
  db.appendMessage({ conversationId: 'derived', role: 'assistant', requestId: 'derived-request', content: '你说过旧偏好', sourceMessageIds: [source.id] })
  db.rememberMemory({ content: '派生记忆', sourceMessageId: question.id })
  db.saveSummary('derived', { text: '旧偏好的派生摘要', throughSeq: question.seq, sourceMessageIds: [question.id] })
  const unrelated = db.appendMessage({ conversationId: 'derived', role: 'user', requestId: 'unrelated-request', content: '另一条独立的消息' })
  db.rememberMemory({ content: '独立记忆', sourceMessageId: unrelated.id })
  db.deleteConversation('source')
  assert.equal(db.getMessage(source.id), null)
  assert.equal(db.getMessage(question.id).excludeFromContext, true)
  assert.equal(db.getMessage(unrelated.id).excludeFromContext, false)
  assert.equal(db.searchMessages('旧偏好').length, 0)
  assert.deepEqual(db.listMemories().map(memory => memory.content), ['独立记忆'])
  assert.equal(db.getSummary('derived'), null)
  assert.throws(() => db.assertTurnWritable('inflight', [source.id]), error => error.status === 409)
})

test('deleting a conversation during a provider call discards later tool actions and does not recreate it', async t => {
  const started = deferred(), response = deferred()
  const { db, xixi } = fixture(t, async () => { started.resolve(); return response.promise })
  const retained = db.createConversation()
  const request = input('创建一个任务')
  const running = xixi.chat(request)
  await started.promise
  db.deleteConversation(request.conversationId)
  response.resolve(tool('create_tasks', { tasks: [{ title: '不能写入' }] }))
  await assert.rejects(running, error => error.status === 404 || error.status === 410)
  assert.equal(db.getTurn(request.requestId), null)
  assert.equal(db.listTasks().length, 0)
  assert.deepEqual(db.listConversations().map(item => item.id), [retained.id])
  await assert.rejects(xixi.chat(request), error => error.status === 410)
})

test('existing conversation schema migrates its last activity before rename', t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-conversation-migration-'))
  const file = join(directory, 'test.sqlite')
  const old = new DatabaseSync(file)
  old.exec(`CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL);
    CREATE TABLE messages (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, conversationId TEXT NOT NULL, role TEXT NOT NULL, document TEXT NOT NULL);
    INSERT INTO conversations VALUES ('historic', '旧标题', '2026-01-01T00:00:00.000Z');`)
  old.prepare('INSERT INTO messages(id,conversationId,role,document) VALUES (?,?,?,?)').run('old-message', 'historic', 'user',
    JSON.stringify({ id: 'old-message', conversationId: 'historic', role: 'user', content: '旧消息', createdAt: '2026-01-02T00:00:00.000Z', excludeFromContext: false }))
  old.close()
  const db = createDatabase(file)
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.equal(db.listConversations()[0].updatedAt, '2026-01-02T00:00:00.000Z')
  assert.equal(db.renameConversation('historic', '迁移后').title, '迁移后')
  assert.equal(db.listMessages('historic')[0].content, '旧消息')
})
