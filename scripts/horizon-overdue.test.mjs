import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'

process.env.TZ = 'Asia/Shanghai'
/**
 * Three-day snapshot contract for work whose planned start already passed:
 *  - every block whose start is not after `now` is an immovable reference in
 *    `items`; an ended slot says 时段已结束, a started-but-unfinished slot says
 *    时段已开始, and a locked slot keeps its own reason
 *  - elapsed todo work is no longer flagged for rescheduling: there is no
 *    needsReschedule field, checking nothing off is not consent to replay the
 *    original slot, and closing an unchanged draft is a local no-op with no
 *    model call and no planner write
 *  - today's elapsed rows stay out of `groups`; only future movable blocks are
 *    editable work, so a day can carry far more elapsed minutes than its
 *    remaining window without blocking tomorrow's real adjustments
 *  - a real future reorder still verifies protection, locks, capacity, full
 *    durations and DDL, and stays replayable, retryable and undoable
 */
const DATE = '2026-09-23', LATER = '2026-09-25', YESTERDAY = '2026-09-22', FOURTH = '2026-09-26'
const NOW = `${DATE}T15:10:00+08:00`
const timeOf = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const minuteOf = time => { const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute }
const minutesOf = block => minuteOf(block.end) - minuteOf(block.start)
const draftOf = snap => snap.groups.map(group => ({ id: group.id, day: group.day, itemIds: group.tasks.map(task => task.id) }))
/** Rows of this fixture that no newly arranged session may overlap: lunch, the lock and the underway session. */
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
  // Five unchecked todo sessions whose planned slot has already ended. They stay
  // visible as original-time references but are not workload again.
  const elapsed = ['late-1', 'late-2', 'late-3', 'late-4', 'late-5']
  const spans = [['09:20', '09:50'], ['10:30', '11:10'], ['13:05', '13:25'], ['13:50', '14:20'], ['14:20', '14:50']]
  const elapsedTasks = elapsed.map((id, index) => {
    const todo = task(`已过任务 ${index + 1}`, { area: 'math' })
    block(id, todo.id, spans[index][0], spans[index][1])
    return todo
  })
  // A doing task whose slot already started is underway and protected; its later
  // session today is still ordinary movable work.
  const underway = task('进行中任务', { area: 'work' })
  db.updateTask(underway.id, { status: 'doing' })
  block('doing-block', underway.id, '14:55', '15:55')
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
  return { db, act, block, now: () => at, advance: value => { at = new Date(value) }, elapsed, elapsedTasks, underway, pinned, future, done, dropped, deleted, settled }
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
const reversed = groups => [...groups].reverse()
const itemOf = (snap, id) => snap.items.find(item => item.id === id)
const placedOf = (db, id) => db.getPlanner().blocks.find(block => block.id === id)
const changedBlocks = (before, db) => db.getPlanner().blocks.filter(block => {
  const previous = before.blocks.find(item => item.id === block.id)
  return !previous || ['date', 'start', 'end', 'horizonGroupId', 'horizonGroupTitle'].some(key => previous[key] !== block[key])
})
const phaseNames = events => events.map(event => event.type === 'phase' ? event.phase : null).filter(Boolean)

