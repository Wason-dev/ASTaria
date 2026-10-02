import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'
import { ProviderError } from '../server/provider.mjs'
import { createLocalService } from '../server/index.mjs'
import { getModelSettings, saveModelSettings } from '../server/modelSettings.mjs'
import { localDay } from '../src/home/agenda.ts'

process.env.TZ = 'Asia/Shanghai'
/**
 * The three-day horizon keeps one model call, and only as a review of a locally
 * prepared, locally verified candidate:
 *  - `createHorizonOrder({ db, complete, now, timeoutMs })` and `apply(input, { onEvent })`.
 *  - the request carries that candidate in the submitted order; the model answers
 *    `{"changes":[{"index":0,"start":"HH:mm"}]}` where `index` addresses that order.
 *  - date and duration stay local: a change only replaces one start, and the whole
 *    batch is re-verified as one unit before the single atomic write.
 *  - `{"changes":[]}` accepts the candidate; a failure never falls back to it.
 *  - progress is `checking → preparing → waiting → thinking → receiving → validating → saving`,
 *    with no provider round at all for no-op, illegal, replayed or unsolvable drafts.
 */
const DATE = '2026-09-23', TOMORROW = '2026-09-24', LATER = '2026-09-25'
const dates = [DATE, TOMORROW, LATER]
const minuteOf = time => { const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute }
const timeOf = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const minutesOf = block => minuteOf(block.end) - minuteOf(block.start)
const placements = db => Object.fromEntries(db.getPlanner().blocks.map(block => [block.id, [block.date, block.start, block.end]]))
const draftOf = snap => snap.groups.map(group => ({ id: group.id, day: group.day, itemIds: group.tasks.map(task => task.id) }))
/** The documented progress order of one three-day fine-tune. */
const PHASES = ['checking', 'preparing', 'waiting', 'thinking', 'receiving', 'validating', 'saving']
const phaseNames = events => {
  const names = events.map(event => event.type === 'phase' ? event.phase : null).filter(Boolean)
  return names.filter((phase, index) => phase !== names[index - 1])
}

