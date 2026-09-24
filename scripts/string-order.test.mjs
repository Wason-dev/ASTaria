import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createStringOrder } from '../server/stringOrder.mjs'
import { ProviderError } from '../server/provider.mjs'
import { createLocalService } from '../server/index.mjs'
import { getModelSettings, saveModelSettings } from '../server/modelSettings.mjs'
import { localDay } from '../src/home/agenda.ts'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-23'
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })
const fixture = t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  let at = new Date(`${DATE}T09:15:00+08:00`)
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) act({ type: 'delete-routine', id: row.id })
  const routine = (id, kind, start, end) => ({ type: 'save-routine', routine: { id, title: id, kind, weekdays: [0,1,2,3,4,5,6], start, end, location: '', items: [], enabled: true } })
  act(routine('free', 'available', '09:00', '22:00'))
  act(routine('lunch', 'break', '12:00', '13:00'))
  act({ type: 'save-day-event', event: { id: 'club', title: '社团', date: DATE, start: '17:00', end: '18:00', location: 'A422', items: [] } })
  const math = db.createTask({ title: '数学', estimateMin: 30, due: '2026-09-25' })
  const physics = db.createTask({ title: '物理', estimateMin: 40, due: '2026-09-25' })
  const held = db.createTask({ title: '保留任务', estimateMin: 30 })
  const block = (id, taskId, start, end, patch = {}) => act({ type: 'save-block', block: { id, taskId, date: DATE, start, end, locked: false, ...patch } })
  block('begun', held.id, '09:00', '09:30')
  block('locked', held.id, '10:00', '10:30', { locked: true })
  block('math', math.id, '14:00', '14:30')
  block('physics', physics.id, '15:00', '15:40')
  return { db, math, physics, held, act, block, now: () => at, advance: value => { at = new Date(value) } }
}
const candidate = () => ({ plans: [
  { id: 'physics', date: DATE, start: '14:00', end: '14:40' },
  { id: 'math', date: DATE, start: '15:00', end: '15:30' },
] })
const service = (f, complete = async () => completion(candidate())) => createStringOrder({ db: f.db, now: f.now, complete })
const request = (svc, patch = {}) => {
  const snap = svc.list({ date: DATE })
  return { date: DATE, orderedIds: snap.items.filter(item => item.movable).map(item => item.id).reverse(),
    expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID(), ...patch }
}

test('snapshot is complete, uses block identities and exposes locked slots without permitting movement', t => {
  const f = fixture(t), before = f.db.getPlanner(), snap = service(f).list({ date: DATE })
  assert.equal(snap.days, 7)
  assert.equal(snap.date, DATE)
  assert.match(snap.snapshotKey, /^[a-f0-9]{64}$/)
  assert.deepEqual(snap.items.map(item => item.id), ['locked', 'math', 'physics'])
  assert.equal(snap.items[0].movable, false)
  assert.match(snap.items[0].reason, /锁定/)
  assert.deepEqual(snap.items.slice(1).map(item => item.durationMin), [30, 40])
  assert.deepEqual(f.db.getPlanner(), before)
})

