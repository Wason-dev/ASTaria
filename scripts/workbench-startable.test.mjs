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
const block = (taskId, date, start, end) => ({ taskId, date, start, end })
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

test('free-time backing tasks stay in the goal workflow rather than becoming one-off unscheduled work', () => {
  const items=[base('ordinary'),base('learning',{freeTimeGoalId:'goal-1',importance:3})]
  assert.deepEqual(taskGroups(items,now,[]).available.map(item=>item.id),['ordinary'])
  const blocks=[block('learning','2026-09-22','18:00','18:30')]
  assert.deepEqual(taskGroups(items,now,blocks).available.map(item=>item.id),['ordinary'])
})
