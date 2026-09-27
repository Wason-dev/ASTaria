import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

const sourceRoot = new URL('../src/', import.meta.url).href
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
const { buildWorkbenchBriefing, deadlineContext } = await import('../src/workbench/briefing.ts')
resolution.deregister()
process.env.TZ = 'Asia/Shanghai'

const now = new Date('2026-09-17T12:00:00+08:00')
const minute = 60_000
const task = (id, extra = {}) => ({
  id, title: id, area: null, source: 'manual', inbox: false, leadDays: 3,
  importance: 2, energy: 'deep', context: [], status: 'todo',
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', deletedAt: null,
  ...extra,
})
const briefing = (tasks, spent = () => 0, focus = 35, at = now, scheduled = {}) => buildWorkbenchBriefing(tasks, at, focus, spent, scheduled)
const context = (entry, spent = 0, focus = 35, at = now, scheduled = {}) => deadlineContext(entry, at, focus, () => spent, scheduled)

test('empty and invalid clock produce no fabricated tasks or advice', () => {
  const empty = { availableCount: 0, dueSoonCount: 0, overdueCount: 0, completedTodayCount: 0, estimatedMin: 0, unestimatedCount: 0, recommendation: null, notices: [] }
  assert.deepEqual(briefing([]), empty)
  assert.deepEqual(briefing([task('one')], () => 0, 35, new Date('invalid')), empty)
})

test('totals respect available tasks, valid estimates, and closed/deleted status', () => {
  const tasks = [
    task('available', { estimateMin: 70 }), task('unknown'), task('invalid', { estimateMin: NaN }),
    task('zero', { estimateMin: 0 }), task('negative', { estimateMin: -5 }),
    task('future', { startAt: '2026-09-20', due: '2026-09-20', estimateMin: 100 }),
    task('ongoing', { status: 'doing', startAt: '2026-09-20', estimateMin: 15 }),
    task('done', { status: 'done', estimateMin: 100, doneAt: now.toISOString() }),
    task('dropped', { status: 'dropped', due: '2026-09-16', estimateMin: 200 }),
    task('deleted', { deletedAt: now.toISOString(), due: '2026-09-16', estimateMin: 200 }),
  ]
  const result = briefing(tasks)
  assert.equal(result.availableCount, 6)
  assert.equal(result.estimatedMin, 85)
  assert.equal(result.unestimatedCount, 4)
  assert.equal(result.overdueCount, 0)
  assert.equal(result.completedTodayCount, 1)
  assert.equal(result.recommendation.task.id, 'ongoing')
  assert.ok(result.notices.every(notice => notice.taskIds.every(id => !['done', 'dropped', 'deleted'].includes(id))))
})

test('dueSoon is only the next 24 hours and date-only deadlines include their entire local day', () => {
  const tasks = [
    task('yesterday', { due: '2026-09-16' }), task('today', { due: '2026-09-17' }),
    task('exact24', { due: '2026-09-18T12:00:00+08:00' }),
    task('after24', { due: '2026-09-18T12:00:00.001+08:00' }),
    task('now', { due: now.toISOString() }), task('invalid', { due: '2026-02-30' }),
    task('closed', { due: '2026-09-17', status: 'done' }),
  ]
  const result = briefing(tasks)
  assert.equal(result.dueSoonCount, 2)
  assert.equal(result.overdueCount, 2)
  const allDay = context(task('all-day', { due: '2026-09-17', estimateMin: 35 }))
  assert.equal(allDay.tone, 'urgent')
  assert.match(allDay.evidence[0], /9月17日 · 全天 · 今天截止/)
  assert.doesNotMatch(allDay.suggestion, /已过截止/)
  const midnight = new Date('2026-09-18T00:00:00+08:00')
  assert.equal(briefing([task('all-day', { due: '2026-09-17' })], () => 0, 35, midnight).overdueCount, 1)
})

test('completed today uses local doneAt rather than updatedAt or cumulative focus', () => {
  const result = briefing([
    task('local-today', { status: 'done', doneAt: '2026-09-16T17:00:00Z' }),
    task('local-yesterday', { status: 'done', doneAt: '2026-09-16T15:59:59Z', updatedAt: now.toISOString() }),
    task('missing-done-at', { status: 'done', updatedAt: now.toISOString() }),
    task('deleted-today', { status: 'done', doneAt: now.toISOString(), deletedAt: now.toISOString() }),
    task('worked', { estimateMin: 20 }),
  ], () => 60 * minute)
  assert.equal(result.completedTodayCount, 1)
  assert.equal(result.availableCount, 1)
  assert.equal(result.estimatedMin, 20)
  assert.match(result.recommendation.evidence.join(' '), /累计专注 60 分钟，包含历史记录/)
  assert.doesNotMatch(result.recommendation.evidence.join(' '), /今日专注|今天专注|已经完成/)
  assert.equal(result.recommendation.suggestedMin, 20)
  assert.match(result.notices[0].body, /确认剩余工作/)
})

