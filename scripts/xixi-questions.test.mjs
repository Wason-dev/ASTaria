import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { initialTaskSchedule } from '../server/autoSchedule.mjs'
import { dayCapacity } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const call = (name, args) => ({ choices: [{ message: { content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const input = text => ({ conversationId: 'questions', requestId: randomUUID(), text, context: { page: 'home', timezone: 'Asia/Shanghai' } })

test('a concrete question persists clickable choices and waits without guessing task facts', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let requests = 0
  const xixi = createXixi({ db, complete: async () => { requests++; return call('ask_user', { prompt: '明天具体几点前交？', options: ['中午前', '下午六点前', '还没定'] }) } })
  const request = input('明天交机器人社测试')
  const result = await xixi.chat(request)
  assert.equal(result.status, 'completed')
  assert.equal(requests, 1)
  assert.equal(db.listTasks().length, 0)
  assert.deepEqual(result.messages.at(-1).question, { options: ['中午前', '下午六点前', '还没定'] })
  assert.equal(result.messages.at(-1).content, '明天具体几点前交？')
  const replay = await xixi.chat(request)
  assert.equal(replay.messages.at(-1).id, result.messages.at(-1).id)
  assert.equal(requests, 1)
})

test('the chosen answer arrives with its question and original options as conversation context', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const xixi = createXixi({ db, complete: async request => {
    requests.push(request)
    return requests.length === 1 ? call('ask_user', { prompt: '先留多少时间？', options: ['先看题十分钟', '大约一小时'] }) : reply('好，先看看题目')
  } })
  await xixi.chat(input('估一下这个测试'))
  await xixi.chat(input('先看题十分钟'))
  const context = requests[1].messages
  assert.ok(context.some(message => message.role === 'assistant' && message.content.includes('先留多少时间？') && message.content.includes('大约一小时')))
  assert.equal(context.at(-1).content, '先看题十分钟')
})

test('invalid or duplicate options are rejected and can be repaired before display', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let requests = 0
  const xixi = createXixi({ db, complete: async () => ++requests === 1
    ? call('ask_user', { prompt: '多久？', options: ['半小时', '半小时'] })
    : call('ask_user', { prompt: '大概要多久？', options: ['半小时', '一小时'] }) })
  const result = await xixi.chat(input('帮我估时'))
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.filter(message => message.question).length, 1)
  assert.deepEqual(result.messages.at(-1).question.options, ['半小时', '一小时'])
  assert.equal(requests, 2)
})

test('facts can be saved before asking a missing detail, without inventing an estimate', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let requests = 0
  const xixi = createXixi({ db, complete: async () => ++requests === 1
    ? call('create_tasks', { tasks: [{ title: '招新测试', due: '2026-09-19' }] })
    : call('ask_user', { prompt: '记好了，明天具体几点前交？', options: ['下午六点前', '还没定'] }) })
  const result = await xixi.chat(input('明天交招新测试'))
  assert.equal(result.status, 'completed')
  assert.equal(result.operations.length, 1)
  assert.equal(db.listTasks()[0].estimateMin, undefined)
  assert.ok(result.messages.at(-1).question)
})

test('a clock in a timetable request does not prohibit clarification of an actually missing date', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const xixi = createXixi({ db, complete: async request => {
    requests.push(request)
    return call('ask_user', { prompt: '12:45 的临时课程是哪一天？', options: ['明天', '后天'] })
  } })
  const result = await xixi.chat(input('12:45 有临时课程，帮我记录'))
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.some(message => message.question), true)
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages.some(message => message.role === 'system' && message.content.includes('信息缺失或已知约束冲突')))
})

const CONFLICT_DATE = '2026-09-23'
const CONFLICT_NOW = new Date(`${CONFLICT_DATE}T17:00:00+08:00`)
const lastReceipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
function fullDormFixture(t) {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const update = action => db.updatePlanner(action, db.getPlanner().revision)
  update({ type: 'save-routine', routine: { id: 'dorm', title: '宿舍', kind: 'available', weekdays: [3],
    start: '20:30', end: '22:30', location: '宿舍', items: [], enabled: true } })
  update({ type: 'save-day-event', event: { id: 'fixed-activity', title: '机器人社活动', date: CONFLICT_DATE,
    start: '20:30', end: '21:15', location: 'A422', items: [] } })
  const sat = db.createTask({ title: 'SAT 单词背诵', estimateMin: 20 })
  const business = db.createTask({ title: 'Business 作业', estimateMin: 55 })
  update({ type: 'save-block', block: { id: 'sat-plan', taskId: sat.id, date: CONFLICT_DATE,
    start: '21:15', end: '21:35', locked: true } })
  update({ type: 'save-block', block: { id: 'business-plan', taskId: business.id, date: CONFLICT_DATE,
    start: '21:35', end: '22:30', locked: false } })
  return db
}

