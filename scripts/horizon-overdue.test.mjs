import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'

process.env.TZ = 'Asia/Shanghai'
/**
 * Three-day snapshot semantics for work whose planned start already passed:
 *  - an overdue `todo` session stays movable and carries needsReschedule:true
 *  - an overdue `doing` session is underway; a locked session stays locked
 *  - completed, dropped, deleted, history-completed and other days stay out
 *  - the elapsed set is part of the snapshot key, so a clock that passes a
 *    planned start invalidates an old draft without any planner write
 *  - an unchanged group order with overdue work is rescheduled after now
 *    instead of being treated as a local no-op, and still costs one model call,
 *    one atomic write, one replayable receipt and one undo
 */
const DATE = '2026-09-23', LATER = '2026-09-25', YESTERDAY = '2026-09-22', FOURTH = '2026-09-26'
const NOW = `${DATE}T15:10:00+08:00`
const minuteOf = time => { const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute }
const minutesOf = block => minuteOf(block.end) - minuteOf(block.start)
const draftOf = snap => snap.groups.map(group => ({ id: group.id, day: group.day, itemIds: group.tasks.map(task => task.id) }))
/** Rows of this fixture that no newly arranged session may overlap: lunch and both protected sessions. */
const FIXED = [['10:00', '10:20'], ['12:00', '13:00'], ['14:55', '15:55']]
const NOW_MINUTE = minuteOf('15:10')

const fixture = t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  let at = new Date(NOW)
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) act({ type: 'delete-routine', id: row.id })
  const routine = (id, kind, start, end) => ({ type: 'save-routine', routine: { id, title: id, kind, weekdays: [0,1,2,3,4,5,6], start, end, location: '', items: [], enabled: true } })
  act(routine('available', 'available', '09:00', '22:00'))
  act(routine('lunch', 'break', '12:00', '13:00'))
  const block = (id, taskId, start, end, patch = {}) => act({ type: 'save-block', block: { id, taskId, date: DATE, start, end, locked: false, ...patch } })
  const task = (title, patch = {}) => db.createTask({ title, estimateMin: 30, due: LATER, ...patch })
  // Five todo sessions whose planned start is already behind the clock. Only the
  // first one gets a name the deadline tests can find again.
  const overdue = ['late-1', 'late-2', 'late-3', 'late-4', 'late-5']
  const spans = [['09:20', '09:50'], ['10:30', '11:10'], ['13:05', '13:25'], ['13:50', '14:20'], ['14:20', '14:50']]
  overdue.forEach((id, index) => block(id, task(`逾期任务 ${index + 1}`, { area: 'math' }).id, spans[index][0], spans[index][1]))
  const underway = task('进行中任务', { area: 'work' })
  db.updateTask(underway.id, { status: 'doing' })
  block('doing-block', underway.id, '14:55', '15:55')
  // Only a start that already passed makes a doing session underway; its later
  // session today is still ordinary movable work.
  block('doing-future', underway.id, '16:30', '17:00')
  const pinned = task('锁定任务', { area: 'work' })
  block('locked-block', pinned.id, '10:00', '10:20', { locked: true })
  const future = task('未来任务', { area: 'life' })
  block('future', future.id, '16:00', '16:30')
  const done = task('已完成任务', { area: 'math' })
  block('done-block', done.id, '09:00', '09:15')
  db.updateTask(done.id, { status: 'done' })
  const dropped = task('已放下任务', { area: 'math' })
  block('dropped-block', dropped.id, '11:35', '11:50')
  db.updateTask(dropped.id, { status: 'dropped' })
  const deleted = task('已删除任务', { area: 'math' })
  block('deleted-block', deleted.id, '11:15', '11:30')
  db.deleteTask(deleted.id)
  const settled = task('已结算任务', { area: 'math' })
  block('history-block', settled.id, '13:30', '13:50')
  // Out-of-range days live on a task without a deadline so the planner accepts them.
  const outside = db.createTask({ title: '界外任务', area: 'math' })
  block('yesterday', outside.id, '14:00', '14:30', { date: YESTERDAY })
  block('fourth-day', outside.id, '14:00', '14:30', { date: FOURTH })
  db.saveCompanionState({ ...db.getCompanionState(), freeTimeHistory: [{ sessionId: 'history-block' }] })
  return { db, act, block, now: () => at, advance: value => { at = new Date(value) }, overdue, underway, pinned, future, done, dropped, deleted, settled }
}

