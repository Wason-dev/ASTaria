import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { dayCapacity, routinesForDay } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-23', NOW = new Date(`${DATE}T11:41:00+08:00`)
const TEXT = '今天有校庆活动，下午1700到晚上八点，晚上八点15-21:15有课。'
const EVENTS = [{ title: '校庆活动', date: DATE, start: '17:00', end: '20:00' }, { title: '课程', date: DATE, start: '20:15', end: '21:15' }]
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const input = (text = TEXT) => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', date: DATE } })
const receipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
function fixture(t) {
  const db = createDatabase(':memory:'), responses = [], requests = [], errors = []
  t.after(() => db.close())
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    requests.push(request)
    const response = responses.shift()
    if (response instanceof Error) throw response
    try { return typeof response === 'function' ? response(request) : response ?? reply('已保存') }
    catch (error) { errors.push(error); throw error }
  } })
  const update = action => db.updatePlanner(action, db.getPlanner().revision)
  update({ type: 'save-routine', routine: { id: 'dorm', title: '宿舍', kind: 'available', weekdays: [3], start: '20:30', end: '22:30', enabled: true, location: '', items: [] } })
  return { db, responses, requests, update, async run(value = input()) { const result = await xixi.chat(value); assert.deepEqual(errors, []); return result } }
}
const read = () => tool('read_planner', { date: DATE })
const save = (db, events = EVENTS) => tool('save_day_events', { expectedRevision: db.getPlanner().revision, evidence: TEXT, events })

test('校庆与临时课程一次记录到精确时刻，不受空课边界/已有任务阻挡，也不改周模板', async t => {
  const f = fixture(t), task = f.db.createTask({ title: '物理复习', estimateMin: 30 })
  f.update({ type: 'save-block', block: { id: 'review', taskId: task.id, date: DATE, start: '18:00', end: '18:30', locked: true } })
  const before = structuredClone(f.db.getPlanner())
  f.responses.push(request => {
    const system = request.messages.filter(message => message.role === 'system').map(message => message.content).join('\n')
    assert.doesNotMatch(system, /本轮用户已给出具体课程\/时间\/顺序|决策绑定：/)
    assert.ok(request.tools.some(item => item.function.name === 'save_day_events'))
    return read()
  }, () => save(f.db), request => {
    const result = receipt(request)
    assert.equal(result.savedEvents.length, 2)
    assert.ok(result.conflicts[0].items.some(item => item.id === 'review'))
    assert.ok(result.savedEvents.every(event => event.id && event.date === DATE))
    return reply('已记录校庆和课程；物理复习与校庆重叠。')
  })
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(f.requests.length, 3)
  assert.equal(f.db.listTasks().length, 1)
  assert.deepEqual(f.db.getPlanner().routines, before.routines)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.deepEqual(f.db.getPlanner().dayEvents.map(({ id, location, items, ...event }) => event), EVENTS)
  assert.ok(!dayCapacity(f.db.getPlanner(), f.db.listTasks(), DATE, NOW).available.some(range => range.start <= 1230 && range.end > 1230))
  assert.equal(routinesForDay(f.db.getPlanner(), '2026-09-30').some(row => row.sourceDate), false)
  f.db.undoOperation(result.operations[0].id)
  assert.deepEqual(f.db.getPlanner().dayEvents ?? [], [])
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('single-day event writes are all-or-nothing if one of the times is invalid', async t => {
  const f = fixture(t)
  f.responses.push(read(), () => save(f.db, [EVENTS[0], { ...EVENTS[1], end: '20:00' }]), request => {
    assert.equal(receipt(request).ok, false)
    return reply('时间格式未能保存')
  })
  const result = await f.run()
  assert.equal(f.db.getPlanner().dayEvents?.length ?? 0, 0)
  assert.equal(result.operations.length, 0)
  assert.equal(f.requests.length, 3, 'a failed write must not inject repeated compulsory submission rounds')
})

test('requires a current target-day read and stale revisions cannot overwrite', async t => {
  const f = fixture(t)
  f.responses.push(() => save(f.db), request => {
    assert.equal(receipt(request).ok, false)
    assert.match(receipt(request).error, /read_planner/)
    return reply('未保存')
  })
  await f.run()
  assert.equal(f.db.getPlanner().dayEvents?.length ?? 0, 0)
  let revision
  f.responses.push(read(), request => {
    revision = receipt(request).revision
    f.update({ type: 'check-item', date: DATE, key: '电脑', checked: true })
    return tool('save_day_events', { expectedRevision: revision, events: EVENTS, evidence: TEXT })
  }, request => { assert.match(receipt(request).error, /其他窗口更新/); return reply('版本已变，未覆盖') })
  await f.run()
  assert.equal(f.db.getPlanner().dayEvents?.length ?? 0, 0)
})

test('event receipt survives provider failure, and editing/removing uses original id', async t => {
  const f = fixture(t)
  f.responses.push(read(), () => save(f.db), new Error('provider down'))
  const first = await f.run()
  assert.equal(first.status, 'completed')
  assert.equal(first.execution.reply.mode, 'fallback')
  const event = f.db.getPlanner().dayEvents[0]
  f.responses.push(read(), () => tool('save_day_events', { expectedRevision: f.db.getPlanner().revision, evidence: '校庆改到16:30开始', events: [{ ...event, start: '16:30' }] }))
  const edited = await f.run(input('校庆改到16:30开始'))
  assert.equal(edited.status, 'completed')
  assert.equal(f.db.getPlanner().dayEvents.length, 2)
  assert.equal(f.db.getPlanner().dayEvents.find(row => row.id === event.id).start, '16:30')
  f.responses.push(read(), () => tool('remove_day_event', { expectedRevision: f.db.getPlanner().revision, evidence: '取消校庆', id: event.id }))
  await f.run(input('取消校庆'))
  assert.equal(f.db.getPlanner().dayEvents.length, 1)
})

test('a time range in a question does not force a task/calendar write', async t => {
  const f = fixture(t)
  f.responses.push(reply('17:00–20:00 是三个小时'))
  const result = await f.run(input('17:00–20:00 是多长时间？'))
  assert.equal(result.status, 'completed')
  assert.equal(f.requests.length, 1)
  assert.equal(result.operations.length, 0)
})

test('clear time does not prohibit genuinely missing required facts', async t => {
  const f = fixture(t)
  f.responses.push(tool('ask_user', { prompt: '这场 18:00–19:00 的会议是哪一天？', options: ['明天', '后天'] }))
  const result = await f.run(input('下次18:00–19:00开会'))
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'awaiting_user')
  assert.equal(f.requests.length, 1)
})

test('an existing task with the same event name does not force a second task placement', async t => {
  const f = fixture(t)
  f.db.createTask({ title: '校庆活动', estimateMin: 180 })
  const text = '今天17:00–20:00校庆活动'
  f.responses.push(read(), () => tool('save_day_events', { expectedRevision: f.db.getPlanner().revision, evidence: text, events: [EVENTS[0]] }), reply('校庆活动已记录'))
  const result = await f.run(input(text))
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(f.requests.length, 3)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.db.getPlanner().dayEvents.length, 1)
})

