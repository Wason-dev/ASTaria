import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, XIXI_TOOLS } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-10-12', EXAM_DATE = '2026-10-22'
const NOW = new Date(`${DATE}T14:50:00+08:00`)
const EXAM = '物理第一次月考'
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const input = text => ({ requestId: randomUUID(), conversationId: 'main', text,
  context: { timezone: 'Asia/Shanghai', page: 'home', date: DATE } })
const toolResult = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
const outcomes = db => db.listMessages('main', { limit: 160 }).filter(message => message.role === 'tool').map(message => JSON.parse(message.content))

function fixture(t, tasks, text = '十月22号物理第一次月考') {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = [], errors = [], responses = [call('create_tasks', { tasks }), reply('日期已记下了。')]
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    requests.push(request)
    const next = responses.shift()
    if (next instanceof Error) throw next
    try { return typeof next === 'function' ? next(request) : next ?? reply('按真实回执确认。') }
    catch (error) { errors.push(error); throw error }
  } })
  return { db, requests, responses, xixi, async run(request = input(text)) {
    const result = await xixi.chat(request)
    assert.deepEqual(errors, [], 'provider assertions must not be swallowed as reply failures')
    return result
  } }
}

const noReservation = (f, result, before) => {
  assert.deepEqual(f.db.getPlanner(), before, 'recording a date never changes the calendar or its revision')
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.execution.scheduleRequirements?.length ?? 0, 0)
  assert.equal(result.execution.reply.mode, 'model')
  assert.equal(result.operations.length, 1)
  const receipt = toolResult(f.requests[1])
  assert.equal(receipt.scheduling.changed, false)
  assert.equal(receipt.scheduling.required, false)
  assert.equal(receipt.scheduling.savedPlans.length, 0)
  assert.deepEqual(receipt.scheduling.recordedTaskIds, f.db.listTasks().map(task => task.id))
  assert.equal(f.requests.length, 2, 'a reminder has no scheduling continuation')
}