test('a known full dorm window saves homework once and asks one concrete tradeoff without moving existing commitments', async t => {
  const db = fullDormFixture(t), before = structuredClone(db.getPlanner()), existingTasks = db.listTasks()
  const notes = 'Ex2A 3 b iv、v；4；6。Ex2B 2（disjoint 定义见第36页）；3；4；5。Bonus 1: Ex2B 6。'
  const prompt = '数学作业记下了，今晚宿舍被机器人社、SAT 和 Business 排满了，改到晚自习还是先保留待排？'
  const options = ['改到今晚18:00–18:30', '先保留待排，不动现有安排']
  const requests = []
  const xixi = createXixi({ db, now: () => CONFLICT_NOW, complete: async request => {
    requests.push(request)
    if (requests.length === 1) return call('create_tasks', { tasks: [{ title: '数学作业', notes,
      startAt: CONFLICT_DATE, scheduleDate: CONFLICT_DATE, scheduleWindow: '宿舍' }] })
    if (requests.length === 2) return call('ask_user', { prompt, options })
    throw new Error('the conflict question should pause instead of invoking another model round')
  } })
  const request = { ...input(`今晚宿舍完成数学作业，详细题目：${notes}`), context: { page: 'home', timezone: 'Asia/Shanghai', date: CONFLICT_DATE } }
  const result = await xixi.chat(request)
  assert.equal(requests.length, 2)
  const receipt = lastReceipt(requests[1])
  assert.equal(receipt.ok, true)
  assert.equal(receipt.scheduling.changed, false)
  assert.deepEqual(receipt.scheduling.savedPlans, [])
  assert.equal(receipt.scheduling.unscheduled.length, 1)
  assert.equal(receipt.scheduling.unscheduled[0].remainingMin, 30)
  assert.equal(receipt.scheduling.unscheduled[0].date, CONFLICT_DATE)
  assert.match(receipt.scheduling.unscheduled[0].reason, /宿舍/u)
  const homework = db.listTasks().filter(task => task.title === '数学作业')
  assert.equal(homework.length, 1)
  assert.equal(homework[0].notes, notes)
  assert.equal(homework[0].startAt, CONFLICT_DATE)
  assert.equal(homework[0].estimateMin, undefined)
  assert.equal(homework[0].due, undefined)
  assert.deepEqual(existingTasks.map(task => db.getTask(task.id)), existingTasks)
  assert.deepEqual(db.getPlanner(), before, 'no fallback slot, other-day block, or change to fixed activity/SAT/Business may be fabricated')
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'awaiting_user')
  assert.equal(result.execution.scheduleRequirements[0].status, 'pending')
  assert.equal(result.execution.scheduleRequirements[0].date, CONFLICT_DATE)
  assert.equal(result.operations.length, 1)
  assert.deepEqual(result.messages.filter(message => message.question).map(message => ({ content: message.content, options: message.question.options })), [{ content: prompt, options }])
  assert.equal(result.messages.at(-1).content, prompt)
  const replay = await xixi.chat(request)
  assert.equal(requests.length, 2, 'retry returns the same waiting question without model calls')
  assert.equal(replay.messages.at(-1).id, result.messages.at(-1).id)
  assert.equal(replay.execution.status, 'awaiting_user')
  assert.equal(db.listTasks().length, existingTasks.length + 1)
  assert.equal(replay.operations.length, 1)
  assert.deepEqual(db.getPlanner(), before)
})

test('scheduleDate alone persists the intended date and schedules that exact day without inventing a DDL', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const tomorrow = '2026-09-24', requests = []
  const xixi = createXixi({ db, now: () => CONFLICT_NOW, complete: async request => {
    requests.push(request)
    return requests.length === 1
      ? call('create_tasks', { tasks: [{ title: '数学作业', scheduleDate: tomorrow, notes: 'Ex2A 3 b iv、v' }] })
      : reply('已安排到明天18:00–18:30，先按30分钟预留')
  } })
  const result = await xixi.chat(input('明晚数学作业，Ex2A 3 b iv、v'))
  assert.equal(result.status, 'completed')
  assert.equal(requests.length, 2)
  const task = db.listTasks()[0]
  assert.equal(task.startAt, tomorrow)
  assert.equal(task.due, undefined)
  assert.equal(task.estimateMin, undefined)
  assert.equal(Object.hasOwn(task, 'scheduleDate'), false, 'tool-only constraint does not leak into unsupported task fields')
  assert.deepEqual(db.getPlanner().blocks.map(({ date, start, end }) => ({ date, start, end })),
    [{ date: tomorrow, start: '18:00', end: '18:30' }])
  assert.equal(lastReceipt(requests[1]).scheduling.unscheduled.length, 0)
})