const fixture = t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  let at = new Date(`${DATE}T09:15:00+08:00`)
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) act({ type: 'delete-routine', id: row.id })
  const routine = (id, kind, start, end) => ({ type: 'save-routine', routine: { id, title: id, kind, weekdays: [0,1,2,3,4,5,6], start, end, location: '', items: [], enabled: true } })
  act(routine('available', 'available', '09:00', '22:00'))
  act(routine('lunch', 'break', '12:00', '13:00'))
  const math = db.createTask({ title: '数学练习', area: 'math', due: LATER })
  const physics = db.createTask({ title: '物理复习', area: 'physics', due: LATER })
  const reading = db.createTask({ title: '读一章', area: 'chinese', freeTimeGoalId: 'reading-goal' })
  const held = db.createTask({ title: '保留任务' })
  const block = (id, taskId, start, end, patch = {}) => act({ type: 'save-block', block: { id, taskId, date: DATE, start, end, locked: false, ...patch } })
  // `begun` is genuinely underway: a doing task keeps its elapsed start protected.
  db.updateTask(held.id, { status: 'doing' })
  block('begun', held.id, '09:00', '09:30')
  block('locked', held.id, '10:00', '10:30', { locked: true })
  block('math-a', math.id, '14:00', '14:30')
  block('physics', physics.id, '15:00', '15:40')
  block('math-b', math.id, '16:00', '16:20')
  block('reading', reading.id, '11:00', '11:25', { date: TOMORROW })
  block('fourth-day', reading.id, '11:00', '11:25', { date: '2026-09-26' })
  db.createTask({ title: '未排期待办不会进入弦轨', area: 'math' })
  db.saveCompanionState({ ...db.getCompanionState(), freeTimeGoals: [{ id: 'reading-goal', taskId: reading.id, title: '读完这本书', targetDate: LATER }] })
  return { db, math, physics, reading, held, act, block, now: () => at, advance: value => { at = new Date(value) } }
}
const service = (f, options = {}) => createHorizonOrder({ db: f.db, now: f.now, ...options })
const request = (svc, change = groups => groups) => {
  const snap = svc.list({ date: DATE })
  return { date: DATE, groups: change(draftOf(snap)), expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID() }
}
const reversed = groups => [...groups.filter(group => group.day === 0).reverse().map(group => ({ ...group, itemIds: [...group.itemIds].reverse() })), ...groups.filter(group => group.day !== 0)]
/** The verified local candidate for the reversed draft, addressed by the submitted index. */
const CANDIDATE = [
  { id: 'physics', title: '物理复习', date: DATE, minutes: 40, start: '15:00', original: [DATE, '15:00'] },
  { id: 'math-b', title: '数学练习', date: DATE, minutes: 20, start: '16:00', original: [DATE, '16:00'] },
  { id: 'math-a', title: '数学练习', date: DATE, minutes: 30, start: '16:20', original: [DATE, '14:00'] },
  { id: 'reading', title: '读一章', date: TOMORROW, minutes: 25, start: '11:00', original: [TOMORROW, '11:00'] },
]
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })
/** Records every provider call; `delta` reproduces a streaming answer with reasoning then content. */
const model = (value, { delta = true } = {}) => {
  const seen = { calls: 0, payloads: [], options: [] }
  return { seen, complete: async (payload, options = {}) => {
    seen.calls += 1; seen.payloads.push(payload); seen.options.push(options)
    if (delta && typeof options.onDelta === 'function') {
      options.onDelta({ type: 'reasoning', delta: '先核对初排' })
      options.onDelta({ type: 'content', delta: '{"changes":' })
    }
    return completion(typeof value === 'function' ? value(payload, options) : value)
  } }
}
/** A completion that never settles: any request that reaches the provider would hang and fail the test. */
const never = () => { const seen = { calls: 0 }; return { seen, complete: () => { seen.calls += 1; return new Promise(() => {}) } } }

/** A minimal ServerResponse stand-in that records SSE frames and can pretend the client vanished. */
const invokeService = (svc, path, payload, { accept, stopWhen } = {}) => new Promise(resolve => {
  const events = [], raw = []
  let buffer = '', settled = false, res
  const finish = () => { if (!settled) { settled = true; resolve({ status: res.statusCode, headers: res.headers, events, raw: raw.join('') }) } }
  const take = chunk => {
    buffer += chunk
    for (let at = buffer.indexOf('\n\n'); at >= 0; at = buffer.indexOf('\n\n')) {
      const block = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      const line = block.split('\n').find(item => item.startsWith('data: '))
      if (!line) continue
      try { events.push(JSON.parse(line.slice(6))) } catch { events.push({ type: 'unreadable' }) }
      if (stopWhen?.(events[events.length - 1], events)) { res.destroyed = true; finish() }
    }
  }
  res = {
    statusCode: 200, headers: {}, destroyed: false, writableEnded: false, writableLength: 0,
    setHeader(name, value) { this.headers[String(name).toLowerCase()] = value },
    flushHeaders() {}, once() {}, on() {}, removeListener() {},
    write(chunk) { raw.push(String(chunk)); take(String(chunk)); return true },
    end(chunk) { this.writableEnded = true; if (chunk !== undefined) { raw.push(String(chunk)); take(String(chunk)) } finish() },
    destroy() { this.destroyed = true; finish() },
  }
  const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
  req.url = `/api${path}`
  req.method = payload === undefined ? 'GET' : 'POST'
  req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
  req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json',
    ...(accept ? { accept } : {}) }
  svc.middleware(req, res, () => { res.statusCode = 404; finish() })
})

