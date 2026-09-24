import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-18'
const NOW = new Date(`${DATE}T17:00:00+08:00`)
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const input = text => ({ requestId: randomUUID(), conversationId: 'main', text,
  context: { timezone: 'Asia/Shanghai', page: 'timetable', date: DATE } })
const toolResult = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)

test('creating a dated task saves a real calendar block in the first call without another model scheduling step', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const responses = [
    call('create_tasks', { tasks: [{ title: '物理课 1.2 单元前三道题', due: '2026-09-22', estimateMin: 30 }] }),
    request => {
      const receipt = toolResult(request)
      assert.equal(receipt.scheduling.changed, true)
      assert.equal(receipt.scheduling.savedPlans.length, 1)
      assert.equal(db.getPlanner().blocks.length, 1)
      return reply('已安排到今天 18:00–18:30。')
    },
  ]
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    requests.push(request)
    const response = responses.shift()
    return typeof response === 'function' ? response(request) : response
  } })
  const result = await xixi.chat(input('物理课1.2单元前三道题，ddl明天'))
  assert.equal(result.status, 'completed')
  assert.equal(requests.length, 2)
  assert.equal(result.operations.filter(operation => operation.kind === 'planner').length, 1)
  assert.deepEqual(db.getPlanner().blocks.map(({ taskId, date, start, end }) => ({ taskId, date, start, end })), [{
    taskId: db.listTasks()[0].id, date: DATE, start: '18:00', end: '18:30',
  }])
  assert.deepEqual(result.execution.commits.map(commit => commit.operationId).sort(), result.operations.map(operation => operation.id).sort())
})

function fixture(t, tasks, text = '记下来') {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    requests.push(request)
    return requests.length === 1 ? call('create_tasks', { tasks }) : reply('按回执说明实际结果')
  } })
  return { db, xixi, requests, run: () => xixi.chat(input(text)) }
}

test('unestimated task gets a transparent initial 30 minute block while user estimate stays unknown', async t => {
  const f = fixture(t, [{ title: '物理前三题', due: '2026-09-19' }])
  await f.run()
  const receipt = toolResult(f.requests[1])
  assert.equal(f.db.listTasks()[0].estimateMin, undefined)
  assert.deepEqual(receipt.scheduling.allocations.map(({ totalMin, scheduledMin, estimated }) => ({ totalMin, scheduledMin, estimated })),
    [{ totalMin: 30, scheduledMin: 30, estimated: true }])
  assert.match(receipt.scheduling.notice, /30分钟/u)
  assert.match(receipt.operations[0].summary, /先按30分钟预留/u)
  assert.equal(f.db.getPlanner().blocks[0].end, '18:30')
})

test('automatic batch respects existing locked blocks, DDL and buffers without overlapping', async t => {
  const f = fixture(t, [
    { title: '第二份作业', due: `${DATE}T20:00:00+08:00`, estimateMin: 30 },
    { title: '先截止的作业', due: `${DATE}T18:35:00+08:00`, estimateMin: 30 },
  ])
  const locked = f.db.createTask({ title: '原安排', due: DATE, estimateMin: 20 })
  f.db.updatePlanner({ type: 'save-block', block: { id: 'locked', taskId: locked.id, date: DATE,
    start: '19:30', end: '19:50', locked: true } }, f.db.getPlanner().revision)
  await f.run()
  const blocks = f.db.getPlanner().blocks
  assert.deepEqual(blocks.find(block => block.id === 'locked'), { id: 'locked', taskId: locked.id, date: DATE,
    start: '19:30', end: '19:50', locked: true })
  const byTitle = new Map(f.db.listTasks().map(task => [task.title, blocks.find(block => block.taskId === task.id)]))
  assert.equal(byTitle.get('先截止的作业').start, '18:00')
  assert.equal(byTitle.get('先截止的作业').end, '18:30')
  assert.equal(byTitle.get('第二份作业').start, '18:40')
  assert.equal(byTitle.get('第二份作业').end, '19:10')
})

test('no available time leaves a truthful partial work order and does not manufacture capacity', async t => {
  const f = fixture(t, [{ title: '今天的作业', due: DATE, estimateMin: 30 }])
  f.db.updatePlanner({ type: 'delete-routine', id: 'default-evening-study' }, f.db.getPlanner().revision)
  const result = await f.run()
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(result.execution.status, 'partial')
  assert.match(result.execution.scheduleRequirements[0].reason, /没有足够/u)
  assert.equal(result.execution.scheduleRequirements[0].status, 'pending')
  assert.equal(toolResult(f.requests[1]).scheduling.unscheduled[0].remainingMin, 30)
})

