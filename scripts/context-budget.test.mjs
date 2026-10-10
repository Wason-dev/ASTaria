import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { contextUnits, fitContext } from '../server/contextBudget.mjs'
import { namedTaskSlots } from '../server/scheduleIntent.mjs'
import { createDatabase } from '../server/database.mjs'
import { createXixi, HARD_INPUT_UNITS } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-21'
const TEXT = '数学缩到21:00–21:30，物理21:30–22:30'
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const tools = (...calls) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: calls } }] })
const read = (days = 1) => call('read_planner', { date: DATE, days })
const request = () => ({ requestId: randomUUID(), conversationId: 'main', text: TEXT, context: { timezone: 'Asia/Shanghai', date: DATE, page: 'timetable' } })

function fixture(t) {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const math = db.createTask({ title: '数学作业：Ex2A、Ex2B', estimateMin: 60 })
  const physics = db.createTask({ title: '物理课 1.2 单元前三道题', estimateMin: 60 })
  db.updatePlanner({ type: 'save-routine', routine: { id: 'dorm', title: '宿舍', kind: 'available', weekdays: [1],
    start: '20:30', end: '22:30', location: '', items: [], enabled: true } }, db.getPlanner().revision)
  db.updatePlanner({ type: 'save-block', block: { id: 'math-block', taskId: math.id, date: DATE, start: '21:00', end: '22:00', locked: false } }, db.getPlanner().revision)
  const responses = [], requests = [], errors = []
  const xixi = createXixi({ db, now: () => new Date(`${DATE}T20:55:00+08:00`), complete: async payload => {
    requests.push(payload)
    assert.ok(contextUnits(payload.messages) + contextUnits(payload.tools ?? []) <= HARD_INPUT_UNITS)
    const next = responses.shift()
    if (next instanceof Error) throw next
    try { return typeof next === 'function' ? next(payload) : next ?? reply('完成') }
    catch (error) { errors.push(error); throw error }
  } })
  const mathPlan = () => call('plan_tasks', { expectedRevision: db.getPlanner().revision, plans: [{ id: 'math-block', taskId: math.id, date: DATE, start: '21:00', end: '21:30' }] })
  const physicsPlan = () => call('plan_tasks', { expectedRevision: db.getPlanner().revision, plans: [{ taskId: physics.id, date: DATE, start: '21:30', end: '22:30' }] })
  return { db, math, physics, responses, requests, mathPlan, physicsPlan, run: async (input = request()) => {
    const result = await xixi.chat(input); assert.deepEqual(errors, []); return result
  } }
}

test('seven-day planner reads retain typed days, availability, and plan IDs when descriptions need compaction', () => {
  const calls = [call('read_planner', { date: DATE, days: 7 }), call('read_tasks', {})]
  const days = Array.from({ length: 7 }, (_, index) => ({ date: `2026-09-${21 + index}`,
    capacity: { remaining: [{ start: 1080, end: 1200 }], remainingMin: 120 },
    availabilityWindows: { items: [{ id: `window-${index}`, title: '晚自习', start: '18:00', end: '20:00', remaining: [{ start: 1080, end: 1200 }], remainingMinutes: 120 }], total: 1, truncated: false },
    blocks: { items: [{ id: `block-${index}`, taskId: 'math', date: `2026-09-${21 + index}`, start: '18:00', end: '18:30', locked: false }], total: 1, truncated: false },
    tasks: { items: [{ id: 'math', title: '数学', estimateMin: 30, updatedAt: '2026-09-21T00:00:00Z', notes: '备注'.repeat(1200) }], total: 1, truncated: false },
  }))
  const messages = [
    { role: 'system', content: '规则'.repeat(600) },
    { role: 'system', content: '以下对话的出处与发送时间：' + JSON.stringify([{ id: 'user' }, { id: 'assistant' }, { id: 'read-1' }, { id: 'read-2' }]) },
    { role: 'user', content: TEXT }, { role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify({ type: 'planner_read', revision: 12, days }) },
    { role: 'tool', tool_call_id: calls[1].id, content: JSON.stringify({ tasks: [{ id: 'math', title: '数学', notes: '需要核对第二题' }] }) },
    { role: 'system', content: '未完成：物理21:30–22:30' },
  ]
  const original = structuredClone(messages)
  assert.ok(contextUnits(messages) > 14000)
  const fitted = fitContext(messages)
  assert.ok(contextUnits(fitted) <= 14000)
  assert.deepEqual(messages, original)
  assert.equal(fitted.find(message => message.role === 'user').content, TEXT)
  assert.deepEqual(fitted.find(message => message.tool_calls).tool_calls, calls)
  const readResult = JSON.parse(fitted.find(message => message.tool_call_id === calls[0].id).content)
  assert.equal(readResult.detailsCompacted, true)
  assert.equal(readResult.revision, 12)
  assert.equal(readResult.days.length, 7)
  for (let index = 0; index < days.length; index++) {
    assert.equal(readResult.days[index].date, days[index].date)
    assert.deepEqual(readResult.days[index].capacity, days[index].capacity)
    assert.deepEqual(readResult.days[index].availabilityWindows, days[index].availabilityWindows)
    assert.deepEqual(readResult.days[index].blocks, days[index].blocks)
    assert.equal(readResult.days[index].tasks.items[0].notesOmitted, true)
  }
  assert.equal(JSON.parse(fitted.find(message => message.tool_call_id === calls[1].id).content).tasks[0].notes, '需要核对第二题')
  assert.match(fitted.at(-1).content, /物理/)
})

