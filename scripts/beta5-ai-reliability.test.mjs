import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { contextUnits, fitContext } from '../server/contextBudget.mjs'
import { createCompanion } from '../server/companion.mjs'
import { readCompletionStream } from '../server/completionStream.mjs'
import { createWorkOrder } from '../server/workOrder.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-29'
const now = () => new Date(`${DATE}T07:00:00+08:00`)
const call = (name, args, id = randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
const response = message => ({ choices: [{ message: { role: 'assistant', ...message } }] })
const input = text => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', date: DATE } })
function assertPairs(messages) {
  for (let index = 0; index < messages.length; index++) {
    const calls = messages[index].tool_calls
    if (!calls) continue
    const results = messages.slice(index + 1, index + 1 + calls.length)
    assert.deepEqual(results.map(message => message.tool_call_id).sort(), calls.map(tool => tool.id).sort())
    assert.ok(results.every(message => message.role === 'tool'))
  }
  for (const message of messages.filter(message => message.role === 'tool')) {
    assert.ok(messages.some(other => other.tool_calls?.some(tool => tool.id === message.tool_call_id)))
  }
}

for (const thinking of [false, true]) test(`20 distinct large reads survive a retry without losing originals or native pairs; thinking=${thinking}`, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  db.setPreference('model-connection', { contextBudget: { mode: 'custom', maxUnits: 24_000 } })
  const tasks = Array.from({ length: 20 }, (_, i) => db.createTask({ title: `资料${i}`, notes: `${i}原文${'详细资料'.repeat(480)}` }))
  const request = input('依次核对这些资料，先不要修改或安排')
  let step = 0, interrupted = false
  const requests = []
  const xixi = createXixi({ db, now, complete: async payload => {
    requests.push(payload)
    assert.ok(contextUnits(payload.messages) + contextUnits(payload.tools ?? []) <= 24_000)
    assertPairs(payload.messages)
    assert.equal(payload.messages.findLast(message => message.role === 'user').content, request.text)
    if (step === 20 && !interrupted) { interrupted = true; throw new Error('temporary provider failure') }
    if (step === 20) return response({ content: '资料已核对' })
    return response({ content: '', ...(thinking ? { reasoning_content: ` \n读取第${step}份资料\t ` } : {}),
      tool_calls: [call('read_tasks', { taskId: tasks[step++].id })] })
  } })
  assert.equal((await xixi.chat(request)).status, 'failed')
  const result = await xixi.chat(request)
  assert.equal(result.status, 'completed', `${result.error}; completed reads=${step}; payload units=${contextUnits(requests.at(-1))}`)
  assert.ok(requests.some(payload => payload.messages.some(message => message.content?.startsWith('本轮较早的完整工具轮次'))))
  const originals = db.listMessages('main', { limit: 160 }).filter(message => message.role === 'tool')
  assert.equal(originals.length, 20)
  assert.ok(originals.every(message => JSON.parse(message.content).tasks[0].notes.includes('详细资料'.repeat(480))))
  const latest = requests.at(-1).messages.findLast(message => message.role === 'tool')
  assert.equal(JSON.parse(latest.content).tasks[0].notes, tasks.at(-1).notes)
  if (thinking) assert.equal(requests.at(-1).messages.findLast(message => message.tool_calls)?.reasoning_content, ' \n读取第19份资料\t ')
})

test('successful read recovery only resolves the exact failed intent', () => {
  const order = createWorkOrder({ requestId: 'recovery', conversationId: 'main' })
  const first = order.step('a', 'read_tasks', 'intent-a'), other = order.step('b', 'read_tasks', 'intent-b')
  order.fail(first, '批次未执行'); order.fail(other, '另一项未执行')
  order.succeed(order.step('a-retry', 'read_tasks', 'intent-a'))
  assert.deepEqual(order.value.failures.map(item => item.stepId), [other.id])
  assert.equal(first.status, 'recovered')
  assert.equal(other.status, 'failed')
  assert.equal(order.verify(), 'failed')
})

test('rejected writes retry once per intent and recover even if the final model acknowledgment fails', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const writes = Array.from({ length: 9 }, (_, i) => call('create_tasks', { tasks: [{ title: `保存事项${i}` }] }))
  let round = 0
  const xixi = createXixi({ db, now, complete: async payload => {
    assertPairs(payload.messages)
    if (round++ === 0) return response({ content: '', tool_calls: writes })
    if (round === 2) {
      assert.equal(db.listTasks().length, 0)
      return response({ content: '', tool_calls: writes.slice(0, 8).map(tool => ({ ...tool, id: randomUUID() })) })
    }
    if (round === 3) return response({ content: '', tool_calls: [writes[8], writes[0]].map(tool => ({ ...tool, id: randomUUID() })) })
    throw new Error('provider disconnected after commits')
  } })
  const result = await xixi.chat(input('这九件事只记录，先不安排'))
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.execution.failures.length, 0)
  assert.equal(result.execution.commits.length, 9)
  assert.equal(db.listTasks().length, 9)
  assert.equal(db.listOperations().length, 9)
  assert.equal(db.getPlanner().blocks.length, 0)
})

