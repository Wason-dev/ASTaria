import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

async function fixture(t) {
  const db = createDatabase(':memory:')
  const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw new Error('No model calls allowed') } })
  const server = createServer((req, res) => service.middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close() })
  const request = async path => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { headers: { 'X-ASTaria-Local': '1' } })
    return { status: response.status, value: await response.json() }
  }
  return { db, request, reasoning: (requestId, conversationId = 'main') => request(`/conversation/reasoning?conversationId=${conversationId}&requestId=${requestId}`) }
}

function begin(db) {
  return db.beginTurn({ requestId: randomUUID(), conversationId: 'main', text: '测试思考复制', context: {} })
}

test('full reasoning copy preserves all rounds past preview and history page limits', async t => {
  const f = await fixture(t), turn = begin(f.db)
  const thoughts = [' \n第一轮🌌\t'.repeat(20000), '\n  最后一轮原文\t ']
  const first = f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'assistant', content: '', reasoningContent: thoughts[0],
    toolCalls: [{ id: 'tool-one', type: 'function', function: { name: 'read_tasks', arguments: '{}' } }] })
  f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'tool', toolCallId: 'tool-one', content: '{}' })
  const final = f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'assistant', content: '核对完毕', reasoningContent: thoughts[1] })
  f.db.finishTurn(turn.requestId, { status: 'completed' })
  const preview = (await f.request('/conversation?id=main')).value.messages.find(message => message.id === final.id)
  assert.match(preview.reasoningContent, /展示已截短/)
  assert.ok(preview.reasoningContent.length < thoughts.join('\n\n').length)
  for (let index = 0; index < 1001; index++) f.db.appendMessage({ conversationId: 'main', role: 'user', content: `后续消息${index}` })
  const copied = await f.reasoning(turn.requestId)
  assert.equal(copied.status, 200)
  assert.equal(copied.value.status, 'completed')
  assert.equal(copied.value.roundCount, 2)
  assert.equal(copied.value.reasoningContent, thoughts.join('\n\n'))
  assert.deepEqual(copied.value.rounds, [{ id: first.id, content: thoughts[0] }, { id: final.id, content: thoughts[1] }])
  assert.equal(f.db.getMessage(first.id).reasoningContent, thoughts[0])
  assert.equal(f.db.getMessage(final.id).reasoningContent, thoughts[1])
})

test('a failed turn exposes its saved tool-round reasoning on the user bubble', async t => {
  const f = await fixture(t), turn = begin(f.db)
  const saved = f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'assistant', content: '', reasoningContent: ' \n失败前已保存的完整轮次\t ',
    toolCalls: [{ id: 'failed-tool', type: 'function', function: { name: 'read_tasks', arguments: '{}' } }] })
  f.db.finishTurn(turn.requestId, { status: 'failed', error: '模拟后续连接中断' })
  const messages = (await f.request('/conversation?id=main')).value.messages
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, turn.userMessageId)
  assert.equal(messages[0].hasSavedReasoning, true)
  assert.equal(messages[0].reasoningContent, undefined, 'the preview must not duplicate saved thoughts on a user message')
  const copied = await f.reasoning(turn.requestId)
  assert.equal(copied.status, 200)
  assert.equal(copied.value.status, 'failed')
  assert.equal(copied.value.reasoningContent, ' \n失败前已保存的完整轮次\t ')
  assert.deepEqual(copied.value.rounds, [{ id: saved.id, content: ' \n失败前已保存的完整轮次\t ' }])
  assert.deepEqual((await f.reasoning(turn.requestId)).value.rounds, copied.value.rounds, 'refreshing must return stable round identities')
})

test('history pages starting after a tool round still expose the saved thinking on the final reply', async t => {
  const f = await fixture(t), turn = begin(f.db)
  const thoughts = ' \n只在工具之前生成的思考\t '
  f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'assistant', content: '', reasoningContent: thoughts,
    toolCalls: [{ id: 'boundary-tool', type: 'function', function: { name: 'read_tasks', arguments: '{}' } }] })
  f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'tool', toolCallId: 'boundary-tool', content: '{}' })
  const final = f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'assistant', content: '核对完毕' })
  f.db.finishTurn(turn.requestId, { status: 'completed' })
  for (let index = 0; index < 199; index++) f.db.appendMessage({ conversationId: 'main', role: 'user', content: `后续消息${index}` })
  const page = (await f.request('/conversation?id=main')).value
  assert.equal(page.oldestSeq, final.seq)
  assert.equal(page.messages[0].id, final.id)
  assert.equal(page.messages[0].hasSavedReasoning, true)
  assert.equal(page.messages[0].reasoningContent, undefined, 'ordinary history does not eagerly load older thought text')
  assert.equal((await f.reasoning(turn.requestId)).value.reasoningContent, thoughts)
})

test('reasoning copy rejects wrong conversations, missing content and withdrawn sources', async t => {
  const f = await fixture(t), turn = begin(f.db)
  assert.equal((await f.reasoning(turn.requestId)).status, 404)
  f.db.appendMessage({ conversationId: 'main', requestId: turn.requestId, role: 'assistant', content: '完整回复', reasoningContent: '仅这一轮的思考' })
  f.db.finishTurn(turn.requestId, { status: 'completed' })
  assert.equal((await f.reasoning(turn.requestId, 'another-conversation')).status, 404)
  assert.equal((await f.reasoning(randomUUID())).status, 404)
  f.db.retractMessage(turn.userMessageId)
  assert.equal((await f.reasoning(turn.requestId)).status, 404)
  const messages = (await f.request('/conversation?id=main')).value.messages
  assert.ok(messages.every(message => !message.hasSavedReasoning && !message.reasoningContent))
})
