import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, XIXI_TOOLS } from '../server/xixi.mjs'
import { createCompanion } from '../server/companion.mjs'

process.env.TZ = 'Asia/Shanghai'
const TODAY = '2026-09-22'
const NOW = new Date(`${TODAY}T10:00:00+08:00`)
const DATES = ['2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-27']
const REQUEST = '接下来这周每一天除了周六，都要安排20分钟sat单词背诵，默认晚自习空闲否则别时段'
const repeat = { from: TODAY, to: '2026-09-27', weekdays: [0, 1, 2, 3, 4, 5], preferredWindow: '晚自习', allowFallback: true }
const draft = patch => ({ title: 'SAT 单词背诵', estimateMin: 20, repeat: { ...repeat }, ...patch })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [
  { id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } },
] } }] })
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const receipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
const input = (text = REQUEST) => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai' } })
const update = (db, action) => db.updatePlanner(action, db.getPlanner().revision)
const routine = (db, id, title, weekdays, start, end) => update(db, { type: 'save-routine', routine: {
  id, title, kind: 'available', weekdays, start, end, location: '', items: [], enabled: true,
} })
function fixture(t, tasks = [draft()]) {
  const db = createDatabase(':memory:'), requests = [], errors = [], responses = [tool('create_tasks', { tasks }), reply('按实际保存的日期确认')]
  t.after(() => db.close())
  const xixi = createXixi({ db, now: () => NOW, complete: async request => {
    requests.push(request)
    const response = responses.shift() ?? reply('按实际保存的日期确认')
    if (response instanceof Error) throw response
    try { return typeof response === 'function' ? response(request) : response }
    catch (error) { errors.push(error); throw error }
  } })
  return { db, requests, responses, xixi, async run(request = input()) {
    const result = await xixi.chat(request)
    assert.deepEqual(errors, [], 'provider assertions must not be swallowed as model failures')
    return result
  } }
}
const satTasks = db => db.listTasks().filter(task => task.occurrence)
const occupied = (db, date, start, end) => {
  const task = db.createTask({ title: `已有安排 ${date}`, estimateMin: 120 })
  update(db, { type: 'save-block', block: { id: randomUUID(), taskId: task.id, date, start, end, locked: true } })
}
const blocks = db => db.getPlanner().blocks.filter(block => db.getTask(block.taskId)?.occurrence)

test('weekly daily request expands Tuesday through Sunday except Saturday into five dated 20 minute instances', async t => {
  const f = fixture(t)
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(satTasks(f.db).length, 5)
  assert.equal(new Set(satTasks(f.db).map(task => task.occurrence.seriesId)).size, 1)
  assert.deepEqual(satTasks(f.db).map(task => task.occurrence.date).sort(), DATES)
  assert.ok(satTasks(f.db).every(task => task.startAt === task.occurrence.date && task.due === undefined))
  assert.deepEqual(blocks(f.db).map(block => block.date).sort(), DATES)
  for (const task of satTasks(f.db)) {
    const placed = blocks(f.db).filter(block => block.taskId === task.id)
    assert.equal(placed.length, 1)
    assert.equal(placed[0].date, task.occurrence.date)
    assert.equal(Date.parse(`${placed[0].date}T${placed[0].end}:00`) - Date.parse(`${placed[0].date}T${placed[0].start}:00`), 20 * 60000)
  }
  const scheduling = receipt(f.requests[1]).scheduling
  assert.deepEqual(scheduling.recurrence, { requestedDates: DATES, scheduledDates: DATES, unscheduledDates: [] })
  assert.equal(scheduling.allocations.find(item => item.date === '2026-09-27').fallback, true)
  assert.match(result.operations.find(operation => operation.kind !== 'planner').summary, /创建 5 项事项/u)
})

test('structured repeat works without any matching user prose and schema exposes date/weekday/window semantics', async t => {
  const f = fixture(t)
  await f.run(input('执行这份计划'))
  assert.deepEqual(blocks(f.db).map(block => block.date).sort(), DATES)
  const schema = XIXI_TOOLS.find(tool => tool.function.name === 'create_tasks').function.parameters.properties.tasks.items.properties.repeat
  assert.deepEqual(schema.required, ['from', 'to', 'weekdays', 'allowFallback'])
  assert.deepEqual(schema.properties.placement.enum, ['start', 'end'])
})

test('prefer evening end, fall back to the closest complete same-day slot, preserve occupied blocks', async t => {
  const f = fixture(t, [draft({ repeat: { ...repeat, placement: 'end' } })])
  routine(f.db, 'afternoon', '下午空档', [1, 2, 3, 4, 5], '17:00', '18:00')
  routine(f.db, 'dorm', '宿舍', [1, 2, 3, 4, 5], '20:30', '22:30')
  occupied(f.db, '2026-09-23', '18:00', '20:00')
  const before = f.db.getPlanner().blocks[0]
  await f.run()
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === before.id), before)
  assert.deepEqual(blocks(f.db).filter(block => block.date === TODAY).map(({ start, end }) => ({ start, end })), [{ start: '19:40', end: '20:00' }])
  assert.deepEqual(blocks(f.db).filter(block => block.date === '2026-09-23').map(({ start, end }) => ({ start, end })), [{ start: '20:30', end: '20:50' }])
  assert.equal(receipt(f.requests[1]).scheduling.allocations.find(item => item.date === '2026-09-23').fallback, true)
})