test('capacity compaction retains exact visible ranges and explicit complete-detail pagination', () => {
  const ranges = Array.from({ length: 240 }, (_, i) => ({ start: i * 5, end: i * 5 + 2 }))
  const c = call('read_planner', { date: DATE, days: 7 })
  const days = Array.from({ length: 7 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`,
    capacity: { available: ranges, free: ranges, remaining: ranges, totalMin: 480, remainingMin: 480, conflicts: [] } }))
  const messages = [{ role: 'user', content: '读取安排' }, { role: 'assistant', content: '', tool_calls: [c] },
    { role: 'tool', tool_call_id: c.id, content: JSON.stringify({ type: 'planner_read', revision: 3, days }) }]
  const fitted = fitContext(messages, [], 6000)
  const result = JSON.parse(fitted.at(-1).content)
  assert.equal(result.revision, 3)
  for (const day of result.days) {
    assert.deepEqual(day.capacity.remaining, ranges.slice(0, 16))
    assert.equal(day.capacity.remainingMin, 480)
    assert.equal(day.capacity.rangeCounts.remaining, 240)
    assert.equal(day.capacity.truncated, true)
    assert.deepEqual(day.capacityReadMore, { tool: 'read_planner', date: day.date, section: 'capacity', offset: 0 })
  }
})

test('direct plan_tasks cannot bypass an explicit record-only request', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const task = db.createTask({ title: '物理作业', estimateMin: 30 })
  const before = db.getPlanner(), replies = [
    response({ content: '', tool_calls: [call('read_planner', { date: DATE })] }),
    response({ content: '', tool_calls: [call('plan_tasks', { expectedRevision: before.revision,
      plans: [{ taskId: task.id, date: DATE, start: '18:00', end: '18:30' }] })] }),
    response({ content: '仅保留记录' }),
  ]
  await createXixi({ db, now, complete: async () => replies.shift() }).chat(input('物理作业只记录，先不安排'))
  assert.deepEqual(db.getPlanner(), before)
  assert.equal(db.listOperations().length, 0)
  const outcome = db.listMessages('main').filter(message => message.role === 'tool').at(-1)
  assert.equal(JSON.parse(outcome.content).ok, false)
  assert.match(outcome.content, /只记录/)
})

test('stored opportunity confirmation survives the environment snapshot', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const companion = createCompanion({ db, now })
  companion.saveWish({ content: '画画', evidence: '画画', items: [], minutes: 30 })
  const snapshots = []
  await createXixi({ db, now, complete: async payload => {
    snapshots.push(JSON.parse(payload.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n')))
    return response({ content: '你好' })
  } }).chat(input('你好'))
  assert.ok(snapshots[0].companion.opportunities.some(item => item.needsConfirmation === true))
  assert.equal(db.getPlanner().blocks.length, 0)
})

test('a nine-call batch receives paired rejection results and can retry in smaller batches', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const tasks = Array.from({ length: 9 }, (_, i) => db.createTask({ title: `事项${i}` }))
  const readCalls = tasks.map(task => call('read_tasks', { taskId: task.id }))
  let round = 0
  const xixi = createXixi({ db, now, complete: async payload => {
    assertPairs(payload.messages)
    if (round++ === 0) return response({ content: '', tool_calls: readCalls })
    if (round === 2) {
      const outcomes = payload.messages.filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
      assert.equal(outcomes.length, 9)
      assert.ok(outcomes.every(outcome => outcome.ok === false && outcome.error.includes('均未执行')))
      return response({ content: '', tool_calls: readCalls.slice(0, 8).map(tool => ({ ...tool, id: randomUUID() })) })
    }
    if (round === 3) return response({ content: '', tool_calls: [{ ...readCalls[8], id: randomUUID() }] })
    return response({ content: '读取完成' })
  } })
  const result = await xixi.chat(input('读取这九件事'))
  assert.equal(result.status, 'completed', result.error)
  assert.equal(result.execution.failures.length, 0)
})

test('missing native call IDs are reported as a format failure rather than a tool limit', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const xixi = createXixi({ db, now, complete: async () => response({ content: '', tool_calls: [call('create_tasks', { tasks: [{ title: '不应创建' }] }, '')] }) })
  const result = await xixi.chat(input('只记录不应创建'))
  assert.equal(result.status, 'failed')
  assert.match(result.error, /格式/)
  assert.doesNotMatch(result.error, /步骤未完成|额度|上限/)
  assert.equal(db.listTasks().length, 0)
})

test('successful stream flushes a literal less-than tail and ignores frames after DONE', async () => {
  const emitted = [], text = '比较 x < 5'
  const frame = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`
  const raw = [
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]',
    { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'late', function: { name: 'create_tasks', arguments: '{}' } }] } }] },
  ].map(frame).join('')
  const result = await readCompletionStream(new Response(raw), { maxBytes: 10000, onDelta: delta => emitted.push(delta) })
  assert.equal(result.choices[0].message.content, text)
  assert.equal(result.choices[0].message.tool_calls, undefined)
  assert.equal(emitted.map(delta => delta.delta).join(''), text)
})
