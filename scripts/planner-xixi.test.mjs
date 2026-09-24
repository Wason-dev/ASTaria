import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, contextUnits, XIXI_TOOLS, HARD_INPUT_UNITS } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-18', NOW = new Date(`${DATE}T17:00:00+08:00`)
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const input = (text = '帮我安排报告', context = {}) => ({ requestId: randomUUID(), conversationId: 'main', text,
  context: { timezone: 'Asia/Shanghai', page: 'timetable', date: DATE, ...context } })
const environment = request => JSON.parse(request.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n')[1])
const receipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
function fixture(t, responses = []) {
  const db = createDatabase(':memory:'), requests = []
  t.after(() => db.close())
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    requests.push(request)
    const next = responses.shift()
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next(request) : next ?? reply('好')
  } })
  return { db, requests, responses, xixi }
}
const createTask = (db, patch = {}) => db.createTask({ title: '物理报告', due: DATE, estimateMin: 35, ...patch })
const plan = task => ({ taskId: task.id, date: DATE, start: '18:00', end: '18:35' })
const update = (db, action) => db.updatePlanner(action, db.getPlanner().revision)
const read = (date = DATE, days) => tool('read_planner', { date, ...(days ? { days } : {}) })

function addSchoolDayWithDorm(db) {
  // A normal evening window used to disappear behind the bounded lesson list.
  for (let index = 0; index < 20; index++) {
    const time = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
    update(db, { type: 'save-routine', routine: { id: `lesson-${index}`, title: `课程${index + 1}`, kind: 'class', weekdays: [5],
      start: time(index * 45), end: time(index * 45 + 40), location: '教室508', items: Array.from({ length: 8 }, (_, i) => `材料${i}${'甲'.repeat(60)}`), enabled: true } })
  }
  update(db, { type: 'save-routine', routine: { id: 'dorm', title: '宿舍', kind: 'available', weekdays: [5],
    start: '20:30', end: '22:30', location: '宿舍', items: [], enabled: true } })
}

test('named dorm availability survives a truncated school day and supports direct read→plan', async t => {
  const f = fixture(t)
  addSchoolDayWithDorm(f.db)
  const sat = createTask(f.db, { title: 'SAT', estimateMin: 45 })
  const google = createTask(f.db, { title: '注册Google账号并加入Classroom', estimateMin: 15 })
  update(f.db, { type: 'save-block', block: { ...plan(sat), id: 'sat-plan', end: '19:00', locked: false } })
  const checkDorm = windows => {
    assert.equal(windows.truncated, false)
    const dorm = windows.items.find(item => item.id === 'dorm')
    assert.deepEqual(Object.fromEntries(['id', 'title', 'start', 'end', 'location'].map(key => [key, dorm[key]])), { id: 'dorm', title: '宿舍', start: '20:30', end: '22:30', location: '宿舍' })
    assert.equal(dorm.remainingMinutes, 120)
    assert.equal(dorm.occupied.total, 0)
  }
  f.responses.push(request => {
    checkDorm(environment(request).planner.availabilityWindows)
    return read()
  }, request => {
    const data = receipt(request), view = data.days[0]
    assert.equal(view.routines.truncated, true)
    assert.ok(!view.routines.items.some(item => item.id === 'dorm'), 'reproduces the former truncation')
    checkDorm(view.availabilityWindows)
    return tool('plan_tasks', { expectedRevision: data.revision, plans: [
      { ...plan(sat), id: 'sat-plan', start: '20:30', end: '21:15' },
      { ...plan(google), start: '21:15', end: '21:30' },
    ] })
  }, request => {
    assert.equal(receipt(request).ok, true)
    assert.ok(environment(request).planner.capacity.remaining.some(range => range.start === 1290 && range.end === 1350))
    return reply('两件已经安排在宿舍时段了')
  })
  const result = await f.xixi.chat(input('SAT还要40多分钟，Google今晚做，把这两个记到宿舍时间'))
  assert.equal(result.status, 'completed')
  assert.equal(result.operations.length, 1)
  assert.equal(f.db.getPlanner().blocks.length, 2)
  assert.equal(f.db.getPlanner().blocks.find(block => block.id === 'sat-plan').start, '20:30')
  assert.ok(f.requests.every(request => contextUnits(request.messages) + contextUnits(XIXI_TOOLS) <= HARD_INPUT_UNITS))
})