test('one fine-tune receives the ordered local candidate and a valid change lands on the fixed date and duration', async t => {
  const f = fixture(t), before = f.db.getPlanner(), tasks = f.db.listTasks(), companion = f.db.getCompanionState()
  const { seen, complete } = model({ changes: [{ index: 2, start: '16:40' }, { index: 3, start: '11:30' }] })
  const svc = service(f, { complete }), input = request(svc, reversed), result = await svc.apply(input)
  assert.equal(seen.calls, 1)
  const payload = seen.payloads[0]
  assert.equal(payload.tools, undefined)
  assert.equal(payload.response_format.type, 'json_object')
  assert.match(payload.messages[0].content, /changes/u)
  assert.match(payload.messages[0].content, /index/u)
  const context = JSON.parse(payload.messages[1].content)
  // `index` addresses the submitted order: the candidate is frozen, never re-packed.
  assert.deepEqual(context.items.map(item => ({ index: item.index, title: item.title, date: item.date, minutes: item.minutes, start: item.start, original: item.original })),
    CANDIDATE.map((item, index) => ({ index, title: item.title, date: item.date, minutes: item.minutes, start: item.start, original: item.original })))
  assert.equal(context.asOf, f.now().toISOString())
  assert.deepEqual(context.availableWindows.map(window => window.date), dates)
  const today = context.availableWindows[0].ranges
  assert.deepEqual(today, [['09:30', '10:00'], ['10:30', '12:00'], ['13:00', '22:00']])
  // The change keeps the local date and duration of the addressed item.
  const placed = id => f.db.getPlanner().blocks.find(block => block.id === id)
  assert.deepEqual(['physics', 'math-b', 'math-a', 'reading'].map(id => [id, placed(id).date, placed(id).start, placed(id).end]), [
    ['physics', DATE, '15:00', '15:40'], ['math-b', DATE, '16:00', '16:20'], ['math-a', DATE, '16:40', '17:10'], ['reading', TOMORROW, '11:30', '11:55'],
  ])
  assert.equal(result.operation.undoable, true)
  assert.equal(f.db.listOperations().length, 1)
  for (const item of CANDIDATE) assert.equal(minutesOf(placed(item.id)), item.minutes)
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.deepEqual(f.db.getCompanionState(), companion)
  for (const id of ['begun', 'locked', 'fourth-day']) assert.deepEqual(placed(id), before.blocks.find(block => block.id === id))
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('empty changes accept the local candidate unchanged', async t => {
  const f = fixture(t), { seen, complete } = model({ changes: [] }), svc = service(f, { complete }), result = await svc.apply(request(svc, reversed))
  assert.equal(seen.calls, 1)
  assert.ok(result.operation)
  const expected = { begun: [DATE, '09:00', '09:30'], locked: [DATE, '10:00', '10:30'], 'fourth-day': ['2026-09-26', '11:00', '11:25'] }
  for (const item of CANDIDATE) expected[item.id] = [item.date, item.start, timeOf(minuteOf(item.start) + item.minutes)]
  assert.deepEqual(placements(f.db), expected)
})

for (const [label, changes, pattern] of [
  ['out-of-range index', [{ index: 2, start: '16:40' }, { index: 9, start: '18:00' }], /重复或无效/u],
  ['duplicate index', [{ index: 2, start: '16:40' }, { index: 2, start: '17:00' }], /重复或无效/u],
  ['string index', [{ index: 2, start: '16:40' }, { index: '3', start: '18:00' }], /重复或无效/u],
  ['fractional index', [{ index: 2, start: '16:40' }, { index: 1.5, start: '18:00' }], /重复或无效/u],
  ['negative index', [{ index: 2, start: '16:40' }, { index: -1, start: '18:00' }], /重复或无效/u],
  ['hour out of range', [{ index: 2, start: '16:40' }, { index: 3, start: '25:00' }], /HH:mm/u],
  ['minute out of range', [{ index: 2, start: '16:40' }, { index: 3, start: '11:60' }], /HH:mm/u],
  ['unpadded clock', [{ index: 2, start: '16:40' }, { index: 3, start: '9:30' }], /HH:mm/u],
  ['missing start', [{ index: 2, start: '16:40' }, { index: 3 }], /HH:mm/u],
  ['model-supplied date', [{ index: 2, start: '16:40' }, { index: 3, start: '11:30', date: LATER }], /不支持/u],
  ['model-supplied end', [{ index: 2, start: '16:40' }, { index: 3, start: '11:30', end: '11:55' }], /不支持/u],
  ['unknown field', [{ index: 2, start: '16:40' }, { index: 3, start: '11:30', minutes: 25 }], /不支持/u],
]) test(`${label} rejects the whole batch without partial writes`, async t => {
  const f = fixture(t), before = f.db.getPlanner(), tasks = f.db.listTasks()
  const { seen, complete } = model({ changes }), svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, reversed)), pattern)
  assert.equal(seen.calls, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.deepEqual(f.db.listOperations(), [])
})