for (const [label, invalid, expectedError] of [
  ['nonexistent date', { scheduleDate: '2026-02-30' }, /指定安排日期不存在/u],
  ['timestamp instead of date', { scheduleDate: '2026-09-23T20:30:00+08:00' }, /YYYY-MM-DD/u],
  ['null date', { scheduleDate: null }, /YYYY-MM-DD/u],
  ['conflicting startAt', { startAt: '2026-09-24', scheduleDate: CONFLICT_DATE }, /计划日期与指定安排日期不一致/u],
  ['conflicting exact schedule', { scheduleDate: CONFLICT_DATE, schedule: { date: '2026-09-24', start: '18:00', end: '18:30' } }, /具体时段与指定安排日期不一致/u],
  ['mixed repeat', { scheduleDate: CONFLICT_DATE, estimateMin: 20, repeat: {
    from: CONFLICT_DATE, to: '2026-09-24', weekdays: [3, 4], allowFallback: false,
  } }, /重复事项的日期由repeat指定/u],
]) test(`invalid scheduleDate input rejects the entire creation batch atomically: ${label}`, async t => {
  const db = fullDormFixture(t), before = structuredClone(db.getPlanner()), tasksBefore = db.listTasks(), requests = []
  const xixi = createXixi({ db, now: () => CONFLICT_NOW, complete: async request => {
    requests.push(request)
    return requests.length === 1 ? call('create_tasks', { tasks: [
      { title: '同批有效事项', scheduleDate: CONFLICT_DATE },
      { title: '数学作业', ...invalid },
    ] }) : reply('这批事项未保存')
  } })
  const result = await xixi.chat(input('记录今晚数学作业和另一项待办'))
  assert.equal(requests.length, 2)
  assert.equal(lastReceipt(requests[1]).ok, false)
  assert.match(lastReceipt(requests[1]).error, expectedError)
  assert.equal(result.operations.length, 0)
  assert.deepEqual(db.listTasks(), tasksBefore, 'even the preceding valid draft must not remain saved')
  assert.deepEqual(db.getPlanner(), before)
})

test('same-day explicit schedule conflict rolls task creation back with its failed planner write', async t => {
  const db = fullDormFixture(t), before = structuredClone(db.getPlanner()), tasksBefore = db.listTasks(), requests = []
  const xixi = createXixi({ db, now: () => CONFLICT_NOW, complete: async request => {
    requests.push(request)
    if (requests.length === 1) return call('read_planner', { date: CONFLICT_DATE })
    if (requests.length === 2) return call('create_tasks', { expectedRevision: before.revision, tasks: [{
      title: '数学作业', scheduleDate: CONFLICT_DATE, notes: 'Ex2A 3 b iv、v',
      schedule: { date: CONFLICT_DATE, start: '20:30', end: '21:00' },
    }] })
    return reply('该时段与机器人社冲突，这次没有保存数学事项或时段')
  } })
  const result = await xixi.chat(input('今晚数学作业20:30–21:00，Ex2A 3 b iv、v'))
  assert.equal(requests.length, 3)
  assert.equal(lastReceipt(requests[2]).ok, false)
  assert.match(lastReceipt(requests[2]).error, /已知可用窗口|冲突/u)
  assert.equal(result.operations.length, 0)
  assert.deepEqual(db.listTasks(), tasksBefore)
  assert.deepEqual(db.getPlanner(), before)
})