test('one completion receives full facts and applies one atomic reversible order without changing tasks or fixed/history data', async t => {
  const f = fixture(t), requests = [], before = f.db.getPlanner(), tasks = f.db.listTasks(), companion = f.db.getCompanionState()
  const svc = service(f, async payload => { requests.push(payload); return completion(candidate()) })
  const result = await svc.apply(request(svc))
  assert.equal(requests.length, 1)
  assert.equal(requests[0].tools, undefined)
  assert.equal(requests[0].response_format.type, 'json_object')
  const facts = JSON.parse(requests[0].messages[1].content)
  assert.deepEqual(facts.originalOrder, ['math', 'physics'])
  assert.deepEqual(facts.orderedIds, ['physics', 'math'])
  assert.equal(facts.dates.length, 7)
  assert.equal(facts.items.length, 2)
  assert.ok(facts.fixedOccupancy.some(item => item.id === 'club' && item.start === '17:00'))
  assert.ok(facts.fixedOccupancy.some(item => item.id === 'begun'))
  assert.ok(facts.fixedOccupancy.some(item => item.id === 'locked'))
  assert.ok(facts.availableWindows.some(item => item.date === DATE && item.start === '13:00' && item.end === '17:00'))
  assert.equal(result.operation.undoable, true)
  assert.equal(f.db.listOperations().length, 1)
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.deepEqual(f.db.getCompanionState(), companion)
  for (const key of ['routines', 'dayEvents', 'dayOverrides', 'checked', 'details']) assert.deepEqual(f.db.getPlanner()[key], before[key])
  for (const id of ['begun', 'locked']) assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === id), before.blocks.find(block => block.id === id))
  assert.deepEqual(result.items.filter(item => item.movable).map(item => item.id), ['physics', 'math'])
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('same request replays durably without a second model call or operation, including after undo', async t => {
  const f = fixture(t)
  let calls = 0
  const complete = async () => { calls++; return completion(candidate()) }, svc = service(f, complete), input = request(svc)
  const first = await svc.apply(input)
  const second = await service(f, complete).apply(input)
  assert.equal(second.operation.id, first.operation.id)
  assert.equal(second.replayed, true)
  assert.equal(calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  f.db.undoOperation(first.operation.id)
  const third = await svc.apply(input)
  assert.match(third.summary, /已撤销/)
  assert.ok(third.operation.undoneAt)
  assert.equal(calls, 1)
  await assert.rejects(svc.apply({ ...input, orderedIds: [...input.orderedIds].reverse() }), /另一种排序/)
})

test('simultaneous retries share one model call and atomic result', async t => {
  const f = fixture(t)
  let release, calls = 0
  const svc = service(f, async () => { calls++; await new Promise(resolve => { release = resolve }); return completion(candidate()) }), input = request(svc)
  const first = svc.apply(input), second = svc.apply(input)
  release()
  assert.equal((await first).operation.id, (await second).operation.id)
  assert.equal(calls, 1)
  assert.equal(f.db.listOperations().length, 1)
})

test('unchanged order skips completion and creates no undo operation', async t => {
  const f = fixture(t)
  let calls = 0
  const svc = service(f, async () => { calls++; return completion(candidate()) })
  const snap = svc.list({ date: DATE }), input = request(svc, { orderedIds: snap.items.filter(item => item.movable).map(item => item.id) })
  const before = f.db.getPlanner(), result = await svc.apply(input)
  assert.equal(result.operation, null)
  assert.equal(calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  assert.equal((await svc.apply(input)).replayed, true)
})

test('incomplete, duplicated, locked and invented user order IDs fail before completion', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  let calls = 0
  const svc = service(f, async () => { calls++; return completion(candidate()) }), input = request(svc)
  for (const orderedIds of [['math'], ['math', 'math'], ['physics', 'locked'], ['physics', 'invented']]) {
    await assert.rejects(async () => svc.apply({ ...input, requestId: randomUUID(), orderedIds }), /全部可移动|重复/)
  }
  assert.equal(calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

for (const [label, output, pattern] of [
  ['fixed event conflict', () => ({ plans: [{ id: 'physics', date: DATE, start: '17:00', end: '17:40' }, { id: 'math', date: DATE, start: '18:00', end: '18:30' }] }), /冲突/],
  ['lock conflict', () => ({ plans: [{ id: 'physics', date: DATE, start: '10:00', end: '10:40' }, { id: 'math', date: DATE, start: '11:00', end: '11:30' }] }), /冲突/],
  ['fixed routine conflict', () => ({ plans: [{ id: 'physics', date: DATE, start: '12:00', end: '12:40' }, { id: 'math', date: DATE, start: '13:00', end: '13:30' }] }), /冲突/],
  ['outside availability', () => ({ plans: [{ id: 'physics', date: DATE, start: '22:00', end: '22:40' }, { id: 'math', date: DATE, start: '23:00', end: '23:30' }] }), /真实空档/],
  ['outside week', () => ({ plans: candidate().plans.map(plan => ({ ...plan, date: '2026-10-01' })) }), /七天范围/],
  ['missed segment', () => ({ plans: candidate().plans.slice(1) }), /遗漏/],
  ['duplicate segment', () => ({ plans: [candidate().plans[0], candidate().plans[0]] }), /重复/],
  ['changed duration', () => ({ plans: candidate().plans.map((plan, index) => index ? plan : { ...plan, end: '14:20' }) }), /原时长/],
  ['not user order', () => ({ plans: candidate().plans.map(plan => plan.id === 'math' ? { ...plan, start: '13:00', end: '13:30' } : plan) }), /先后顺序/],
  ['overlapping segments', () => ({ plans: candidate().plans.map(plan => plan.id === 'math' ? { ...plan, start: '14:20', end: '14:50' } : plan) }), /先后顺序/],
  ['protected ID', () => ({ plans: candidate().plans.map(plan => plan.id === 'math' ? { ...plan, id: 'locked' } : plan) }), /不属于本次/],
  ['unexpected task edits', () => ({ ...candidate(), tasks: [] }), /不支持/],
  ['model cannot fit', () => ({ error: '物理在截止时间前没有完整40分钟空档' }), /无法完整调整/],
]) test(`reject ${label} without partial writes or a second completion`, async t => {
  const f = fixture(t), before = f.db.getPlanner(), tasks = f.db.listTasks()
  let calls = 0
  const svc = service(f, async () => { calls++; return completion(output()) })
  await assert.rejects(svc.apply(request(svc)), pattern)
  assert.equal(calls, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.deepEqual(f.db.listOperations(), [])
})

test('exact DDL prevents a late candidate without changing the deadline', async t => {
  const f = fixture(t)
  f.db.updateTask(f.physics.id, { due: `${DATE}T14:20:00+08:00` })
  const svc = service(f), before = f.db.getPlanner()
  await assert.rejects(svc.apply(request(svc)), /DDL/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.db.getTask(f.physics.id).due, `${DATE}T14:20:00+08:00`)
})

test('a recurring occurrence cannot leave its original day', async t => {
  const f = fixture(t)
  f.db.updateTask(f.physics.id, { occurrence: { seriesId: 'vocabulary', date: DATE, allowFallback: true, placement: 'end' } })
  const svc = service(f, async () => completion({ plans: candidate().plans.map(plan => ({ ...plan, date: '2026-09-24' })) })), before = f.db.getPlanner()
  await assert.rejects(svc.apply(request(svc)), /重复事项.*其他日期/)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('goal target date is enforced even when task DDL is later', async t => {
  const f = fixture(t)
  f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeGoals: [{ id: 'goal', taskId: f.physics.id, targetDate: DATE }] })
  const svc = service(f, async () => completion({ plans: candidate().plans.map(plan => ({ ...plan, date: '2026-09-24' })) })), before = f.db.getPlanner()
  await assert.rejects(svc.apply(request(svc)), /余时目标日期/)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('completed sessions and closed tasks are excluded, multiple sessions of one goal retain separate workload', async t => {
  const f = fixture(t), goal = f.db.createTask({ title: '数学复习', freeTimeGoalId: 'goal' })
  for (const [id, start, end] of [['goal-a', '18:00', '18:20'], ['goal-b', '18:30', '18:50'], ['goal-done', '19:00', '19:20']]) f.block(id, goal.id, start, end)
  f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeGoals: [{ id: 'goal', taskId: goal.id, targetDate: '2026-09-25' }],
    freeTimeHistory: [{ sessionId: 'goal-done', goalId: 'goal', date: DATE, completedAt: f.now().toISOString(), minutes: 20 }] })
  const completed = f.db.createTask({ title: '完成任务' })
  f.block('done-task', completed.id, '20:00', '20:20'); f.db.updateTask(completed.id, { status: 'done' })
  const dropped = f.db.createTask({ title: '放下任务' })
  f.block('dropped-task', dropped.id, '20:30', '20:50'); f.db.updateTask(dropped.id, { status: 'dropped' })
  const svc = service(f), items = svc.list({ date: DATE }).items
  assert.deepEqual(items.filter(item => item.taskId === goal.id).map(item => item.id), ['goal-a', 'goal-b'])
  assert.equal(items.filter(item => item.taskId === goal.id).reduce((sum, item) => sum + item.durationMin, 0), 40)
  assert.ok(!items.some(item => ['goal-done', 'done-task', 'dropped-task'].includes(item.id)))
  const history = f.db.getCompanionState().freeTimeHistory
  const reorder = service(f, async payload => {
    const facts = JSON.parse(payload.messages[1].content)
    assert.equal(facts.items.length, 4)
    return completion({ plans: [
      { id: 'goal-b', date: DATE, start: '13:00', end: '13:20' },
      { id: 'goal-a', date: DATE, start: '13:30', end: '13:50' },
      ...candidate().plans,
    ] })
  })
  const result = await reorder.apply(request(reorder))
  assert.equal(result.items.filter(item => item.taskId === goal.id).reduce((sum, item) => sum + item.durationMin, 0), 40)
  assert.deepEqual(f.db.getCompanionState().freeTimeHistory, history)
  assert.equal(f.db.getPlanner().blocks.find(block => block.id === 'goal-done').start, '19:00')
})

for (const field of ['planner', 'task', 'history', 'goal']) test(`a stale ${field} snapshot is rejected before completion`, async t => {
  const f = fixture(t)
  let calls = 0
  const svc = service(f, async () => { calls++; return completion(candidate()) }), input = request(svc)
  if (field === 'planner') f.act({ type: 'check-item', date: DATE, key: 'book', checked: true })
  else if (field === 'task') f.db.updateTask(f.math.id, { title: '新标题' })
  else if (field === 'history') f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeHistory: [{ sessionId: 'math' }] })
  else f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeGoals: [{ id: 'new-goal', taskId: f.math.id }] })
  const before = f.db.getPlanner()
  await assert.rejects(svc.apply(input), /已有变化/)
  assert.equal(calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

for (const field of ['task', 'history', 'started']) test(`changes to ${field} while the model runs invalidate completion`, async t => {
  const f = fixture(t)
  const svc = service(f, async () => {
    if (field === 'task') f.db.updateTask(f.math.id, { estimateMin: 90 })
    else if (field === 'history') f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeHistory: [{ sessionId: 'math' }] })
    else f.advance(`${DATE}T14:05:00+08:00`)
    return completion(candidate())
  }), input = request(svc), before = f.db.getPlanner()
  await assert.rejects(svc.apply(input), /已有变化/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a proposed start that elapsed during inference is rejected against the final clock', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  const svc = service(f, async () => { f.advance(`${DATE}T11:05:00+08:00`); return completion({ plans: [
    { id: 'physics', date: DATE, start: '11:00', end: '11:40' }, { id: 'math', date: DATE, start: '13:00', end: '13:30' },
  ] }) })
  await assert.rejects(svc.apply(request(svc)), /开始时间已过去/)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('legacy startAt stays suppressed after removing movable explicit plans', async t => {
  const f = fixture(t)
  f.db.updateTask(f.math.id, { startAt: `${DATE}T14:00:00+08:00` })
  const svc = service(f)
  const result = await svc.apply(request(svc))
  assert.ok(result.operation)
  assert.equal(f.db.getTask(f.math.id).startAt, `${DATE}T14:00:00+08:00`)
})

