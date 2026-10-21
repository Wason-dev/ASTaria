import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { replanTimetableConflicts } from '../server/timetableReplan.mjs'
import { dayCapacity, minuteOf, routinesForDay } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-10-18', NOW = new Date('2026-10-17T12:00:00+08:00')
const routine = (id, kind, start, end, patch = {}) => ({
  id, title: id, kind, start, end, weekdays: [4], enabled: true, location: '', items: [], ...patch,
})
const lesson = (start = '09:00', end = '10:00', patch = {}) => routine('source-class', 'class', start, end, patch)
const available = (start = '09:00', end = '14:00', patch = {}) => routine('source-free', 'available', start, end, patch)
const event = (date, patch = {}) => ({ id: 'new-event', title: '临时固定活动', date, start: '09:00', end: '10:00', location: '', items: [], ...patch })
const freeze = value => {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}

function fixture(t, { date = DATE, now = NOW, source = [lesson(), available()], target = [], persistent = false } = {}) {
  const directory = persistent ? mkdtempSync(join(tmpdir(), 'astaria-timetable-replan-')) : null
  const db = createDatabase(directory ? join(directory, 'isolated.sqlite') : ':memory:')
  t.after(() => { db.close(); if (directory) rmSync(directory, { recursive: true, force: true }) })
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  for (const row of db.getPlanner().routines) edit({ type: 'delete-routine', id: row.id })
  edit({ type: 'import-routines', routines: [
    routine('target-free', 'available', '00:00', '23:59', { weekdays: [new Date(`${date}T12:00:00`).getDay()] }),
    ...target, ...source,
  ] })
  const change = { type: 'set-day-template', date, sourceWeekday: 4 }
  const project = (actions = [change]) => {
    const copy = createDatabase(':memory:')
    try {
      copy.importData(db.exportData())
      for (const action of actions) copy.updatePlanner(action, copy.getPlanner().revision)
      return copy.getPlanner()
    } finally { copy.close() }
  }
  const task = (patch = {}) => db.createTask({ title: 'synthetic task', estimateMin: 30, ...patch })
  const place = (item = task(), patch = {}) => {
    const block = { id: randomUUID(), taskId: item.id, date, start: '09:15', end: '09:45', locked: false, ...patch }
    edit({ type: 'save-block', block })
    return block
  }
  const plan = (state = project(), options = {}) => replanTimetableConflicts({ state, allTasks: db.listTasks(), date, now, ...options })
  const commit = (result, actions = [change]) => db.applyPlannerOperation({
    id: randomUUID(), requestId: randomUUID(), summary: '单日调课并移动冲突时段', expectedRevision: db.getPlanner().revision,
    actions: [...actions, ...result.moves.map(({ after }) => ({ type: 'save-block', block: after }))],
  })
  return { db, date, now, edit, change, project, task, place, plan, commit }
}

function checkMoves(f, state, result) {
  const byId = new Map(state.blocks.map(block => [block.id, block]))
  const replacements = new Map(result.moves.map(({ after }) => [after.id, after]))
  const final = { ...state, blocks: state.blocks.map(block => replacements.get(block.id) ?? block) }
  const conflicts = new Set(dayCapacity(final, f.db.listTasks(), f.date, f.now).conflicts)
  for (const { before, after } of result.moves) {
    assert.deepEqual(before, byId.get(before.id))
    assert.notStrictEqual(before, byId.get(before.id))
    assert.notStrictEqual(after, before)
    assert.deepEqual({ ...after, start: before.start, end: before.end }, before, 'only start/end may change')
    assert.equal(minuteOf(after.end) - minuteOf(after.start), minuteOf(before.end) - minuteOf(before.start))
    assert.equal(Date.parse(`${after.date}T${after.end}:00`) - Date.parse(`${after.date}T${after.start}:00`),
      (minuteOf(before.end) - minuteOf(before.start)) * 60000)
    assert.ok(Date.parse(`${after.date}T${after.start}:00`) >= f.now.getTime())
    assert.equal(conflicts.has(after.id), false, 'a moved block must pass real final dayCapacity')
    assert.ok(dayCapacity(final, f.db.listTasks(), f.date, f.now).available.some(range =>
      range.start <= minuteOf(after.start) && minuteOf(after.end) <= range.end), 'only known availability is used')
  }
  return final
}