const service = (f, options = {}) => createHorizonOrder({ db: f.db, now: f.now, ...options })
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })
/** An empty change list accepts the locally verified candidate, which is the ordinary answer. */
const emptyChanges = () => {
  const seen = { calls: 0, payloads: [] }
  return { seen, complete: async payload => { seen.calls += 1; seen.payloads.push(payload); return completion({ changes: [] }) } }
}
/** A model callback that fails the test that installed it whenever it is used. */
const refuseModel = () => {
  const seen = { calls: 0 }
  return { seen, complete: async () => { seen.calls += 1; throw new Error('这次请求应在本地完成，不应调用模型') } }
}
const request = (svc, change = groups => groups) => {
  const snap = svc.list({ date: DATE })
  return { date: DATE, groups: change(draftOf(snap)), expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID() }
}
const itemOf = (snap, id) => snap.items.find(item => item.id === id)
const placedOf = (db, id) => db.getPlanner().blocks.find(block => block.id === id)

test('the three-day snapshot revives overdue todo sessions while underway and locked work stays fixed', t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete }), snap = svc.list({ date: DATE })
  assert.equal(snap.days, 3)
  assert.equal(seen.calls, 0)
  // Overdue todo work is visible and movable again; protected rows stay visible as references.
  assert.deepEqual(snap.items.map(item => item.id), ['late-1', 'locked-block', 'late-2', 'late-3', 'late-4', 'late-5', 'doing-block', 'future', 'doing-future'])
  const overdue = snap.items.filter(item => item.needsReschedule)
  assert.deepEqual(overdue.map(item => item.id), f.overdue)
  assert.ok(overdue.every(item => item.movable))
  assert.deepEqual(overdue.map(item => [item.id, item.date, item.start, item.end, item.durationMin, item.movable]),
    [['late-1', DATE, '09:20', '09:50', 30, true], ['late-2', DATE, '10:30', '11:10', 40, true], ['late-3', DATE, '13:05', '13:25', 20, true],
      ['late-4', DATE, '13:50', '14:20', 30, true], ['late-5', DATE, '14:20', '14:50', 30, true]])
  assert.deepEqual([itemOf(snap, 'doing-block').movable, itemOf(snap, 'doing-block').needsReschedule ?? null, itemOf(snap, 'doing-block').reason],
    [false, null, '正在进行，保留当前安排'])
  assert.deepEqual([itemOf(snap, 'locked-block').movable, itemOf(snap, 'locked-block').reason], [false, '这段时间已锁定'])
  assert.deepEqual([itemOf(snap, 'future').movable, itemOf(snap, 'future').needsReschedule ?? null, itemOf(snap, 'future').start], [true, null, '16:00'])
  assert.deepEqual([itemOf(snap, 'doing-future').movable, itemOf(snap, 'doing-future').needsReschedule ?? null, itemOf(snap, 'doing-future').start], [true, null, '16:30'])
  // Finished, deleted, settled and out-of-range work never enters the three days.
  for (const id of ['done-block', 'dropped-block', 'deleted-block', 'history-block', 'yesterday', 'fourth-day'])
    assert.ok(!itemOf(snap, id), `${id} 不应出现在三天快照中`)
  assert.deepEqual(snap.groups.flatMap(group => group.tasks.map(task => task.id)).sort(), [...f.overdue, 'future', 'doing-future'].sort())
  // Reading a snapshot is never a write.
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  assert.equal(seen.calls, 0)
})

test('reading the same snapshot twice changes neither the planner nor the key', t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  const first = svc.list({ date: DATE }), second = svc.list(), third = svc.list({ date: DATE })
  assert.equal(second.date, DATE)
  assert.equal(first.snapshotKey, second.snapshotKey)
  assert.equal(first.snapshotKey, third.snapshotKey)
  assert.equal(first.revision, third.revision)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  assert.equal(seen.calls, 0)
})

test('an unchanged group order with overdue work is rescheduled after now instead of a no-op', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc), result = await svc.apply(input)
  // The draft is identical to the saved grouping, yet elapsed work still forces
  // one review and one write.
  assert.equal(seen.calls, 1)
  assert.ok(result.operation)
  assert.deepEqual(input.groups, draftOf(svc.list({ date: DATE })))
  assert.match(result.summary, /已按新顺序调整 7 段日程，完整保留 210 分钟/)
  const submitted = input.groups.flatMap(group => group.itemIds)
  assert.equal(submitted.length, 7)
  for (const id of submitted) {
    const block = placedOf(f.db, id), original = before.blocks.find(item => item.id === id)
    assert.equal(block.date, DATE)
    assert.equal(minutesOf(block), minutesOf(original))
    assert.ok(minuteOf(block.start) > NOW_MINUTE, `「${id}」仍停在 ${block.start}，没有排到当前时刻之后`)
  }
  const ordered = submitted.map(id => placedOf(f.db, id))
  for (let index = 1; index < ordered.length; index++)
    assert.ok(minuteOf(ordered[index].start) >= minuteOf(ordered[index - 1].end), `第 ${index + 1} 段没有遵循提交的先后顺序`)
  for (const block of ordered) for (const [start, end] of FIXED)
    assert.ok(minuteOf(block.end) <= minuteOf(start) || minuteOf(block.start) >= minuteOf(end), `「${block.id}」占用了固定安排`)
  // Underway and locked rows are untouched references, not workload.
  for (const id of ['doing-block', 'locked-block']) assert.deepEqual(placedOf(f.db, id), before.blocks.find(block => block.id === id))
  // One receipt, one replay, one undo.
  assert.equal((await svc.apply(input)).replayed, true)
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

