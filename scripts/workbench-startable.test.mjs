import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
const root = new URL('../src/', import.meta.url).href
const hook = registerHooks({ resolve(specifier, context, nextResolve) { if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) return nextResolve(`${specifier}.ts`, context); return nextResolve(specifier, context) } })
const { taskGroups, taskSchedule, scheduleDisplay, scheduleStatusLabel } = await import('../src/workbench/tasks.ts')
const { buildWorkbenchBriefing } = await import('../src/workbench/briefing.ts')
hook.deregister()
process.env.TZ = 'Asia/Shanghai'
const now = new Date('2026-09-22T17:40:00+08:00')
const base = (id, extra = {}) => ({ id, title: id, area: null, source: 'manual', inbox: false, leadDays: 3, importance: 2, energy: 'deep', context: [], status: 'todo', createdAt: '2026-01-01', updatedAt: '2026-01-01', deletedAt: null, ...extra })
const block = (taskId, date, start, end) => ({ id: `${taskId}-${date}-${start}`, taskId, date, start, end })
test('a concrete block becomes available exactly twenty minutes before start and stays after it ends', () => {
  const task = base('sat'), blocks = [block('sat', '2026-09-22', '18:00', '19:00')]
  assert.deepEqual(taskGroups([task], new Date('2026-09-22T15:00:00+08:00'), blocks).available, [])
  assert.deepEqual(taskGroups([task], new Date('2026-09-22T17:39:59+08:00'), blocks).later.map(item => item.id), ['sat'])
  assert.deepEqual(taskGroups([task], new Date('2026-09-22T17:39:59.999+08:00'), blocks).available, [])
  assert.deepEqual(taskGroups([task], now, blocks).available.map(item => item.id), ['sat'])
  assert.equal(scheduleStatusLabel(blocks[0], now), '即将开始')
  assert.equal(scheduleDisplay(taskSchedule(task, now, blocks), now), '今天 18:00–19:00')
  assert.equal(scheduleStatusLabel(blocks[0], new Date('2026-09-22T19:01:00+08:00')), '原安排已结束，可继续')
})
test('due today, overdue DDL, doing status and date-only intentions never override a concrete future block', () => {
  const items = [base('due', { due: '2026-09-22' }), base('overdue', { due: '2026-09-21' }), base('doing', { status: 'doing' }), base('today', { startAt: '2026-09-22', fuzzyWindow: 'today' })]
  const blocks = items.map(task => block(task.id, '2026-09-22', '18:00', '19:00'))
  assert.equal(taskGroups(items, new Date('2026-09-22T15:00:00+08:00'), blocks).available.length, 0)
  assert.equal(taskGroups(items, now, blocks).available.length, 4)
})
test('same-day split work waits for its next segment, and overlapping active work wins over future work', () => {
  const task = base('split')
  const blocks = [block('split', '2026-09-22', '18:00', '19:00'), block('split', '2026-09-22', '10:00', '11:00')]
  const afternoon = new Date('2026-09-22T15:00:00+08:00')
  assert.equal(taskSchedule(task, afternoon, blocks).start, '18:00')
  assert.deepEqual(taskGroups([task], afternoon, blocks).available, [])
  assert.equal(taskSchedule(task, new Date('2026-09-22T10:30:00+08:00'), blocks).start, '10:00')
  assert.equal(taskSchedule(task, new Date('2026-09-22T20:00:00+08:00'), blocks).start, '18:00')
})
test('near-midnight future dates do not leak into the previous day', () => {
  const task = base('midnight'), blocks = [block('midnight', '2026-09-23', '00:10', '01:00')]
  assert.deepEqual(taskGroups([task], new Date('2026-09-22T23:50:00+08:00'), blocks).available, [])
  assert.deepEqual(taskGroups([task], new Date('2026-09-23T00:00:00+08:00'), blocks).available, [task])
})
test('calendar edits and their undo update readiness, labels and briefing from the next immutable snapshot', () => {
  const task = base('sat', { estimateMin: 60 })
  const original = [block('sat', '2026-09-22', '18:00', '19:00')]
  const postponed = [block('sat', '2026-09-22', '19:00', '20:00')]
  const snapshots = [original, postponed, original, []]
  const counts = snapshots.map(blocks => buildWorkbenchBriefing([task], now, 35, () => 0, {}, blocks).availableCount)
  assert.deepEqual(counts, [1, 0, 1, 1])
  assert.deepEqual(snapshots.map(blocks => taskSchedule(task, now, blocks)?.start), ['18:00', '19:00', '18:00', undefined])
  assert.equal(buildWorkbenchBriefing([task], now, 35, () => 0, {}, postponed).recommendation, null)
})
test('invalid blocks do not create a false schedule and closed/deleted tasks stay filtered', () => {
  const task = base('invalid')
  const blocks = [block('invalid', '2026-02-30', '18:00', '19:00'), block('invalid', '2026-09-22', '25:00', '26:00'), block('invalid', '2026-09-22', '19:00', '18:00')]
  assert.equal(taskSchedule(task, now, blocks), undefined)
  assert.deepEqual(taskGroups([task], now, blocks).available, [task])
  const items = [base('done', { status: 'done' }), base('dropped', { status: 'dropped' }), base('deleted', { deletedAt: now.toISOString() })]
  const result = taskGroups(items, now, items.map(task => block(task.id, '2026-09-22', '18:00', '19:00')))
  assert.deepEqual(result.available, []); assert.deepEqual(result.later, [])
  assert.deepEqual(result.completed.map(task => task.id), ['done'])
})
test('a future concrete day stays later even when an old block has ended, and uses nearest future block', () => {
  const task = base('split'), blocks = [block('split', '2026-09-22', '10:00', '11:00'), block('split', '2026-09-23', '09:00', '10:00')]
  assert.deepEqual(taskGroups([task], now, blocks).later.map(item => item.id), ['split'])
  assert.deepEqual(taskGroups([task], now, blocks).available.map(item => item.id), [])
  assert.equal(taskSchedule(task, now, blocks)?.date, '2026-09-23')
  assert.equal(taskSchedule(task, new Date('2026-09-23T09:30:00+08:00'), blocks)?.date, '2026-09-23')
})
test('a deadline alone is available while a future date-only start remains later', () => {
  const ddl = base('ddl', { due: '2026-09-23' }), date = base('date', { startAt: '2026-09-23' }), precise = base('precise', { startAt: '2026-09-22T18:00:00+08:00' })
  assert.deepEqual(taskGroups([ddl, date, precise], now).available.map(item => item.id), ['ddl', 'precise'])
  assert.deepEqual(taskGroups([ddl, date, precise], now).later.map(item => item.id), ['date'])
  assert.deepEqual(taskGroups([precise], new Date('2026-09-22T17:40:00+08:00')).available, [precise])
})
test('past concrete blocks remain available for unfinished work and retain no fake schedule', () => {
  const task = base('past'), blocks = [block('past', '2026-09-22', '15:00', '16:00')]
  assert.deepEqual(taskGroups([task], now, blocks).available.map(item => item.id), ['past'])
  assert.equal(scheduleStatusLabel(blocks[0], now), '原安排已结束，可继续')
  assert.equal(taskSchedule(task, now, blocks)?.start, '15:00')
})