test('a projected school-day change moves a real free-time block and commits in one actual planner batch', t => {
  const f = fixture(t, { persistent: true }), task = f.task({ freeTimeGoalId: 'goal-reading', estimateMin: 75 })
  const before = f.place(task, { horizonGroupId: 'group-reading', horizonGroupTitle: '阅读与练习' })
  const state = f.project(), original = f.db.getPlanner(), tasks = f.db.listTasks()
  assert.deepEqual(dayCapacity(state, tasks, DATE, NOW).conflicts, [before.id])
  const result = f.plan(state)
  assert.equal(result.moves.length, 1)
  assert.deepEqual(result.unresolved, [])
  assert.deepEqual(result.moves[0].after, { ...before, start: '10:00', end: '10:30' })
  checkMoves(f, state, result)
  assert.deepEqual(f.db.getPlanner(), original)
  const receipt = f.commit(result)
  assert.equal(receipt.requestedActions.length, 2)
  assert.equal(receipt.planChanges.length, 1)
  assert.deepEqual(f.db.getPlanner().blocks, [result.moves[0].after])
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.deepEqual(dayCapacity(f.db.getPlanner(), tasks, DATE, NOW).conflicts, [])
})

test('nearest complete slot wins over earliest free time; equidistant slots use a stable earlier tie', t => {
  const f = fixture(t, { source: [lesson(), available('07:00', '14:00')] })
  const before = f.place(f.task(), { start: '09:30', end: '10:00' })
  let state = f.project(), result = f.plan(state)
  assert.equal(result.moves[0].after.start, '10:00')
  checkMoves(f, state, result)
  f.edit({ type: 'save-block', block: { ...before, start: '09:15', end: '09:45' } })
  state = f.project(); result = f.plan(state)
  assert.equal(result.moves[0].after.start, '08:30')
  assert.deepEqual(f.plan(state), result, 'projection must be deterministic')
  checkMoves(f, state, result)
  f.commit(result)
})

for (const [label, source] of [
  ['fully occupied known availability', [lesson(), available('09:00', '10:00')]],
  ['no known availability', [lesson()]],
]) test(`${label} preserves the original block with an unresolved reason`, t => {
  const f = fixture(t, { source }), before = f.place(), state = f.project(), result = f.plan(state)
  assert.equal(dayCapacity(state, f.db.listTasks(), DATE, NOW).totalMin, 0)
  assert.deepEqual(result.moves, [])
  assert.deepEqual(result.unresolved.map(item => [item.id, item.taskId]), [[before.id, before.taskId]])
  assert.match(result.unresolved[0].reason, /完整 30 分钟.*原安排保留/)
  f.commit(result)
  assert.deepEqual(f.db.getPlanner().blocks, [before])
})

test('several smaller gaps never split, shorten or move a long original to another date', t => {
  const f = fixture(t, { source: [lesson('09:00', '09:45'), lesson('10:15', '11:15', { id: 'second-class' }), available('09:00', '12:00')] })
  const before = f.place(f.task({ estimateMin: 30 }), { start: '09:00', end: '10:10' })
  const state = f.project(), result = f.plan(state)
  const empty = dayCapacity({ ...state, blocks: [] }, f.db.listTasks(), DATE, NOW)
  assert.equal(empty.remainingMin, 75)
  assert.equal(empty.longestMin, 45)
  assert.deepEqual(result.moves, [])
  assert.match(result.unresolved[0].reason, /完整 70 分钟.*不拆段、不缩短、不越日/)
  assert.deepEqual(state.blocks, [before])
})

for (const [due, movable] of [
  [`${DATE}T10:30:00+08:00`, true],
  [`${DATE}T10:29:59+08:00`, false],
  ['2026-10-18T02:30:00.000Z', true],
]) test(`precise DDL ${due} bounds the entire original duration`, t => {
  const f = fixture(t), before = f.place(f.task({ due })), state = f.project(), result = f.plan(state)
  assert.equal(result.moves.length, Number(movable))
  if (movable) {
    assert.equal(result.moves[0].after.end, '10:30')
    assert.ok(Date.parse(`${DATE}T${result.moves[0].after.end}:00`) <= Date.parse(due))
    checkMoves(f, state, result); f.commit(result)
  } else {
    assert.equal(result.unresolved[0].id, before.id)
    assert.match(result.unresolved[0].reason, /截止前完整/)
  }
})

