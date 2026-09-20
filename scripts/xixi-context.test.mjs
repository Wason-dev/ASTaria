import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, contextUnits, XIXI_TOOLS } from '../server/xixi.mjs'

const NOW = new Date('2026-09-18T00:30:00+08:00')
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args, id = randomUUID()) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const input = (text, extras = {}) => ({ requestId: randomUUID(), conversationId: 'main', text,
  context: { timezone: 'Asia/Shanghai', page: 'home' }, ...extras })
function fixture(t, responses = []) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const requests = []
  let index = 0
  const complete = async request => {
    requests.push(request)
    const response = responses[index++]
    if (response instanceof Error) throw response
    return typeof response === 'function' ? await response(request) : response ?? reply('嗯')
  }
  return { db, requests, responses, xixi: createXixi({ db, complete, now: () => NOW }) }
}
const toolResults = request => request.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
const contextData = request => JSON.parse(request.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n'))

test('prompt uses positive warm persona and facts anchor midnight in the local timezone', async t => {
  const f = fixture(t)
  await f.xixi.chat(input('早'))
  const prompt = f.requests[0].messages[0].content
  assert.match(prompt, /笨蛋/)
  assert.match(prompt, /温柔/)
  const context = contextData(f.requests[0])
  assert.equal(context.now, '2026-09-17T16:30:00.000Z')
  assert.equal(context.timezone, 'Asia/Shanghai')
  assert.match(context.localTime, /2026年9月18日/)
})

test('creates real tasks with DDL and a date-only startAt intention then provides successful tool receipts', async t => {
  const f = fixture(t, [call('create_tasks', { tasks: [{ title: '物理报告', due: '2026-09-25', startAt: '2026-09-23', estimateMin: 120 }] }), reply('记好了')])
  const result = await f.xixi.chat(input('下周五交物理报告，准备周三开始，预计两小时'))
  assert.equal(result.status, 'completed')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.listTasks()[0].due, '2026-09-25')
  assert.equal(f.db.listTasks()[0].startAt, '2026-09-23')
  assert.equal(f.db.listTasks()[0].source, 'ai')
  assert.equal(result.operations.length, 1)
  assert.equal(toolResults(f.requests[1])[0].ok, true)
  assert.equal(contextData(f.requests[1]).tasks[0].title, '物理报告')
})

test('failed provider reply preserves committed actions; retry with different tool IDs does not duplicate', async t => {
  const args = { tasks: [{ title: '物理报告', due: '2026-09-25' }] }
  const f = fixture(t, [call('create_tasks', args, 'call-a'), new Error('secret-provider-body'), call('create_tasks', args, 'call-b'), reply('记好了')])
  const request = input('记下物理报告，下周五交')
  const first = await f.xixi.chat(request)
  assert.equal(first.status, 'failed')
  assert.equal(first.operations.length, 1)
  assert.doesNotMatch(JSON.stringify(first), /secret-provider-body/)
  const retry = await f.xixi.chat(request)
  assert.equal(retry.status, 'completed')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(retry.operations.length, 1)
  assert.equal(retry.messages.filter(message => message.role === 'user').length, 1)
  assert.equal(toolResults(f.requests[3])[0].reused, true)
})

test('completed request is durable and idempotent', async t => {
  const f = fixture(t)
  const request = input('晚安')
  const first = await f.xixi.chat(request)
  const second = await f.xixi.chat(request)
  assert.deepEqual(second, first)
  assert.equal(f.requests.length, 1)
  assert.deepEqual(Object.keys(f.db.getTurn(request.requestId).result).sort(), ['conversationId', 'requestId', 'status'])
  await assert.rejects(f.xixi.chat({ ...request, text: '不同消息' }), /已用于/)
})