for (const [label, changes, pattern] of [
  ['fixed occupancy conflict', [{ index: 2, start: '16:40' }, { index: 3, start: '12:10' }], /冲突|空档/u],
  ['submitted order conflict', [{ index: 3, start: '11:30' }, { index: 1, start: '16:05' }], /先后顺序|冲突/u],
  ['start before the captured clock', [{ index: 2, start: '16:40' }, { index: 0, start: '09:10' }], /已过去/u],
]) test(`a fine-tune with a ${label} rejects the whole batch`, async t => {
  const f = fixture(t), before = f.db.getPlanner()
  const { seen, complete } = model({ changes }), svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, reversed)), pattern)
  assert.equal(seen.calls, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a fine-tune beyond the task DDL rejects the whole batch and never edits the deadline', async t => {
  const f = fixture(t)
  f.db.updateTask(f.math.id, { due: `${DATE}T17:00:00+08:00` })
  const before = f.db.getPlanner(), { seen, complete } = model({ changes: [{ index: 2, start: '16:40' }, { index: 3, start: '11:30' }] })
  const svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, reversed)), /DDL/u)
  assert.equal(seen.calls, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.db.getTask(f.math.id).due, `${DATE}T17:00:00+08:00`)
  assert.equal(f.db.getPlanner().blocks.find(block => block.id === 'reading').start, '11:00')
  assert.deepEqual(f.db.listOperations(), [])
})

for (const [label, mutate, pattern] of [
  ['a task edit', f => f.db.updateTask(f.math.id, { title: '数学新标题' }), /已有变化/u],
  ['a planner edit', f => f.act({ type: 'check-item', date: DATE, key: 'book', checked: true }), /已有变化/u],
  ['a clock that moves past the candidate', f => f.advance(`${DATE}T16:30:00+08:00`), /已有变化|已过去/u],
]) test(`${label} while the fine-tune is in flight is rejected by the final check`, async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = model(() => { mutate(f); return { changes: [{ index: 2, start: '16:40' }] } })
  const svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, reversed)), pattern)
  assert.equal(seen.calls, 1)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.deepEqual(f.db.listOperations(), [])
})