test('free-time backing tasks enter through an unfinished persisted session and never as an unscheduled goal', () => {
  const items=[base('ordinary'),base('learning',{freeTimeGoalId:'goal-1',importance:3})]
  assert.deepEqual(taskGroups(items,now,[]).available.map(item=>item.id),['ordinary'])
  const blocks=[block('learning','2026-09-22','18:00','18:30')]
  assert.deepEqual(taskGroups(items,now,blocks).available.map(item=>item.id),['learning','ordinary'])
  assert.deepEqual(taskGroups(items,now,blocks,{ [blocks[0].id]: '2026-09-22T10:00:00.000Z' }).available.map(item=>item.id),['ordinary'])
})

/* -------------------------------------------------------------------------- *
 * Free-time sessions: readiness, completion fields and the briefing count
 * -------------------------------------------------------------------------- */
const TODAY = '2026-09-22', TOMORROW = '2026-09-23', YESTERDAY = '2026-09-21'
const DONE_TODAY = '2026-09-22T02:00:00.000Z', DONE_YESTERDAY = '2026-09-21T02:00:00.000Z'
const localTime = time => new Date(`2026-09-22T${time}+08:00`)
const goalTask = (id = 'goal-task', extra = {}) => base(id, { freeTimeGoalId: 'goal-1', ...extra })
/** A planner row carrying its own persisted id; omitting the id models a legacy session. */
const persisted = (taskId, date, start, end, id) => id === undefined ? { taskId, date, start, end } : { id, taskId, date, start, end }
const ids = result => result.available.map(task => task.id)