test('explicit record-only instructions and propose mode preserve the calendar', async t => {
  for (const text of ['只记下物理作业，先不安排', '今天18:00–19:00的活动先记录，不要排进日历']) {
    const f = fixture(t, [{ title: '物理作业', due: '2026-09-19' }], text)
    const result = await f.run()
    assert.equal(result.operations.length, 1)
    assert.equal(f.db.getPlanner().blocks.length, 0)
    assert.equal(result.execution.status, 'verified')
  }
  const f = fixture(t, [{ title: '物理作业' }])
  f.db.setPreference('app', { assistant: { autonomy: 'propose' } })
  await f.run()
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('provider reply failure preserves both commits and retry cannot duplicate them', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let count = 0
  const xixi = createXixi({ db, now: () => NOW, complete: async () => {
    if (++count === 1) return call('create_tasks', { tasks: [{ title: '作业', due: '2026-09-19' }] })
    throw new Error('reply failed')
  } })
  const request = input('记下作业明天交')
  const first = await xixi.chat(request)
  assert.equal(first.status, 'completed')
  assert.equal(first.operations.length, 2)
  assert.equal(first.execution.commits.length, 2)
  assert.equal(first.execution.reply.mode, 'fallback')
  assert.match(first.messages.at(-1).content, /先按30分钟预留/u)
  const retry = await xixi.chat(request)
  assert.equal(count, 2)
  assert.equal(retry.operations.length, 2)
  assert.equal(db.getPlanner().blocks.length, 1)
})

test('undoing task creation also removes its associated automatic schedule', async t => {
  const f = fixture(t, [{ title: '作业', due: '2026-09-19' }])
  const result = await f.run()
  const created = result.operations.find(operation => operation.kind !== 'planner')
  const scheduled = result.operations.find(operation => operation.kind === 'planner')
  f.db.undoOperation(created.id)
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.ok(f.db.listOperations({ requestId: result.requestId }).find(operation => operation.id === scheduled.id).undoneAt)
})

test('linked creation undo preserves later manual planner edits and rolls back atomically', async t => {
  const f = fixture(t, [{ title: '作业', due: '2026-09-19' }])
  const result = await f.run()
  const created = result.operations.find(operation => operation.kind !== 'planner')
  const block = f.db.getPlanner().blocks[0]
  f.db.updatePlanner({ type: 'save-block', block: { ...block, start: '18:40', end: '19:10' } }, f.db.getPlanner().revision)
  const before = { planner: f.db.getPlanner(), tasks: f.db.listTasks(), operations: f.db.listOperations() }
  assert.throws(() => f.db.undoOperation(created.id), /新的修改/)
  assert.deepEqual({ planner: f.db.getPlanner(), tasks: f.db.listTasks(), operations: f.db.listOperations() }, before)
})

test('backups retain tasks, automatic plans and work-order receipts without replaying writes on restore', async t => {
  const f = fixture(t, [{ title: '作业', due: '2026-09-19' }])
  const result = await f.run()
  const restored = createDatabase(':memory:'); t.after(() => restored.close())
  restored.importData(f.db.exportData())
  assert.deepEqual(restored.getPlanner().blocks, f.db.getPlanner().blocks)
  const taskData = tasks => tasks.map(({ updatedAt, ...task }) => task)
  assert.deepEqual(taskData(restored.listTasks()), taskData(f.db.listTasks()))
  assert.notEqual(restored.listTasks()[0].updatedAt, f.db.listTasks()[0].updatedAt, 'restore invalidates stale browser versions')
  assert.equal(restored.getTurn(result.requestId).progress.status, 'verified')
  assert.ok(restored.listOperations().every(operation => operation.undoable === false))
})

test('a task starts after the current minute and can split across tomorrow without crossing its DDL', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const requests = []
  const xixi = createXixi({ db, now: () => new Date(`${DATE}T19:40:30+08:00`), complete: async request => {
    requests.push(request)
    return requests.length === 1 ? call('create_tasks', { tasks: [{ title: '两天报告', estimateMin: 45,
      due: '2026-09-19T09:30:00+08:00' }] }) : reply('已按空档分段保存')
  } })
  await xixi.chat(input('记下这份报告'))
  assert.deepEqual(db.getPlanner().blocks.map(({ date, start, end }) => ({ date, start, end })), [
    { date: DATE, start: '19:45', end: '20:00' },
    { date: '2026-09-19', start: '09:00', end: '09:30' },
  ])
  assert.equal(toolResult(requests[1]).scheduling.unscheduled.length, 0)
})