test('fragmented or full days remain specifically unscheduled, never split or push a second instance into tomorrow', async t => {
  const f = fixture(t, [draft({ repeat: { ...repeat, from: TODAY, to: '2026-09-23' } })])
  update(f.db, { type: 'delete-routine', id: 'default-evening-study' })
  routine(f.db, 'tue-a', '晚自习', [2], '18:00', '18:10')
  routine(f.db, 'tue-b', '晚自习', [2], '18:20', '18:30')
  routine(f.db, 'wed', '晚自习', [3], '18:00', '20:00')
  const result = await f.run()
  assert.equal(result.execution.status, 'partial')
  assert.deepEqual(blocks(f.db).map(block => block.date), ['2026-09-23'])
  const scheduling = receipt(f.requests[1]).scheduling
  assert.equal(scheduling.unscheduled.length, 1)
  assert.equal(scheduling.unscheduled[0].date, TODAY)
  assert.equal(scheduling.unscheduled[0].remainingMin, 20)
  assert.deepEqual(scheduling.recurrence.unscheduledDates, [TODAY])
  assert.match(scheduling.unscheduled[0].reason, /当天.*完整 20 分钟/u)
})

test('unavailable required evening does not silently fall back even when Sunday has another large window', async t => {
  const f = fixture(t, [draft({ repeat: { ...repeat, from: '2026-09-27', allowFallback: false } })])
  await f.run()
  assert.equal(satTasks(f.db).length, 1)
  assert.equal(blocks(f.db).length, 0)
  assert.equal(receipt(f.requests[1]).scheduling.unscheduled[0].date, '2026-09-27')
})

test('six identical undated drafts are rejected before writes rather than pooled as six unrelated chunks', async t => {
  const f = fixture(t, Array.from({ length: 6 }, () => ({ title: 'SAT 单词背诵', estimateMin: 20 })))
  await f.run()
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.match(receipt(f.requests[1]).error, /repeat/u)
})

test('repeat expansion validates weekday/date ranges and per-occurrence minutes atomically', async t => {
  for (const task of [
    draft({ estimateMin: undefined }),
    draft({ repeat: { ...repeat, weekdays: [2, 2] } }),
    draft({ repeat: { ...repeat, from: '2026-09-21' } }),
    draft({ repeat: { ...repeat, to: '2026-12-31' } }),
    draft({ repeat: { ...repeat, to: TODAY, weekdays: [6] } }),
    draft({ startAt: TODAY }),
  ]) {
    const f = fixture(t, [{ title: '也不能部分创建' }, task])
    await f.run()
    assert.equal(f.db.listTasks().length, 0)
    assert.equal(f.db.getPlanner().blocks.length, 0)
    assert.equal(receipt(f.requests[1]).ok, false)
  }
})

test('replay, backup import and undo preserve instance identity and remove only the generated series', async t => {
  const f = fixture(t), request = input()
  const first = await f.run(request)
  const ids = satTasks(f.db).map(task => task.id).sort()
  const replay = await f.run(request)
  assert.equal(f.requests.length, 2)
  assert.deepEqual(satTasks(f.db).map(task => task.id).sort(), ids)
  assert.equal(replay.operations.length, 2)
  const other = createDatabase(':memory:'); t.after(() => other.close())
  other.importData(f.db.exportData())
  assert.deepEqual(satTasks(other).map(task => task.occurrence).sort((a, b) => a.date.localeCompare(b.date)), satTasks(f.db).map(task => task.occurrence).sort((a, b) => a.date.localeCompare(b.date)))
  assert.deepEqual(blocks(other).map(block => block.date).sort(), DATES)
  f.db.undoOperation(first.operations.find(operation => operation.kind !== 'planner').id)
  assert.equal(satTasks(f.db).length, 0)
  assert.equal(blocks(f.db).length, 0)
})

test('shared planner validation rejects wrong-day moves, split sessions and duplicate instances', async t => {
  const f = fixture(t)
  await f.run()
  const block = blocks(f.db).find(block => block.date === TODAY)
  const before = f.db.getPlanner()
  for (const patch of [{ date: '2026-09-23', start: '19:00', end: '19:20' }, { id: 'extra-copy', start: '19:00', end: '19:20' }]) {
    assert.throws(() => update(f.db, { type: 'save-block', block: { ...block, ...patch } }), /重复事项/u)
    assert.deepEqual(f.db.getPlanner(), before)
  }
})

test('an explicitly corrected occurrence date remains editable through update_task then its original plan ID', async t => {
  const f = fixture(t, [draft({ repeat: { ...repeat, to: TODAY } })])
  await f.run()
  const task = satTasks(f.db)[0], block = blocks(f.db)[0]
  f.responses.push(tool('update_task', { taskId: task.id, expectedUpdatedAt: task.updatedAt, patch: { occurrenceDate: '2026-09-23' } }),
    tool('read_planner', { date: TODAY, days: 2 }), request => tool('plan_tasks', { expectedRevision: receipt(request).revision,
      plans: [{ id: block.id, taskId: task.id, date: '2026-09-23', start: '18:00', end: '18:20' }] }), reply('已改期'))
  await f.run(input('今天这次单词背诵改到明天，保留二十分钟'))
  assert.equal(f.db.getTask(task.id).occurrence.date, '2026-09-23')
  assert.equal(f.db.getTask(task.id).startAt, '2026-09-23')
  assert.equal(blocks(f.db)[0].id, block.id)
  assert.equal(blocks(f.db)[0].date, '2026-09-23')
})

test('generic companion rebalancing retains daily instances instead of re-pooling their time', async t => {
  const f = fixture(t)
  await f.run()
  const before = blocks(f.db)
  const companion = createCompanion({ db: f.db, now: () => NOW })
  const scenario = companion.previewScenario({ date: TODAY, days: 6, mode: 'rebalance' })
  assert.equal(scenario.plans.length, 0)
  assert.equal(scenario.removedBlockIds.length, 0)
  assert.deepEqual(blocks(f.db), before)
  assert.ok(scenario.warnings.some(message => message.includes('每日安排')))
})