test('history recovery and the freshest planner result yield to old prose, never disappear into receipts', () => {
  const calls = [call('search_history', { messageIds: ['original'] }), call('read_planner', { date: DATE })]
  const history = { messages: [{ id: 'original', role: 'user', content: '原始安排'.repeat(600), truncated: false }], memories: [] }
  const planner = { type: 'planner_read', revision: 4, days: [{ date: DATE, capacity: { remaining: [{ start: 1080, end: 1200 }], remainingMin: 120 } }] }
  const messages = [
    { role: 'system', content: '规则' }, { role: 'user', content: '旧对话'.repeat(2500) },
    { role: 'assistant', content: '旧回复'.repeat(2500) }, { role: 'user', content: '按原话安排' },
    { role: 'assistant', content: '', tool_calls: calls },
    { role: 'tool', tool_call_id: calls[0].id, content: JSON.stringify(history) },
    { role: 'tool', tool_call_id: calls[1].id, content: JSON.stringify(planner) },
  ]
  const fitted = fitContext(messages)
  assert.ok(contextUnits(fitted) <= 14000)
  assert.deepEqual(JSON.parse(fitted.find(message => message.tool_call_id === calls[0].id).content), history)
  assert.deepEqual(JSON.parse(fitted.find(message => message.tool_call_id === calls[1].id).content), planner)
  assert.deepEqual(fitted.find(message => message.tool_calls).tool_calls, calls)
})

test('an impossible history recovery budget fails explicitly instead of returning another unread receipt', () => {
  const c = call('search_history', { messageIds: ['original'] })
  const messages = [{ role: 'system', content: '规则'.repeat(1000) }, { role: 'user', content: '读取原文' },
    { role: 'assistant', content: '', tool_calls: [c] },
    { role: 'tool', tool_call_id: c.id, content: JSON.stringify({ messages: [{ id: 'original', content: '原文'.repeat(6000) }] }) }]
  const original = structuredClone(messages)
  assert.throws(() => fitContext(messages), error => error.message === 'CONTEXT_TOO_LARGE' && error.oversizedInput === false)
  assert.deepEqual(messages, original)
})

test('identical parallel reads point to a complete result in the same dispatch instead of rereading', () => {
  const calls = Array.from({ length: 3 }, () => call('search_history', { messageIds: ['source'] }))
  const content = JSON.stringify({ messages: [{ id: 'source', content: '任务原文'.repeat(1400) }] })
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '继续' },
    { role: 'assistant', content: '', tool_calls: calls },
    ...calls.map(c => ({ role: 'tool', tool_call_id: c.id, content }))]
  const fitted = fitContext(messages)
  assert.ok(contextUnits(fitted) <= 14000)
  assert.equal(fitted.find(message => message.tool_call_id === calls[2].id).content, content)
  for (const message of fitted.filter(message => message.role === 'tool' && message.tool_call_id !== calls[2].id)) {
    const result = JSON.parse(message.content)
    assert.equal(result.duplicateRead, true)
    assert.equal(result.sourceToolCallId, calls[2].id)
  }
})

