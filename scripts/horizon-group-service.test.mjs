import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { localDay } from '../src/home/agenda.ts'

const resultOf = groups => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify({ groups }) } }] })
const dateOffset = offset => { const date = new Date(); date.setDate(date.getDate() + offset); return localDay(date) }
const itemIds = groups => groups.flatMap(group => group.tasks.map(task => task.id)).sort()
const draftInput = snapshot => ({ date: snapshot.date, expectedRevision: snapshot.revision, snapshotKey: snapshot.snapshotKey, requestId: randomUUID() })
const readEvents = raw => raw.split(/\r?\n\r?\n/u).filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)))

async function fixture(t, { answer, duringComplete } = {}) {
  const db = createDatabase(':memory:'), date = dateOffset(0), tomorrow = dateOffset(1), later = dateOffset(2)
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const routine of db.getPlanner().routines) edit({ type: 'delete-routine', id: routine.id })
  edit({ type: 'save-routine', routine: { id: 'test-free', title: '测试空档', kind: 'available', weekdays: [0, 1, 2, 3, 4, 5, 6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
  const titles = ['复习三角函数', '完成三角函数习题', '整理物理实验记录', '修复网站导航']
  const tasks = titles.map(title => db.createTask({ title }))
  for (const [index, task] of tasks.entries()) edit({ type: 'save-block', block: { id: `group-http-${index}`, taskId: task.id,
    date: index === 3 ? later : tomorrow, start: `${10 + index}:00`, end: `${10 + index}:30`, locked: false } })
  const proposed = [
    { title: '三角函数复习与练习', day: 1, itemIds: ['group-http-0', 'group-http-1'] },
    { title: '物理实验收尾', day: 1, itemIds: ['group-http-2'] },
    { title: '网站维护', day: 2, itemIds: ['group-http-3'] },
  ]
  const calls = []
  const complete = async (payload, options) => {
    calls.push({ payload, purpose: options.purpose })
    options.onDelta?.({ type: 'reasoning', delta: 'TEST_PRIVATE_REASONING_NEVER_DISPLAY' })
    options.onDelta?.({ type: 'content', delta: '{"groups":[' })
    await duringComplete?.({ db, edit, tasks })
    return answer ? answer({ payload, proposed }) : resultOf(proposed)
  }
  const service = createLocalService({ db, vault: { status: async () => true }, complete })
  const server = createServer((req, res) => service.middleware(req, res, () => { res.statusCode = 404; res.end('not found') }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
    await service.whenIdle()
    service.close()
  })
  const request = async (path, body, stream = false) => {
    const response = await fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Astaria-Local': '1', Origin: base, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(stream ? { Accept: 'text/event-stream' } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const raw = await response.text()
    return { status: response.status, headers: response.headers, raw, ...(stream ? { events: readEvents(raw) } : { value: JSON.parse(raw) }) }
  }
  const snapshot = async () => {
    const read = await request(`/companion/horizon-order?date=${date}`)
    assert.equal(read.status, 200)
    return read.value
  }
  return { db, edit, tasks, proposed, calls, request, snapshot, date }
}

test('real GET snapshot and POST grouping route return complete suggestions without changing the planner', async t => {
  const f = await fixture(t), before = f.db.getPlanner(), tasksBefore = f.db.listTasks(), operationsBefore = f.db.listOperations()
  const snapshot = await f.snapshot()
  assert.equal(snapshot.days, 3); assert.equal(snapshot.date, f.date)
  assert.match(snapshot.snapshotKey, /^[a-f0-9]{64}$/u)
  assert.deepEqual(itemIds(snapshot.groups), ['group-http-0', 'group-http-1', 'group-http-2', 'group-http-3'])
  const response = await f.request('/companion/horizon-groups', draftInput(snapshot))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/u)
  assert.equal(response.value.snapshotKey, snapshot.snapshotKey)
  assert.deepEqual(response.value.groups.map(group => ({ title: group.title, day: group.day, itemIds: group.tasks.map(task => task.id) })), f.proposed)
  assert.deepEqual(itemIds(response.value.groups), itemIds(snapshot.groups))
  assert.ok(response.value.groups.every(group => /^horizon-group-[a-f0-9]{24}$/u.test(group.id)))
  assert.ok(response.value.groups.every(group => group.tasks.every(task => typeof task.title === 'string' && task.minutes === 30)))
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].purpose, 'horizon-grouping')
  const context = JSON.parse(f.calls[0].payload.messages.at(-1).content)
  assert.equal(context.items.length, 4)
  assert.deepEqual(f.db.getPlanner(), before); assert.deepEqual(f.db.listTasks(), tasksBefore); assert.deepEqual(f.db.listOperations(), operationsBefore)
  assert.deepEqual((await f.snapshot()).groups, snapshot.groups, 'a grouping suggestion is only a draft until explicitly saved')
})