for (const wording of ['数学18:00–19:00是一个小时吗？', '请帮我算一下数学18:00–19:00是多久？', '帮我看看数学18:00–19:00是不是一小时？']) test(`asking about an existing task time range does not create a schedule obligation: ${wording}`, async t => {
  const f = fixture(t)
  f.db.createTask({ title: '数学', estimateMin: 60 })
  f.responses.push(reply('是，一个小时。'))
  const result = await f.run(input(wording))
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.scheduleRequirements?.length ?? 0, 0)
  assert.equal(f.requests.length, 1)
})

test('same request event replay canonicalizes evidence, defaults and batch order', async t => {
  const f = fixture(t)
  f.responses.push(read(), () => save(f.db), request => {
    assert.equal(receipt(request).savedEvents.length, 2)
    return tool('save_day_events', { expectedRevision: f.db.getPlanner().revision, evidence: '今天有校庆活动',
      events: [...EVENTS].reverse().map(event => ({ ...event, location: '', items: [] })) })
  }, request => {
    assert.equal(receipt(request).reused, true)
    assert.equal(receipt(request).savedEvents.length, 2)
    return reply('沿用已保存的活动')
  })
  const result = await f.run()
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.operations.length, 1)
  assert.equal(f.db.getPlanner().dayEvents.length, 2)
})

for (const change of ['delete', 'move', 'undo']) test(`an event ${change} while composing preserves prose with independent execution evidence`, async t => {
  const f = fixture(t), staleReply = '两项活动仍然按原时间保存好了'
  f.responses.push(read(), () => save(f.db), () => {
    const event = f.db.getPlanner().dayEvents[0]
    if (change === 'undo') f.db.undoOperation(f.db.listOperations()[0].id)
    else f.update(change === 'delete' ? { type: 'delete-day-event', id: event.id } : { type: 'save-day-event', event: { ...event, start: '16:30' } })
    return reply(staleReply)
  })
  const result = await f.run()
  const message = result.messages.find(message => message.content === staleReply)
  assert.ok(message)
  assert.equal(result.execution.reply.mode, 'model')
  if (change !== 'undo') {
    assert.equal(result.execution.status, 'partial')
    assert.match(message.executionNotice.issues.join('\n'), /已保存的活动与当前日历不一致/)
  } else {
    assert.equal(message.executionNotice, undefined)
    assert.ok(result.operations.every(operation => operation.undoneAt))
    assert.ok(result.execution.eventRequirements.every(item => item.status === 'cancelled'))
  }
})

test('event verification recovers a durable write even without a tool receipt or progress checkpoint', async t => {
  const f = fixture(t), request = input(), event = { ...EVENTS[0], id: 'event-before-crash', location: '', items: [] }
  f.db.ensureConversation(request.conversationId)
  f.db.beginTurn(request)
  f.db.applyPlannerOperation({ id: randomUUID(), requestId: request.requestId, summary: '保存校庆活动', expectedRevision: f.db.getPlanner().revision,
    actions: [{ type: 'save-day-event', event }] })
  f.db.finishTurn(request.requestId, { status: 'failed', error: 'simulated crash before receipt' })
  f.update({ type: 'delete-day-event', id: event.id })
  f.responses.push(reply('校庆按原时间保存好了'))
  const result = await f.run(request)
  assert.equal(result.execution.status, 'partial')
  assert.equal(result.execution.eventRequirements[0].status, 'pending')
  const message = result.messages.find(message => message.content === '校庆按原时间保存好了')
  assert.match(message.executionNotice.issues.join('\n'), /已保存的活动与当前日历不一致/)
  assert.equal(f.db.getPlanner().dayEvents.length, 0)
})

test('a successful removal supersedes a saved event obligation in the same turn', async t => {
  const f = fixture(t), text = `${TEXT} 记录后取消校庆活动。`
  f.responses.push(read(), () => tool('save_day_events', { expectedRevision: f.db.getPlanner().revision, evidence: TEXT, events: [EVENTS[0]] }), read(), () =>
    tool('remove_day_event', { id: f.db.getPlanner().dayEvents[0].id, expectedRevision: f.db.getPlanner().revision, evidence: '取消校庆活动' }))
  const result = await f.run(input(text))
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.execution.eventRequirements[0].status, 'cancelled')
  assert.equal(f.db.getPlanner().dayEvents.length, 0)
})
