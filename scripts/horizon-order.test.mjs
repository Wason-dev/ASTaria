import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createHorizonOrder } from '../server/horizonOrder.mjs'
import { createLocalService } from '../server/index.mjs'
import { localDay } from '../src/home/agenda.ts'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-23', TOMORROW = '2026-09-24', LATER = '2026-09-25'
const dates = [DATE, TOMORROW, LATER]
const timeOf = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
const minuteOf = time => { const [hour, minute] = time.split(':').map(Number); return hour * 60 + minute }
const minutesOf = block => minuteOf(block.end) - minuteOf(block.start)
const placements = db => db.getPlanner().blocks.map(block => [block.id, block.date, block.start, block.end])
const placementsOf = planner => planner.blocks.map(block => [block.id, block.date, block.start, block.end])
const blocksOf = (db, groups) => groups.flatMap(group => group.itemIds).map(id => db.getPlanner().blocks.find(block => block.id === id))
/** The submitted group order and member order hold globally: no later session may start before an earlier one ends. */
const assertGlobalOrder = (db, groups) => {
  const ordered = blocksOf(db, groups)
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1], current = ordered[index]
    assert.ok(`${current.date}T${current.start}` >= `${previous.date}T${previous.end}`, `第 ${index + 1} 段没有遵循提交的先后顺序`)
  }
  return ordered
}
/** The fixed rows of the fixture that no arranged session may overlap. */
const FIXED = [['09:00', '09:30'], ['10:00', '10:30'], ['12:00', '13:00']]

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
  // `begun` represents work that is genuinely underway: its task is doing, so an
  // elapsed start stays protected instead of being pulled back for rescheduling.
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
/**
 * The three-day flow is one model fine-tune of a locally verified candidate:
 * the backend prepares and verifies the arrangement, then asks the model for
 * `{"changes":[{"index":0,"start":"HH:mm"}]}` where `index` addresses the
 * submitted order and date/duration stay local. The model may also return
 * `{"updates":[...]}` review notes, which only feed the public activity feed.
 * These constraint regressions therefore wire a completion that either accepts
 * the candidate unchanged (`emptyChanges`) or fails the test that installed it
 * (`refuseModel`).
 */
const service = (f, options = {}) => createHorizonOrder({ db: f.db, now: f.now, ...options })
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })
/** An empty change list accepts the local candidate, which is the ordinary "nothing to tune" answer. */
const emptyChanges = () => {
  const seen = { calls: 0, payloads: [] }
  return { seen, complete: async payload => { seen.calls += 1; seen.payloads.push(payload); return completion({ changes: [] }) } }
}
/** A model callback that fails the test that installed it whenever it is used. */
const refuseModel = () => {
  const seen = { calls: 0 }
  return { seen, complete: async () => { seen.calls += 1; throw new Error('这次请求应在本地完成，不应调用模型') } }
}
const PHASES = ['checking', 'preparing', 'waiting', 'thinking', 'receiving', 'validating', 'saving']
const phaseNames = events => events.map(event => event.type === 'phase' ? event.phase : null).filter(Boolean)
const draftOf = snap => snap.groups.map(group => ({ id: group.id, day: group.day, itemIds: group.tasks.map(task => task.id) }))
const request = (svc, change = groups => groups) => {
  const snap = svc.list({ date: DATE })
  return { date: DATE, groups: change(draftOf(snap)), expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID() }
}
const reversed = groups => [...groups.filter(group => group.day === 0).reverse().map(group => ({ ...group, itemIds: [...group.itemIds].reverse() })), ...groups.filter(group => group.day !== 0)]
/** Swap the two same-day groups without reversing their members. */
const swapped = groups => [...groups.filter(group => group.day === 0).reverse(), ...groups.filter(group => group.day !== 0)]
/** The candidate the local packer produces for the reversed draft, in submitted order. */
const CANDIDATE = [['physics', DATE, '15:00', '15:40'], ['math-b', DATE, '16:00', '16:20'], ['math-a', DATE, '16:20', '16:50'], ['reading', TOMORROW, '11:00', '11:25']]
/** Blocks whose placement or saved grouping metadata changed, which is what a receipt counts. */
const changedBlocks = (before, after) => after.blocks.filter(block => {
  const previous = before.blocks.find(item => item.id === block.id)
  return !previous || ['date', 'start', 'end', 'horizonGroupId', 'horizonGroupTitle'].some(key => previous[key] !== block[key])
})