for (const id of ['doing-block', 'locked-block']) test(`an underway or locked session can never be submitted as movable work (${id})`, async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete }), input = request(svc)
  const groups = input.groups.map((group, index) => index === 0 ? { ...group, itemIds: [...group.itemIds, id] } : group)
  await assert.rejects(async () => svc.apply({ ...input, groups }), /全部可移动|不属于本次|重复/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a day with no remaining window refuses the overdue reschedule before any provider call', async t => {
  const f = fixture(t)
  f.act({ type: 'save-day-event', event: { id: 'blocked-evening', title: '晚间课程', date: DATE, start: '15:05', end: '22:00', location: '', items: [] } })
  const before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc)), /真实空档只有 0 分钟|空档/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a draft that drops an overdue session is refused instead of quietly rescheduling the rest', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete }), input = request(svc)
  const groups = input.groups.map(group => ({ ...group, itemIds: group.itemIds.filter(id => id !== 'late-5') })).filter(group => group.itemIds.length)
  await assert.rejects(async () => svc.apply({ ...input, groups }), /全部可移动|完整保留/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a clock that passes a planned start changes the snapshot key without rewriting the planner', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  const first = svc.list({ date: DATE })
  const stale = { date: DATE, groups: draftOf(first), expectedRevision: first.revision, snapshotKey: first.snapshotKey, requestId: randomUUID() }
  f.advance(`${DATE}T16:05:00+08:00`)
  const second = svc.list({ date: DATE })
  assert.equal(second.revision, first.revision)
  assert.notEqual(second.snapshotKey, first.snapshotKey)
  assert.deepEqual([itemOf(second, 'future').movable, itemOf(second, 'future').needsReschedule, itemOf(second, 'future').start], [true, true, '16:00'])
  assert.deepEqual(f.db.getPlanner(), before)
  await assert.rejects(svc.apply(stale), /已有变化/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  // The refreshed snapshot still arranges every overdue session after the new clock.
  const { seen: fresh, complete: accept } = emptyChanges(), again = service(f, { complete: accept })
  const latest = again.list({ date: DATE }), result = await again.apply({ ...stale, expectedRevision: latest.revision, snapshotKey: latest.snapshotKey })
  assert.equal(fresh.calls, 1)
  assert.ok(result.operation)
  for (const id of [...f.overdue, 'future', 'doing-future'])
    assert.ok(minuteOf(placedOf(f.db, id).start) > minuteOf('16:05'), `「${id}」仍停在 ${placedOf(f.db, id).start}`)
})

for (const [label, due] of [
  ['a date-only deadline that already passed', YESTERDAY],
  ['a timestamped deadline that already passed today', `${DATE}T10:00:00+08:00`],
]) test(`an overdue session with ${label} is rejected without editing the deadline`, async t => {
  const f = fixture(t)
  const late = f.db.listTasks().find(task => task.title === '逾期任务 1')
  f.db.updateTask(late.id, { due })
  const before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc)), /DDL/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.db.getTask(late.id).due, due)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a model failure while overdue work waits writes nothing and the same request may retry', async t => {
  const f = fixture(t), before = f.db.getPlanner(), calls = { count: 0 }
  const failing = async () => { calls.count += 1; throw new Error('socket closed') }
  const svc = service(f, { complete: failing }), input = request(svc)
  await assert.rejects(svc.apply(input), /模型服务暂时不可用/)
  assert.equal(calls.count, 1)
  // The locally prepared overdue arrangement is never a fallback.
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  const retry = emptyChanges(), again = service(f, { complete: retry.complete }), latest = again.list({ date: DATE })
  const result = await again.apply({ ...input, expectedRevision: latest.revision, snapshotKey: latest.snapshotKey })
  assert.equal(retry.seen.calls, 1)
  assert.ok(result.operation)
  assert.equal(f.db.listOperations().length, 1)
  for (const id of f.overdue) assert.ok(minuteOf(placedOf(f.db, id).start) > NOW_MINUTE)
})

test('a second overdue reschedule after an undo still replays instead of writing twice', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc), first = await svc.apply(input)
  f.db.undoOperation(first.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  const afterUndo = await svc.apply(input)
  assert.equal(afterUndo.replayed, true)
  assert.match(afterUndo.summary, /已撤销/)
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})