test('an unscheduled free-time goal never appears as an ordinary task', () => {
  const scheduled = goalTask('scheduled', { due: TODAY, estimateMin: 30, fuzzyWindow: 'today', importance: 3 })
  const bare = goalTask('bare', { due: TODAY, estimateMin: 30, fuzzyWindow: 'today', importance: 3 })
  const blocks = [persisted('scheduled', TODAY, '10:00', '11:00', 's-1')]
  const groups = taskGroups([bare, scheduled], localTime('12:00'), blocks)
  assert.deepEqual(ids(groups), ['scheduled'])
  assert.deepEqual(groups.later.map(task => task.id), [])
  assert.deepEqual(groups.completed.map(task => task.id), [])
  // The backing task of a goal without a usable session is invisible to the briefing too.
  assert.equal(buildWorkbenchBriefing([bare], localTime('12:00'), 35, () => 0, {}, []).availableCount, 0)
})

test('a same-day unfinished session with an id becomes startable twenty minutes early', () => {
  const task = goalTask(), blocks = [persisted('goal-task', TODAY, '18:00', '19:00', 's-1')]
  assert.deepEqual(ids(taskGroups([task], localTime('17:39:59'), blocks)), [])
  assert.deepEqual(taskGroups([task], localTime('17:39:59'), blocks).later.map(item => item.id), ['goal-task'])
  assert.deepEqual(ids(taskGroups([task], localTime('17:40'), blocks)), ['goal-task'])
  assert.equal(scheduleStatusLabel(blocks[0], localTime('17:39:59')), '按日历时段开始')
  assert.equal(scheduleStatusLabel(blocks[0], localTime('17:40')), '即将开始')
  assert.equal(scheduleDisplay(taskSchedule(task, localTime('17:40'), blocks), localTime('17:40')), '今天 18:00–19:00')
  assert.equal(buildWorkbenchBriefing([task], localTime('17:39:59'), 35, () => 0, {}, blocks).recommendation, null)
  assert.equal(buildWorkbenchBriefing([task], localTime('17:40'), 35, () => 0, {}, blocks).recommendation?.task.id, 'goal-task')
})

test('an unfinished session from today outranks tomorrow, and past days never accumulate', () => {
  const task = goalTask()
  const today = persisted('goal-task', TODAY, '10:00', '11:00', 's-today')
  const tomorrow = persisted('goal-task', TOMORROW, '09:00', '10:00', 's-tomorrow')
  const yesterday = persisted('goal-task', YESTERDAY, '10:00', '11:00', 's-yesterday')
  assert.equal(taskSchedule(task, localTime('17:40'), [tomorrow, today])?.id, 's-today')
  assert.deepEqual(ids(taskGroups([task], localTime('17:40'), [tomorrow, today])), ['goal-task'])
  // A historical day is not a session that can still be resumed, and it never accumulates
  // into an overdue task: the goal simply has nothing to show.
  assert.equal(taskSchedule(task, localTime('17:40'), [yesterday]), undefined)
  assert.deepEqual(ids(taskGroups([task], localTime('17:40'), [yesterday])), [])
  assert.deepEqual(taskGroups([task], localTime('17:40'), [yesterday]).later.map(item => item.id), [])
  assert.equal(taskSchedule(task, localTime('17:40'), [yesterday, today, tomorrow])?.id, 's-today')
})