test('SSE emits nested real activity objects and a full terminal result without exposing reasoning', async t => {
  const f = await fixture(t), snapshot = await f.snapshot(), before = f.db.getPlanner()
  const response = await f.request('/companion/horizon-groups', draftInput(snapshot), true)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/u)
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const phases = response.events.filter(event => event.type === 'phase').map(event => event.phase)
  assert.deepEqual(phases, ['checking', 'preparing', 'waiting', 'thinking', 'receiving', 'validating'])
  const activities = response.events.filter(event => event.type === 'activity')
  assert.ok(activities.length >= 6)
  for (const event of activities) {
    assert.equal(event.title, undefined, 'activity metadata stays in the expected nested envelope')
    assert.equal(typeof event.activity.id, 'string'); assert.equal(typeof event.activity.title, 'string')
    assert.ok(['local', 'model'].includes(event.activity.source))
    assert.ok(['running', 'done', 'proposed'].includes(event.activity.state))
  }
  assert.ok(activities.some(event => event.activity.id === 'group-semantics' && event.activity.state === 'running'))
  const proposals = activities.filter(event => event.activity.state === 'proposed').map(event => event.activity)
  assert.deepEqual(proposals.map(activity => activity.title), f.proposed.map(group => group.title))
  assert.deepEqual(proposals.map(activity => activity.itemIds), f.proposed.map(group => group.itemIds))
  const terminal = response.events.at(-1)
  assert.equal(terminal.type, 'result'); assert.equal(terminal.result.snapshotKey, snapshot.snapshotKey)
  assert.deepEqual(itemIds(terminal.result.groups), itemIds(snapshot.groups))
  assert.equal(response.events.filter(event => event.type === 'result').length, 1)
  assert.doesNotMatch(response.raw, /TEST_PRIVATE_REASONING_NEVER_DISPLAY|reasoning_content|"delta"/u)
  assert.deepEqual(f.db.getPlanner(), before); assert.equal(f.db.listOperations().length, 0)
})

test('stale snapshot errors use HTTP 409 or the SSE error envelope without calling the model', async t => {
  const f = await fixture(t), snapshot = await f.snapshot(), input = draftInput(snapshot)
  const original = f.db.getPlanner().blocks.find(block => block.id === 'group-http-0')
  f.edit({ type: 'save-block', block: { ...original, start: '10:10', end: '10:40' } })
  const changed = f.db.getPlanner()
  const json = await f.request('/companion/horizon-groups', input)
  assert.equal(json.status, 409); assert.match(json.value.error, /日程已变化/u)
  const streamed = await f.request('/companion/horizon-groups', { ...input, requestId: randomUUID() }, true)
  assert.equal(streamed.status, 200)
  assert.deepEqual(streamed.events.map(event => event.type), ['error'])
  assert.equal(streamed.events[0].status, 409); assert.match(streamed.events[0].error, /日程已变化/u)
  assert.equal(f.calls.length, 0); assert.deepEqual(f.db.getPlanner(), changed)
})

test('a concurrent planner change discards late model grouping and emits no successful result', async t => {
  let concurrentlyChanged
  const f = await fixture(t, { duringComplete: ({ db, edit }) => {
    const original = db.getPlanner().blocks.find(block => block.id === 'group-http-0')
    edit({ type: 'save-block', block: { ...original, start: '10:05', end: '10:35' } })
    concurrentlyChanged = db.getPlanner()
  } })
  const snapshot = await f.snapshot()
  const response = await f.request('/companion/horizon-groups', draftInput(snapshot), true)
  assert.equal(f.calls.length, 1)
  assert.equal(response.events.at(-1).type, 'error'); assert.equal(response.events.at(-1).status, 409)
  assert.ok(!response.events.some(event => event.type === 'result'))
  assert.ok(!response.events.some(event => event.type === 'activity' && event.activity.state === 'proposed'))
  assert.deepEqual(f.db.getPlanner(), concurrentlyChanged, 'only the deliberate concurrent edit remains')
  assert.equal(f.db.listOperations().length, 0)
})

test('cached grouping travels through the same SSE result contract without another model call', async t => {
  const f = await fixture(t), snapshot = await f.snapshot(), before = f.db.getPlanner()
  const first = await f.request('/companion/horizon-groups', draftInput(snapshot))
  const cached = await f.request('/companion/horizon-groups', draftInput(snapshot), true)
  assert.equal(f.calls.length, 1)
  assert.equal(cached.events[0].type, 'activity'); assert.equal(cached.events[0].activity.id, 'group-cache')
  assert.equal(cached.events.at(-1).type, 'result')
  assert.deepEqual(cached.events.at(-1).result, first.value)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('incomplete model membership fails the endpoint and cannot publish a partial grouping result', async t => {
  const f = await fixture(t, { answer: ({ proposed }) => resultOf(proposed.slice(0, -1)) }), snapshot = await f.snapshot(), before = f.db.getPlanner()
  const response = await f.request('/companion/horizon-groups', draftInput(snapshot), true)
  assert.equal(response.events.at(-1).type, 'error'); assert.equal(response.events.at(-1).status, 409)
  assert.match(response.events.at(-1).error, /遗漏/u)
  assert.ok(!response.events.some(event => event.type === 'result'))
  assert.deepEqual(f.db.getPlanner(), before); assert.equal(f.db.listOperations().length, 0)
})