test('date-only DDL uses the local next midnight in both positive and negative UTC offsets', t => {
  const previousTZ = process.env.TZ
  try {
    for (const timezone of ['Asia/Shanghai', 'America/Los_Angeles']) {
      process.env.TZ = timezone
      const f = fixture(t, { now: new Date('2026-10-17T12:00:00'), source: [lesson('22:00', '23:00'), available('22:00', '23:59')] })
      const before = f.place(f.task({ due: DATE }), { start: '22:00', end: '22:45' })
      const state = f.project(), result = f.plan(state)
      assert.deepEqual(result.moves[0].after, { ...before, start: '23:00', end: '23:45' })
      const deadline = new Date('2026-10-19T00:00:00').getTime()
      assert.ok(Date.parse(`${DATE}T${result.moves[0].after.end}:00`) < deadline)
      checkMoves(f, state, result); f.commit(result)
    }
  } finally { process.env.TZ = previousTZ }
})

for (const [label, setup, reason] of [
  ['locked', (f, task, block) => f.edit({ type: 'save-block', block: { ...block, locked: true } }), /锁定/],
  ['doing', (f, task) => f.db.updateTask(task.id, { status: 'doing' }), /正在进行/],
  ['done', (f, task) => f.db.updateTask(task.id, { status: 'done' }), /已完成/],
]) test(`${label} conflicts retain their exact block and report why they cannot move`, t => {
  const f = fixture(t), task = f.task(), block = f.place(task)
  setup(f, task, block)
  const state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves, [])
  assert.equal(result.unresolved[0].id, block.id)
  assert.match(result.unresolved[0].reason, reason)
  f.commit(result)
  assert.deepEqual(f.db.getPlanner().blocks, state.blocks)
})

for (const [label, now] of [
  ['past day', new Date('2026-10-19T00:00:00+08:00')],
  ['already started today', new Date(`${DATE}T09:15:00.001+08:00`)],
]) test(`${label} is not silently rescheduled`, t => {
  const f = fixture(t, { now }), before = f.place(), result = f.plan()
  assert.deepEqual(result.moves, [])
  assert.equal(result.unresolved[0].id, before.id)
  assert.match(result.unresolved[0].reason, /已开始或属于过去/)
})

test('an original starting exactly now may move, and today never rounds current seconds backwards', t => {
  const f = fixture(t, { now: new Date(`${DATE}T09:15:00+08:00`) })
  f.place()
  const state = f.project(), result = f.plan(state)
  assert.equal(result.moves[0].after.start, '10:00')
  checkMoves(f, state, result); f.commit(result)
})

test('today can use the real next minute when the only complete slot falls between five-minute ticks', t => {
  const f = fixture(t, { now: new Date(`${DATE}T07:02:30.500+08:00`), source: [lesson(), available('07:00', '07:33')] })
  const before = f.place(), state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves[0].after, { ...before, start: '07:03', end: '07:33' })
  checkMoves(f, state, result); f.commit(result)
})

test('a future day uses the five-minute grid and does not borrow tomorrow when rounding prevents a full slot', t => {
  const f = fixture(t, { source: [lesson(), available('10:02', '10:32')] })
  const before = f.place(), result = f.plan()
  assert.equal(dayCapacity({ ...f.project(), blocks: [] }, f.db.listTasks(), DATE, NOW).remainingMin, 30)
  assert.deepEqual(result.moves, [])
  assert.equal(result.unresolved[0].id, before.id)
})

test('multiple blocks of the same ordinary task keep their own original durations and ten-minute rests', t => {
  const f = fixture(t, { source: [lesson('09:00', '10:30'), available()] }), task = f.task({ estimateMin: 25 })
  const first = f.place(task, { start: '09:00', end: '09:30' })
  const second = f.place(task, { start: '09:40', end: '10:20' })
  const laterDate = f.place(task, { date: '2026-10-25', start: '18:00', end: '19:30', horizonGroupId: 'other-date', horizonGroupTitle: '另一日' })
  const state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves.map(move => move.before.id), [first.id, second.id])
  assert.deepEqual(result.moves.map(move => [move.after.start, move.after.end]), [['10:30', '11:00'], ['11:10', '11:50']])
  checkMoves(f, state, result); f.commit(result)
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === laterDate.id), laterDate)
})