test('three-day groups contain each real movable block exactly once; locks are references and tasks without blocks stay out', t => {
  const f = fixture(t), before = f.db.getPlanner(), svc = service(f), snap = svc.list({ date: DATE })
  assert.equal(snap.days, 3)
  assert.equal(snap.groupingSaved, false)
  assert.equal(snap.groups.length, 3)
  assert.deepEqual(snap.groups.map(group => [group.title, group.day]), [['数学', 0], ['物理', 0], ['读完这本书', 1]])
  assert.deepEqual(snap.groups[0].tasks.map(task => [task.id, task.minutes]), [['math-a', 30], ['math-b', 20]])
  assert.equal(snap.groups[2].project, '语文')
  // Elapsed work stays in the snapshot: underway and locked sessions are visible
  // references, while overdue todo sessions are movable again with a flag.
  assert.deepEqual(snap.items.map(item => item.id), ['begun', 'locked', 'math-a', 'physics', 'math-b', 'reading'])
  assert.deepEqual(snap.items.slice(0, 2).map(item => [item.id, item.movable, item.needsReschedule ?? null, item.reason]),
    [['begun', false, null, '正在进行，保留当前安排'], ['locked', false, null, '这段时间已锁定']])
  assert.ok(snap.items.slice(2).every(item => item.movable && item.needsReschedule === undefined))
  assert.deepEqual(svc.list().groups, snap.groups)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('large same-day categories split into bounded six-session groups without hiding workload', t => {
  const f = fixture(t)
  for (let index = 0; index < 9; index++) f.block(`extra-${index}`, f.math.id, timeOf(1020 + index * 10), timeOf(1025 + index * 10))
  const snap = service(f).list(), tasks = snap.groups.flatMap(group => group.tasks)
  assert.ok(snap.groups.every(group => group.tasks.length <= 6))
  assert.equal(tasks.length, 13)
  assert.equal(new Set(tasks.map(task => task.id)).size, tasks.length)
  assert.deepEqual(snap.groups.filter(group => group.title.startsWith('数学')).map(group => group.tasks.length), [6, 5])
})

test('untouched interleaved grouping is a local no-op that never calls the model and stays replayable', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  const input = request(svc), events = [], result = await svc.apply(input, { onEvent: event => events.push(event) })
  assert.equal(seen.calls, 0)
  assert.equal(result.operation, null)
  // A no-op reports its local preflight activity but never enters a provider phase.
  assert.deepEqual(phaseNames(events), ['checking'])
  assert.deepEqual(events.filter(event => event.type === 'activity').map(event => [event.activity.source, event.activity.state]),
    [['local', 'done']])
  assert.ok(!events.some(event => PHASES.includes(event.phase) && event.phase !== 'checking'))
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  assert.equal((await svc.apply(input)).replayed, true)
  assert.equal(seen.calls, 0)
})

test('three-day horizon fine-tunes the locally verified candidate once and keeps day, order, duration and locks', async t => {
  const f = fixture(t), before = f.db.getPlanner(), tasks = f.db.listTasks(), companion = f.db.getCompanionState()
  const { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc, reversed), result = await svc.apply(input)
  // The arrangement itself stays local and deterministic; the model only reviews it once.
  assert.equal(seen.calls, 1)
  assert.equal(result.operation.undoable, true)
  assert.equal(result.days, 3)
  assert.ok(result.groups.length)
  // The receipt counts every written block: the time change plus the group
  // metadata each newly arranged session now carries.
  assert.match(result.summary, new RegExp(`已按新顺序调整 ${changedBlocks(before, f.db.getPlanner()).length} 段日程`))
  assert.equal(f.db.listOperations().length, 1)
  // Requester order is [物理, 数学(math-b, math-a), 读完这本书]; empty changes accept the local candidate.
  const placed = id => f.db.getPlanner().blocks.find(block => block.id === id)
  assert.deepEqual(['physics', 'math-b', 'math-a', 'reading'].map(id => [id, placed(id).date, placed(id).start, placed(id).end]), CANDIDATE)
  for (const group of input.groups) for (const id of group.itemIds) {
    const block = f.db.getPlanner().blocks.find(item => item.id === id), original = before.blocks.find(item => item.id === id)
    assert.equal(block.date, dates[group.day])
    assert.equal(minutesOf(block), minutesOf(original))
    // Times follow the candidate; the saved grouping follows the submitted groups.
    assert.equal(block.horizonGroupId, group.id)
    assert.equal(block.horizonGroupTitle, result.groups.find(item => item.id === group.id).title)
  }
  const ordered = assertGlobalOrder(f.db, input.groups)
  for (const block of ordered.filter(item => item.date === DATE)) for (const [start, end] of FIXED)
    assert.ok(minuteOf(block.end) <= minuteOf(start) || minuteOf(block.start) >= minuteOf(end), `「${block.id}」占用了固定安排`)
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.deepEqual(f.db.getCompanionState(), companion)
  for (const id of ['locked', 'begun', 'fourth-day']) assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === id), before.blocks.find(block => block.id === id))
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('identical drafts fine-tune identically and moving one group only moves that group', async t => {
  const f = fixture(t), twin = fixture(t), first = service(f, emptyChanges()), second = service(twin, emptyChanges())
  const input = request(first, reversed), mirror = request(second, reversed)
  assert.deepEqual(input.groups, mirror.groups)
  await first.apply(input)
  await second.apply(mirror)
  assert.deepEqual(placements(f.db), placements(twin.db))
  const groups = service(f).list({ date: DATE }).groups
  const physics = groups.find(group => group.tasks.some(task => task.id === 'physics')), before = f.db.getPlanner()
  const { seen, complete } = emptyChanges()
  const result = await service(f, { complete }).apply(request(service(f), draft => draft.map(group => group.id === physics.id ? { ...group, day: 2 } : group)))
  assert.equal(seen.calls, 1)
  assert.equal(f.db.getPlanner().blocks.find(block => block.id === 'physics').date, LATER)
  assert.equal(minutesOf(f.db.getPlanner().blocks.find(block => block.id === 'physics')), 40)
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('swapping two groups keeps the global group order without reversing the members', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc, swapped), result = await svc.apply(input)
  assert.equal(seen.calls, 1)
  assert.equal(result.operation.undoable, true)
  assert.deepEqual(input.groups.filter(group => group.day === 0).map(group => group.itemIds), [['physics'], ['math-a', 'math-b']])
  const ordered = assertGlobalOrder(f.db, input.groups)
  assert.deepEqual(ordered.slice(0, 3).map(block => [block.id, block.date]), [['physics', DATE], ['math-a', DATE], ['math-b', DATE]])
  assert.equal(ordered[3].date, TOMORROW)
  for (const id of ['physics', 'math-a', 'math-b', 'reading']) {
    const block = f.db.getPlanner().blocks.find(item => item.id === id), original = before.blocks.find(item => item.id === id)
    assert.equal(minutesOf(block), minutesOf(original))
  }
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('a late preferred slot moves earlier so the session that follows still fits', async t => {
  const f = fixture(t), late = f.db.createTask({ title: '英语听力', area: 'english' })
  f.block('late-a', late.id, '21:20', '21:50', { date: TOMORROW })
  f.block('late-b', late.id, '20:00', '20:40', { date: TOMORROW })
  const before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc, draft => draft.map(group => group.itemIds.includes('late-a') ? { ...group, itemIds: [...group.itemIds].reverse() } : group))
  assert.deepEqual(input.groups.find(group => group.itemIds.includes('late-a')).itemIds, ['late-a', 'late-b'])
  const result = await svc.apply(input)
  assert.equal(seen.calls, 1)
  assert.equal(result.operation.undoable, true)
  const ordered = assertGlobalOrder(f.db, input.groups), placed = id => f.db.getPlanner().blocks.find(block => block.id === id)
  assert.deepEqual(ordered.filter(block => block.id.startsWith('late-')).map(block => block.id), ['late-a', 'late-b'])
  for (const [id, minutes] of [['late-a', 30], ['late-b', 40]]) {
    assert.equal(placed(id).date, TOMORROW)
    assert.equal(minutesOf(placed(id)), minutes)
  }
  assert.ok(minuteOf(placed('late-a').start) < minuteOf('21:20'), `late-a 仍停在 ${placed('late-a').start}，后面的 40 分钟排不进当天空档`)
  assert.ok(minuteOf(placed('late-b').end) <= minuteOf('22:00'))
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('a fragmented day rejects an order that cannot be packed without splitting a session and never calls the model', async t => {
  const f = fixture(t), long = f.db.createTask({ title: '长段练习', area: 'life' })
  f.block('long-a', long.id, '14:00', '14:45', { date: LATER })
  f.block('long-b', long.id, '16:00', '16:45', { date: LATER })
  f.block('long-c', long.id, '20:00', '20:15', { date: LATER })
  for (const [id, start, end] of [['morning', '09:00', '14:00'], ['midday', '15:00', '16:00'], ['evening', '16:45', '22:00']])
    f.act({ type: 'save-day-event', event: { id, title: id, date: LATER, start, end, location: '', items: [] } })
  const before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  const input = request(svc, draft => draft.map(group => group.itemIds.includes('long-a') ? { ...group, itemIds: ['long-b', 'long-a', 'long-c'] } : group))
  await assert.rejects(svc.apply(input), /空档/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('groups may split, merge and invent new titled groups while an old title stays optional', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc), [math, physics, reading] = input.groups
  const groups = [
    { id: 'horizon-group-combined', title: '联合理科', day: 0, itemIds: ['math-a', 'physics'] },
    { id: 'horizon-group-tail', title: '数学尾段', day: 0, itemIds: ['math-b'] },
    { id: reading.id, day: reading.day, itemIds: reading.itemIds },
  ]
  const result = await svc.apply({ ...input, groups })
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  const saved = id => { const block = f.db.getPlanner().blocks.find(item => item.id === id); return [block.horizonGroupId, block.horizonGroupTitle] }
  assert.deepEqual(Object.fromEntries(groups.flatMap(group => group.itemIds).map(id => [id, saved(id)])), {
    'math-a': ['horizon-group-combined', '联合理科'], physics: ['horizon-group-combined', '联合理科'],
    'math-b': ['horizon-group-tail', '数学尾段'], reading: [reading.id, '读完这本书'],
  })
  // Times did not move: this transaction only persisted the new grouping.
  assert.deepEqual(placementsOf(f.db.getPlanner()), placementsOf(before))
  const after = f.db.getPlanner(), changed = changedBlocks(before, after)
  assert.equal(changed.length, 4)
  assert.ok(changed.every(block => {
    const previous = before.blocks.find(item => item.id === block.id)
    return ['date', 'start', 'end'].every(key => previous[key] === block[key])
  }))
  assert.match(result.summary, /已按新顺序调整 4 段日程/)
  // Saved membership wins on the next read, and the omitted old title is kept.
  const next = svc.list({ date: DATE })
  assert.equal(next.groupingSaved, true)
  assert.deepEqual(next.groups.map(group => [group.id, group.title, group.day, group.tasks.map(task => task.id)]), [
    ['horizon-group-combined', '联合理科', 0, ['math-a', 'physics']],
    ['horizon-group-tail', '数学尾段', 0, ['math-b']],
    [reading.id, '读完这本书', 1, ['reading']],
  ])
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('invalid days, omitted, duplicated, foreign and over-long groups are rejected before local scheduling', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete }), input = request(svc)
  const [math, physics, reading] = input.groups
  for (const [rule, groups, pattern] of [
    ['a day outside the three-day horizon', [{ ...math, day: 3 }, physics, reading], /后天/],
    ['a draft that drops a movable session', [math, physics], /全部可移动|完整保留/],
    ['the same session twice in one group', [{ ...math, itemIds: ['math-a', 'math-a'] }, physics, reading], /重复/],
    ['a locked session smuggled into a group', [{ ...math, itemIds: ['math-a', 'locked'] }, physics, reading], /全部可移动|不属于本次|重复/],
    ['two groups sharing one id', [math, { ...physics, id: math.id }, reading], /重复分组/],
    ['a brand-new group without a title', [{ ...math, id: 'horizon-group-brand-new' }, physics, reading], /组名称/],
    ['an over-long group title', [{ ...math, title: '长'.repeat(161) }, physics, reading], /组名/],
  ]) await assert.rejects(async () => svc.apply({ ...input, groups, requestId: randomUUID() }), pattern, rule)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a group may not hold more than six sessions', async t => {
  const f = fixture(t)
  for (let index = 0; index < 4; index++) f.block(`extra-${index}`, f.math.id, timeOf(1020 + index * 10), timeOf(1025 + index * 10))
  const before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  const input = request(svc, groups => [{ id: 'horizon-group-everything', title: '全部', day: 0, itemIds: groups.flatMap(group => group.itemIds).filter(id => id !== 'reading') }, groups.find(group => group.itemIds.includes('reading'))])
  assert.equal(input.groups[0].itemIds.length, 7)
  await assert.rejects(async () => svc.apply(input), /1–6 段/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

for (const constraint of ['DDL', 'occurrence', 'goal']) test(`${constraint} blocks invalid cross-day movement before local scheduling`, async t => {
  const f = fixture(t)
  if (constraint === 'DDL') f.db.updateTask(f.physics.id, { due: DATE })
  if (constraint === 'occurrence') f.db.updateTask(f.physics.id, { estimateMin: 40, occurrence: { seriesId: 'daily', date: DATE, allowFallback: true, placement: 'start' } })
  if (constraint === 'goal') f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeGoals: [{ id: 'physics-goal', taskId: f.physics.id, targetDate: DATE }] })
  const { seen, complete } = refuseModel(), svc = service(f, { complete }), before = f.db.getPlanner()
  await assert.rejects(svc.apply(request(svc, groups => groups.map(group => group.itemIds.includes('physics') ? { ...group, day: 1 } : group))), /DDL|重复事项|目标日期/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('a same-day deadline is met by arranging the session earlier instead of failing', async t => {
  const f = fixture(t)
  f.db.updateTask(f.physics.id, { due: `${DATE}T13:20:00+08:00` })
  const { seen, complete } = emptyChanges(), svc = service(f, { complete })
  const input = request(svc, reversed), result = await svc.apply(input)
  assert.equal(seen.calls, 1)
  assert.equal(result.operation.undoable, true)
  const physics = f.db.getPlanner().blocks.find(block => block.id === 'physics')
  assert.equal(physics.date, DATE)
  assert.equal(minutesOf(physics), 40)
  assert.ok(minuteOf(physics.end) <= minuteOf('13:20'), `physics 结束时间 ${physics.end} 超过了同日 DDL 13:20`)
  assertGlobalOrder(f.db, input.groups)
  // The fixture's own 15:00 placement already breaks the freshly set deadline,
  // so the planner refuses to restore it; undo is covered by the other
  // arrangement tests, and this one only proves the deadline can still be met.
})

test('an exact-minute clock uses the next minute when an earlier slot is required', async t => {
  const f = fixture(t)
  f.block('physics', f.physics.id, '15:00', '15:25')
  f.db.updateTask(f.physics.id, { due: `${DATE}T10:00:00+08:00` })
  f.advance(`${DATE}T09:30:00+08:00`)
  const { seen, complete } = emptyChanges(), svc = service(f, { complete })
  await svc.apply(request(svc, reversed))
  assert.equal(seen.calls, 1)
  const physics = f.db.getPlanner().blocks.find(block => block.id === 'physics')
  assert.equal(physics.start, '09:31')
  assert.equal(physics.end, '09:56')
})

test('a same-day deadline with no room before it still rejects the whole draft', async t => {
  const f = fixture(t)
  f.db.updateTask(f.physics.id, { due: `${DATE}T10:00:00+08:00` })
  const before = f.db.getPlanner(), { seen, complete } = refuseModel(), svc = service(f, { complete })
  await assert.rejects(svc.apply(request(svc, reversed)), /DDL/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('an overfull target day fails immediately with concrete capacity instead of arranging locally', async t => {
  const f = fixture(t)
  f.act({ type: 'save-day-event', event: { id: 'full-day', title: '整日课程', date: LATER, start: '09:00', end: '21:40', location: '', items: [] } })
  const { seen, complete } = refuseModel(), svc = service(f, { complete }), before = f.db.getPlanner()
  await assert.rejects(svc.apply(request(svc, groups => groups.map(group => group.itemIds.includes('physics') ? { ...group, day: 2 } : group))), /2026-09-25.*40 分钟.*20 分钟/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('fragmented capacity cannot masquerade as a continuous slot for an intact session', async t => {
  const f = fixture(t)
  f.act({ type: 'save-day-event', event: { id: 'most-day', title: '课程', date: LATER, start: '09:00', end: '21:00', location: '', items: [] } })
  f.act({ type: 'save-day-event', event: { id: 'split-slot', title: '会议', date: LATER, start: '21:20', end: '21:40', location: '', items: [] } })
  const { seen, complete } = refuseModel(), svc = service(f, { complete }), before = f.db.getPlanner()
  await assert.rejects(svc.apply(request(svc, groups => groups.map(group => group.itemIds.includes('physics') ? { ...group, day: 2 } : group))), /连续 40 分钟.*20 分钟/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

for (const [change, mutate] of [
  ['task', f => f.db.updateTask(f.math.id, { title: '数学新标题' })],
  ['planner', f => f.act({ type: 'check-item', date: DATE, key: 'book', checked: true })],
  ['area', f => f.db.renameArea('math', '新数学')],
  ['history', f => f.db.saveCompanionState({ ...f.db.getCompanionState(), freeTimeHistory: [{ sessionId: 'reading' }] })],
  ['started', f => f.advance(`${DATE}T14:05:00+08:00`)],
]) test(`${change} changes invalidate a captured horizon snapshot before local scheduling`, async t => {
  const f = fixture(t), { seen, complete } = refuseModel(), svc = service(f, { complete }), before = f.db.getPlanner(), input = request(svc, reversed)
  mutate(f)
  await assert.rejects(svc.apply(input), /已有变化/)
  assert.equal(seen.calls, 0)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.deepEqual(f.db.listOperations(), [])
})

test('a real timeout aborts the in-flight model call, cancels its signal and writes nothing', { timeout: 10_000 }, async t => {
  const f = fixture(t), before = f.db.getPlanner()
  let signal, calls = 0
  const complete = (_payload, { signal: passed } = {}) => {
    calls += 1; signal = passed
    // Ignore the abort and stay silent: only the configured timeout may end this call.
    return new Promise(() => {})
  }
  const svc = createHorizonOrder({ db: f.db, now: f.now, complete, timeoutMs: 25 })
  const input = request(svc, reversed)
  await assert.rejects(svc.apply(input), /用时过长/)
  assert.equal(calls, 1)
  assert.equal(signal?.aborted, true)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  // Nothing was recorded, so the same request ID may be retried: it calls the
  // model again and commits exactly one arrangement instead of replaying a
  // half-finished receipt.
  const retry = emptyChanges(), again = service(f, { complete: retry.complete }), latest = again.list({ date: DATE })
  await again.apply({ ...input, expectedRevision: latest.revision, snapshotKey: latest.snapshotKey })
  assert.equal(retry.seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  assert.notDeepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('journal failure rolls back all local assignments and receipt', async t => {
  const f = fixture(t), before = f.db.getPlanner(), { seen, complete } = emptyChanges()
  const svc = createHorizonOrder({ db: { ...f.db, setPreference: () => { throw new Error('journal unavailable') } }, now: f.now, complete })
  await assert.rejects(svc.apply(request(svc, reversed)), /journal unavailable/)
  assert.equal(seen.calls, 1)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
})

test('same normalized request retries once across service restarts and reports current state after undo', async t => {
  const f = fixture(t), { seen, complete } = emptyChanges(), svc = service(f, { complete }), input = request(svc, reversed), first = await svc.apply(input)
  const replay = await service(f, { complete }).apply(input)
  assert.equal(replay.operation.id, first.operation.id)
  assert.equal(replay.replayed, true)
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  f.db.undoOperation(first.operation.id)
  const afterUndo = await svc.apply(input)
  assert.match(afterUndo.summary, /已撤销/)
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
  await assert.rejects(svc.apply({ ...input, groups: input.groups.map(group => ({ ...group, day: 2 })) }), /另一种排序/)
  assert.equal(seen.calls, 1)
})

test('simultaneous identical submissions share one model call and one local arrangement', async t => {
  const f = fixture(t), { seen, complete } = emptyChanges(), svc = service(f, { complete }), input = request(svc, reversed)
  const first = svc.apply(input), second = svc.apply(input)
  assert.equal((await first).operation.id, (await second).operation.id)
  assert.equal(seen.calls, 1)
  assert.equal(f.db.listOperations().length, 1)
})

test('real HTTP endpoints return groups, fine-tune once and expose an undoable public receipt', async t => {
  const db = createDatabase(':memory:'), today = localDay(new Date()), value = new Date(), other = new Date()
  value.setDate(value.getDate() + 1)
  other.setDate(other.getDate() + 2)
  const tomorrow = localDay(value), dayAfter = localDay(other), edit = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) edit({ type: 'delete-routine', id: row.id })
  edit({ type: 'save-routine', routine: { id: 'free', title: '空档', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '22:00', location: '', items: [], enabled: true } })
  for (let index = 0; index < 2; index++) {
    const task = db.createTask({ title: `任务 ${index}` })
    edit({ type: 'save-block', block: { id: `http-${index}`, taskId: task.id, date: tomorrow, start: `${14 + index}:00`, end: `${14 + index}:30`, locked: false } })
  }
  const { seen, complete } = emptyChanges()
  const svc = createLocalService({ db, vault: { status: async () => true }, complete })
  t.after(() => svc.close())
  const invoke = (path, payload) => new Promise(resolve => {
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))])
    req.url = `/api${path}`; req.method = payload === undefined ? 'GET' : 'POST'
    req.socket = { remoteAddress: '127.0.0.1', localPort: 5188 }
    req.headers = { host: '127.0.0.1:5188', origin: 'http://127.0.0.1:5188', 'x-astaria-local': '1', 'content-type': 'application/json' }
    svc.middleware(req, { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body: JSON.parse(body) }) } }, () => resolve({ status: 404 }))
  })
  const read = await invoke(`/companion/horizon-order?date=${today}`)
  assert.equal(read.status, 200)
  assert.equal(read.body.groups.length, 2)
  assert.equal(read.body.days, 3)
  const snap = read.body, draft = draftOf(snap), moved = draft.findIndex(group => group.itemIds.includes('http-0'))
  const input = { date: today, expectedRevision: snap.revision, snapshotKey: snap.snapshotKey, requestId: randomUUID(),
    groups: draft.map((group, index) => index === moved ? { ...group, day: 2 } : group) }
  const saved = await invoke('/companion/horizon-order', input)
  assert.equal(saved.status, 200)
  assert.equal(seen.calls, 1)
  assert.equal(saved.body.operation.undoable, true)
  assert.equal(saved.body.operation.plannerBefore, undefined)
  assert.equal(saved.body.days, 3)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'http-0').date, dayAfter)
  assert.equal((await invoke('/companion/horizon-order', input)).body.replayed, true)
  assert.equal(seen.calls, 1)
  assert.equal((await invoke(`/operations/${saved.body.operation.id}/undo`, {})).status, 200)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'http-0').date, tomorrow)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'http-0').start, '14:00')
})
