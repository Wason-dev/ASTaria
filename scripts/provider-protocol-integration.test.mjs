import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

const rawQuestion = '<｜DSML｜calls><｜DSML｜invoke name="ask_user"><｜DSML｜parameter name="question" string="true">今天19:50—21:45已经排了两段，你想怎么调整？</｜DSML｜parameter><｜DSML｜parameter name="options" string="false">["数学放今晚","重排今天","不动今天"]</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜calls>'
const response = content => ({ choices: [{ message: { role: 'assistant', content } }] })
async function setup(t, replies = []) {
  const db = createDatabase(':memory:'), requests = []
  const vault = { status: async () => true, save: async () => {}, read: async () => 'fake-unused', remove: async () => {} }
  const service = createLocalService({ db, vault, complete: async payload => { requests.push(payload); return response(replies.shift() ?? '好') }, dataDirectory: ':memory:' })
  const server = createServer((req, res) => service.middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close() })
  const request = async (path, value) => {
    const result = await fetch(`${base}/api${path}`, { method: value ? 'POST' : 'GET', headers: { 'X-Astaria-Local': '1', Origin: base, ...(value ? { 'Content-Type': 'application/json' } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) })
    assert.equal(result.status, 200)
    return result.json()
  }
  return { db, requests, request }
}
const chat = text => ({ conversationId: 'main', requestId: randomUUID(), text, context: { timezone: 'Asia/Shanghai', page: 'home' } })

test('new raw DSML ask_user response is persisted as normal question and its choices remain in follow-up context', async t => {
  const f = await setup(t, [rawQuestion, '那就先不动今天'])
  const result = await f.request('/chat', chat('我今天晚上要做什么'))
  assert.equal(result.status, 'completed')
  const answer = result.messages.find(message => message.role === 'assistant')
  assert.equal(answer.content, '今天19:50—21:45已经排了两段，你想怎么调整？')
  assert.deepEqual(answer.question.options, ['数学放今晚', '重排今天', '不动今天'])
  assert.doesNotMatch(JSON.stringify(result), /DSML/)
  await f.request('/chat', chat('第三个'))
  assert.doesNotMatch(JSON.stringify(f.requests[1]), /DSML/)
  assert.match(JSON.stringify(f.requests[1]), /3\. 不动今天/)
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.listOperations().length, 0)
})

test('old raw assistant messages render readable question without modifying stored evidence or emitting protocol into provider context', async t => {
  const f = await setup(t)
  const original = f.db.appendMessage({ conversationId: 'main', role: 'assistant', content: rawQuestion })
  f.db.appendMessage({ conversationId: 'main', role: 'assistant', content: '<|DSML|invoke name="create_tasks">' })
  const result = await f.request('/conversation?id=main')
  assert.equal(result.messages[0].content, '今天19:50—21:45已经排了两段，你想怎么调整？')
  assert.deepEqual(result.messages[0].question.options, ['数学放今晚', '重排今天', '不动今天'])
  assert.match(result.messages[1].content, /回复格式/)
  assert.doesNotMatch(JSON.stringify(result), /DSML/)
  assert.equal(f.db.getMessage(original.id).content, rawQuestion)
  await f.request('/chat', chat('第二个'))
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /DSML/)
  assert.match(JSON.stringify(f.requests[0]), /2\. 重排今天/)
})

test('malformed or write-shaped textual protocol fails safely with no task/plan mutation or raw chat bubble', async t => {
  const f = await setup(t, Array(6).fill(rawQuestion.replace('ask_user', 'create_tasks')))
  for (let index = 0; index < 2; index++) {
    const result = await f.request('/chat', chat('试着安排一下'))
    assert.equal(result.status, 'failed')
    assert.match(result.error, /回复格式/)
    assert.doesNotMatch(JSON.stringify(result.messages), /DSML/)
    assert.equal(f.db.listTasks().length, 0)
    assert.equal(f.db.getPlanner().blocks.length, 0)
    assert.equal(f.db.listOperations().length, 0)
  }
})