test('temporarily removed explicit blocks do not resurrect their superseded task startAt', t => {
  const f = fixture(t), task = f.task({ startAt: `${DATE}T09:00:00+08:00`, estimateMin: 300 })
  const before = f.place(task, { start: '09:00', end: '09:30' }), state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves[0].after, { ...before, start: '10:00', end: '10:30' })
  checkMoves(f, state, result); f.commit(result)
  assert.equal(f.db.getTask(task.id).startAt, task.startAt)
})

test('implicit startAt conflicts receive reasons and cannot be converted into planner blocks', t => {
  const f = fixture(t), task = f.task({ startAt: `${DATE}T09:15:00+08:00`, estimateMin: 30 })
  const state = f.project(), result = f.plan(state)
  assert.deepEqual(dayCapacity(state, f.db.listTasks(), DATE, NOW).conflicts, [`task:${task.id}`])
  assert.deepEqual(result.moves, [])
  assert.equal(result.unresolved[0].taskId, task.id)
  assert.match(result.unresolved[0].reason, /startAt.*隐式/)
  assert.equal(state.blocks.length, 0)
})

test('implicit peer occupancy keeps second-level buffer precision', t => {
  const f = fixture(t), before = f.place()
  f.task({ title: 'implicit peer', startAt: `${DATE}T10:30:30+08:00`, estimateMin: 30 })
  const state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves[0].after, { ...before, start: '11:15', end: '11:45' })
  checkMoves(f, state, result); f.commit(result)
})

test('a prior-day implicit interval crossing midnight retains its target-day occupancy', t => {
  const f = fixture(t, { source: [lesson('00:00', '01:00'), available('00:00', '03:00')] })
  const before = f.place(f.task(), { start: '00:00', end: '00:30' })
  f.task({ title: 'cross-midnight peer', startAt: '2026-10-17T23:45:30+08:00', estimateMin: 90 })
  const state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves[0].after, { ...before, start: '01:30', end: '02:00' })
  assert.ok(result.unresolved.some(item => /隐式/.test(item.reason)))
  checkMoves(f, state, result); f.commit(result)
})

test('future nonconflicting peers keep their occupied time and grouping even when unlocked', t => {
  const f = fixture(t), before = f.place()
  const peer = f.place(f.task(), { start: '10:00', end: '11:30', horizonGroupId: 'peer-group', horizonGroupTitle: '已有安排' })
  const state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves[0].after, { ...before, start: '11:40', end: '12:10' })
  assert.equal(result.moves.some(move => move.before.id === peer.id), false)
  checkMoves(f, state, result); f.commit(result)
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === peer.id), peer)
})

for (const [bufferMin, expected] of [[10, '10:30'], [0, '10:20'], [15, null]]) test(`bufferMin=${bufferMin} respects peers on both sides of a gap`, t => {
  const f = fixture(t, { source: [lesson(), available('09:00', '12:00')] })
  const before = f.place()
  const first = f.place(f.task(), { start: '10:00', end: '10:20', locked: true })
  const second = f.place(f.task(), { start: '11:10', end: '12:00' })
  const state = f.project(), result = f.plan(state, { bufferMin })
  if (expected) {
    assert.equal(result.moves[0].after.start, expected)
    assert.ok(minuteOf(result.moves[0].after.start) - minuteOf(first.end) >= bufferMin)
    assert.ok(minuteOf(second.start) - minuteOf(result.moves[0].after.end) >= bufferMin)
    checkMoves(f, state, result); f.commit(result)
  } else {
    assert.deepEqual(result.moves, [])
    assert.equal(result.unresolved[0].id, before.id)
  }
})

for (const allowFallback of [false, true]) test(`occurrence allowFallback=${allowFallback} preserves preferredWindow and its date`, t => {
  const f = fixture(t, { source: [lesson('09:00', '10:45'), available('09:00', '11:00', { title: '晚自习' }),
    available('12:00', '14:00', { id: 'other-window', title: '午间空课' })] })
  const task = f.task({ source: 'recurring', startAt: DATE, estimateMin: 35,
    occurrence: { seriesId: 'series', date: DATE, preferredWindow: '晚自习', allowFallback, placement: 'end' } })
  const before = f.place(task), state = f.project(), tasks = f.db.listTasks(), result = f.plan(state)
  if (allowFallback) {
    assert.deepEqual(result.moves[0].after, { ...before, start: '12:00', end: '12:30' })
    checkMoves(f, state, result); f.commit(result)
    assert.deepEqual(f.db.listTasks(), tasks)
  } else {
    assert.deepEqual(result.moves, [])
    assert.match(result.unresolved[0].reason, /「晚自习」窗口内/)
  }
})