test('progress phases stay strictly ordered while activity notes are interleaved', async t => {
  const f = fixture(t), { complete } = model({ changes: [{ index: 2, start: '16:40' }] }), svc = service(f, { complete }), events = []
  await svc.apply(request(svc, reversed), { onEvent: event => events.push(event) })
  // Only phase frames may advance the phase list, and every phase frame uses a real name.
  assert.ok(events.filter(event => event.type === 'phase').every(event => PHASES.includes(event.phase)))
  assert.deepEqual(phaseNames(events), PHASES)
  assert.deepEqual([...new Set(phaseNames(events))], PHASES)
  // Activity frames carry public, structured notes and never become a phase.
  const activities = events.filter(event => event.type === 'activity').map(event => event.activity)
  assert.ok(activities.length >= 3)
  assert.deepEqual([...new Set(activities.map(activity => activity.source))], ['local', 'model'])
  const modelStatus = activities.filter(activity => activity.id === 'model-review')
  assert.deepEqual(modelStatus.map(activity => activity.state), ['running', 'running', 'done'])
  assert.match(modelStatus[0].title, /请求模型核对 4 段/)
  assert.match(modelStatus[1].title, /模型正在核对 4 段/)
  assert.match(modelStatus.at(-1).detail, /尚未保存/)
  for (const activity of activities) {
    assert.equal(typeof activity.id, 'string')
    assert.ok(['running', 'done', 'proposed'].includes(activity.state))
    assert.ok(activity.title.trim())
  }
  // A note that merely repeats a phase name cannot impersonate one.
  const fake = model({ changes: [], updates: [{ index: 0, action: 'keep', summary: 'saving' }] }, { delta: false })
  const second = service(f, { complete: fake.complete }), secondEvents = []
  await second.apply(request(second, reversed), { onEvent: event => secondEvents.push(event) })
  assert.deepEqual(phaseNames(secondEvents), ['checking', 'preparing', 'waiting', 'validating', 'saving'])
  assert.deepEqual(secondEvents.filter(event => event.type === 'activity' && event.activity.source === 'model' && event.activity.state === 'proposed').map(event => event.activity.detail), ['saving'])
})

test('optional updates become public review activity without changing the changes protocol', async t => {
  const f = fixture(t), before = f.db.getPlanner(), events = []
  const { seen, complete } = model({ updates: [{ index: 0, action: 'keep', summary: '初排符合截止时间，可继续沿用' }, { index: 2, action: 'adjust', summary: '把这段挪到稍晚的空档' }],
    changes: [{ index: 2, start: '16:40' }] })
  const svc = service(f, { complete }), result = await svc.apply(request(svc, reversed), { onEvent: event => events.push(event) })
  assert.equal(seen.calls, 1)
  const reviews = events.filter(event => event.type === 'activity' && event.activity.source === 'model' && event.activity.state === 'proposed').map(event => event.activity)
  assert.deepEqual(reviews.map(review => [review.id, review.state, review.title, review.detail, review.itemIds, review.day]), [
    ['model-review:0', 'proposed', '建议沿用「物理复习」', '初排符合截止时间，可继续沿用', ['physics'], 0],
    ['model-review:2', 'proposed', '建议微调「数学练习」', '把这段挪到稍晚的空档', ['math-a'], 0],
  ])
  // The change list keeps its original meaning: date and duration stay local.
  assert.equal(f.db.getPlanner().blocks.find(block => block.id === 'math-a').start, '16:40')
  assert.equal(f.db.getPlanner().blocks.find(block => block.id === 'math-a').end, '17:10')
  assert.ok(result.operation)
  assert.equal(f.db.listOperations().length, 1)
  // An untouched session keeps its time and only gains the submitted grouping metadata.
  const physics = f.db.getPlanner().blocks.find(block => block.id === 'physics'), original = before.blocks.find(block => block.id === 'physics')
  assert.deepEqual([physics.date, physics.start, physics.end], [original.date, original.start, original.end])
  assert.equal(physics.horizonGroupTitle, '物理')
})

test('unusable review notes are ignored while the verified plan still commits', async t => {
  const f = fixture(t), events = []
  const { seen, complete } = model({ updates: [
    { index: 99, action: 'keep', summary: '序号越界' },
    { index: 3, action: 'keep', summary: '带控制字符\u0007' },
    { index: 3, action: 'keep', summary: '第三条的有效结论' },
    { index: 3, action: 'keep', summary: '同一个序号的重复结论' },
    { index: 0, action: 'delete', summary: '动作非法' },
    { index: 1, action: 'keep', summary: '长'.repeat(161) },
    { index: 2, action: 'keep', summary: '   ' },
    { index: 1.5, action: 'keep', summary: '序号不是整数' },
    { index: 0, action: 'keep', summary: '多余字段', extra: true },
  ], changes: [] })
  const svc = service(f, { complete }), result = await svc.apply(request(svc, reversed), { onEvent: event => events.push(event) })
  assert.equal(seen.calls, 1)
  // Only well-formed, first-seen notes reach the feed. A rejected note never
  // consumes its index, so a later valid note for the same index still shows up.
  assert.deepEqual(events.filter(event => event.type === 'activity' && event.activity.source === 'model' && event.activity.state === 'proposed').map(event => event.activity),
    [{ id: 'model-review:3', source: 'model', state: 'proposed', title: '建议沿用「读一章」', detail: '第三条的有效结论', itemIds: ['reading'], day: 1 }])
  assert.ok(result.operation)
  assert.equal(f.db.listOperations().length, 1)
})

