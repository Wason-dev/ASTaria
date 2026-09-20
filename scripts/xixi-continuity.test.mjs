import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, contextUnits, XIXI_TOOLS } from '../server/xixi.mjs'

const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const input = text => ({ requestId: randomUUID(), conversationId: 'assignment', text, context: { page: 'home', timezone: 'Asia/Shanghai' } })
const assignment = '帮我记一下 Agentic AI G10 开学作业：加入班级微信群，修改实名；加入 Google Classroom 并修改名称；安装 Python 3.13 与 Jupyter Notebook；运行 L1_env_check.ipynb 和 L1_Python基础_课堂课件.ipynb 全部单元格；配置 WorkBuddy，生成十行以内 Python 并运行。提交群名截图、Classroom截图、WorkBuddy对话截图以及两个跑通的 notebook；安装或账号问题在评论说明设备和错误，不分享 Key。'
const question = '这份作业的截止时间是？'
const options = ['明天晚上前', '下周一前', '还没说，之后补给你']
const facts = request => JSON.parse(request.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n')[1])

test('a deadline answer retains the immediately preceding assignment, question and created task ID under a crowded context', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  for (let i = 0; i < 24; i++) db.createTask({ title: `更早截止的数学作业${i}`, due: '2026-09-20', estimateMin: 60 })
  let count = 0, created
  const requests = []
  const xixi = createXixi({ db, now: () => new Date('2026-09-19T12:07:00Z'), complete: async request => {
    requests.push(request); count++
    if (count === 1) return tool('create_tasks', { tasks: [{ title: 'Agentic AI G10 开学作业', notes: assignment }] })
    if (count === 2) { created = db.listTasks().find(task => task.title === 'Agentic AI G10 开学作业'); return tool('ask_user', { prompt: question, options }) }
    if (count === 3) {
      assert.ok(request.messages.some(message => message.role === 'user' && message.content === assignment))
      const prior = request.messages.find(message => message.role === 'assistant' && message.content.includes(question))
      assert.ok(prior); assert.match(prior.content, /Agentic AI G10/)
      assert.ok(prior.content.includes(created.id)); assert.ok(prior.content.includes(options[2]))
      assert.equal(request.messages.at(-1).content, 'Wednesday at 12:00 PM')
      assert.equal(request.messages.some(message => message.tool_calls || message.role === 'tool'), false)
      return tool('update_task', { taskId: created.id, expectedUpdatedAt: created.updatedAt, patch: { due: '2026-09-23T12:00:00+08:00' } })
    }
    if (count === 4) return reply('这份开学作业记到 9 月 23 日周三中午 12 点')
    assert.ok(request.messages.some(message => message.role === 'user' && message.content === assignment))
    assert.ok(request.messages.some(message => message.role === 'user' && message.content === 'Wednesday at 12:00 PM'))
    return reply('嗯，就是刚才的 Agentic AI 作业')
  } })
  assert.equal((await xixi.chat(input(assignment))).status, 'completed')
  assert.equal((await xixi.chat(input('Wednesday at 12:00 PM'))).status, 'completed')
  assert.equal(db.getTask(created.id).due, '2026-09-23T12:00:00+08:00')
  assert.ok(db.listTasks().filter(task => task.id !== created.id).every(task => task.due === '2026-09-20'))
  assert.equal((await xixi.chat(input('我说的就是刚刚那个作业啊'))).status, 'completed')
  assert.ok(requests.every(request => contextUnits(request.messages) + contextUnits(request.tools ?? []) <= 14000))
  assert.ok(facts(requests[2]).tasks.length < 24)
})

test('large historical tool payloads cannot evict a nearby question; raw originals remain intact', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requestId = randomUUID()
  const original = db.appendMessage({ conversationId: 'assignment', requestId, role: 'user', content: assignment })
  const calls = [{ id: 'historic-read', type: 'function', function: { name: 'read_planner', arguments: '{"date":"2026-09-19"}' } }]
  db.appendMessage({ conversationId: 'assignment', requestId, role: 'assistant', content: '', toolCalls: calls })
  const receipt = db.appendMessage({ conversationId: 'assignment', requestId, role: 'tool', toolCallId: 'historic-read', content: JSON.stringify({ unusedData: '计划细节'.repeat(3000) }) })
  db.appendMessage({ conversationId: 'assignment', requestId, role: 'assistant', content: question, question: { options } })
  let received
  const xixi = createXixi({ db, complete: async request => { received = request; return reply('收到截止时间') } })
  assert.equal((await xixi.chat(input('Wednesday at 12:00 PM'))).status, 'completed')
  assert.ok(received.messages.some(message => message.content === assignment))
  assert.ok(received.messages.some(message => message.role === 'assistant' && message.content.includes(question)))
  assert.doesNotMatch(JSON.stringify(received.messages), /unusedData/)
  assert.equal(db.getMessage(original.id).content, assignment)
  assert.ok(db.getMessage(receipt.id).content.includes('unusedData'))
  assert.ok(contextUnits(received.messages) + contextUnits(XIXI_TOOLS) < 14000)
})

test('recent-turn reservation still excludes withdrawn sources and separate conversations', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const old = input('已经撤回的开学作业内容'), turn = db.beginTurn(old)
  db.appendMessage({ conversationId: old.conversationId, requestId: old.requestId, role: 'assistant', content: '截止时间呢', sourceMessageIds: [turn.userMessageId] })
  db.finishTurn(old.requestId, { status: 'completed' }); db.retractMessage(turn.userMessageId)
  db.appendMessage({ conversationId: 'other-conversation', role: 'user', content: '其他对话的特殊暗号' })
  const xixi = createXixi({ db, complete: async request => {
    assert.doesNotMatch(JSON.stringify(request.messages), /已经撤回的开学作业内容|其他对话的特殊暗号|截止时间呢/)
    return reply('我们从这里开始')
  } })
  assert.equal((await xixi.chat(input('换个话题'))).status, 'completed')
})

test('oversized adjacent originals keep both the subject and ending question with a retrieval reference', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  for (let index = 0; index < 4; index++) {
    const requestId = randomUUID()
    db.appendMessage({ conversationId: 'assignment', requestId, role: 'user', content: `Agentic AI 作业${index}：${'具体细节'.repeat(1200)}` })
    db.appendMessage({ conversationId: 'assignment', requestId, role: 'assistant', content: `记下了这些资料${'整理内容'.repeat(500)}最后确认第${index}份作业截止时间？`, question: { options } })
  }
  let captured
  const xixi = createXixi({ db, complete: async request => { captured = request; return reply('收到') } })
  assert.equal((await xixi.chat(input('Wednesday at 12:00 PM'))).status, 'completed')
  assert.match(JSON.stringify(captured.messages), /Agentic AI 作业3|最后确认第3份作业截止时间/)
  assert.ok(captured.messages.some(message => message.role === 'assistant' && message.content.includes('最后确认第3份作业截止时间？')))
  assert.match(JSON.stringify(captured.messages), /search_history/)
  assert.ok(contextUnits(captured.messages) + contextUnits(captured.tools ?? []) <= 14000)
})

test('an oversized current message explains how to recover rather than offering an endless retry', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let calls = 0
  const xixi = createXixi({ db, complete: async () => { calls++; return reply('不应调用') } })
  const result = await xixi.chat(input('字'.repeat(8000)))
  assert.equal(result.status, 'failed'); assert.equal(calls, 0)
  assert.match(result.error, /拆成较短的消息/)
})