test('occurrence preferredWindow wins over a nearer fallback when it can fit the full original block', t => {
  const f = fixture(t, { source: [lesson(), available('09:00', '11:00', { title: '其他空档' }),
    available('12:00', '14:00', { id: 'preferred', title: '晚自习' })] })
  const task = f.task({ estimateMin: 45, occurrence: { seriesId: 'preferred-series', date: DATE, preferredWindow: '晚自习', allowFallback: true, placement: 'end' } })
  const before = f.place(task), state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves[0].after, { ...before, start: '12:00', end: '12:30' })
  checkMoves(f, state, result); f.commit(result)
  assert.equal(f.db.getTask(task.id).occurrence.placement, 'end')
})

test('touching availability rows with the same occurrence window can hold one unsplit block', t => {
  const f = fixture(t, { source: [lesson('09:00', '09:30'), available('09:00', '10:00', { title: '晚自习' }),
    available('10:00', '11:00', { id: 'preferred-extension', title: '晚自习' })] })
  const task = f.task({ estimateMin: 20, occurrence: { seriesId: 'touching-series', date: DATE, preferredWindow: '晚自习', allowFallback: false, placement: 'start' } })
  const before = f.place(task, { start: '09:10', end: '09:55' }), state = f.project(), result = f.plan(state)
  assert.deepEqual(result.moves[0].after, { ...before, start: '09:30', end: '10:15' })
  checkMoves(f, state, result); f.commit(result)
})

test('strict missing occurrence windows do not use unrelated available rows', t => {
  const f = fixture(t), task = f.task({ occurrence: { seriesId: 'missing-window', date: DATE, preferredWindow: '未录入的窗口', allowFallback: false, placement: 'start' } })
  const before = f.place(task), result = f.plan()
  assert.deepEqual(result.moves, [])
  assert.equal(result.unresolved[0].id, before.id)
  assert.match(result.unresolved[0].reason, /未录入的窗口/)
})

test('new fixed day events replan their task collisions without returning a resolved event as unresolved', t => {
  const f = fixture(t), before = f.place(), action = { type: 'save-day-event', event: event(DATE) }
  const state = f.project([action]), result = f.plan(state)
  assert.ok(dayCapacity(state, f.db.listTasks(), DATE, NOW).conflicts.includes(action.event.id))
  assert.deepEqual(result.moves[0].after, { ...before, start: '08:30', end: '09:00' })
  assert.deepEqual(result.unresolved, [])
  checkMoves(f, state, result); f.commit(result, [action])
})

test('fixed-versus-fixed conflicts and record-only tasks never manufacture planner moves', t => {
  const f = fixture(t, { target: [lesson('09:00', '10:00', { id: 'target-class', weekdays: [0] })] })
  const record = f.task({ title: '只记下的提醒', due: DATE, estimateMin: 30 })
  const state = f.project([{ type: 'save-day-event', event: event(DATE) }]), result = f.plan(state)
  assert.deepEqual(result.moves, [])
  assert.equal(state.blocks.length, 0)
  assert.equal(result.unresolved.length, 2)
  assert.ok(result.unresolved.every(item => item.taskId === null && /固定课程或活动/.test(item.reason)))
  assert.equal(result.unresolved.some(item => item.taskId === record.id), false)
})

test('restored day exceptions use the real weekly timetable instead of the removed holiday', t => {
  const f = fixture(t, { target: [lesson('09:00', '10:00', { id: 'sunday-class', weekdays: [0] })] })
  f.edit({ type: 'set-day-exception', date: DATE, kind: 'holiday' })
  const before = f.place(), action = { type: 'set-day-exception', date: DATE, kind: 'restored' }
  const state = f.project([action]), result = f.plan(state)
  assert.equal(state.dayExceptions[DATE].kind, 'restored')
  assert.ok(routinesForDay(state, DATE).some(row => row.id === 'sunday-class'))
  assert.deepEqual(result.moves[0].after, { ...before, start: '08:30', end: '09:00' })
  checkMoves(f, state, result); f.commit(result, [action])
})