test('availability names use fresh target-day overrides and respect occupied time', async t => {
  const f = fixture(t), date = '2026-09-26'
  addSchoolDayWithDorm(f.db)
  update(f.db, { type: 'set-day-template', date, sourceWeekday: 5 })
  const occupied = createTask(f.db, { due: date })
  update(f.db, { type: 'save-block', block: { id: 'occupied-dorm', taskId: occupied.id, date, start: '20:30', end: '21:00', locked: true } })
  f.responses.push(read(date), request => {
    const view = receipt(request).days[0]
    assert.equal(view.dayOverride.sourceWeekday, 5)
    assert.equal(view.availabilityWindows.items.find(item => item.id === 'dorm').start, '20:30')
    assert.ok(view.capacity.remaining.some(range => range.start === 1260 && range.end === 1350))
    assert.ok(!view.capacity.remaining.some(range => range.start <= 1230 && range.end > 1230))
    return reply('宿舍时段前半小时有安排，后面还有空')
  })
  await f.xixi.chat(input('看看周日宿舍时间', { date }))
  const dorm = f.db.getPlanner().routines.find(item => item.id === 'dorm')
  update(f.db, { type: 'save-routine', routine: { ...dorm, title: '晚间自选', location: '宿舍二楼', start: '21:00' } })
  await f.xixi.chat(input('我刚改了宿舍时间，再看看', { date }))
  const current = environment(f.requests.at(-1)).planner.availabilityWindows.items.find(item => item.id === 'dorm')
  assert.equal(current.start, '21:00')
  assert.equal(current.title, '晚间自选')
  assert.equal(current.location, '宿舍二楼')
})

test('missing and disabled dorm windows are not inferred from an unnamed free evening', async t => {
  const f = fixture(t)
  await f.xixi.chat(input('宿舍时间能做什么'))
  assert.ok(environment(f.requests[0]).planner.availabilityWindows.items.every(item => item.title !== '宿舍'))
  addSchoolDayWithDorm(f.db)
  const dorm = f.db.getPlanner().routines.find(item => item.id === 'dorm')
  update(f.db, { type: 'save-routine', routine: { ...dorm, enabled: false } })
  f.responses.push(read(), request => {
    assert.ok(receipt(request).days[0].availabilityWindows.items.every(item => item.id !== 'dorm'))
    return reply('这天没有已启用的宿舍时段')
  })
  await f.xixi.chat(input('再看看宿舍时间'))
})