test('insufficient room records exactly the remaining minutes instead of claiming full completion', async t => {
  const f = fixture(t, [{ title: '报告', due: `${DATE}T18:20:00+08:00`, estimateMin: 45 }])
  const result = await f.run()
  assert.equal(f.db.getPlanner().blocks[0].end, '18:20')
  assert.equal(toolResult(f.requests[1]).scheduling.unscheduled[0].remainingMin, 25)
  assert.equal(result.execution.status, 'partial')
  assert.match(result.execution.scheduleRequirements[0].reason, /25 分钟未安排/u)
})

test('negating record-only still automatically schedules, while a separate no-schedule instruction is retained', async t => {
  for (const text of ['不要只记下物理作业，直接安排', '别再只记录，帮我排进空档', '不是只记下，直接安排日历']) {
    const f = fixture(t, [{ title: '物理作业', due: '2026-09-19' }], text)
    const result = await f.run()
    assert.equal(f.db.getPlanner().blocks.length, 1)
    assert.equal(result.operations.length, 2)
  }
  const f = fixture(t, [{ title: '物理作业', due: '2026-09-19' }], '不要只记下标题，详细内容也保存，但先不安排')
  await f.run()
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('a planner commit failure rolls back the paired task creation and leaves no false receipt', async t => {
  const f = fixture(t, [{ title: '不能半途提交的报告', due: '2026-09-19', estimateMin: 30 }])
  f.db.applyPlannerOperation = () => { throw new Error('database write failed') }
  const result = await f.run()
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(result.operations.length, 0)
  assert.equal(toolResult(f.requests[1]).ok, false)
})

test('replaying after undoing a legacy automatic-schedule receipt restores neither task nor schedule', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const request = input('记下作业')
  const args = { tasks: [{ title: '作业', due: '2026-09-19' }] }
  let first = true
  const initial = createXixi({ db, now: () => NOW, complete: async () => {
    if (first) { first = false; return call('create_tasks', args) }
    return reply('已记录')
  } })
  const created = await initial.chat(request)
  const scheduled = created.operations.find(operation => operation.kind === 'planner')
  const undone = db.undoOperation(scheduled.id)
  assert.equal(undone.id, scheduled.parentOperationId, 'legacy schedule undo resolves to its creation')
  assert.equal(db.listTasks().length, 0)
  assert.ok(db.listOperations({ requestId: request.requestId }).every(operation => operation.undoneAt))
  // Reopening simulates interruption before the original completion marker.
  db.finishTurn(request.requestId, { status: 'failed', error: 'interrupted acknowledgement' })
  const requests = []
  const replay = createXixi({ db, now: () => NOW, complete: async payload => {
    requests.push(payload)
    return requests.length === 1 ? call('create_tasks', args) : reply('保留当前状态')
  } })
  await replay.chat(request)
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.getPlanner().blocks.length, 0)
  assert.equal(db.listOperations({ requestId: request.requestId }).length, 2)
  assert.equal(toolResult(requests[1]).ok, false)
  assert.match(toolResult(requests[1]).error, /已经被用户撤销/u)
})

test('a named dorm window is honored rather than taking an earlier school slot', async t => {
  const f = fixture(t, [{ title: '注册 Google 账号', estimateMin: 15 }], '注册 Google 账号记到宿舍时间')
  f.db.updatePlanner({ type: 'save-routine', routine: { id: 'dorm', title: '宿舍', kind: 'available', weekdays: [5],
    start: '20:30', end: '22:30', location: '宿舍', items: [], enabled: true } }, f.db.getPlanner().revision)
  await f.run()
  assert.equal(f.db.getPlanner().blocks[0].start, '20:30')
  assert.equal(f.db.getPlanner().blocks[0].end, '20:45')
})

test('per-task window selection supports a batch and unavailable named windows remain explicit', async t => {
  const f = fixture(t, [
    { title: '校内作业', estimateMin: 30, scheduleWindow: '晚自习' },
    { title: '宿舍作业', estimateMin: 20, scheduleWindow: '宿舍' },
  ], '记下两项任务')
  await f.run()
  const receipt = toolResult(f.requests[1])
  assert.equal(receipt.scheduling.savedPlans.length, 1)
  assert.equal(receipt.scheduling.savedPlans[0].start, '18:00')
  assert.equal(receipt.scheduling.unscheduled[0].title, '宿舍作业')
  assert.match(receipt.scheduling.unscheduled[0].reason, /宿舍/u)
  assert.ok(f.db.listTasks().every(task => !Object.hasOwn(task, 'scheduleWindow')))
})
