import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createWorkOrder } from '../server/workOrder.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-27'
const TEXT = '回到宿舍大概八点30所有任务到这个时间后'
const EVENT = { title: '乘火车回上海宿舍', date: DATE, start: '17:00', end: '20:30' }
const INVALID_EVIDENCE = '下午五点钟离开家坐火车到上海；回到宿舍大概八点30'
const INTERNAL_TERMS = /本轮写入记录|当前或相邻确认|read_planner|分开的句子不要拼接/u
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const read = () => tool('read_planner', { date: DATE })
const receipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
const finalReply = result => result.messages.findLast(message => message.role === 'assistant' && !message.toolCalls?.length)?.content

function fixture(t) {
  const db = createDatabase(':memory:'), responses = [], errors = []
  t.after(() => db.close())
  const tasks = ['单词', '物理复习', '英语作业'].map((title, index) => db.createTask({ title, estimateMin: index === 2 ? 30 : 20 }))
  const plans = tasks.map((task, index) => ({ id: `original-${index}`, taskId: task.id, date: DATE,
    start: ['20:40', '21:00', '21:20'][index], end: ['21:00', '21:20', '21:50'][index] }))
  const xixi = createXixi({ db, now: () => new Date(`${DATE}T19:00:00+08:00`), complete: async request => {
    const response = responses.shift()
    assert.ok(response, 'unexpected provider call')
    if (response instanceof Error) throw response
    try { return typeof response === 'function' ? response(request) : response }
    catch (error) { errors.push(error); throw error }
  } })
  const update = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const [index, plan] of plans.entries()) update({ type: 'save-block', block: { ...plan,
    start: ['20:00', '20:20', '20:50'][index], end: ['20:20', '20:50', '21:20'][index], locked: false } })
  const input = { requestId: randomUUID(), conversationId: 'main', text: TEXT, context: { timezone: 'Asia/Shanghai', date: DATE } }
  const save = (evidence = TEXT, event = EVENT) => tool('save_day_events', { expectedRevision: db.getPlanner().revision, evidence, events: [event] })
  const plan = (date = DATE) => tool('plan_tasks', { expectedRevision: db.getPlanner().revision,
    plans: plans.map(item => ({ ...item, date })) })
  return { db, responses, input, save, plan, plans, async run() {
    const result = await xixi.chat(input)
    assert.deepEqual(errors, [], 'provider assertions must not become silent failures')
    return result
  } }
}

test('corrected calls with new call IDs preserve the natural reply after both writes are verified', async t => {
  const f = fixture(t), content = '都排到你到宿舍之后了，20:40 开始，21:50 结束。'
  f.responses.push(read(), () => f.save(INVALID_EVIDENCE), request => {
    assert.match(receipt(request).error, /当前或相邻确认/u)
    return f.save()
  }, () => f.plan(), request => {
    assert.match(receipt(request).error, /read_planner/u)
    return read()
  }, () => f.plan(), reply(content))
  const result = await f.run()
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.execution.reply.mode, 'model')
  assert.deepEqual(result.execution.failures, [])
  const recovered = result.execution.steps.filter(step => step.status === 'recovered')
  assert.equal(recovered.length, 2)
  assert.ok(recovered.every(step => step.error && step.resolvedByStepId), 'old diagnostics stay on recovered steps')
  assert.equal(finalReply(result), content)
  assert.equal(result.operations.length, 2)
  assert.deepEqual(f.db.getPlanner().blocks.map(({ locked, ...item }) => item), f.plans)
})

for (const interruption of [false, true]) test(`unresolved operations use user-facing reasons${interruption ? ' in a failed reply' : ''}`, async t => {
  const f = fixture(t)
  f.responses.push(read(), () => f.save(), read(), () => f.save(INVALID_EVIDENCE, { ...EVENT, title: '另一项活动' }),
    () => f.plan('2026-09-28'), interruption ? new Error('provider unavailable') : reply('都安排好了'))
  const result = await f.run()
  assert.equal(result.status, interruption ? 'failed' : 'completed')
  assert.equal(result.execution.status, 'partial')
  assert.equal(result.execution.failures.length, 2)
  assert.ok(result.execution.failures.some(item => item.error.includes('read_planner')))
  const visible = interruption ? result.error : finalReply(result)
  assert.match(visible, /已保存的部分/u)
  assert.match(visible, /尚未完成/u)
  assert.match(visible, /没能核对你之前的要求/u)
  assert.match(visible, /核对当天的最新日程/u)
  assert.doesNotMatch(visible, INTERNAL_TERMS)
  assert.equal(result.operations.length, 1)
  assert.equal(f.db.getPlanner().dayEvents.length, 1)
  assert.deepEqual(f.db.getPlanner().blocks.map(item => item.start), ['20:00', '20:20', '20:50'])
})

test('recovering one operation cannot clear a different failed operation', () => {
  const order = createWorkOrder({ requestId: 'recover', conversationId: 'main', userMessageId: 'user' })
  const first = order.step('old-first', 'save_day_events', 'first-operation')
  const second = order.step('old-second', 'save_day_events', 'second-operation')
  order.fail(first, '原话格式错误')
  order.fail(second, '另一个活动未保存')
  order.commit(order.step('retry-first', 'save_day_events', 'first-operation'), { id: 'first-operation', summary: '活动已保存' })
  assert.equal(first.status, 'recovered')
  assert.equal(second.status, 'failed')
  assert.deepEqual(order.value.failures, [{ stepId: second.id, error: '另一个活动未保存' }])
  assert.equal(order.verify(), 'partial')
})

test('retry restores operation identities for failures saved by an older work-order checkpoint', async t => {
  const f = fixture(t)
  f.responses.push(read(), () => f.save(INVALID_EVIDENCE), () => f.save(), () => f.plan(), new Error('provider unavailable'))
  assert.equal((await f.run()).status, 'failed')
  const progress = structuredClone(f.db.getTurn(f.input.requestId).progress)
  for (const step of progress.steps) if (step.error) {
    step.status = 'failed'; delete step.operationId; delete step.resolvedByStepId
  }
  progress.failures = progress.steps.filter(step => step.status === 'failed').map(step => ({ stepId: step.id, error: step.error }))
  f.db.updateTurnProgress(f.input.requestId, progress)
  f.responses.push(read(), () => f.plan(), reply('活动和任务时间都已保存'))
  const result = await f.run()
  assert.equal(result.execution.status, 'verified')
  assert.deepEqual(result.execution.failures, [])
  assert.equal(finalReply(result), '活动和任务时间都已保存')
  assert.equal(result.operations.length, 2)
})
