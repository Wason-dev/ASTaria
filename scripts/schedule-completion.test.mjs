import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-19', NEXT_DATE = '2026-09-20'
const NOW = new Date('2026-09-18T17:00:00+08:00')
const ACTIVITY = 'PSEC社团活动'
const MIXED_REQUEST = '明天17:15–18:00 PSEC社团活动，测试移18:30–1900'
const SLOT = { date: DATE, start: '17:15', end: '18:00' }
const FALSE_REPLY = 'PSEC已安排在明天17:15–18:00，测试也已移到18:30–19:00。'
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } })
const tools = (...toolCalls) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: toolCalls } }] })
const read = (date = DATE, days) => call('read_planner', { date, ...(days ? { days } : {}) })
const input = (text = MIXED_REQUEST) => ({ requestId: randomUUID(), conversationId: 'main', text,
  context: { timezone: 'Asia/Shanghai', page: 'timetable', date: DATE } })
const receipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
const pending = request => {
  const content = request.messages.find(message => message.content?.startsWith('本轮待完成日历事项（逐项核验）：'))?.content
  return content ? JSON.parse(content.slice(content.indexOf('：') + 1)) : []
}
const activity = db => db.listTasks().find(task => task.title === ACTIVITY)
const placement = block => ({ taskId: block.taskId, date: block.date, start: block.start, end: block.end })

function fixture(t) {
  const db = createDatabase(':memory:'), requests = [], responses = [], callbackErrors = []
  t.after(() => db.close())
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    requests.push(request)
    const next = responses.shift()
    if (next instanceof Error) throw next
    try { return typeof next === 'function' ? next(request) : next ?? reply('已保存。') }
    catch (error) { callbackErrors.push(error); throw error }
  } })
  return { db, requests, responses, xixi, async run(request = input()) {
    const result = await xixi.chat(request)
    assert.deepEqual(callbackErrors, [], 'assertions inside the simulated provider must not become silent provider failures')
    return result
  } }
}

function seedExam(db) {
  const task = db.createTask({ title: '测试', estimateMin: 30 })
  db.updatePlanner({ type: 'save-block', block: { id: 'exam-plan', taskId: task.id, date: DATE,
    start: '17:30', end: '18:00', locked: false } }, db.getPlanner().revision)
  return task
}
const moveExam = (db, exam) => call('plan_tasks', { expectedRevision: db.getPlanner().revision,
  plans: [{ id: 'exam-plan', taskId: exam.id, date: DATE, start: '18:30', end: '19:00' }] })
const createActivity = () => call('create_tasks', { tasks: [{ title: ACTIVITY, startAt: DATE, estimateMin: 45 }] })
const planActivity = db => call('plan_tasks', { expectedRevision: db.getPlanner().revision,
  plans: [{ taskId: activity(db).id, ...SLOT }] })

for (const order of ['planner-before-create', 'create-before-planner']) test(`${order}: another task's planner commit cannot satisfy the new activity`, async t => {
  const f = fixture(t), exam = seedExam(f.db)
  if (order === 'planner-before-create') f.responses.push(tools(read()), () => tools(moveExam(f.db, exam), createActivity()))
  else f.responses.push(tools(createActivity(), read()), () => tools(moveExam(f.db, exam)))
  f.responses.push(reply(FALSE_REPLY), request => {
    assert.equal(pending(request).length, 1)
    assert.equal(pending(request)[0].taskId, activity(f.db).id)
    assert.equal(pending(request)[0].mustComplete, true)
    assert.deepEqual(pending(request)[0].slot, SLOT)
    assert.equal(f.db.getPlanner().blocks.length, 1)
    return tools(read())
  }, () => tools(planActivity(f.db)), reply('两项对应的日历时段都已保存。'))
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(f.requests.length, 6)
  assert.equal(f.db.listTasks().length, 2)
  assert.deepEqual(f.db.getPlanner().blocks.map(placement).sort((a, b) => a.start.localeCompare(b.start)), [
    { taskId: activity(f.db).id, ...SLOT },
    { taskId: exam.id, date: DATE, start: '18:30', end: '19:00' },
  ])
  assert.ok(result.execution.scheduleRequirements.every(item => item.status === 'verified'))
  assert.ok(!result.messages.some(message => message.role === 'assistant' && !message.toolCalls?.length && message.content === FALSE_REPLY))
})