test('completed request replay reads fresh action state without storing full history twice', async t => {
  const f = fixture(t, [call('create_tasks', { tasks: [{ title: '报告' }] }), reply('记好了')])
  const request = input('记下报告')
  const result = await f.xixi.chat(request)
  f.db.undoOperation(result.operations[0].id)
  const replay = await f.xixi.chat(request)
  assert.ok(replay.operations[0].undoneAt)
  assert.equal(f.requests.length, 2)
  assert.equal(f.db.getTurn(request.requestId).result.messages, undefined)
})

test('invalid calendar dates cannot create tasks; entire batch is rejected atomically', async t => {
  const f = fixture(t, [call('create_tasks', { tasks: [{ title: '正常事项' }, { title: '日期错误', due: '2026-02-30' }] }), reply('这个日期需要确认')])
  const result = await f.xixi.chat(input('记下两件事'))
  assert.equal(result.status, 'completed')
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(result.operations.length, 0)
  assert.equal(toolResults(f.requests[1])[0].ok, false)
})

test('task updates detect a newer browser edit rather than overwrite it', async t => {
  const f = fixture(t)
  const task = f.db.createTask({ title: '报告', due: '2026-09-25' })
  f.responses.push(call('update_task', { taskId: task.id, expectedUpdatedAt: '2020-01-01T00:00:00Z', patch: { due: '2026-09-30' } }), reply('刚有新的修改，我再看看'))
  await f.xixi.chat(input('把报告改到周日'))
  assert.equal(f.db.getTask(task.id).due, '2026-09-25')
  assert.equal(toolResults(f.requests[1])[0].ok, false)
})

test('current database facts override old chat and changes can be undone', async t => {
  const f = fixture(t)
  const task = f.db.createTask({ title: '报告', due: '2026-09-25' })
  f.db.appendMessage({ conversationId: 'main', requestId: randomUUID(), role: 'user', content: '报告周五交' })
  f.db.updateTask(task.id, { due: '2026-09-27' })
  const updated = f.db.getTask(task.id)
  f.responses.push(call('update_task', { taskId: task.id, expectedUpdatedAt: updated.updatedAt, patch: { status: 'done' } }), reply('完成了'))
  const result = await f.xixi.chat(input('报告做完了'))
  assert.equal(contextData(f.requests[0]).tasks[0].due, '2026-09-27')
  assert.equal(f.db.getTask(task.id).status, 'done')
  f.db.undoOperation(result.operations[0].id)
  assert.equal(f.db.getTask(task.id).status, 'todo')
})

test('focused task receives its latest bounded notes and classification dictionary without unrelated notes', async t => {
  const f = fixture(t)
  const selected = f.db.createTask({ title: '物理报告', notes: '旧备注', area: 'phy2', energy: 'deep', context: ['library'], fuzzyWindow: 'this-week' })
  f.db.createTask({ title: '其他事项', notes: '不相关的完整备注不应默认发出' })
  f.db.updateTask(selected.id, { notes: '最新分析要求：' + '甲'.repeat(1400) })
  await f.xixi.chat(input('帮我看这一项', { context: { timezone: 'Asia/Shanghai', page: 'workbench', taskId: selected.id } }))
  const context = contextData(f.requests[0])
  assert.match(context.selectedTask.notes, /^最新分析要求：/)
  assert.equal(context.selectedTask.notes.length, 1000)
  assert.equal(context.selectedTask.area, 'phy2')
  assert.equal(context.selectedTask.energy, 'deep')
  assert.deepEqual(context.selectedTask.context, ['library'])
  assert.equal(context.selectedTask.fuzzyWindow, 'this-week')
  assert.ok(context.areas.some(area => area.id === 'phy2' && area.name === 'Phy2' && area.defaultEnergy === 'deep'))
  assert.ok(context.tasks.every(task => task.notes === undefined))
  assert.doesNotMatch(JSON.stringify(f.requests[0]), /不相关的完整备注不应默认发出/)
  assert.ok(contextUnits(f.requests[0].messages) + contextUnits(XIXI_TOOLS) < 9000)
})