test('a SQLite backup-restored dated snapshot keeps its own recorded availability and metadata', t => {
  const f = fixture(t, { persistent: true }), before = f.place(f.task({ freeTimeGoalId: 'goal-restored' }), {
    horizonGroupId: 'restored-group', horizonGroupTitle: '恢复的分组',
  })
  f.edit(f.change)
  const state = f.db.getPlanner(), backup = f.db.exportData(), restored = createDatabase(':memory:')
  t.after(() => restored.close())
  restored.importData(backup)
  const imported = restored.getPlanner(), importedTask = restored.getTask(before.taskId)
  assert.deepEqual(imported, { ...state, revision: imported.revision })
  const result = replanTimetableConflicts({ state: imported, allTasks: restored.listTasks(), date: DATE, now: NOW })
  assert.deepEqual(restored.getPlanner(), imported)
  assert.deepEqual(result.moves[0].after, { ...before, start: '10:00', end: '10:30' })
  checkMoves(f, state, result)
  const receipt = restored.applyPlannerOperation({ id: randomUUID(), requestId: randomUUID(), summary: '恢复后移动',
    actions: result.moves.map(({ after }) => ({ type: 'save-block', block: after })), expectedRevision: restored.getPlanner().revision })
  assert.equal(receipt.planChanges.length, 1)
  assert.deepEqual(restored.getTask(before.taskId), importedTask)
})

test('completed per-session free-time history prevents movement even while its goal task is todo', t => {
  const f = fixture(t), companion = createCompanion({ db: f.db, now: () => NOW }), freeTime = createFreeTime({ db: f.db, now: () => NOW })
  companion.saveFreeTimeGoal({ title: '阅读', minPerWeek: 1, sessionMin: 30, sessionMax: 30 })
  const scheduled = freeTime.schedule({ date: DATE }), before = f.db.getPlanner().blocks.find(block => block.date === DATE)
  assert.ok(before)
  // Put the real scheduled session into the time replaced by the new course.
  f.edit({ type: 'save-block', block: { ...before, start: '09:15', end: '09:45' } })
  freeTime.completeSession({ sessionId: before.id })
  assert.equal(scheduled.goals.length, 1)
  assert.equal(f.db.getTask(before.taskId).status, 'todo')
  const state = freeTime.plannerState(f.project()), result = f.plan(state)
  assert.deepEqual(result.moves, [])
  assert.equal(result.unresolved[0].id, before.id)
  assert.match(result.unresolved[0].reason, /本次余时已完成/)
})

for (const alternative of [false, true]) test(`failed original is restored before finalizing other moves (alternative=${alternative})`, t => {
  const source = [lesson('10:00', '11:00'), lesson('12:00', '12:30', { id: 'later-class' }), available('11:00', '12:00')]
  if (alternative) source.push(available('08:00', '09:00', { id: 'earlier-window' }))
  const f = fixture(t, { source }), first = f.place(f.task(), { start: '09:45', end: '10:45' })
  const failed = f.place(f.task(), { start: '11:00', end: '12:30' })
  const state = f.project(), result = f.plan(state)
  assert.ok(result.unresolved.some(item => item.id === failed.id))
  if (alternative) assert.deepEqual(result.moves[0].after, { ...first, start: '08:00', end: '09:00' })
  else assert.deepEqual(result.moves, [])
  checkMoves(f, state, result); f.commit(result)
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === failed.id), failed)
  assert.equal(result.moves.some(move => move.after.start === '11:00'), false, 'cannot keep the destination now occupied by a failed original')
})

for (const maxMoves of [undefined, 0, 2, 100]) test(`move budget ${maxMoves ?? 'default'} fits one timetable action plus seven saves`, t => {
  const f = fixture(t, { source: [lesson('09:00', '14:00'), available('09:00', '23:00')] }), originals = []
  for (let index = 0; index < 9; index++) {
    const start = 9 * 60 + index * 30
    const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
    originals.push(f.place(f.task(), { start: clock(start), end: clock(start + 20) }))
  }
  const state = f.project(), result = f.plan(state, { maxMoves }), limit = Math.min(7, maxMoves ?? 7)
  assert.equal(result.moves.length, limit)
  assert.equal(result.unresolved.length, originals.length - limit)
  assert.ok(result.unresolved.every(item => /未处理.*原时段保留/.test(item.reason)))
  checkMoves(f, state, result)
  const receipt = f.commit(result)
  assert.equal(receipt.requestedActions.length, limit + 1)
  for (const original of originals.slice(limit)) assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === original.id), original)
})