test('a provider failure with an omitted activity remains retryable and reconstructs its obligation without duplicating tasks', async t => {
  const f = fixture(t), exam = seedExam(f.db), request = input()
  f.responses.push(tools(read()), () => tools(moveExam(f.db, exam), createActivity()), new Error('simulated provider unavailable'))
  const first = await f.run(request)
  const taskId = activity(f.db).id
  assert.equal(first.status, 'failed')
  assert.equal(first.execution.status, 'partial')
  assert.ok(first.execution.scheduleRequirements.some(item => item.taskId === taskId && item.mustComplete && item.status === 'pending'))
  assert.equal(f.db.getPlanner().blocks.length, 1)
  // A durable tool receipt must recover an obligation if its progress checkpoint is missing.
  const progress = structuredClone(f.db.getTurn(request.requestId).progress)
  delete progress.scheduleRequirements
  f.db.updateTurnProgress(request.requestId, progress)
  f.responses.push(payload => {
    assert.equal(pending(payload).length, 1)
    assert.equal(pending(payload)[0].taskId, taskId)
    return tools(read())
  }, () => tools(planActivity(f.db)), reply('活动时段现在也已保存。'))
  const resumed = await f.run(request)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.execution.status, 'verified')
  assert.equal(f.db.listTasks().length, 2)
  assert.equal(activity(f.db).id, taskId)
  assert.equal(resumed.operations.length, 3)
  assert.deepEqual(f.db.getPlanner().blocks.filter(block => block.taskId === taskId).map(placement), [{ taskId, ...SLOT }])
})

for (const wrong of ['short-duration', 'wrong-date', 'wrong-time']) test(`an unestimated named 45 minute activity is not verified by a ${wrong} block`, async t => {
  const f = fixture(t)
  f.responses.push(tools(call('create_tasks', { tasks: [{ title: ACTIVITY, startAt: DATE }] }), read(DATE, 2)), () => tools(call('plan_tasks', {
    expectedRevision: f.db.getPlanner().revision,
    plans: [{ taskId: activity(f.db).id, ...SLOT, ...(wrong === 'short-duration' ? { end: '17:45' } : wrong === 'wrong-date' ? { date: NEXT_DATE } : { start: '18:30', end: '19:15' }) }],
  })), reply('PSEC活动已全部安排。'), payload => {
    const requirement = pending(payload).find(item => item.taskId === activity(f.db).id)
    assert.equal(requirement.minutes, 45)
    assert.deepEqual(requirement.slot, SLOT)
    return reply('PSEC活动已全部安排。')
  })
  const result = await f.run(input('明天17:15–18:00 PSEC社团活动'))
  assert.equal(result.status, 'failed')
  assert.equal(result.execution.status, 'partial')
  assert.equal(activity(f.db).estimateMin, undefined)
  assert.equal(f.db.getPlanner().blocks.length, 1, 'the wrong saved block is retained as a real commit, not treated as completion')
  assert.ok(result.execution.scheduleRequirements.some(item => item.taskId === activity(f.db).id && item.mustComplete && item.status === 'pending'))
  assert.ok(!result.messages.some(message => message.role === 'assistant' && !message.toolCalls?.length && message.content === 'PSEC活动已全部安排。'))
})