test('large executed arguments become a complete checkpoint instead of orphaned tools or a new write', () => {
  const c = call('update_task', { taskId: 'math', patch: { notes: '长资料'.repeat(5000) } })
  const messages = [{ role: 'system', content: '规则' }, { role: 'user', content: '更新数学备注' },
    { role: 'assistant', content: '', tool_calls: [c] },
    { role: 'tool', tool_call_id: c.id, content: JSON.stringify({ ok: true, operation: { id: 'op-math', summary: '更新事项：数学' } }) }]
  const result = fitContext(messages)
  assert.ok(contextUnits(result) < 14000)
  assert.ok(result.every(message => message.role !== 'tool' && !message.tool_calls))
  assert.match(result.at(-1).content, /op-math/)
  assert.match(result.at(-1).content, /"ok":true/)
})

test('short task references bind only unique existing names and preserve both requested slots', () => {
  const tasks = [{ id: 'm', title: '数学作业：Ex2A、Ex2B' }, { id: 'p', title: '物理课 1.2 单元前三道题' }]
  assert.deepEqual(namedTaskSlots(TEXT, tasks, DATE, DATE).map(item => [item.taskId, item.slot]), [
    ['m', { date: DATE, start: '21:00', end: '21:30' }], ['p', { date: DATE, start: '21:30', end: '22:30' }],
  ])
  assert.equal(namedTaskSlots(TEXT, [...tasks, { id: 'm2', title: '数学练习' }], DATE, DATE).some(item => item.taskId === 'm'), false)
})

test('a crowded multi-task turn survives parallel reads and completes both calendar changes', async t => {
  const f = fixture(t)
  for (let i = 0; i < 4; i++) {
    const requestId = randomUUID()
    f.db.appendMessage({ conversationId: 'main', requestId, role: 'user', content: `之前的作业资料${'细节'.repeat(1600)}` })
    f.db.appendMessage({ conversationId: 'main', requestId, role: 'assistant', content: '记好了。' })
  }
  f.responses.push(tools(read()), () => tools(f.mathPlan()), () => tools(read(7), read(7), read(7)), payload => {
    assert.ok(payload.messages.some(message => message.role === 'tool' && JSON.parse(message.content).days?.length))
    assert.ok(payload.messages.some(message => message.content?.includes('本轮待完成日历事项') && message.content.includes(f.physics.id)))
    return tools(read())
  }, () => tools(f.physicsPlan()), reply('数学21:00–21:30，物理21:30–22:30，已保存。'))
  const result = await f.run()
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.execution.status, 'verified')
  assert.equal(f.db.getPlanner().blocks.length, 2)
  assert.equal(f.db.getPlanner().blocks.find(block => block.taskId === f.physics.id).start, '21:30')
  assert.ok(f.db.listMessages('main').some(message => message.content.includes('细节'.repeat(1600))), 'original history stays intact')
})

for (const failure of ['simulated provider unavailable', 'CONTEXT_TOO_LARGE']) test(`${failure}: interruption after math reports physics and retries only unfinished work`, async t => {
  const f = fixture(t), input = request()
  f.responses.push(tools(read()), () => tools(f.mathPlan()), new Error(failure))
  const first = await f.run(input)
  assert.equal(first.status, 'failed')
  assert.doesNotMatch(first.error, /21:00–21:30/, 'successful times belong only in operation receipts')
  assert.ok(first.operations.some(operation => operation.summary.includes('21:00–21:30')))
  assert.match(first.error, /物理.*21:30–22:30.*尚未保存/)
  assert.doesNotMatch(first.error, /请拆成/)
  assert.equal(f.db.getPlanner().blocks.length, 1)
  f.responses.push(tools(read()), () => tools(f.physicsPlan()), reply('两段都保存了'))
  const resumed = await f.run(input)
  assert.equal(resumed.status, 'completed')
  assert.equal(f.db.getPlanner().blocks.length, 2)
  assert.equal(resumed.operations.length, 2)
})

test('a context failure after both verified writes uses local receipts without replaying mutations', async t => {
  const f = fixture(t), input = request()
  f.responses.push(tools(read()), () => tools(f.mathPlan()), tools(read()), () => tools(f.physicsPlan()), new Error('CONTEXT_TOO_LARGE'))
  const result = await f.run(input)
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.execution.reply.mode, 'fallback')
  assert.equal(result.messages.at(-1).content, '')
  assert.deepEqual(result.messages.at(-1).executionNotice, { issues: [], replyUnavailable: true })
  assert.ok(result.operations.some(operation => operation.summary.includes('21:00–21:30')))
  assert.ok(result.operations.some(operation => operation.summary.includes('21:30–22:30')))
  const calls = f.requests.length
  await f.run(input)
  assert.equal(f.requests.length, calls)
  assert.equal(f.db.getPlanner().blocks.length, 2)
})