test('at most six review notes reach the activity feed', async t => {
  const f = fixture(t)
  const extra = f.db.createTask({ title: '额外任务', area: 'life' })
  for (const [index, start] of [[0, '17:00'], [1, '17:30'], [2, '18:00']]) f.block(`extra-${index}`, extra.id, start, timeOf(minuteOf(start) + 20))
  const { seen, complete } = model({ updates: Array.from({ length: 7 }, (_, index) => ({ index, action: 'keep', summary: `第 ${index + 1} 条结论` })), changes: [] })
  const svc = service(f, { complete }), events = []
  await svc.apply(request(svc, reversed), { onEvent: event => events.push(event) })
  assert.equal(seen.calls, 1)
  const reviews = events.filter(event => event.type === 'activity' && event.activity.source === 'model' && event.activity.state === 'proposed').map(event => event.activity)
  assert.deepEqual(reviews.map(review => [review.id, review.detail]), [0, 1, 2, 3, 4, 5].map(index => [`model-review:${index}`, `第 ${index + 1} 条结论`]))
})

test('updates without changes stay rejected because changes keeps the original protocol', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = model({ updates: [{ index: 0, action: 'keep', summary: '只是结论' }] })
  const svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, reversed)), /微调结果不完整/u)
  assert.equal(seen.calls, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

/** Two sessions tomorrow, addressed through the real HTTP service whose clock is the wall clock. */
const liveFixture = (t, options = {}) => {
  const db = createDatabase(':memory:')
  const today = localDay(new Date()), value = new Date(), other = new Date()
  value.setDate(value.getDate() + 1)
  other.setDate(other.getDate() + 2)
  const tomorrow = localDay(value), dayAfter = localDay(other), edit = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) edit({ type: 'delete-routine', id: row.id })
  edit({ type: 'save-routine', routine: { id: 'free', title: '空档', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
  for (let index = 0; index < 2; index++) {
    const task = db.createTask({ title: `任务 ${index}` })
    edit({ type: 'save-block', block: { id: `api-${index}`, taskId: task.id, date: tomorrow, start: `${14 + index}:00`, end: `${14 + index}:30`, locked: false } })
  }
  const svc = createLocalService({ db, vault: { read: async () => 'fixture-not-a-real-key', status: async () => true }, ...options })
  // `svc.close()` closes the database and the installer; never close both.
  t.after(() => svc.close())
  return { db, svc, today, tomorrow, dayAfter }
}
const snapshotOf = (fixture, svc) => invokeService(svc, `/companion/horizon-order?date=${fixture.today}`).then(read => {
  assert.equal(read.status, 200)
  return JSON.parse(read.raw)
})
const submit = (fixture, snap, change = groups => groups) => ({
  date: fixture.today, expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID(), groups: change(draftOf(snap)),
})
const swapGroups = groups => [...groups].reverse()

test('SSE progress streams over HTTP and a broken stream retries idempotently', async t => {
  const { seen, complete } = model({ changes: [{ index: 1, start: '16:00' }] }), fixture = liveFixture(t, { complete }), { db, svc } = fixture
  const input = submit(fixture, await snapshotOf(fixture, svc), swapGroups)
  const broken = await invokeService(svc, '/companion/horizon-order', input, { accept: 'text/event-stream', stopWhen: event => event.phase === 'thinking' })
  assert.match(broken.headers['content-type'], /text\/event-stream/u)
  assert.deepEqual(phaseNames(broken.events), ['checking', 'preparing', 'waiting', 'thinking'])
  // Activity notes travel on the same stream, interleaved between phase frames.
  const activityAt = broken.events.findIndex(event => event.type === 'activity')
  assert.ok(activityAt > 0 && activityAt < broken.events.findIndex(event => event.type === 'phase' && event.phase === 'preparing'))
  assert.ok(broken.events.some(event => event.type === 'activity' && event.activity.source === 'local' && event.activity.state === 'done'))
  assert.ok(broken.events.filter(event => event.type === 'phase').every(event => PHASES.includes(event.phase)))
  assert.ok(!broken.events.some(event => event.type === 'result'), '断流时客户端不应收到最终回执')
  // The durable turn finishes on its own after the client vanished.
  await svc.whenIdle()
  assert.equal(seen.calls, 1)
  assert.equal(db.listOperations().length, 1)
  const retried = await invokeService(svc, '/companion/horizon-order', input)
  assert.equal(retried.status, 200)
  const body = JSON.parse(retried.raw)
  assert.equal(body.replayed, true)
  assert.equal(body.operation.id, db.listOperations()[0].id)
  assert.equal(seen.calls, 1)
  assert.equal(db.listOperations().length, 1)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'api-0').start, '16:00')
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'api-0').end, '16:30')
})

