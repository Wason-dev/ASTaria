import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createLocalService } from '../server/index.mjs'

test('chat accepts a selected free-time goal and still rejects unknown context fields', async t => {
  const db = createDatabase(':memory:')
  const goal = createCompanion({ db }).saveFreeTimeGoal({
    title: '三周学习计划', minPerWeek: 1, sessionMin: 20, sessionMax: 30,
    planWeeks: [1, 2, 3].map(week => ({ week, title: `第 ${week} 阶段` })),
  })
  const seen = []
  const service = createLocalService({ db, dataDirectory: ':memory:',
    vault: { status: async () => true, read: async () => 'test-only' },
    complete: async payload => {
      seen.push(payload)
      return { choices: [{ message: { role: 'assistant', content: '计划可以从本周开始。' } }] }
    },
  })
  t.after(() => service.close())
  const request = input => new Promise((resolve, reject) => {
    const body = JSON.stringify(input)
    const req = Readable.from([Buffer.from(body)])
    req.method = 'POST'
    req.url = '/api/chat'
    req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    const res = { statusCode: 200, setHeader() {}, end(raw) { try { resolve({ status: this.statusCode, value: JSON.parse(raw) }) } catch (error) { reject(error) } } }
    service.middleware(req, res, () => reject(Error('Chat middleware did not handle request')))
  })
  const input = { requestId: randomUUID(), conversationId: db.getActiveConversation().id,
    text: '请细化这个已保存的长期计划', context: { page: 'home', timezone: 'Asia/Shanghai', freeTimeGoalId: goal.id } }
  const accepted = await request(input)
  assert.equal(accepted.status, 200)
  assert.equal(accepted.value.status, 'completed')
  assert.equal(seen.length, 1)
  const environment = seen[0].messages.find(message => message.content?.startsWith('当前环境与数据库资料'))
  assert.ok(environment)
  assert.equal(JSON.parse(environment.content.slice(environment.content.indexOf('\n') + 1)).selectedFreeTimeGoal.id, goal.id)

  const rejected = await request({ ...input, requestId: randomUUID(), context: { ...input.context, unexpectedField: true } })
  assert.equal(rejected.status, 400)
  assert.match(rejected.value.error, /页面上下文包含不支持的字段/)
  assert.equal(seen.length, 1)
})