test('urgency compares the original estimate with remaining clock time without subtracting past effort', () => {
  const insufficient = context(task('close', { due: '2026-09-17T12:20:00+08:00', estimateMin: 35 }), 30 * minute)
  assert.equal(insufficient.tone, 'urgent')
  assert.match(insufficient.suggestion, /原预计用时超过距截止的时间/)
  const equal = context(task('exact', { due: '2026-09-17T12:35:00+08:00', estimateMin: 35 }))
  assert.doesNotMatch(equal.suggestion, /超过距截止/)
  const roomy = context(task('roomy', { due: '2026-09-20', estimateMin: 70 }))
  assert.match(roomy.suggestion, /2 段专注/)
  assert.doesNotMatch(roomy.suggestion, /足够|空闲|一定|可以完成|能完成/)
})

test('custom focus lengths change the suggested segment count without claiming completion', () => {
  const entry = task('essay', { estimateMin: 70 })
  assert.match(context(entry, 0, 25).suggestion, /3 段专注，先推进 25 分钟/)
  assert.equal(briefing([entry], () => 0, 25).recommendation.suggestedMin, 25)
  assert.equal(briefing([task('short', { estimateMin: 15 })], () => 0, 25).recommendation.suggestedMin, 15)
  assert.match(context(entry, 70 * minute).suggestion, /核对进度/)
  assert.doesNotMatch(context(entry, 70 * minute).suggestion, /完成了|剩余 0|还需 0/)
  assert.equal(briefing([task('unknown')], () => NaN, NaN).recommendation.suggestedMin, 35)
})

test('missing or invalid information stays explicit and never becomes invented scheduling advice', () => {
  const missing = context(task('missing', { due: '下周三', estimateMin: Infinity }), -10)
  assert.match(missing.effortLabel, /用时待估 · 尚未记录专注/)
  assert.ok(missing.evidence.includes('截止日期待确认'))
  assert.match(missing.suggestion, /先补一个用时估计/)
  const result = briefing([task('one'), task('two', { due: '2026-02-30' })])
  assert.equal(result.dueSoonCount, 0)
  assert.deepEqual(result.notices.map(notice => notice.id), ['missing-estimates', 'missing-deadlines'])
  assert.deepEqual(result.notices[1].taskIds, ['one', 'two'])
  assert.doesNotMatch(JSON.stringify(result), /课表|空课|依赖|DeepSeek|AI 已|空闲时间/)
})

test('notices remain bounded, actionable and do not repeat overdue reminders', () => {
  const result = briefing([
    task('past', { due: '2026-09-16', estimateMin: 10 }), task('unestimated'), task('undated', { estimateMin: 20 }),
  ], id => id === 'past' ? 20 * minute : 0)
  assert.equal(result.notices.length, 2)
  assert.deepEqual(result.notices.map(notice => notice.id), ['review-estimates', 'missing-estimates'])
  assert.equal(result.recommendation.task.id, 'past')
  assert.doesNotMatch(result.notices.map(notice => notice.body).join(' '), /逾期|已过截止/)
  assert.ok(result.notices.every(notice => notice.taskIds.length > 0))
})

test('briefing preserves input tasks and returns the existing task identity', () => {
  const tasks = [task('later', { due: '2026-09-20' }), task('first', { due: '2026-09-17', estimateMin: 35 })]
  const before = JSON.stringify(tasks)
  tasks.forEach(Object.freeze)
  Object.freeze(tasks)
  const result = briefing(tasks)
  assert.equal(result.recommendation.task, tasks[1])
  assert.equal(JSON.stringify(tasks), before)
})

test('scheduled planner blocks fill missing estimates without overwriting task data', () => {
  const sat = task('sat', { due: '2026-09-17' })
  const meeting = task('meeting', { due: '2026-09-17' })
  const result = briefing([sat, meeting], () => 0, 35, now, { sat: 60, meeting: 30 })
  assert.equal(result.estimatedMin, 90)
  assert.equal(result.unestimatedCount, 0)
  assert.equal(result.notices.some(notice => notice.id === 'missing-estimates'), false)
  const scheduledContext = context(sat, 0, 35, now, { sat: 60 })
  assert.match(scheduledContext.effortLabel, /^已排 60 分钟 · /)
  assert.match(scheduledContext.suggestion, /已排时长约合/)
  assert.doesNotMatch(scheduledContext.suggestion, /原估时/)
  assert.equal(sat.estimateMin, undefined)
  assert.equal(meeting.estimateMin, undefined)
})

test('tasks without estimates or planner blocks remain explicitly unestimated', () => {
  const result = briefing([task('missing')], () => 0, 35, now)
  assert.equal(result.estimatedMin, 0)
  assert.equal(result.unestimatedCount, 1)
  assert.match(context(task('missing')).effortLabel, /^用时待估 · /)
})

test('original task estimates take precedence over scheduled duration', () => {
  const entry = task('known', { estimateMin: 30 })
  const result = briefing([entry], () => 0, 35, now, { known: 60 })
  assert.equal(result.estimatedMin, 30)
  assert.equal(result.unestimatedCount, 0)
  assert.match(context(entry, 0, 35, now, { known: 60 }).effortLabel, /^原预计 30 分钟 · /)
})