test('creating with an explicit schedule saves task and slot atomically and undoing creation removes both', async t => {
  const f = fixture(t)
  f.responses.push(tools(read()), payload => tools(call('create_tasks', { expectedRevision: receipt(payload).revision,
    tasks: [{ title: ACTIVITY, schedule: SLOT }] })), payload => {
    const outcome = receipt(payload)
    assert.equal(outcome.ok, true)
    assert.equal(outcome.scheduling.changed, true)
    assert.equal(outcome.scheduling.required, false)
    assert.deepEqual(outcome.scheduling.savedPlans.map(placement), [{ taskId: activity(f.db).id, ...SLOT }])
    assert.equal(f.db.getPlanner().blocks.length, 1)
    return reply('PSEC活动时段已保存。')
  })
  const result = await f.run(input('明天17:15–18:00 PSEC社团活动'))
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(activity(f.db).estimateMin, undefined)
  assert.equal(activity(f.db).startAt, DATE)
  assert.equal(result.operations.length, 2)
  const parent = result.operations.find(operation => operation.kind !== 'planner')
  const child = result.operations.find(operation => operation.kind === 'planner')
  assert.equal(child.parentOperationId, parent.id)
  f.db.undoOperation(parent.id)
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.ok(f.db.listOperations({ requestId: result.requestId }).every(operation => operation.undoneAt))
})

for (const failure of ['conflict', 'stale-revision']) test(`explicit schedule creation rolls back task and slot on ${failure}`, async t => {
  const f = fixture(t)
  if (failure === 'conflict') seedExam(f.db)
  const originalTasks = f.db.listTasks()
  let expectedPlanner = f.db.getPlanner()
  f.responses.push(tools(read()), payload => {
    const revision = receipt(payload).revision
    if (failure === 'stale-revision') {
      f.db.updatePlanner({ type: 'check-item', date: DATE, key: '计算器', checked: true }, revision)
      expectedPlanner = f.db.getPlanner()
    }
    return tools(call('create_tasks', { expectedRevision: revision, tasks: [{ title: ACTIVITY, schedule: SLOT }] }))
  }, payload => {
    assert.equal(receipt(payload).ok, false)
    assert.match(receipt(payload).error, failure === 'conflict' ? /已有其他/u : /其他窗口/u)
    assert.deepEqual(f.db.listTasks(), originalTasks)
    assert.deepEqual(f.db.getPlanner(), expectedPlanner)
    return reply('这次安排还没有保存。')
  })
  const result = await f.run(input('明天17:15–18:00 PSEC社团活动'))
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'failed')
  assert.equal(result.execution.reply.mode, 'fallback')
  assert.equal(f.requests.length, 3, 'a failed write can report failure without repeated forced retries')
  assert.equal(result.operations.length, 0)
  assert.deepEqual(f.db.listTasks(), originalTasks)
  assert.deepEqual(f.db.getPlanner(), expectedPlanner)
})

test('replaying explicit creation after undoing its old child receipt never recreates the task or slot', async t => {
  const f = fixture(t), request = input('明天17:15–18:00 PSEC社团活动')
  const tasks = [{ title: ACTIVITY, schedule: SLOT }]
  f.responses.push(tools(read()), payload => tools(call('create_tasks', { expectedRevision: receipt(payload).revision, tasks })), reply('已保存。'))
  const first = await f.run(request)
  assert.equal(first.status, 'completed')
  const child = first.operations.find(operation => operation.kind === 'planner')
  f.db.undoOperation(child.id)
  f.db.finishTurn(request.requestId, { status: 'failed', error: 'simulated interrupted acknowledgement' })
  f.responses.push(() => tools(call('create_tasks', { expectedRevision: f.db.getPlanner().revision, tasks })), payload => {
    assert.equal(receipt(payload).ok, false)
    assert.match(receipt(payload).error, /已经被用户撤销/u)
    assert.equal(pending(payload).length, 0)
    return reply('保留已撤销时段的状态。')
  })
  const resumed = await f.run(request)
  assert.equal(resumed.status, 'completed')
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(resumed.operations.length, 2)
  assert.equal(resumed.execution.scheduleRequirements[0].status, 'cancelled')
})