test('a later next-day plan cannot verify an unresolved scheduleDate requirement for tonight', async t => {
  const db = fullDormFixture(t), requests = []
  const tomorrow = '2026-09-24', falseClaim = '已经按你的要求全部安排好了'
  const xixi = createXixi({ db, now: () => CONFLICT_NOW, complete: async request => {
    requests.push(request)
    if (requests.length === 1) return call('create_tasks', { tasks: [{ title: '数学作业', scheduleDate: CONFLICT_DATE, scheduleWindow: '宿舍' }] })
    if (requests.length === 2) return call('read_planner', { date: tomorrow })
    if (requests.length === 3) return call('plan_tasks', { expectedRevision: db.getPlanner().revision, plans: [{
      taskId: db.listTasks().find(task => task.title === '数学作业').id, date: tomorrow, start: '18:00', end: '18:30',
    }] })
    return reply(falseClaim)
  } })
  const result = await xixi.chat(input('今晚宿舍完成数学作业'))
  const homework = db.listTasks().find(task => task.title === '数学作业')
  assert.equal(lastReceipt(requests[3]).ok, true, 'this exercises verification after a model has submitted the wrong day')
  assert.ok(db.getPlanner().blocks.some(block => block.taskId === homework.id && block.date === tomorrow))
  const required = result.execution.scheduleRequirements.find(item => item.taskId === homework.id)
  assert.equal(required.date, CONFLICT_DATE)
  assert.equal(required.status, 'pending')
  assert.equal(result.status, 'failed')
  assert.equal(result.execution.status, 'partial')
  assert.ok(!result.messages.some(message => message.content === falseClaim), 'a saved block on the wrong day is not proof of completion')
})

test('a requested night with only 25 fragmented dorm minutes neither splits the default estimate nor spills into tomorrow', async t => {
  const db = fullDormFixture(t)
  const update = action => db.updatePlanner(action, db.getPlanner().revision)
  db.setPreference('app', { scheduling: { bufferMin: 0 } })
  const dorm = db.getPlanner().routines.find(routine => routine.id === 'dorm')
  update({ type: 'save-routine', routine: { ...dorm, weekdays: [3, 4] } })
  const activity = db.getPlanner().dayEvents.find(event => event.id === 'fixed-activity')
  update({ type: 'save-day-event', event: { ...activity, end: '21:00' } })
  const business = db.getPlanner().blocks.find(block => block.id === 'business-plan')
  update({ type: 'save-block', block: { ...business, end: '22:20' } })
  const before = structuredClone(db.getPlanner()), requests = []
  const remaining = dayCapacity(before, db.listTasks(), CONFLICT_DATE, CONFLICT_NOW).remaining
    .filter(range => range.start >= 20 * 60 + 30)
  assert.deepEqual(remaining.map(range => range.end - range.start), [15, 10])
  const notes = 'Ex2B 2、3、4、5；Bonus 1: Ex2B 6'
  const prompt = '今晚宿舍只剩15分钟和10分钟两段，先记着待排，还是改到明晚连续做30分钟？'
  const options = ['先保留待排，不动其他任务', '改到明晚宿舍20:30–21:00']
  const xixi = createXixi({ db, now: () => CONFLICT_NOW, complete: async request => {
    requests.push(request)
    if (requests.length === 1) return call('create_tasks', { tasks: [{ title: '数学作业', notes,
      startAt: CONFLICT_DATE, scheduleDate: CONFLICT_DATE, scheduleWindow: '宿舍' }] })
    if (requests.length === 2) return call('ask_user', { prompt, options })
    throw new Error('a short requested window must ask once and pause')
  } })
  const request = { ...input(`今晚宿舍完成数学作业，${notes}`), context: { page: 'home', timezone: 'Asia/Shanghai', date: CONFLICT_DATE } }
  const result = await xixi.chat(request)
  assert.equal(requests.length, 2)
  const receipt = lastReceipt(requests[1])
  assert.equal(receipt.ok, true)
  assert.equal(receipt.scheduling.changed, false)
  assert.deepEqual(receipt.scheduling.savedPlans, [])
  assert.deepEqual(receipt.scheduling.allocations.map(({ date, totalMin, scheduledMin, estimated }) => ({ date, totalMin, scheduledMin, estimated })),
    [{ date: CONFLICT_DATE, totalMin: 30, scheduledMin: 0, estimated: true }])
  assert.equal(receipt.scheduling.unscheduled[0].date, CONFLICT_DATE)
  assert.equal(receipt.scheduling.unscheduled[0].remainingMin, 30)
  assert.match(receipt.scheduling.unscheduled[0].reason, /宿舍.*完整 30 分钟/u)
  const homework = db.listTasks().filter(task => task.title === '数学作业')
  assert.equal(homework.length, 1)
  assert.equal(homework[0].notes, notes)
  assert.equal(homework[0].estimateMin, undefined)
  assert.equal(homework[0].due, undefined)
  assert.deepEqual(db.getPlanner(), before, 'neither today fragments nor tomorrow capacity are used before the user chooses')
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'awaiting_user')
  assert.equal(result.operations.length, 1)
  assert.equal(result.messages.filter(message => message.question).length, 1)
  assert.equal(result.messages.at(-1).content, prompt)
  assert.deepEqual(result.messages.at(-1).question.options, options)
  const replay = await xixi.chat(request)
  assert.equal(requests.length, 2)
  assert.equal(replay.messages.at(-1).id, result.messages.at(-1).id)
  assert.equal(db.listTasks().filter(task => task.title === '数学作业').length, 1)
  assert.deepEqual(db.getPlanner(), before)
})

