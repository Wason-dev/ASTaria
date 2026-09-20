import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-20'
const TEXT = '这周特殊，明天周天上平时周四的课，你直接帮我记了'
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const receipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
const read = () => tool('read_planner', { date: DATE })
function fixture(t) {
  const db = createDatabase(':memory:'), responses = []
  t.after(() => db.close())
  const save = routine => db.updatePlanner({ type: 'save-routine', routine }, db.getPlanner().revision)
  const routine = { id: 'thursday-class', title: '周四物理', kind: 'class', weekdays: [4], start: '09:00', end: '10:00', location: '物理教室', items: ['实验手册'], enabled: true }
  save(routine)
  save({ ...routine, id: 'thursday-free', title: '自主学习', kind: 'available', start: '10:00', end: '12:00', items: [] })
  const xixi = createXixi({ db, now: () => new Date('2026-09-19T21:00:00+08:00'), complete: async request => {
    const next = responses.shift()
    assert.ok(next, 'unexpected provider call')
    return typeof next === 'function' ? next(request) : next
  } })
  const input = (text = TEXT, context = {}) => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', page: 'home', ...context } })
  const set = revision => tool('set_day_timetable', { date: DATE, sourceWeekday: 4, expectedRevision: revision, evidence: TEXT })
  return { db, responses, xixi, input, set }
}

test('Xixi applies Sunday-to-Thursday to real schedule, reports collisions, and can undo', async t => {
  const f = fixture(t), task = f.db.createTask({ title: '原定周日任务', due: DATE, estimateMin: 30 })
  f.db.updatePlanner({ type: 'save-block', block: { id: 'sunday-task', taskId: task.id, date: DATE, start: '09:00', end: '09:30', locked: true } }, f.db.getPlanner().revision)
  const before = f.db.getPlanner()
  f.responses.push(read(), request => {
    const data = receipt(request)
    assert.equal(data.weeklyTemplates.find(item => item.weekday === 4).classCount, 1)
    assert.equal(data.days[0].capacity.totalMin, 780)
    return f.set(data.revision)
  }, request => {
    const data = receipt(request)
    assert.equal(data.ok, true)
    assert.equal(data.day.dayOverride.sourceWeekday, 4)
    assert.equal(data.day.capacity.totalMin, 240)
    assert.deepEqual(data.day.capacity.conflicts, ['sunday-task'])
    assert.ok(data.day.routines.items.some(item => item.title === '周四物理'))
    assert.ok(data.day.carry.items.some(item => item.label === '实验手册'))
    assert.match(data.operation.summary, /仅当天生效/)
    return reply('明天已改成周四课表，仅这一天；原有任务与物理课冲突，需要调整')
  })
  const result = await f.xixi.chat(f.input())
  assert.equal(result.status, 'completed')
  assert.equal(result.operations.length, 1)
  assert.deepEqual(f.db.getPlanner().routines, before.routines)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.equal(f.db.listMemories().length, 0)
  f.db.undoOperation(result.operations[0].id)
  assert.deepEqual(f.db.getPlanner().dayOverrides, before.dayOverrides)
})

test('Xixi restores a day override from the latest read', async t => {
  const f = fixture(t), text = '明天恢复原课表'
  f.db.updatePlanner({ type: 'set-day-template', date: DATE, sourceWeekday: 4 }, f.db.getPlanner().revision)
  f.responses.push(read(), request => {
    assert.equal(receipt(request).days[0].dayOverride.sourceWeekday, 4)
    return tool('restore_day_timetable', { date: DATE, expectedRevision: receipt(request).revision, evidence: text })
  }, request => {
    assert.equal(receipt(request).ok, true)
    assert.equal(receipt(request).day.dayOverride, null)
    assert.equal(receipt(request).day.capacity.totalMin, 780)
    return reply('明天恢复原课表了')
  })
  assert.equal((await f.xixi.chat(f.input(text))).status, 'completed')
  assert.equal(f.db.getPlanner().dayOverrides[DATE], undefined)
})

for (const invalid of ['unread', 'timezone', 'evidence', 'missing-template', 'propose']) {
  test(`day timetable rejects ${invalid} without changing schedule`, async t => {
    const f = fixture(t)
    if (invalid === 'propose') f.db.setPreference('app', { assistant: { autonomy: 'propose' } })
    if (invalid !== 'unread') f.responses.push(read())
    const before = f.db.getPlanner()
    f.responses.push(() => tool('set_day_timetable', { date: DATE, sourceWeekday: invalid === 'missing-template' ? 2 : 4,
      expectedRevision: before.revision, evidence: invalid === 'evidence' ? '编造的调课依据' : TEXT }), request => {
      const outcome = receipt(request)
      assert.equal(outcome.ok, false)
      assert.match(outcome.error, { unread: /read_planner/, timezone: /时区/, evidence: /原话/, 'missing-template': /课/, propose: /先提议/ }[invalid])
      return reply('需要补充或核对后再调整')
    })
    const result = await f.xixi.chat(f.input(TEXT, invalid === 'timezone' ? { timezone: 'UTC' } : {}))
    assert.equal(result.status, 'completed')
    assert.equal(result.operations.length, 0)
    assert.deepEqual(f.db.getPlanner(), before)
  })
}