test('an atomic schedule cannot redefine the named time range in the user request', async t => {
  const f = fixture(t)
  f.responses.push(tools(read()), payload => tools(call('create_tasks', { expectedRevision: receipt(payload).revision,
    tasks: [{ title: ACTIVITY, schedule: { ...SLOT, end: '17:45' } }] })), payload => {
    assert.equal(receipt(payload).ok, false)
    assert.match(receipt(payload).error, /用户原话不一致/)
    return reply('尚未保存')
  })
  const result = await f.run(input('明天17:15–18:00 PSEC社团活动'))
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'failed')
  assert.equal(result.execution.reply.mode, 'fallback')
  assert.equal(f.requests.length, 3, 'a failed write can report failure without repeated forced retries')
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('final completion rechecks slots changed while the model was composing its reply', async t => {
  const f = fixture(t)
  f.responses.push(tools(read()), payload => tools(call('create_tasks', { expectedRevision: receipt(payload).revision,
    tasks: [{ title: ACTIVITY, schedule: SLOT }] })), () => {
    const block = f.db.getPlanner().blocks[0]
    f.db.updatePlanner({ type: 'save-block', block: { ...block, start: '18:30', end: '19:15' } }, f.db.getPlanner().revision)
    return reply('PSEC17:15安排好了')
  }, new Error('provider unavailable'))
  const result = await f.run(input('明天17:15–18:00 PSEC社团活动'))
  assert.equal(result.status, 'failed')
  assert.equal(result.execution.status, 'partial')
  assert.equal(result.execution.scheduleRequirements[0].status, 'pending')
  assert.ok(!result.messages.some(message => message.role === 'assistant' && !message.toolCalls?.length && message.content === 'PSEC17:15安排好了'))
})

test('the first provider context names an activity occupying the evening window beyond the next task', async t => {
  const f = fixture(t)
  const math = f.db.createTask({ title: '数学作业' }), robot = f.db.createTask({ title: '机器人社新生第一次活动' })
  for (const block of [{ id: 'math-plan', taskId: math.id, date: DATE, start: '17:00', end: '18:00', locked: false },
    { id: 'robot-plan', taskId: robot.id, date: DATE, start: '18:00', end: '20:00', locked: false }]) {
    f.db.updatePlanner({ type: 'save-block', block }, f.db.getPlanner().revision)
  }
  // Saturday's explicit window is the fixture's equivalent of evening study.
  f.responses.push(payload => {
    const environment = JSON.parse(payload.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n'))
    const windows = environment.planner.availabilityWindows.items
    assert.ok(windows.some(window => window.occupied.items.some(item => item.taskId === robot.id && item.title === robot.title)))
    assert.deepEqual(environment.planner.nextSchedule.items.filter(item => item.kind === 'plan').map(item => item.title), [math.title, robot.title])
    return reply('机器人社那段已占用，不能再塞数学。')
  })
  assert.equal((await f.run(input('我累了，后面还有什么安排'))).status, 'completed')
})

test('a planner write for an existing task cannot redefine the time explicitly requested for that task', async t => {
  const f = fixture(t), exam = seedExam(f.db)
  const falseReply = '测试已排在明天18:30–19:00。'
  f.responses.push(tools(read()), () => tools(call('plan_tasks', { expectedRevision: f.db.getPlanner().revision,
    plans: [{ id: 'exam-plan', taskId: exam.id, date: DATE, start: '17:15', end: '17:45' }] })),
  reply(falseReply), new Error('simulated provider unavailable'))
  const result = await f.run(input('明天测试安排在18:30–1900'))
  assert.equal(result.status, 'failed')
  assert.notEqual(result.execution.status, 'verified')
  assert.ok(!result.messages.some(message => message.role === 'assistant' && !message.toolCalls?.length && message.content === falseReply))
  assert.equal(f.db.listTasks().length, 1)
})

test('undoing the old child receipt before the final reply cancels the whole creation and suppresses stale success', async t => {
  const f = fixture(t)
  const staleReply = 'PSEC社团活动已安排明天17:15–18:00。'
  let childId
  f.responses.push(tools(read()), payload => tools(call('create_tasks', { expectedRevision: receipt(payload).revision,
    tasks: [{ title: ACTIVITY, schedule: SLOT }] })), () => {
    childId = f.db.listOperations().find(operation => operation.kind === 'planner').id
    f.db.undoOperation(childId)
    return reply(staleReply)
  })
  const result = await f.run(input('明天17:15–18:00 PSEC社团活动'))
  assert.equal(result.status, 'completed')
  assert.equal(f.requests.length, 3, 'an explicit cancellation must not trigger automatic rescheduling')
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.ok(result.operations.find(operation => operation.id === childId).undoneAt)
  assert.equal(result.execution.scheduleRequirements[0].status, 'cancelled')
  assert.ok(!result.messages.some(message => message.role === 'assistant' && !message.toolCalls?.length && message.content === staleReply))
  assert.match(result.messages.at(-1).content, /已撤销/u)
})

test('replaying a planner commit without its checkpoint or receipt reconstructs the original slot and verifies current state', async t => {
  const f = fixture(t), exam = seedExam(f.db), request = input('明天测试安排在18:30–1900')
  const updateProgress = f.db.updateTurnProgress, appendMessage = f.db.appendMessage
  let committedWithoutCheckpoint = false, omittedReceipts = 0
  // Preserve the durable state at a process exit between planner commit and
  // the following progress/tool-receipt writes. The database stays in memory.
  f.db.updateTurnProgress = (requestId, progress) => {
    if (progress.steps.some(step => step.name === 'plan_tasks' && step.status === 'committed')) committedWithoutCheckpoint = true
    return committedWithoutCheckpoint ? f.db.getTurn(requestId) : updateProgress(requestId, progress)
  }
  f.db.appendMessage = message => {
    if (committedWithoutCheckpoint && (message.role === 'tool' || (message.role === 'assistant' && !message.toolCalls?.length))) {
      if (message.role === 'tool') omittedReceipts += 1
      return { ...message }
    }
    return appendMessage(message)
  }
  f.responses.push(tools(read()), () => tools(moveExam(f.db, exam)), new Error('simulated process interruption'))
  await f.run(request)
  f.db.updateTurnProgress = updateProgress
  f.db.appendMessage = appendMessage
  assert.equal(omittedReceipts, 1)
  // Also cover recovery from an older checkpoint without registered targets.
  const progress = structuredClone(f.db.getTurn(request.requestId).progress)
  delete progress.scheduleRequirements
  f.db.updateTurnProgress(request.requestId, progress)
  assert.equal(f.db.listOperations({ requestId: request.requestId }).length, 1)
  f.db.finishTurn(request.requestId, { status: 'failed', error: 'simulated restart after committed planner write' })
  const savedBlock = f.db.getPlanner().blocks[0]
  const manualBlock = { ...savedBlock, start: '17:15', end: '17:45' }
  f.db.updatePlanner({ type: 'save-block', block: manualBlock }, f.db.getPlanner().revision)
  const staleReply = '测试已安排18:30–19:00。'
  f.responses.push(payload => {
    const reused = receipt(payload)
    assert.equal(reused.reused, true)
    assert.deepEqual(reused.savedPlans.map(placement), [{ taskId: exam.id, date: DATE, start: '18:30', end: '19:00' }])
    const requirement = pending(payload).find(item => item.taskId === exam.id)
    assert.equal(requirement.status, 'pending')
    assert.deepEqual(requirement.slot, { date: DATE, start: '18:30', end: '19:00' })
    return reply(staleReply)
  }, new Error('simulated provider unavailable during repair'))
  const resumed = await f.run(request)
  assert.equal(resumed.status, 'failed')
  assert.equal(resumed.execution.status, 'partial')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(resumed.operations.length, 1)
  assert.deepEqual(f.db.getPlanner().blocks, [manualBlock])
  assert.ok(!resumed.messages.some(message => message.role === 'assistant' && !message.toolCalls?.length && message.content === staleReply))
})