test('selected date and real capacity enter context, then read→plan persists receipt and undo restores state', async t => {
  const f = fixture(t), task = createTask(f.db)
  const before = f.db.getPlanner()
  f.responses.push(request => {
    const data = environment(request)
    assert.equal(data.selectedDate, DATE)
    assert.equal(data.planner.date, DATE)
    assert.equal(data.planner.capacity.freeMin, 120)
    assert.equal(data.planner.timezoneMatches, true)
    return read()
  }, request => {
    const data = receipt(request)
    assert.equal(data.type, 'planner_read')
    assert.equal(data.days[0].capacity.freeMin, 120)
    assert.ok(data.days[0].tasks.items.some(item => item.id === task.id))
    return tool('plan_tasks', { expectedRevision: data.revision, plans: [plan(task)] })
  }, request => {
    const data = receipt(request)
    assert.equal(data.ok, true)
    assert.equal(data.operation.kind, 'planner')
    assert.deepEqual(data.operation.changes, [])
    assert.equal(data.operation.plannerBefore, undefined)
    assert.equal(data.operation.requestedActions, undefined)
    assert.equal(environment(request).planner.capacity.freeMin, 85)
    assert.doesNotMatch(JSON.stringify(request), /plannerBefore|plannerAfterRevision/)
    return reply('留了18:00–18:35写物理报告，后面还有空闲')
  })
  const result = await f.xixi.chat(input())
  assert.equal(result.status, 'completed')
  assert.equal(result.operations.length, 1)
  assert.equal(f.db.getPlanner().blocks.length, 1)
  assert.equal(f.db.getTask(task.id).due, DATE)
  assert.equal(f.db.getTask(task.id).startAt, undefined)
  f.db.undoOperation(result.operations[0].id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('creating a timed meeting then shifting SAT and math saves the final calendar in one planner receipt', async t => {
  const f = fixture(t)
  const sat = createTask(f.db, { title: 'SAT 作业', estimateMin: 60 })
  const math = createTask(f.db, { title: '数学作业', estimateMin: 30 })
  update(f.db, { type: 'save-block', block: { ...plan(sat), id: 'sat-evening', end: '19:00', locked: false } })
  update(f.db, { type: 'save-block', block: { ...plan(math), id: 'math-evening', start: '19:00', end: '19:30', locked: false } })
  const before = f.db.getPlanner()
  let meeting
  f.responses.push(tool('create_tasks', { tasks: [{ title: '社团会议', startAt: DATE, estimateMin: 30 }] }), request => {
    const created = receipt(request)
    assert.equal(created.ok, true)
    assert.equal(created.scheduling.changed, false)
    assert.match(created.scheduling.notice, /没有新增或移动日历时段/)
    meeting = f.db.listTasks().find(task => task.title === '社团会议')
    assert.ok(meeting)
    assert.deepEqual(f.db.getPlanner(), before, 'creating a task alone does not shift the calendar')
    return read()
  }, request => tool('plan_tasks', { expectedRevision: receipt(request).revision, plans: [
    { taskId: meeting.id, date: DATE, start: '18:00', end: '18:30' },
    { id: 'sat-evening', taskId: sat.id, date: DATE, start: '18:30', end: '19:30' },
    { id: 'math-evening', taskId: math.id, date: DATE, start: '19:30', end: '20:00' },
  ] }), request => {
    const saved = receipt(request)
    assert.equal(saved.ok, true)
    assert.deepEqual(saved.savedPlans.map(({ taskId, start, end }) => ({ taskId, start, end })), [
      { taskId: meeting.id, start: '18:00', end: '18:30' },
      { taskId: sat.id, start: '18:30', end: '19:30' },
      { taskId: math.id, start: '19:30', end: '20:00' },
    ])
    for (const block of saved.savedPlans) assert.deepEqual(f.db.getPlanner().blocks.find(item => item.id === block.id), block)
    return reply('已经保存：会议18:00–18:30，SAT18:30–19:30，数学19:30–20:00。')
  })
  const result = await f.xixi.chat(input('今天晚上18:00–18:30有社团会议，其余顺延，数学留在晚自习内。直接改。'))
  assert.equal(result.status, 'completed')
  assert.equal(result.operations.length, 2)
  assert.equal(f.db.getPlanner().blocks.length, 3)
  assert.equal(f.db.getTask(sat.id).due, DATE)
  assert.equal(f.db.getTask(math.id).due, DATE)
  assert.equal(f.db.getTask(meeting.id).due, undefined, 'an appointment time is not invented as a deadline')
  const plannerReceipt = result.operations.find(item => item.kind === 'planner')
  assert.equal(plannerReceipt.planChanges.length, 3)
  f.db.undoOperation(plannerReceipt.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.ok(f.db.getTask(meeting.id), 'undoing the schedule preserves the created meeting task')
})

test('an explicit activity window is not left in the inbox: create is followed by planning over the available evening window', async t => {
  const f = fixture(t)
  let activity
  f.responses.push(
    tool('create_tasks', { tasks: [{ title: '机器人社新生第一次活动', startAt: DATE }] }),
    request => {
      const created = receipt(request)
      assert.equal(created.ok, true)
      activity = f.db.listTasks().find(task => task.title === '机器人社新生第一次活动')
      assert.ok(activity)
      return read()
    },
    request => tool('plan_tasks', { expectedRevision: receipt(request).revision, plans: [{ taskId: activity.id, date: DATE, start: '18:00', end: '20:00' }] }),
    request => {
      const saved = receipt(request)
      assert.equal(saved.ok, true)
      assert.deepEqual(saved.savedPlans.map(({ taskId, start, end }) => ({ taskId, start, end })), [{ taskId: activity.id, start: '18:00', end: '20:00' }])
      return reply('机器人社活动已安排在今晚18:00–20:00，晚自习窗口保留')
    },
  )
  const result = await f.xixi.chat(input('今晚18:00–20:00，前来A422参与机器人社本学期新生第一次活动'))
  assert.equal(result.status, 'completed')
  assert.equal(f.db.getPlanner().blocks.length, 1)
  assert.deepEqual(f.db.getPlanner().blocks[0], { id: f.db.getPlanner().blocks[0].id, taskId: activity.id, date: DATE, start: '18:00', end: '20:00', locked: false })
  assert.equal(f.db.getPlanner().routines.find(routine => routine.id === 'default-evening-study').enabled, true)
})

for (const date of ['2026-09-19', '2026-09-20']) test(`weekend ${date} read→plan uses the default 09:00–22:00 window`, async t => {
  const f = fixture(t), task = createTask(f.db, { due: date })
  const proposed = { taskId: task.id, date, start: '09:00', end: '09:35' }
  f.responses.push(request => {
    const data = environment(request)
    assert.equal(data.selectedDate, date)
    assert.equal(data.planner.capacity.freeMin, 780)
    return read(date)
  }, request => {
    const data = receipt(request)
    assert.equal(data.type, 'planner_read')
    assert.equal(data.days[0].date, date)
    assert.equal(data.days[0].capacity.freeMin, 780)
    assert.ok(data.days[0].routines.items.some(item => item.kind === 'available' && item.start === '09:00' && item.end === '22:00'))
    return tool('plan_tasks', { expectedRevision: data.revision, plans: [proposed] })
  }, request => {
    assert.equal(receipt(request).ok, true)
    assert.equal(environment(request).planner.capacity.freeMin, 745)
    return reply('上午九点留了三十五分钟写报告')
  })
  const result = await f.xixi.chat(input('周末帮我安排报告', { date }))
  assert.equal(result.status, 'completed')
  assert.equal(result.operations.length, 1)
  assert.equal(f.db.getPlanner().blocks.length, 1)
  const { id, locked, ...placement } = f.db.getPlanner().blocks[0]
  assert.equal(typeof id, 'string')
  assert.equal(locked, false)
  assert.deepEqual(placement, proposed)
})

test('planning requires an actual current-revision read of its target date', async t => {
  const f = fixture(t), task = createTask(f.db)
  f.responses.push(tool('plan_tasks', { expectedRevision: 0, plans: [plan(task)] }), request => {
    assert.equal(receipt(request).ok, false)
    assert.match(receipt(request).error, /read_planner/)
    return reply('先看看可用时间')
  })
  await f.xixi.chat(input())
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('unknown availability rejects AI planning even though manual placement supports it', async t => {
  const f = fixture(t), task = createTask(f.db)
  update(f.db, { type: 'delete-routine', id: 'default-evening-study' })
  f.responses.push(read(), request => tool('plan_tasks', { expectedRevision: receipt(request).revision, plans: [plan(task)] }), request => {
    assert.match(receipt(request).error, /没有明确/)
    return reply('先确认你那段时间是否有空')
  })
  await f.xixi.chat(input())
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

for (const name of ['plan_tasks', 'remove_plan']) test(`AI ${name} preserves a locked placement`, async t => {
  const f = fixture(t), task = createTask(f.db)
  update(f.db, { type: 'save-block', block: { ...plan(task), id: 'locked', locked: true } })
  const before = f.db.getPlanner()
  f.responses.push(read(), request => tool(name, name === 'remove_plan'
    ? { id: 'locked', expectedRevision: receipt(request).revision }
    : { plans: [{ ...plan(task), id: 'locked', start: '19:00', end: '19:35' }], expectedRevision: receipt(request).revision }), request => {
    assert.match(receipt(request).error, /锁定/)
    return reply('这段已经锁定，你可以先在页面解锁')
  })
  await f.xixi.chat(input())
  assert.deepEqual(f.db.getPlanner(), before)
})

test('planner store rejects conflicts and deadlines; AI also rejects past times and mismatched timezones', async t => {
  for (const kind of ['conflict', 'deadline', 'past', 'timezone']) {
    const f = fixture(t), task = createTask(f.db, kind === 'deadline' ? { due: `${DATE}T18:20:00+08:00` } : {})
    if (kind === 'conflict') {
      const other = createTask(f.db, { title: '已经排好的事' })
      update(f.db, { type: 'save-block', block: { ...plan(other), id: 'occupied', locked: false } })
    }
    f.responses.push(read(), request => tool('plan_tasks', { expectedRevision: receipt(request).revision,
      plans: [{ ...plan(task), ...(kind === 'past' ? { start: '16:00', end: '16:35' } : {}) }] }), request => {
      assert.equal(receipt(request).ok, false)
      assert.match(receipt(request).error, { conflict: /已有其他/, deadline: /截止/, past: /过去/, timezone: /时区/ }[kind])
      return reply('先调整一下条件')
    })
    await f.xixi.chat(input('安排一下', kind === 'timezone' ? { timezone: 'UTC' } : {}))
    assert.equal(f.db.listOperations().length, 0)
  }
})

test('preparation preserves real submission status and explicit carry items', async t => {
  const f = fixture(t), task = createTask(f.db)
  update(f.db, { type: 'save-details', taskId: task.id, details: { items: [], preparation: '', needsSubmission: true, submittedAt: `${DATE}T08:00:00Z` } })
  f.responses.push(read(), request => tool('save_task_preparation', { taskId: task.id, expectedRevision: receipt(request).revision,
    items: ['纸质报告'], preparation: '打印签名页', needsSubmission: true }), reply('准备信息记好了'))
  await f.xixi.chat(input('纸质报告要打印签名页'))
  assert.equal(f.db.getPlanner().details[task.id].submittedAt, `${DATE}T08:00:00.000Z`)
  assert.deepEqual(f.db.getPlanner().details[task.id].items, ['纸质报告'])
  assert.equal(f.db.listOperations().length, 1)
})

test('removing an unlocked plan keeps the task and can be undone', async t => {
  const f = fixture(t), task = createTask(f.db)
  update(f.db, { type: 'save-block', block: { ...plan(task), id: 'old', locked: false } })
  f.responses.push(read(), request => tool('remove_plan', { id: 'old', expectedRevision: receipt(request).revision }), reply('时间腾出来了'))
  const result = await f.xixi.chat(input('移除这段安排'))
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.db.getTask(task.id).title, task.title)
  f.db.undoOperation(result.operations[0].id)
  assert.equal(f.db.getPlanner().blocks[0].id, 'old')
})

test('failed final reply acknowledges committed plans locally without a retryable mutation', async t => {
  const f = fixture(t), task = createTask(f.db)
  f.responses.push(read(), request => tool('plan_tasks', { expectedRevision: receipt(request).revision, plans: [plan(task)] }), new Error('offline'))
  const request = input()
  const first = await f.xixi.chat(request)
  assert.equal(first.status, 'completed')
  assert.match(first.messages.at(-1).content, /18:00–18:35/)
  f.responses.push(tool('plan_tasks', { expectedRevision: f.db.getPlanner().revision, plans: [plan(task)] }), request => {
    assert.equal(receipt(request).reused, true)
    return reply('安排保留着')
  })
  assert.equal((await f.xixi.chat(request)).status, 'completed')
  assert.equal(f.requests.length, 3)
  assert.equal(f.db.getPlanner().blocks.length, 1)
  assert.equal(f.db.listOperations().length, 1)
})

test('read planner bounds days and content, and context.date rejects malformed dates', async t => {
  const f = fixture(t)
  f.responses.push(read(DATE, 7), request => {
    const data = receipt(request)
    assert.equal(data.days.length, 7)
    assert.equal(data.days[6].date, '2026-09-24')
    assert.ok(contextUnits(data) < 4500)
    assert.ok(contextUnits(request.messages) + contextUnits(XIXI_TOOLS) <= HARD_INPUT_UNITS)
    return reply('看完这周了')
  })
  await f.xixi.chat(input('看看未来7天', { date: '2026-09-19' }))
  assert.equal(environment(f.requests[0]).selectedDate, '2026-09-19')
  await assert.rejects(f.xixi.chat(input('看看', { date: '2026-02-30' })), /不存在/)
})

test('stale planner revisions and unread dates cannot overwrite another browser', async t => {
  for (const kind of ['stale', 'unread']) {
    const f = fixture(t), task = createTask(f.db, { due: '2026-09-22' })
    f.responses.push(read(), request => {
      const revision = receipt(request).revision
      if (kind === 'stale') update(f.db, { type: 'check-item', date: DATE, key: '计算器', checked: true })
      return tool('plan_tasks', { expectedRevision: revision, plans: [{ ...plan(task), ...(kind === 'unread' ? { date: '2026-09-21' } : {}) }] })
    }, request => {
      assert.equal(receipt(request).ok, false)
      assert.match(receipt(request).error, kind === 'stale' ? /其他窗口/ : /read_planner/)
      return reply('我重新看看')
    })
    await f.xixi.chat(input())
    assert.equal(f.db.getPlanner().blocks.length, 0)
    assert.equal(f.db.listOperations().length, 0)
  }
})

test('a conflicting batch rolls back all plans and preparation cannot forge submission time', async t => {
  const f = fixture(t), first = createTask(f.db), second = createTask(f.db)
  f.responses.push(read(), request => tool('plan_tasks', { expectedRevision: receipt(request).revision, plans: [plan(first), plan(second)] }), request => {
    assert.equal(receipt(request).ok, false)
    assert.match(receipt(request).error, /已有其他/)
    return reply('这两段重叠了，我调整一下')
  })
  await f.xixi.chat(input())
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.db.getPlanner().revision, 0)
  f.responses.push(read(), request => tool('save_task_preparation', { taskId: first.id, expectedRevision: receipt(request).revision,
    items: ['纸质报告'], preparation: '', needsSubmission: true, submittedAt: NOW.toISOString() }), request => {
    assert.equal(receipt(request).ok, false)
    assert.match(receipt(request).error, /不支持的字段/)
    return reply('提交状态留给你确认')
  })
  await f.xixi.chat(input('准备纸质报告'))
  assert.equal(f.db.getPlanner().details[first.id], undefined)
})

test('AI task writes cannot bypass fixed or locked times through precise startAt, and create batches stay atomic', async t => {
  for (const kind of ['fixed', 'locked']) for (const name of ['create_tasks', 'update_task']) {
    const f = fixture(t), task = createTask(f.db, { startAt: DATE })
    if (kind === 'fixed') update(f.db, { type: 'save-routine', routine: { id: 'physics', title: '物理课', kind: 'class',
      weekdays: [5], start: '18:00', end: '19:00', location: '', items: [], enabled: true } })
    else {
      const lockedTask = createTask(f.db, { title: '锁定的安排' })
      update(f.db, { type: 'save-block', block: { ...plan(lockedTask), id: 'locked', locked: true } })
    }
    const beforeTasks = f.db.listTasks(), beforePlanner = f.db.getPlanner()
    const startAt = `${DATE}T18:00:00+08:00`
    f.responses.push(tool(name, name === 'create_tasks'
      ? { tasks: [{ title: '先处理的正常事项', startAt: DATE }, { title: '绕过排程的事项', startAt, estimateMin: 35 }] }
      : { taskId: task.id, expectedUpdatedAt: task.updatedAt, patch: { title: '尝试一起改标题', startAt } }), request => {
      assert.equal(receipt(request).ok, false)
      assert.match(receipt(request).error, /read_planner.*plan_tasks/)
      return reply('先看看那段时间的安排')
    })
    await f.xixi.chat(input('今天18点开始写报告'))
    assert.deepEqual(f.db.listTasks(), beforeTasks)
    assert.deepEqual(f.db.getPlanner(), beforePlanner)
    assert.equal(f.db.listOperations().length, 0)
  }
})

test('historical precise startAt stays readable and unrelated updates preserve it; new date intentions remain supported', async t => {
  const f = fixture(t), startAt = `${DATE}T18:00:00+08:00`
  const task = createTask(f.db, { startAt })
  const storedStart = f.db.getTask(task.id).startAt
  f.responses.push(tool('read_tasks', { taskId: task.id }), request => {
    assert.equal(receipt(request).tasks[0].startAt, storedStart)
    return tool('update_task', { taskId: task.id, expectedUpdatedAt: receipt(request).tasks[0].updatedAt,
      patch: { title: '物理实验报告' } })
  }, reply('标题改好了'))
  await f.xixi.chat(input('把标题改成物理实验报告'))
  assert.equal(f.db.getTask(task.id).title, '物理实验报告')
  assert.equal(f.db.getTask(task.id).startAt, storedStart)

  f.responses.push(tool('update_task', { taskId: task.id, expectedUpdatedAt: f.db.getTask(task.id).updatedAt,
    patch: { startAt: DATE } }), reply('先记到今天，具体时段再安排'))
  await f.xixi.chat(input('改成今天，先不指定钟点'))
  assert.equal(f.db.getTask(task.id).startAt, DATE)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})