test('every started session is an original-time reference in items while only future blocks stay movable', t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete }), snap = svc.list({ date: DATE })
  assert.equal(snap.days, 3)
  assert.equal(seen.calls, 0)
  // Elapsed work stays visible, but a started slot is never offered as movable
  // work again: unchecked todo sessions keep their original calendar reference.
  assert.deepEqual(snap.items.map(item => item.id),
    ['late-1', 'locked-block', 'late-2', 'late-3', 'late-4', 'late-5', 'doing-block', 'future', 'doing-future'])
  assert.deepEqual(f.elapsed.map(id => { const item = itemOf(snap, id); return [id, item.date, item.start, item.end, item.durationMin] }),
    [['late-1', DATE, '09:20', '09:50', 30], ['late-2', DATE, '10:30', '11:10', 40], ['late-3', DATE, '13:05', '13:25', 20],
      ['late-4', DATE, '13:50', '14:20', 30], ['late-5', DATE, '14:20', '14:50', 30]])
  for (const id of f.elapsed) assert.deepEqual([itemOf(snap, id).movable, itemOf(snap, id).reason], [false, '时段已结束，保留原记录'], `${id} 已结束，应保留原记录`)
  assert.deepEqual([itemOf(snap, 'doing-block').movable, itemOf(snap, 'doing-block').reason], [false, '时段已开始，保留原安排'])
  assert.deepEqual([itemOf(snap, 'locked-block').movable, itemOf(snap, 'locked-block').reason], [false, '这段时间已锁定'])
  assert.deepEqual([itemOf(snap, 'future').movable, itemOf(snap, 'future').start], [true, '16:00'])
  assert.deepEqual([itemOf(snap, 'doing-future').movable, itemOf(snap, 'doing-future').start], [true, '16:30'])
  // The retired auto-reschedule flag is gone from the snapshot and from groups.
  assert.ok(snap.items.every(item => !Object.hasOwn(item, 'needsReschedule')), 'items 不应再生成 needsReschedule')
  assert.deepEqual(snap.items.filter(item => minuteOf(item.start) <= NOW_MINUTE).map(item => item.id), ['late-1', 'locked-block', 'late-2', 'late-3', 'late-4', 'late-5', 'doing-block'])
  assert.ok(snap.items.filter(item => minuteOf(item.start) <= NOW_MINUTE).every(item => !item.movable))
  // Finished, deleted, settled and out-of-range work never enters the three days.
  for (const id of ['done-block', 'dropped-block', 'deleted-block', 'history-block', 'yesterday', 'fourth-day'])
    assert.ok(!itemOf(snap, id), `${id} 不应出现在三天快照中`)
  // Today's elapsed rows are references, not group workload.
  const grouped = snap.groups.flatMap(group => group.tasks)
  assert.deepEqual(grouped.map(task => task.id).sort(), ['doing-future', 'future'])
  assert.ok(grouped.every(task => !Object.hasOwn(task, 'needsReschedule')))
  for (const id of [...f.elapsed, 'doing-block', 'locked-block']) assert.ok(!grouped.some(task => task.id === id), `${id} 不应进入可调整分组`)
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

test('closing an unchanged draft with elapsed work is a local no-op that never calls the model', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  const input = request(svc), events = []
  const result = await svc.apply(input, { onEvent: event => events.push(event) })
  // Unchecked elapsed work is not consent to reschedule: closing the untouched
  // draft retains every original placement without a provider round-trip.
  assert.equal(seen.calls, 0)
  assert.equal(result.operation, null)
  assert.match(result.summary, /顺序没有变化/)
  assert.deepEqual(phaseNames(events), ['checking'])
  assert.deepEqual(events.filter(event => event.type === 'activity').map(event => [event.activity.source, event.activity.state]), [['local', 'done']])
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  for (const id of [...f.elapsed, 'doing-block', 'locked-block'])
    assert.deepEqual(placedOf(f.db, id), before.blocks.find(block => block.id === id), `「${id}」不应被重新安排`)
  assert.equal((await svc.apply(input)).replayed, true)
  assert.equal(seen.calls, 0)
})