test('an unsuccessful long block does not consume the successful-move budget', t => {
  const f = fixture(t, { source: [lesson('09:00', '14:00'), available('14:00', '15:00')] })
  const long = f.place(f.task(), { start: '09:00', end: '11:00' })
  const short = f.place(f.task(), { start: '11:10', end: '11:30' })
  const remaining = f.place(f.task(), { start: '11:40', end: '12:00' })
  const state = f.project(), result = f.plan(state, { maxMoves: 1 })
  assert.equal(result.moves.length, 1)
  assert.equal(result.moves[0].before.id, short.id)
  assert.ok(result.unresolved.some(item => item.id === long.id && /完整 120 分钟/.test(item.reason)))
  assert.ok(result.unresolved.some(item => item.id === remaining.id && /未处理/.test(item.reason)))
  checkMoves(f, state, result); f.commit(result)
})

test('deeply frozen input and returned snapshots keep task, goal, occurrence, grouping and lock data intact', t => {
  const f = fixture(t), task = f.task({ freeTimeGoalId: 'goal-meta', estimateMin: 55,
    occurrence: { seriesId: 'series-meta', date: DATE, preferredWindow: 'source-free', allowFallback: false, placement: 'end' } })
  const before = f.place(task, { horizonGroupId: 'meta-group', horizonGroupTitle: '保留原组' })
  const state = freeze(f.project()), tasks = freeze(f.db.listTasks()), snapshot = structuredClone({ state, tasks, now: NOW })
  const result = replanTimetableConflicts({ state, allTasks: tasks, date: DATE, now: NOW })
  assert.equal(result.moves.length, 1)
  assert.deepEqual({ state, tasks, now: NOW }, snapshot)
  checkMoves(f, state, result)
  result.moves[0].after.horizonGroupTitle = 'external output change'
  result.moves[0].before.horizonGroupTitle = 'external before change'
  assert.equal(state.blocks.find(block => block.id === before.id).horizonGroupTitle, '保留原组')
  assert.equal(f.db.getTask(task.id).occurrence.placement, 'end')
})

test('daylight-saving gaps cannot turn one clock-hour block into missing time or a shortened real interval', t => {
  const previousTZ = process.env.TZ
  try {
    process.env.TZ = 'America/New_York'
    const f = fixture(t, { date: '2026-03-08', now: new Date('2026-03-07T12:00:00'),
      source: [lesson('00:00', '01:00'), available('01:30', '04:00')] })
    const before = f.place(f.task(), { start: '00:00', end: '01:00' }), state = f.project(), result = f.plan(state)
    assert.deepEqual(result.moves[0].after, { ...before, start: '03:00', end: '04:00' })
    checkMoves(f, state, result); f.commit(result)
  } finally { process.env.TZ = previousTZ }
})

test('unchanged timetables and unscheduled record-only tasks produce no changes', t => {
  const f = fixture(t)
  f.place(); f.task({ title: '仅记录截止', due: DATE })
  const state = f.db.getPlanner()
  assert.deepEqual(dayCapacity(state, f.db.listTasks(), DATE, NOW).conflicts, [])
  assert.deepEqual(f.plan(state), { moves: [], unresolved: [] })
})

test('invalid date, current instant, move budget and buffer are rejected without mutating snapshots', t => {
  const f = fixture(t), state = f.project(), tasks = f.db.listTasks(), snapshot = structuredClone({ state, tasks })
  for (const patch of [{ date: '2026-02-30' }, { now: new Date(NaN) }, { now: '2026-10-17' },
    { maxMoves: -1 }, { maxMoves: 1.5 }, { maxMoves: NaN }, { bufferMin: -1 }, { bufferMin: NaN }]) {
    assert.throws(() => replanTimetableConflicts({ state, allTasks: tasks, date: DATE, now: NOW, ...patch }))
  }
  assert.deepEqual({ state, tasks }, snapshot)
})