test('completing a session hands readiness to the next session at its own time', () => {
  const task = goalTask()
  const blocks = [persisted('goal-task', TODAY, '10:00', '11:00', 's-1'), persisted('goal-task', TODAY, '18:00', '19:00', 's-2')]
  const done = { 's-1': DONE_TODAY }
  // The unfinished morning session keeps the goal startable right away...
  assert.equal(taskSchedule(task, localTime('17:00'), blocks)?.id, 's-1')
  assert.deepEqual(ids(taskGroups([task], localTime('17:00'), blocks)), ['goal-task'])
  // ...once completed, the evening session governs, including its own twenty-minute window.
  assert.equal(taskSchedule(task, localTime('17:00'), blocks, done)?.id, 's-2')
  assert.deepEqual(ids(taskGroups([task], localTime('17:00'), blocks, done)), [])
  assert.deepEqual(taskGroups([task], localTime('17:39:59'), blocks, done).later.map(item => item.id), ['goal-task'])
  assert.deepEqual(ids(taskGroups([task], localTime('17:40'), blocks, done)), ['goal-task'])
})

test('a goal whose sessions are all completed disappears instead of becoming an ordinary task', () => {
  const task = goalTask('goal-task', { due: TODAY, estimateMin: 30, fuzzyWindow: 'today', importance: 3 })
  const blocks = [persisted('goal-task', TODAY, '10:00', '11:00', 's-1'), persisted('goal-task', TOMORROW, '09:00', '10:00', 's-2')]
  const done = { 's-1': DONE_TODAY, 's-2': DONE_TODAY }
  assert.deepEqual(ids(taskGroups([task], localTime('17:40'), blocks)), ['goal-task'])
  assert.equal(taskSchedule(task, localTime('17:40'), blocks, done), undefined)
  const groups = taskGroups([task], localTime('17:40'), blocks, done)
  assert.deepEqual(ids(groups), [])
  assert.deepEqual(groups.later, [])
  assert.deepEqual(groups.completed, [])
  const briefing = buildWorkbenchBriefing([task], localTime('17:40'), 35, () => 0, {}, blocks, done)
  assert.equal(briefing.availableCount, 0)
  assert.equal(briefing.recommendation, null)
})

test('a session without its own persisted id can never schedule a free-time goal', () => {
  const task = goalTask(), rows = id => [persisted('goal-task', TODAY, '18:00', '19:00', id)]
  for (const id of [undefined, '', null, 0, 123, false]) {
    assert.equal(taskSchedule(task, localTime('17:40'), rows(id)), undefined, `an id of ${String(id)} must not schedule a goal`)
    assert.deepEqual(ids(taskGroups([task], localTime('17:40'), rows(id))), [], `an id of ${String(id)} must not make a goal startable`)
  }
  // The identical row with a persisted id is usable, so the id is what gates the session.
  assert.equal(taskSchedule(task, localTime('17:40'), rows('s-1'))?.id, 's-1')
})

test('only an own string completion field hides a free-time session', () => {
  const task = goalTask(), blocks = [persisted('goal-task', TODAY, '18:00', '19:00', 's-1')]
  const available = completed => ids(taskGroups([task], localTime('17:40'), blocks, completed))
  const ignored = [
    ['no field', {}],
    ['boolean', { 's-1': true }],
    ['number', { 's-1': 123 }],
    ['null', { 's-1': null }],
    ['undefined', { 's-1': undefined }],
    ['array', { 's-1': [DONE_TODAY] }],
    ['unrelated key', { other: DONE_TODAY }],
    ['inherited string', Object.create({ 's-1': DONE_TODAY })],
  ]
  for (const [label, completed] of ignored) assert.deepEqual(available(completed), ['goal-task'], `a ${label} completion field must not hide the session`)
  // An own string marks the row done for readiness even when it is not a parsable date;
  // only the briefing counter requires a real date (asserted below).
  assert.deepEqual(available({ 's-1': DONE_TODAY }), [])
  assert.deepEqual(available({ 's-1': '' }), [])
  assert.deepEqual(available({ 's-1': 'not-a-date' }), [])
})