for (const patch of [{}, { scheduleMode: 'auto' }, { scheduleMode: 'auto', estimateMin: 30 }]) {
  test(`a date-only exam is retained without today's default 30 minutes: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t, [{ title: EXAM, due: EXAM_DATE, ...patch }]), before = f.db.getPlanner()
    const result = await f.run()
    noReservation(f, result, before)
    assert.equal(f.db.listTasks()[0].due, EXAM_DATE)
    if (!patch.estimateMin) assert.equal(f.db.listTasks()[0].estimateMin, undefined)
    assert.ok(!Object.hasOwn(f.db.listTasks()[0], 'scheduleMode'), 'creation intent does not change the stored task schema')
  })
}

for (const title of ['妈妈生日', '项目截止', '报名截止提醒', '证件到期', '结婚纪念日']) {
  test(`${title} is a date marker when an older caller omits the scheduling mode`, async t => {
    const f = fixture(t, [{ title, due: EXAM_DATE }], `10月22号${title}`), before = f.db.getPlanner()
    noReservation(f, await f.run(), before)
  })
}

test('per-item record-only intent supports other reminder wording without a keyword dependency', async t => {
  const f = fixture(t, [{ title: '返校日', due: EXAM_DATE, scheduleMode: 'record-only' }], '10月22日返校，记到事项里')
  const before = f.db.getPlanner()
  noReservation(f, await f.run(), before)
})

for (const text of ['不要占用时间，只设置物理作业的事项', '记下物理作业，不占时间', '记下物理作业，不用预留日历时间', '记下物理作业，不排进日历']) {
  test(`explicit no-time instruction applies to actionable tasks too: ${text}`, async t => {
    const f = fixture(t, [{ title: '物理作业', due: EXAM_DATE }], text), before = f.db.getPlanner()
    noReservation(f, await f.run(), before)
  })
}

test('an unrelated meeting time cannot turn the exam reminder into a mandatory task slot', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE }], '十月22号物理第一次月考；今天18:00–18:30开会')
  const before = f.db.getPlanner()
  noReservation(f, await f.run(), before)
})

for (const title of ['物理月考复习', '备考物理月考', '整理物理月考错题', '完成物理试卷前三题', '准备生日礼物', '填写报名表']) {
  test(`${title} remains real work and keeps automatic scheduling`, async t => {
    const f = fixture(t, [{ title, due: EXAM_DATE, estimateMin: 30 }], `今天${title}，半小时`)
    const result = await f.run()
    assert.equal(result.execution.status, 'verified')
    assert.equal(f.db.getPlanner().blocks.length, 1)
    assert.deepEqual(toolResult(f.requests[1]).scheduling.recordedTaskIds, [])
    assert.equal(f.db.getPlanner().blocks[0].taskId, f.db.listTasks()[0].id)
  })
}

test('a mixed exam/reminder and study batch reserves time only for study', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE, scheduleMode: 'record-only' },
    { title: '物理复习', estimateMin: 30, scheduleMode: 'auto' }], '十月22号物理第一次月考，今天复习物理半小时')
  const result = await f.run(), tasks = f.db.listTasks(), exam = tasks.find(task => task.title === EXAM), study = tasks.find(task => task.title === '物理复习')
  assert.equal(result.execution.status, 'verified')
  assert.deepEqual(f.db.getPlanner().blocks.map(block => block.taskId), [study.id])
  const scheduling = toolResult(f.requests[1]).scheduling
  assert.deepEqual(scheduling.recordedTaskIds, [exam.id])
  assert.deepEqual(scheduling.allocations.map(item => item.taskId), [study.id])
  const parent = result.operations.find(operation => operation.kind !== 'planner')
  f.db.undoOperation(parent.id)
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0, 'linked undo still removes only the actual study reservation')
})

test('a full calendar does not make a reminder incomplete or create a fictional duration', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE }])
  for (const routine of f.db.getPlanner().routines.filter(item => item.kind === 'available')) {
    f.db.updatePlanner({ type: 'save-routine', routine: { ...routine, enabled: false } }, f.db.getPlanner().revision)
  }
  const before = f.db.getPlanner()
  noReservation(f, await f.run(), before)
  assert.equal(toolResult(f.requests[1]).scheduling.unscheduled, undefined)
})

test('a full mixed batch reports only the unscheduled study task', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE }, { title: '物理复习', estimateMin: 30 }], '十月22号物理第一次月考，今天复习物理半小时')
  for (const routine of f.db.getPlanner().routines.filter(item => item.kind === 'available')) {
    f.db.updatePlanner({ type: 'save-routine', routine: { ...routine, enabled: false } }, f.db.getPlanner().revision)
  }
  const result = await f.run(), study = f.db.listTasks().find(task => task.title === '物理复习')
  assert.equal(result.execution.status, 'partial')
  assert.deepEqual(result.execution.scheduleRequirements.map(item => item.taskId), [study.id])
  assert.deepEqual(toolResult(f.requests[1]).scheduling.unscheduled.map(item => item.taskId), [study.id])
})

for (const patch of [{ scheduleMode: 'bogus' },
  { scheduleMode: 'record-only', schedule: { date: DATE, start: '15:00', end: '15:30' } },
  { schedule: { date: DATE, start: '15:00', end: '15:30' } },
  { scheduleMode: 'record-only', scheduleDate: DATE }, { scheduleMode: 'record-only', scheduleWindow: '晚自习' }]) {
  test(`invalid reminder scheduling cannot leave a partial creation: ${JSON.stringify(patch)}`, async t => {
    const f = fixture(t, [{ title: EXAM, due: EXAM_DATE, ...patch }]), before = f.db.getPlanner()
    const result = await f.run()
    assert.equal(outcomes(f.db)[0].ok, false)
    assert.match(outcomes(f.db)[0].error, /安排方式|只记录日期/u)
    assert.equal(f.db.listTasks().length, 0)
    assert.equal(result.operations.length, 0)
    assert.deepEqual(f.db.getPlanner(), before)
  })
}

test('the model cannot add a default block in a later tool step of the same reminder turn', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE }]), before = f.db.getPlanner()
  f.responses.splice(1, 1, call('read_planner', { date: DATE }), request => call('plan_tasks', {
    expectedRevision: toolResult(request).revision,
    plans: [{ taskId: f.db.listTasks()[0].id, date: DATE, start: '18:00', end: '18:30' }],
  }), reply('考试日期保留，复习时间没有擅自添加。'))
  const result = await f.run()
  assert.equal(outcomes(f.db).at(-1).ok, false)
  assert.match(outcomes(f.db).at(-1).error, /仅记录日期/u)
  assert.equal(result.operations.length, 1)
  assert.equal(f.db.listTasks().length, 1)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('the model cannot bypass per-item record-only intent by scheduling an arbitrary named reminder later', async t => {
  const f = fixture(t, [{ title: '返校日', due: EXAM_DATE, scheduleMode: 'record-only' }], '记下十月22日返校')
  const before = f.db.getPlanner()
  f.responses.splice(1, 1, call('read_planner', { date: DATE }), request => call('plan_tasks', {
    expectedRevision: toolResult(request).revision,
    plans: [{ taskId: f.db.listTasks()[0].id, date: DATE, start: '18:00', end: '18:30' }],
  }), reply('只保留日期。'))
  await f.run()
  assert.equal(outcomes(f.db).at(-1).ok, false)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('a reminder replay after interruption reuses the item without inventing a scheduling obligation', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE }]), request = input('十月22号物理第一次月考')
  const first = await f.run(request), before = f.db.getPlanner(), taskId = f.db.listTasks()[0].id
  f.db.finishTurn(request.requestId, { status: 'failed', error: 'interrupted acknowledgement' })
  f.responses.push(call('create_tasks', { tasks: [{ title: EXAM, due: EXAM_DATE }] }), reply('日期沿用已保存的事项。'))
  const replay = await f.run(request)
  assert.equal(outcomes(f.db).at(-1).reused, true)
  assert.equal(replay.execution.status, 'verified')
  assert.equal(replay.execution.scheduleRequirements?.length ?? 0, 0)
  assert.deepEqual(replay.operations, first.operations)
  assert.deepEqual(f.db.listTasks().map(task => task.id), [taskId])
  assert.deepEqual(f.db.getPlanner(), before)
})

test('replaying a mixed reminder and explicit study slot reconstructs only the study obligation', async t => {
  const f = fixture(t, []), text = '十月22号返校日；今天18:00–18:30物理复习', request = input(text)
  const args = { expectedRevision: f.db.getPlanner().revision, tasks: [
    { title: '返校日', due: EXAM_DATE, scheduleMode: 'record-only' },
    { title: '物理复习', scheduleMode: 'auto', schedule: { date: DATE, start: '18:00', end: '18:30' } },
  ] }
  f.responses.splice(0, 2, call('read_planner', { date: DATE }), call('create_tasks', args), reply('提醒保留日期，复习时段已保存。'))
  const first = await f.run(request), before = f.db.getPlanner(), study = f.db.listTasks().find(task => task.title === '物理复习')
  assert.equal(first.execution.status, 'verified')
  f.db.finishTurn(request.requestId, { status: 'failed', error: 'interrupted acknowledgement' })
  f.responses.push(call('create_tasks', args), reply('沿用已保存的事项和时段。'))
  const replay = await f.run(request), scheduling = outcomes(f.db).at(-1).scheduling
  assert.equal(replay.execution.status, 'verified')
  assert.deepEqual(scheduling.requirements.map(item => item.taskId), [study.id])
  assert.deepEqual(scheduling.recordedTaskIds, f.db.listTasks().filter(task => task.title === '返校日').map(task => task.id))
  assert.deepEqual(replay.execution.scheduleRequirements.map(item => item.taskId), [study.id])
  assert.equal(f.db.listTasks().length, 2)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('reply failure and backup restore retain only the reminder item, with a truthful undo receipt', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE, scheduleMode: 'record-only' }]), before = f.db.getPlanner()
  f.responses[1] = new Error('scripted provider reply failure')
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.execution.reply.mode, 'fallback')
  assert.equal(result.operations.length, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  const restored = createDatabase(':memory:'); t.after(() => restored.close())
  restored.importData(f.db.exportData())
  assert.deepEqual(restored.getPlanner().blocks, [])
  assert.equal(restored.listTasks()[0].due, EXAM_DATE)
  assert.throws(() => restored.undoOperation(result.operations[0].id), /恢复备份中的历史变更只供回溯/u)
  f.db.undoOperation(result.operations[0].id)
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(restored.listTasks().length, 1, 'restoring history does not authorize replaying or undoing old mutations')
  assert.deepEqual(restored.getPlanner().blocks, [])
})

test('a later explicit instruction can schedule an existing recorded item without creating a duplicate', async t => {
  const f = fixture(t, [{ title: EXAM, due: EXAM_DATE }])
  await f.run()
  const taskId = f.db.listTasks()[0].id
  f.responses.push(call('read_planner', { date: DATE }), request => call('plan_tasks', {
    expectedRevision: toolResult(request).revision,
    plans: [{ taskId, date: DATE, start: '18:00', end: '18:30' }],
  }), reply('已按这次明确要求保存时段。'))
  const result = await f.run(input(`今天18:00–18:30 ${EXAM}，把这段安排进日历`))
  assert.equal(result.execution.status, 'verified')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.getPlanner().blocks.length, 1)
})

test('the creation interface lets the model express per-item intent without changing update fields', () => {
  const create = XIXI_TOOLS.find(tool => tool.function.name === 'create_tasks').function
  assert.deepEqual(create.parameters.properties.tasks.items.properties.scheduleMode.enum, ['auto', 'record-only'])
  assert.match(create.description, /考试.*record-only/u)
  const update = XIXI_TOOLS.find(tool => tool.function.name === 'update_task').function
  assert.equal(update.parameters.properties.patch.properties.scheduleMode, undefined)
})
