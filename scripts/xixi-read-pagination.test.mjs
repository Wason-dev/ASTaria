import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-22'
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const receipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
function fixture(t) {
  const db = createDatabase(':memory:'), responses = [], requests = [], errors = []
  t.after(() => db.close())
  const xixi = createXixi({ db, now: () => new Date(`${DATE}T07:00:00+08:00`), complete: async request => {
    requests.push(request)
    try { const response = responses.shift(); return (typeof response === 'function' ? response(request) : response) ?? { choices: [{ message: { role: 'assistant', content: '已读取' } }] } }
    catch (error) { errors.push(error); throw error }
  } })
  return { db, responses, requests, async run() {
    const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '读取安排', context: { timezone: 'Asia/Shanghai' } })
    assert.deepEqual(errors, [])
    assert.equal(result.status, 'completed')
    return result
  } }
}
const clock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const routine = (db, index, items = []) => db.updatePlanner({ type: 'save-routine', routine: { id: `school-${index}`, title: `课程${index}`,
  kind: 'class', weekdays: [0, 1, 2, 3, 4, 5, 6], start: clock(480 + index * 10), end: clock(489 + index * 10),
  location: '508', items, enabled: true } }, db.getPlanner().revision)

test('seven-day planner read retains each full normal school day and named evening windows', async t => {
  const f = fixture(t)
  for (let index = 0; index < 16; index++) routine(f.db, index)
  f.responses.push(tool('read_planner', { date: DATE, days: 7 }), request => {
    const data = receipt(request)
    assert.equal(data.days.length, 7)
    for (const view of data.days) {
      assert.equal(view.routines.truncated, false)
      assert.equal(view.routines.items.filter(row => row.kind === 'class').length, 16)
      assert.ok(view.routines.items.some(row => row.id === 'school-15'))
      assert.ok(view.availabilityWindows.items.some(row => row.remainingMinutes > 0))
    }
  })
  await f.run()
})

test('planner overflow provides concrete section/offset continuation and complete detail rows', async t => {
  const f = fixture(t), materials = Array.from({ length: 18 }, (_, index) => `材料${index}`)
  for (let index = 0; index < 42; index++) routine(f.db, index, index === 0 ? materials : [])
  const ids = new Set()
  f.responses.push(tool('read_planner', { date: DATE }), request => {
    const page = receipt(request).days[0].routines
    assert.equal(page.truncated, true)
    assert.ok(page.nextOffset > 0)
    page.items.forEach(row => ids.add(row.id))
    const { tool: name, ...args } = page.readMore
    assert.equal(args.section, 'routines')
    return tool(name, args)
  }, request => {
    const page = receipt(request).days[0].routines
    page.items.forEach(row => ids.add(row.id))
    assert.equal(page.nextOffset, null)
    assert.equal(ids.size, 43)
    return tool('read_planner', { date: DATE, section: 'routines', offset: 0, limit: 1 })
  }, request => {
    const row = receipt(request).days[0].routines.items[0]
    assert.deepEqual(row.items, materials)
  })
  await f.run()
})

test('read_tasks can page past the former twelve-task limit and retrieve complete notes by id', async t => {
  const f = fixture(t), expected = []
  for (let index = 0; index < 28; index++) expected.push(f.db.createTask({ title: `分页事项${index}`, notes: index === 0 ? '完整备注'.repeat(250) : '' }))
  const ids = new Set()
  f.responses.push(tool('read_tasks', { query: '分页事项', limit: 15 }), request => {
    const page = receipt(request)
    assert.equal(page.count, 28)
    assert.equal(page.truncated, true)
    assert.equal(page.nextOffset, 15)
    page.tasks.forEach(task => ids.add(task.id))
    const { tool: name, ...args } = page.readMore
    return tool(name, args)
  }, request => {
    const page = receipt(request)
    page.tasks.forEach(task => ids.add(task.id))
    assert.equal(page.nextOffset, null)
    assert.equal(ids.size, 28)
    return tool('read_tasks', { taskId: expected[0].id })
  }, request => assert.equal(receipt(request).tasks[0].notes, expected[0].notes))
  await f.run()
})