test('the briefing counts a completed session once, only with a real date on an open goal', () => {
  const task = goalTask(), blocks = [persisted('goal-task', TODAY, '10:00', '11:00', 's-1')]
  const count = (tasks, rows, completed) => buildWorkbenchBriefing(tasks, localTime('17:40'), 35, () => 0, {}, rows, completed).completedTodayCount
  assert.equal(count([task], blocks, { 's-1': DONE_TODAY }), 1)
  assert.equal(count([task], blocks, { 's-1': DONE_YESTERDAY }), 0)
  assert.equal(count([task], blocks, { 's-1': TODAY }), 1, 'a date-only completion is that local day')
  for (const value of ['', 'not-a-date', '2026-02-30']) assert.equal(count([task], blocks, { 's-1': value }), 0, `${JSON.stringify(value)} is not a real completion date`)
  assert.equal(count([task], blocks, { 's-1': true }), 0)
  assert.equal(count([task], blocks, Object.create({ 's-1': DONE_TODAY })), 0, 'an inherited field is not a completion')
  assert.equal(count([task], [blocks[0], { ...blocks[0] }], { 's-1': DONE_TODAY }), 1, 'duplicate rows are one session')
  assert.equal(count([task], [persisted('goal-task', TODAY, '10:00', '11:00')], { 's-1': DONE_TODAY }), 0, 'a row without an id cannot be a completed session')
  // Only an open goal owns a counted session, and a closed goal is counted as itself, never twice.
  assert.equal(count([goalTask('goal-task', { status: 'done', doneAt: DONE_TODAY })], blocks, { 's-1': DONE_TODAY }), 1)
  assert.equal(count([goalTask('goal-task', { status: 'done', doneAt: DONE_YESTERDAY })], blocks, { 's-1': DONE_TODAY }), 0)
  assert.equal(count([goalTask('goal-task', { deletedAt: DONE_TODAY })], blocks, { 's-1': DONE_TODAY }), 0)
  assert.equal(count([base('ordinary')], [persisted('ordinary', TODAY, '10:00', '11:00', 's-1')], { 's-1': DONE_TODAY }), 0)
  // Real task completions keep counting alongside the session, and duplicates are still one session.
  assert.equal(count([task, base('done-a', { status: 'done', doneAt: DONE_TODAY }), base('done-b', { status: 'done', doneAt: TODAY })], [blocks[0], { ...blocks[0] }], { 's-1': DONE_TODAY }), 3)
  assert.equal(count([base('done-c', { status: 'done', doneAt: 'not-a-date' })], [], {}), 0)
})

test('ordinary tasks keep their existing semantics under the session rules', () => {
  const ordinary = base('ordinary'), today = block('ordinary', TODAY, '18:00', '19:00')
  // An ordinary planner block needs no persisted id, and a completion map never hides it.
  assert.deepEqual(ids(taskGroups([ordinary], localTime('17:40'), [persisted('ordinary', TODAY, '18:00', '19:00')])), ['ordinary'])
  assert.deepEqual(ids(taskGroups([ordinary], localTime('17:40'), [today], { [today.id]: DONE_TODAY })), ['ordinary'])
  assert.deepEqual(ids(taskGroups([ordinary], localTime('17:40'), [today], Object.create({ [today.id]: DONE_TODAY }))), ['ordinary'])
  // Historical blocks still keep unfinished ordinary work startable, and no block at all is fine.
  assert.equal(taskSchedule(ordinary, localTime('17:40'), [block('ordinary', YESTERDAY, '15:00', '16:00')])?.start, '15:00')
  assert.deepEqual(ids(taskGroups([ordinary], localTime('17:40'), [block('ordinary', YESTERDAY, '15:00', '16:00')])), ['ordinary'])
  assert.deepEqual(ids(taskGroups([ordinary], localTime('17:40'))), ['ordinary'])
})