test('a future reorder changes only future rows and protects every started or locked session', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc, reversed), result = await svc.apply(input)
  assert.equal(seen.calls, 1)
  assert.ok(result.operation?.undoable)
  // Only the two future sessions are editable, so only they may be written.
  const submitted = input.groups.flatMap(group => group.itemIds)
  assert.deepEqual(submitted, ['doing-future', 'future'])
  assert.deepEqual(changedBlocks(before, f.db).map(block => block.id).sort(), ['doing-future', 'future'])
  for (const id of submitted) {
    const block = placedOf(f.db, id), original = before.blocks.find(item => item.id === id)
    assert.equal(block.date, DATE)
    assert.equal(minutesOf(block), minutesOf(original))
    assert.ok(minuteOf(block.start) > NOW_MINUTE, `「${id}」仍停在 ${block.start}，没有排到当前时刻之后`)
  }
  const ordered = submitted.map(id => placedOf(f.db, id))
  assert.deepEqual(ordered.map(block => [block.id, block.start, block.end]), [['doing-future', '16:30', '17:00'], ['future', '17:00', '17:30']])
  for (let index = 1; index < ordered.length; index++)
    assert.ok(minuteOf(ordered[index].start) >= minuteOf(ordered[index - 1].end), `第 ${index + 1} 段没有遵循提交的先后顺序`)
  for (const block of ordered) for (const [start, end] of FIXED)
    assert.ok(minuteOf(block.end) <= minuteOf(start) || minuteOf(block.start) >= minuteOf(end), `「${block.id}」占用了固定安排`)
  // Elapsed and locked rows are untouched references, including their times,
  // task status and (absent) grouping metadata.
  for (const id of [...f.elapsed, 'doing-block', 'locked-block'])
    assert.deepEqual(placedOf(f.db, id), before.blocks.find(block => block.id === id), `「${id}」不应被重新安排`)
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('an in-progress todo slot stays fixed through a future reorder although the task is unchecked', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const at = new Date(NOW)
  const act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) act({ type: 'delete-routine', id: row.id })
  act({ type: 'save-routine', routine: { id: 'available', title: 'available', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
  const block = (id, taskId, start, end) => act({ type: 'save-block', block: { id, taskId, date: DATE, start, end, locked: false } })
  // The slot is underway but the task itself is still an unchecked todo.
  const started = db.createTask({ title: '未勾选的进行中任务', area: 'math', due: LATER })
  block('in-progress', started.id, '15:05', '15:35')
  const life = db.createTask({ title: '晚间生活', area: 'life', due: LATER })
  block('future-a', life.id, '16:00', '16:30')
  const work = db.createTask({ title: '晚间工作', area: 'work', due: LATER })
  block('future-b', work.id, '17:00', '17:30')
  const before = db.getPlanner(), { seen, complete } = refuseModel(), svc = createHorizonOrder({ db, now: () => at, complete })
  const snap = svc.list({ date: DATE })
  assert.equal(db.getTask(started.id).status, 'todo')
  assert.deepEqual(snap.items.map(item => item.id), ['in-progress', 'future-a', 'future-b'])
  assert.deepEqual([itemOf(snap, 'in-progress').movable, itemOf(snap, 'in-progress').reason, Object.hasOwn(itemOf(snap, 'in-progress'), 'needsReschedule')],
    [false, '时段已开始，保留原安排', false])
  assert.deepEqual(snap.groups.flatMap(group => group.tasks.map(task => task.id)), ['future-a', 'future-b'])
  // Closing the untouched draft remains a no-op even with an unchecked,
  // already-started session on the calendar.
  const closed = await svc.apply(request(svc))
  assert.equal(seen.calls, 0)
  assert.equal(closed.operation, null)
  assert.deepEqual(db.getPlanner(), before)
  // A real reorder of the two future groups never pulls the underway todo slot
  // back into scheduling work.
  const { seen: tuning, complete: accept } = emptyChanges(), again = createHorizonOrder({ db, now: () => at, complete: accept })
  const result = await again.apply(request(again, reversed))
  assert.equal(tuning.calls, 1)
  assert.ok(result.operation?.undoable)
  assert.deepEqual(placedOf(db, 'in-progress'), before.blocks.find(block => block.id === 'in-progress'))
  assert.deepEqual(['future-a', 'future-b'].map(id => { const row = placedOf(db, id); return [row.id, row.start, row.end] }),
    [['future-a', '17:30', '18:00'], ['future-b', '17:00', '17:30']])
  assert.equal(minutesOf(placedOf(db, 'future-a')), 30)
  db.undoOperation(result.operation.id)
  assert.deepEqual(db.getPlanner().blocks, before.blocks)
})

test('drafting an elapsed, underway or locked row as movable work is rejected before any provider call', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  for (const pastId of [...f.elapsed, 'doing-block', 'locked-block']) {
    const input = request(svc)
    const groups = input.groups.map((group, index) => index === 0 ? { ...group, itemIds: [...group.itemIds, pastId] } : group)
    await assert.rejects(async () => svc.apply({ ...input, groups, requestId: randomUUID() }), /可移动|开始|锁定|不属于本次/, pastId)
  }
  // Dropping a future movable row is equally invalid: a draft must keep the
  // complete future workload, it cannot silently re-plan around it.
  const dropped = request(svc), groups = dropped.groups.map(group => ({ ...group, itemIds: group.itemIds.filter(id => id !== 'future') })).filter(group => group.itemIds.length)
  await assert.rejects(async () => svc.apply({ ...dropped, groups }), /可移动|完整保留|不属于本次/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a clock that passes a planned start changes the snapshot key and rejects the stale draft', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  const first = svc.list({ date: DATE })
  const stale = { date: DATE, groups: draftOf(first), expectedRevision: first.revision, snapshotKey: first.snapshotKey, requestId: randomUUID() }
  f.advance(`${DATE}T16:05:00+08:00`)
  const second = svc.list({ date: DATE })
  assert.equal(second.revision, first.revision)
  assert.notEqual(second.snapshotKey, first.snapshotKey)
  // The 16:00 session started while the clock moved; it is protected now and
  // only the still-future session remains movable.
  assert.deepEqual([itemOf(second, 'future').movable, itemOf(second, 'future').reason], [false, '时段已开始，保留原安排'])
  assert.deepEqual([itemOf(second, 'doing-future').movable, itemOf(second, 'doing-future').start], [true, '16:30'])
  assert.deepEqual(second.groups.flatMap(group => group.tasks.map(task => task.id)), ['doing-future'])
  assert.deepEqual(f.db.getPlanner(), before)
  await assert.rejects(svc.apply(stale), /已有变化/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  // The refreshed snapshot accepts closing its own unchanged draft as a no-op.
  const latest = svc.list({ date: DATE })
  const fresh = { date: DATE, groups: draftOf(latest), expectedRevision: latest.revision, snapshotKey: latest.snapshotKey, requestId: randomUUID() }
  const result = await svc.apply(fresh)
  assert.equal(result.operation, null)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

for (const [label, index, due] of [
  ['a date-only deadline that already passed', 0, YESTERDAY],
  ['a timestamped deadline that passed earlier today', 1, `${DATE}T10:00:00+08:00`],
]) test(`an elapsed session with ${label} does not block a future reorder`, async t => {
  const f = fixture(t), late = f.elapsedTasks[index]
  f.db.updateTask(late.id, { due })
  const before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const result = await svc.apply(request(svc, reversed))
  // A historical DDL belongs to an ended reference row and stays out of the
  // validation scope of the future work the user actually adjusted.
  assert.equal(seen.calls, 1)
  assert.ok(result.operation?.undoable)
  assert.match(result.summary, /已按新顺序调整/)
  assert.equal(f.db.getTask(late.id).due, due)
  for (const id of [...f.elapsed, 'doing-block', 'locked-block'])
    assert.deepEqual(placedOf(f.db, id), before.blocks.find(block => block.id === id), `「${id}」不应被重新安排`)
  for (const id of ['future', 'doing-future']) {
    const block = placedOf(f.db, id)
    assert.equal(minutesOf(block), minutesOf(before.blocks.find(item => item.id === id)))
    assert.ok(minuteOf(block.start) > NOW_MINUTE)
  }
})

test('a real future reorder with no remaining window is rejected locally while closing unchanged stays a no-op', async t => {
  const f = fixture(t)
  f.act({ type: 'save-day-event', event: { id: 'blocked-evening', title: '晚间课程', date: DATE, start: '15:05', end: '22:00', location: '', items: [] } })
  const before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  // An unchanged draft is never capacity-checked: the elapsed rows are not
  // workload to replay, so a full evening cannot turn a no-op into an error.
  const unchanged = await svc.apply(request(svc))
  assert.equal(unchanged.operation, null)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  // The future reorder itself has no real window left and fails before the model.
  await assert.rejects(svc.apply(request(svc, reversed)), /真实空档只有 0 分钟|空档/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a model failure during a future reorder writes nothing and the same request may retry', async t => {
  const f = fixture(t), before = f.db.getPlanner(), calls = { count: 0 }
  const failing = async () => { calls.count += 1; throw new Error('socket closed') }
  const svc = service(f, { complete: failing }), input = request(svc, reversed)
  await assert.rejects(svc.apply(input), /模型服务暂时不可用/)
  assert.equal(calls.count, 1)
  // The locally prepared candidate is never a fallback after a provider failure.
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  const retry = emptyChanges(), again = service(f, { complete: retry.complete }), latest = again.list({ date: DATE })
  const result = await again.apply({ ...input, expectedRevision: latest.revision, snapshotKey: latest.snapshotKey })
  assert.equal(retry.seen.calls, 1)
  assert.ok(result.operation)
  assert.equal(f.db.listOperations().length, 1)
  for (const id of f.elapsed) assert.deepEqual(placedOf(f.db, id), before.blocks.find(block => block.id === id))
  for (const id of ['future', 'doing-future']) assert.ok(minuteOf(placedOf(f.db, id).start) > NOW_MINUTE)
})

test('a second future reorder after an undo still replays instead of writing twice', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc, reversed), first = await svc.apply(input)
  const replay = await service(f, { complete }).apply(input)
  assert.equal(replay.operation.id, first.operation.id)
  assert.equal(replay.replayed, true)
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  f.db.undoOperation(first.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  const afterUndo = await svc.apply(input)
  assert.equal(afterUndo.replayed, true)
  assert.match(afterUndo.summary, /已撤销/)
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('at 21:47, 550 elapsed minutes leave 72 and are never replayed by a close or by a future reorder', async t => {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const at = new Date(`${DATE}T21:47:00+08:00`), act = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) act({ type: 'delete-routine', id: row.id })
  act({ type: 'save-routine', routine: { id: 'available', title: 'available', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '23:00', location: '', items: [], enabled: true } })
  const block = (id, taskId, start, end) => act({ type: 'save-block', block: { id, taskId, date: DATE, start, end, locked: false } })
  // Eleven unchecked 50-minute todo sessions from 09:00 to 18:10: exactly 550
  // minutes of elapsed work on a day whose remaining window is 21:48–23:00.
  const elapsed = [], elapsedTasks = []
  let cursor = minuteOf('09:00')
  for (let index = 0; index < 11; index++) {
    const todo = db.createTask({ title: `已过任务 ${index + 1}`, area: index % 2 ? 'math' : 'work', due: LATER })
    block(`elapsed-${index}`, todo.id, timeOf(cursor), timeOf(cursor + 50))
    elapsed.push(`elapsed-${index}`); elapsedTasks.push(todo); cursor += 50
  }
  // Legacy history: one elapsed session carries a deadline that already passed.
  db.updateTask(elapsedTasks[0].id, { due: YESTERDAY })
  const life = db.createTask({ title: '晚间生活', area: 'life', due: LATER })
  block('future-a', life.id, '22:00', '22:30')
  const work = db.createTask({ title: '晚间工作', area: 'work', due: LATER })
  block('future-b', work.id, '22:30', '23:00')
  const before = db.getPlanner(), { seen, complete } = refuseModel(), svc = createHorizonOrder({ db, now: () => at, complete })
  const snap = svc.list({ date: DATE })
  const references = snap.items.filter(item => elapsed.includes(item.id))
  assert.equal(references.length, 11)
  assert.equal(references.reduce((sum, item) => sum + item.durationMin, 0), 550)
  assert.ok(references.every(item => !item.movable && item.reason === '时段已结束，保留原记录'))
  assert.ok(snap.items.every(item => !Object.hasOwn(item, 'needsReschedule')))
  assert.deepEqual(snap.items.filter(item => item.movable).map(item => item.id), ['future-a', 'future-b'])
  assert.deepEqual(snap.groups.flatMap(group => group.tasks.map(task => task.id)), ['future-a', 'future-b'])
  // Closing the unchanged draft does not try to fit 550 elapsed minutes into
  // the 72 real minutes that are left: it is a pure local no-op.
  const closed = await svc.apply(request(svc))
  assert.equal(seen.calls, 0)
  assert.equal(closed.operation, null)
  assert.match(closed.summary, /顺序没有变化/)
  assert.deepEqual(db.getPlanner(), before)
  assert.deepEqual(db.listOperations(), [])
  // The future reorder only needs its own 60 minutes and reports the real
  // remaining window; no elapsed row is rewritten.
  const { seen: tuning, complete: accept } = emptyChanges(), events = [], again = createHorizonOrder({ db, now: () => at, complete: accept })
  const result = await again.apply(request(again, reversed), { onEvent: event => events.push(event) })
  assert.equal(tuning.calls, 1)
  assert.ok(result.operation?.undoable)
  const capacity = events.find(event => event.type === 'activity' && event.activity.id === 'capacity:0')
  assert.match(capacity.activity.title, /核对 2 段 · 60 分钟/)
  assert.match(capacity.activity.detail, /共 72 分钟/)
  for (const id of elapsed) assert.deepEqual(placedOf(db, id), before.blocks.find(block => block.id === id), `「${id}」的过去时段不应被重新安排`)
  const ordered = ['future-b', 'future-a'].map(id => placedOf(db, id))
  assert.deepEqual(ordered.map(block => [block.id, block.start, block.end]), [['future-b', '21:48', '22:18'], ['future-a', '22:18', '22:48']])
  for (const block of ordered) assert.ok(minuteOf(block.start) >= minuteOf('21:48') && minuteOf(block.end) <= minuteOf('23:00'))
  db.undoOperation(result.operation.id)
  assert.deepEqual(db.getPlanner().blocks, before.blocks)
})