test('memory source is fixed to current user message and inspectable', async t => {
  const f = fixture(t, [call('remember', { content: '喜欢温柔的交流', evidence: '我喜欢你温柔点', scope: 'global', kind: 'preference' }), reply('嗯，记住了')])
  const result = await f.xixi.chat(input('我喜欢你温柔点'))
  assert.equal(f.db.listMemories().length, 1)
  const memory = f.db.listMemories()[0]
  assert.equal(memory.sourceMessageId, result.messages.find(message => message.role === 'user').id)
  assert.equal(result.operations.length, 1)
  assert.equal(memory.kind, 'preference')
})

test('invented user evidence cannot become a persistent memory', async t => {
  const f = fixture(t, [call('remember', { content: '害怕社交', evidence: '我害怕社交', scope: 'global', kind: 'preference' }), reply('嗯，先休息')])
  await f.xixi.chat(input('今天有点累'))
  assert.equal(f.db.listMemories().length, 0)
  assert.equal(toolResults(f.requests[1])[0].ok, false)
})

test('replacement removes stale preference from relevant memory', async t => {
  const f = fixture(t, [call('remember', { content: '专注35分钟', evidence: '专注35分钟', scope: 'global', kind: 'preference' }), reply('记好了')])
  await f.xixi.chat(input('以后专注35分钟'))
  const old = f.db.listMemories()[0]
  f.responses.push(call('remember', { content: '专注25分钟', evidence: '专注25分钟', scope: 'global', kind: 'preference', replacesId: old.id }), reply('好，改成25分钟'))
  await f.xixi.chat(input('改成专注25分钟'))
  assert.deepEqual(f.db.listMemories().map(memory => memory.content), ['专注25分钟'])
})

test('forgetting removes source from retrieval and future context with a durable non-reversible receipt', async t => {
  const f = fixture(t, [call('remember', { content: '喜欢蓝莓蛋糕', evidence: '喜欢蓝莓蛋糕', scope: 'global', kind: 'preference' }), reply('蓝莓蛋糕，记住了')])
  await f.xixi.chat(input('我喜欢蓝莓蛋糕'))
  const memory = f.db.listMemories()[0]
  f.responses.push(call('forget_memory', { memoryId: memory.id, evidence: '忘记刚才那条偏好' }), reply('好，已经忘记了'))
  const forgotten = await f.xixi.chat(input('忘记刚才那条偏好'))
  assert.equal(forgotten.status, 'completed')
  assert.equal(f.db.listMemories().length, 0)
  assert.equal(f.db.searchMessages('蓝莓蛋糕').length, 0)
  assert.equal(forgotten.operations.length, 1)
  assert.equal(forgotten.operations[0].undoable, false)
  assert.throws(() => f.db.undoOperation(forgotten.operations[0].id))
  await f.xixi.chat(input('我们聊点别的'))
  assert.doesNotMatch(JSON.stringify(f.requests.at(-1)), /蓝莓蛋糕/)
})

test('task memories load only in their scope and expired preferences stay out', async t => {
  const f = fixture(t)
  const a = f.db.createTask({ title: '数学' })
  const b = f.db.createTask({ title: '物理' })
  const source = f.db.appendMessage({ conversationId: 'main', role: 'user', content: '旧消息' })
  f.db.rememberMemory({ content: '数学先写草稿', scope: 'task', taskId: a.id, kind: 'project', sourceMessageId: source.id })
  f.db.rememberMemory({ content: '过期临时偏好', scope: 'global', kind: 'context', sourceMessageId: source.id, expiresAt: '2020-01-01T00:00:00Z' })
  await f.xixi.chat(input('来做物理', { context: { timezone: 'Asia/Shanghai', taskId: b.id } }))
  assert.equal(contextData(f.requests.at(-1)).memories.length, 0)
  await f.xixi.chat(input('来做数学', { context: { timezone: 'Asia/Shanghai', taskId: a.id } }))
  assert.equal(contextData(f.requests.at(-1)).memories[0].content, '数学先写草稿')
})