test('journal failure rolls back the entire planner operation', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  const db = { ...f.db, setPreference: () => { throw new Error('fixture journal failure') } }
  const svc = createStringOrder({ db, now: f.now, complete: async () => completion(candidate()) })
  await assert.rejects(svc.apply(request(svc)), /fixture journal failure/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('provider and malformed JSON fail explicitly without fallback scheduling', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  for (const complete of [async () => { throw new ProviderError('模型离线') }, async () => ({ choices: [{ message: { content: 'not json' } }] })]) {
    const svc = service(f, complete)
    await assert.rejects(svc.apply(request(svc)), /模型离线|完整安排/)
  }
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('GET never hides a long order, and POST rejects an unsupported whole batch without partial changes', async t => {
  const f = fixture(t)
  const huge = Array.from({ length: 129 }, (_, index) => ({ id: `extra-${index}`, taskId: f.math.id, date: DATE, start: '14:00', end: '14:30', locked: false }))
  const original = f.db.getPlanner()
  const db = { ...f.db, getPlanner: () => ({ ...original, blocks: huge }) }
  let calls = 0
  const svc = createStringOrder({ db, now: f.now, complete: async () => { calls++; return completion(candidate()) } })
  assert.equal(svc.list({ date: DATE }).items.length, 129)
  await assert.rejects(svc.apply(request(svc)), /128/)
  assert.equal(calls, 0)
  assert.deepEqual(f.db.getPlanner(), original)
})

test('HTTP endpoints use the configured model once, preserve Max/budget-off, return a public receipt and support ordinary undo', async t => {
  const db = createDatabase(':memory:'), sent = []
  const date = localDay(new Date()), next = new Date(); next.setDate(next.getDate() + 1)
  const tomorrow = localDay(next), edit = action => db.updatePlanner(action, db.getPlanner().revision)
  edit({ type: 'save-routine', routine: { id: 'fixture-availability', title: '空档', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
  const tasks = ['A', 'B'].map(title => db.createTask({ title, estimateMin: 30 }))
  for (let index = 0; index < tasks.length; index++) edit({ type: 'save-block', block: { id: `api-${index}`, taskId: tasks[index].id, date: tomorrow, start: `${14 + index}:00`, end: `${14 + index}:30`, locked: false } })
  const settings = saveModelSettings(db, { ...getModelSettings(db), cloudModel: 'deepseek-v4-pro', reasoningEffort: 'max', contextBudget: { mode: 'off' } })
  const svc = createLocalService({ db, vault: { read: async () => 'fixture-not-a-real-key', status: async () => true },
    fetcher: async (_url, options) => {
      sent.push(JSON.parse(options.body))
      return new Response(JSON.stringify(completion({ plans: [
        { id: 'api-1', date: tomorrow, start: '14:00', end: '14:30' },
        { id: 'api-0', date: tomorrow, start: '15:00', end: '15:30' },
      ] })), { status: 200, headers: { 'Content-Type': 'application/json' } })
    } })
  t.after(() => svc.close())
  const invoke = (path, payload) => new Promise(resolve => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
    req.url = `/api${path}`; req.method = payload === undefined ? 'GET' : 'POST'
    req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    svc.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } }, () => resolve({ status: 404 }))
  })
  const { status, body: snap } = await invoke(`/companion/string-order?date=${date}`)
  assert.equal(status, 200)
  assert.deepEqual(snap.items.map(item => item.id), ['api-0', 'api-1'])
  const input = { date, orderedIds: ['api-1', 'api-0'], expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID() }
  const applied = await invoke('/companion/string-order', input)
  assert.equal(applied.status, 200)
  assert.ok(applied.body.operation.id)
  assert.equal(applied.body.operation.plannerBefore, undefined)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].model, 'deepseek-v4-pro')
  assert.equal(sent[0].reasoning_effort, 'max')
  assert.equal(sent[0].thinking.type, 'enabled')
  assert.equal(sent[0].max_tokens, undefined)
  assert.deepEqual(getModelSettings(db), settings)
  assert.equal((await invoke('/companion/string-order', input)).body.replayed, true)
  assert.equal(sent.length, 1)
  assert.equal((await invoke(`/operations/${applied.body.operation.id}/undo`, {})).status, 200)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'api-0').start, '14:00')
})