for (const [label, complete, pattern] of [
  ['a provider error', async () => { throw new ProviderError('模型离线') }, /模型离线|模型服务/u],
  ['an unexpected provider crash', async () => { throw new Error('socket closed') }, /模型服务暂时不可用/u],
  ['unreadable output', async () => ({ choices: [{ finish_reason: 'stop', message: { content: '不是 JSON' } }] }), /完整安排/u],
  ['a truncated answer', async () => ({ choices: [{ finish_reason: 'length', message: { content: '{"changes":' } }] }), /没有完整返回/u],
  ['an unsupported result shape', async () => completion({ plans: [] }), /不支持/u],
  ['a model-declared dead end', async () => completion({ error: '今天没有连续 30 分钟空档' }), /无法完整调整/u],
]) test(`failure from ${label} never falls back to the local candidate and writes nothing`, async t => {
  const f = fixture(t), before = f.db.getPlanner(), calls = { count: 0 }
  const failing = async (...args) => { calls.count += 1; return complete(...args) }
  const svc = service(f, { complete: failing }), input = request(svc, reversed)
  await assert.rejects(svc.apply(input), pattern)
  assert.equal(calls.count, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  // Nothing was journalled, so the same request ID retries the model and commits once.
  const retry = model({ changes: [] }), again = service(f, { complete: retry.complete })
  const latest = again.list({ date: DATE })
  const result = await again.apply({ ...input, expectedRevision: latest.revision, snapshotKey: latest.snapshotKey })
  assert.equal(retry.seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  assert.ok(result.operation)
  assert.notDeepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('an unchanged draft never reaches the provider', { timeout: 5000 }, async t => {
  const f = fixture(t), { seen, complete } = never(), svc = service(f, { complete })
  const result = await svc.apply(request(svc))
  assert.equal(result.operation, null)
  assert.equal(seen.calls, 0)
})

test('an illegal draft never reaches the provider', { timeout: 5000 }, async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = never(), svc = service(f, { complete }), input = request(svc, reversed)
  const groups = [{ ...input.groups[0], itemIds: ['math-a'] }, ...input.groups.slice(1)]
  await assert.rejects(async () => svc.apply({ ...input, groups }), /原有成员|全部可移动|重复/u)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('a capacity dead end never reaches the provider', { timeout: 5000 }, async t => {
  const f = fixture(t)
  f.act({ type: 'save-day-event', event: { id: 'full-day', title: '整日课程', date: LATER, start: '09:00', end: '21:40', location: '', items: [] } })
  const before = f.db.getPlanner(), { seen, complete } = never(), svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, groups => groups.map(group => group.itemIds.includes('physics') ? { ...group, day: 2 } : group))), /分钟/u)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('a DDL dead end never reaches the provider', { timeout: 5000 }, async t => {
  const f = fixture(t)
  f.db.updateTask(f.physics.id, { due: DATE })
  const before = f.db.getPlanner(), { seen, complete } = never(), svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, groups => groups.map(group => group.itemIds.includes('physics') ? { ...group, day: 1 } : group))), /DDL/u)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('a replayed request never reaches the provider again', { timeout: 5000 }, async t => {
  const f = fixture(t), working = model({ changes: [] }), svc = service(f, { complete: working.complete }), input = request(svc, reversed)
  await svc.apply(input)
  const { seen, complete } = never(), replay = await service(f, { complete }).apply(input)
  assert.equal(replay.replayed, true)
  assert.equal(seen.calls, 0)
  assert.equal(working.seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
})

test('simultaneous identical submissions share one model call and one write; another draft on the same request id is refused', async t => {
  const f = fixture(t), events = []
  let release
  const gate = new Promise(resolve => { release = resolve })
  const calls = { count: 0 }
  const complete = async () => { calls.count += 1; await gate; return completion({ changes: [{ index: 2, start: '16:40' }] }) }
  const svc = service(f, { complete }), input = request(svc, reversed)
  const first = svc.apply(input), second = svc.apply(input, { onEvent: event => events.push(event) })
  await assert.rejects(svc.apply({ ...input, groups: input.groups.map(group => ({ ...group, day: 2 })) }), /另一种排序/u)
  release()
  const [one, two] = [await first, await second]
  assert.equal(one.operation.id, two.operation.id)
  assert.equal(calls.count, 1)
  assert.equal(f.db.listOperations().length, 1)
  assert.deepEqual(phaseNames(events), ['checking', 'preparing', 'waiting', 'validating', 'saving'])
})

for (const effort of ['max', 'high', 'low', 'off']) test(`cloud scheduling uses low thinking for ${effort} without touching chat settings`, async t => {
  const sent = []
  const fixture = liveFixture(t, { fetcher: async (url, options) => {
    sent.push({ url: String(url), body: JSON.parse(options.body) })
    return new Response(JSON.stringify(completion({ changes: [] })), { status: 200, headers: { 'Content-Type': 'application/json' } })
  } })
  const { db, svc, dayAfter } = fixture
  const settings = saveModelSettings(db, { ...getModelSettings(db), provider: 'deepseek', cloudModel: 'deepseek-v4-pro', reasoningEffort: effort, contextBudget: { mode: 'off' } })
  assert.equal(settings.reasoningEffort, effort)
  const snap = await snapshotOf(fixture, svc), draft = draftOf(snap), moved = draft.findIndex(group => group.itemIds.includes('api-0'))
  const saved = await invokeService(svc, '/companion/horizon-order', submit(fixture, snap, groups => groups.map((group, index) => index === moved ? { ...group, day: 2 } : group)))
  assert.equal(saved.status, 200)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].url, 'https://api.deepseek.com/chat/completions')
  assert.equal(sent[0].body.model, 'deepseek-v4-pro')
  assert.equal(sent[0].body.reasoning_effort, 'low')
  assert.equal(sent[0].body.thinking.type, 'enabled')
  assert.equal(sent[0].body.tools, undefined)
  assert.equal(sent[0].body.response_format.type, 'json_object')
  // Chat keeps the user's own setting: the cap is request-local.
  assert.equal(getModelSettings(db).reasoningEffort, effort)
  assert.equal(db.getPreference('model-connection').reasoningEffort, effort)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'api-0').date, dayAfter)
})