test('tool loop stops after bounded rounds and retains all applied changes', async t => {
  const f = fixture(t, Array.from({ length: 6 }, (_, i) => call('create_tasks', { tasks: [{ title: `任务${i}` }] })))
  const result = await f.xixi.chat(input('安排事情'))
  assert.equal(f.requests.length, 6)
  assert.equal(f.requests.at(-1).tools, undefined)
  assert.equal(result.status, 'failed')
  assert.equal(result.operations.length, 5)
  assert.equal(f.db.listTasks().length, 5)
})

test('same-conversation concurrent requests serialize and see prior message', async t => {
  const f = fixture(t, [async () => { await new Promise(resolve => setTimeout(resolve, 10)); return reply('第一条好了') }, reply('第二条好了')])
  const [first, second] = await Promise.all([f.xixi.chat(input('第一条')), f.xixi.chat(input('第二条'))])
  assert.equal(first.status, 'completed')
  assert.equal(second.status, 'completed')
  assert.ok(f.requests[1].messages.some(message => message.content === '第一条好了'))
})

test('summaries preserve source references and original records while bounding recent history', async t => {
  const f = fixture(t)
  for (let i = 0; i < 18; i += 1) {
    const requestId = randomUUID()
    f.db.appendMessage({ conversationId: 'main', requestId, role: 'user', content: `报告第${i}段还没决定` })
    f.db.appendMessage({ conversationId: 'main', requestId, role: 'assistant', content: `先保留这个问题${i}` })
  }
  f.responses.push(request => {
    assert.equal(request.response_format.type, 'json_object')
    const source = JSON.parse(request.messages.find(message => message.role === 'user').content).source
    return reply(JSON.stringify({ goal: '报告', constraints: [], decisions: [], openItems: [{ text: '报告还有未定的段落', source: source[0].id }], completedActions: [] }))
  }, reply('我们接着看'))
  await f.xixi.chat(input('继续讨论报告'))
  const summary = f.db.getSummary('main')
  assert.ok(summary.sourceMessageIds.length >= 12)
  assert.equal(f.db.listMessages('main', { limit: 1000 }).length, 38)
  assert.match(summary.text, /未定/)
  assert.ok(contextUnits(f.requests.at(-1).messages) + contextUnits(XIXI_TOOLS) < 9000)
  assert.ok(contextData(f.requests.at(-1)).summary.sourceMessageIds.length > 0)
})

test('malformed summary leaves original history usable', async t => {
  const f = fixture(t)
  for (let i = 0; i < 24; i += 1) f.db.appendMessage({ conversationId: 'main', requestId: randomUUID(), role: i % 2 ? 'assistant' : 'user', content: `原文${i}` })
  f.responses.push(reply('not json'), reply('继续'))
  const result = await f.xixi.chat(input('继续'))
  assert.equal(result.status, 'completed')
  assert.equal(f.db.getSummary('main'), null)
  assert.ok(f.requests.at(-1).messages.some(message => message.content === '原文23'))
})