test('an exact-date complete slot retains buffers and the actual deadline while leaving source plans untouched', t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const targetDate = '2026-09-24', update = action => db.updatePlanner(action, db.getPlanner().revision)
  update({ type: 'save-routine', routine: { id: 'dorm', title: '宿舍', kind: 'available', weekdays: [3, 4, 5],
    start: '20:30', end: '22:30', location: '宿舍', items: [], enabled: true } })
  const fixed = db.createTask({ title: '原安排', estimateMin: 30 })
  update({ type: 'save-block', block: { id: 'fixed-plan', taskId: fixed.id, date: targetDate,
    start: '20:30', end: '21:00', locked: true } })
  const homework = db.createTask({ title: '数学作业', startAt: CONFLICT_DATE, estimateMin: 30 })
  const before = structuredClone(db.getPlanner())
  const plan = due => {
    const task = { ...homework, due }
    return initialTaskSchedule({ state: before, allTasks: [fixed, task], tasks: [task], now: CONFLICT_NOW,
      idForBlock: () => 'proposed-math', bufferMin: 10,
      windowByTask: new Map([[task.id, '宿舍']]), dateByTask: new Map([[task.id, targetDate]]) })
  }
  const short = plan(`${targetDate}T21:35:00+08:00`)
  assert.deepEqual(short.plans, [], 'only 25 minutes fit after the buffer and before the deadline')
  assert.equal(short.unscheduled[0].date, targetDate)
  assert.equal(short.allocations[0].scheduledMin, 0)
  const fits = plan(`${targetDate}T21:40:00+08:00`)
  assert.deepEqual(fits.plans, [{ id: 'proposed-math', taskId: homework.id, date: targetDate,
    start: '21:10', end: '21:40', locked: false }])
  assert.deepEqual(fits.unscheduled, [])
  assert.equal(fits.allocations[0].scheduledMin, 30)
  assert.deepEqual(before, db.getPlanner(), 'pure placement never rewrites locked or existing plans')
})

test('an explicit pending slot can pause for a newly discovered conflict without a scheduling-nudge loop', async t => {
  const db = fullDormFixture(t)
  const homework = db.createTask({ title: '数学作业', estimateMin: 30 })
  const before = structuredClone(db.getPlanner()), requests = []
  const prompt = '20:30–21:00 和机器人社活动重叠，数学改到18:00还是先不排？'
  const options = ['数学改到今晚18:00–18:30', '先不排，保留机器人社活动']
  const xixi = createXixi({ db, now: () => CONFLICT_NOW, complete: async request => {
    requests.push(request)
    if (requests.length === 1) return call('read_planner', { date: CONFLICT_DATE })
    if (requests.length === 2) return call('ask_user', { prompt, options })
    throw new Error('a necessary conflict question is a valid pause even with a required schedule pending')
  } })
  const request = { ...input('把数学作业安排在今晚20:30–21:00'), context: { page: 'home', timezone: 'Asia/Shanghai', date: CONFLICT_DATE } }
  const result = await xixi.chat(request)
  assert.equal(requests.length, 2)
  assert.ok(requests[1].messages.some(message => message.role === 'system' && message.content.includes('本轮待完成日历事项')))
  const requirement = result.execution.scheduleRequirements.find(item => item.taskId === homework.id)
  assert.deepEqual(requirement.slot, { date: CONFLICT_DATE, start: '20:30', end: '21:00' })
  assert.equal(requirement.mustComplete, true)
  assert.equal(requirement.status, 'pending')
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'awaiting_user')
  assert.equal(result.execution.reply.mode, 'model')
  assert.equal(result.execution.failures.length, 0)
  assert.equal(result.operations.length, 0)
  assert.equal(result.messages.filter(message => message.question).length, 1)
  assert.equal(result.messages.at(-1).content, prompt)
  assert.deepEqual(result.messages.at(-1).question.options, options)
  assert.deepEqual(db.getPlanner(), before)
  assert.deepEqual(db.getTask(homework.id), homework)
  const replay = await xixi.chat(request)
  assert.equal(requests.length, 2)
  assert.equal(replay.messages.at(-1).id, result.messages.at(-1).id)
  assert.equal(replay.execution.status, 'awaiting_user')
  assert.equal(replay.operations.length, 0)
  assert.deepEqual(db.getPlanner(), before)
})