test('long-dialogue summary receives ordered question choices and retains their meaning for ordinal answers', async t => {
  const f = fixture(t)
  const firstRequest = randomUUID()
  f.db.appendMessage({ conversationId: 'main', requestId: firstRequest, role: 'user', content: '报告先留多少时间' })
  const question = f.db.appendMessage({ conversationId: 'main', requestId: firstRequest, role: 'assistant',
    content: '想先做多久？', question: { options: ['先看题十分钟', '大约一小时', '先不安排'] } })
  for (let i = 0; i < 17; i += 1) {
    const requestId = randomUUID()
    f.db.appendMessage({ conversationId: 'main', requestId, role: 'user', content: `先聊其他事情${i}` })
    f.db.appendMessage({ conversationId: 'main', requestId, role: 'assistant', content: `其他事情${i}已讨论` })
  }
  f.responses.push(request => {
    assert.equal(request.response_format.type, 'json_object')
    const source = JSON.parse(request.messages.find(message => message.role === 'user').content).source
    const original = source.find(message => message.id === question.id)
    assert.deepEqual(original.question.options, ['先看题十分钟', '大约一小时', '先不安排'])
    assert.match(request.messages[0].content, /按原顺序保留选项文字与序号/)
    return reply(JSON.stringify({ goal: '报告时间待定', constraints: [], decisions: [], completedActions: [],
      openItems: [{ sourceMessageId: original.id, prompt: original.content,
        options: original.question.options.map((label, index) => ({ number: index + 1, label })) }] }))
  }, request => {
    const summary = JSON.parse(contextData(request).summary.text)
    assert.equal(summary.openItems[0].sourceMessageId, question.id)
    assert.deepEqual(summary.openItems[0].options[1], { number: 2, label: '大约一小时' })
    assert.equal(request.messages.at(-1).content, '刚才报告那个问题，我选第二个')
    return reply('好，报告先留一小时')
  })
  const result = await f.xixi.chat(input('刚才报告那个问题，我选第二个'))
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.at(-1).content, '好，报告先留一小时')
  assert.ok(f.db.getSummary('main').sourceMessageIds.includes(question.id))
})

test('source IDs retrieve full archived text and forgotten sources remain unavailable', async t => {
  const f = fixture(t)
  const source = f.db.appendMessage({ conversationId: 'older', requestId: randomUUID(), role: 'user', content: '论文要求：' + '正文'.repeat(600) })
  f.responses.push(call('search_history', { messageIds: [source.id] }), reply('找到了'))
  await f.xixi.chat(input('看那条论文原文'))
  const found = toolResults(f.requests[1])[0].messages[0]
  assert.equal(found.content, source.content)
  assert.equal(found.truncated, false)
  const memory = f.db.rememberMemory({ content: '论文要求', scope: 'global', kind: 'project', sourceMessageId: source.id })
  f.db.forgetMemory(memory.id)
  f.responses.push(call('search_history', { messageIds: [source.id] }), reply('没有找到'))
  await f.xixi.chat(input('再看那条原文'))
  assert.equal(toolResults(f.requests.at(-1))[0].messages.length, 0)
})

test('recovers an interrupted assistant tool call before the next model request', async t => {
  const f = fixture(t)
  const request = input('明天交报告')
  f.db.beginTurn(request)
  const interrupted = call('create_tasks', { tasks: [{ title: '报告', due: '2026-09-19' }] }, 'interrupted').choices[0].message
  f.db.appendMessage({ conversationId: 'main', requestId: request.requestId, role: 'assistant', content: '', toolCalls: interrupted.tool_calls })
  f.db.finishTurn(request.requestId, { status: 'failed', error: '服务重启' })
  const result = await f.xixi.chat(request)
  assert.equal(result.status, 'completed')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(toolResults(f.requests[0])[0].ok, true)
})

test('replaying an operation after user undo respects the undone state', async t => {
  const args = { tasks: [{ title: '报告' }] }
  const f = fixture(t, [call('create_tasks', args), new Error('network'), call('create_tasks', args), reply('保留撤销后的状态')])
  const request = input('记下报告')
  const first = await f.xixi.chat(request)
  f.db.undoOperation(first.operations[0].id)
  const second = await f.xixi.chat(request)
  assert.equal(second.status, 'completed')
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(toolResults(f.requests.at(-1))[0].ok, false)
})

test('separate runtime instances cannot execute the same in-flight request twice', async t => {
  const f = fixture(t, [async () => { await new Promise(resolve => setTimeout(resolve, 15)); return reply('完成') }])
  const other = createXixi({ db: f.db, complete: async () => { throw new Error('must not execute') } })
  const request = input('今天怎么样')
  const pending = f.xixi.chat(request)
  await new Promise(resolve => setTimeout(resolve, 2))
  await assert.rejects(other.chat(request), /正在处理/)
  assert.equal((await pending).status, 'completed')
  assert.equal(f.requests.length, 1)
})
