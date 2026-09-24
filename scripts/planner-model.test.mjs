import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const sourceRoot = new URL('../src/', import.meta.url).href
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/u.test(specifier)) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
})
const { minuteOf, timeOf, minutesLabel, compactMinutesLabel, routinesForDay, weeklyRoutineSource, blocksForDay, dayCapacity, carryItems } = await import('../src/planner/model.ts')
resolution.deregister()
process.env.TZ = 'Asia/Shanghai'

const friday = '2026-09-18'
const at = clock => new Date(`${friday}T${clock}:00+08:00`)
const state = patch => ({ revision: 1, timetableConfirmed: false, routines: [], blocks: [], details: {}, checked: {}, ...patch })
const task = (id, patch = {}) => ({ id, title: id, area: null, source: 'manual', inbox: false, leadDays: 3, importance: 2,
  energy: 'deep', context: ['anywhere'], status: 'todo', createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', deletedAt: null, ...patch })
const routine = (id, kind, start, end, patch = {}) => ({ id, title: id, kind, start, end, weekdays: [5], location: '', items: [], enabled: true, ...patch })
const block = (id, taskId, start, end, date = friday) => ({ id, taskId, date, start, end, locked: false })
const details = (items, patch = {}) => ({ items, preparation: '', needsSubmission: false, submittedAt: null, ...patch })
const range = (start, end) => ({ start: minuteOf(start), end: minuteOf(end) })

test('editing a timetable fragment or temporary lesson resolves to the current full weekly row', () => {
  const current = routine('course', 'class', '08:00', '08:40', { title: '更新后的课', weekdays: [4, 5] })
  const free = routine('free', 'available', '09:00', '12:00')
  const s = state({ routines: [current, free] })
  assert.equal(weeklyRoutineSource(s, { ...current, title: '旧调课记录' }, 4), current)
  assert.equal(weeklyRoutineSource(s, { ...free, start: '10:00', end: '10:30' }), free)
})

test('detached historical snapshots cannot recreate removed rows or edit a different weekday after splitting', () => {
  const snapshot = routine('shared', 'class', '08:00', '08:40', { weekdays: [4, 5] })
  const remaining = { ...snapshot, weekdays: [5] }
  const thursday = { ...snapshot, id: 'split-thursday', weekdays: [4] }
  const s = state({ routines: [remaining, thursday] })
  assert.equal(weeklyRoutineSource(s, snapshot, 4), undefined)
  assert.equal(weeklyRoutineSource(s, { ...snapshot, id: 'removed' }, 4), undefined)
  assert.equal(weeklyRoutineSource(s, snapshot, 5), remaining)
  assert.equal(weeklyRoutineSource(s, thursday, 4), thursday)
})

test('minute helpers preserve midnight boundaries without inventing values for invalid input', () => {
  assert.equal(minuteOf('00:00'), 0)
  assert.equal(minuteOf('18:20'), 1100)
  assert.equal(minuteOf('24:00'), 1440)
  for (const text of ['24:01', '12:60', '-1:00', '9:00', 'bad']) assert.ok(Number.isNaN(minuteOf(text)))
  assert.equal(timeOf(0), '00:00')
  assert.equal(timeOf(1100), '18:20')
  assert.equal(timeOf(1440), '24:00')
  assert.equal(timeOf(2000), '24:00')
  assert.equal(minutesLabel(125), '2 小时 5 分钟')
  assert.equal(minutesLabel(60), '1 小时')
  assert.equal(minutesLabel(0), '0 分钟')
})

test('compact duration labels stay readable and carry rounded minutes into the next hour', () => {
  assert.equal(compactMinutesLabel(508), '8h 28m')
  assert.equal(compactMinutesLabel(480), '8h')
  assert.equal(compactMinutesLabel(27), '27m')
  assert.equal(compactMinutesLabel(59.99), '1h')
  assert.equal(minutesLabel(59.99), '1 小时')
  assert.equal(minutesLabel(129.228916666666692), '2 小时 10 分钟')
  assert.equal(minutesLabel(129.505783333333284), '2 小时 10 分钟')
  for (const invalid of [NaN, Infinity, -Infinity, -20]) {
    assert.equal(compactMinutesLabel(invalid), '0m')
    assert.equal(minutesLabel(invalid), '0 分钟')
  }
})

test('remaining capacity retains seconds while both duration labels display whole minutes', () => {
  const s = state({ routines: [routine('day', 'available', '09:00', '22:00')] })
  const result = dayCapacity(s, [], friday, new Date('2026-09-18T13:32:30+08:00'))
  assert.equal(result.remainingMin, 507.5)
  assert.equal(compactMinutesLabel(result.remainingMin), '8h 28m')
  assert.equal(minutesLabel(result.remainingMin), '8 小时 28 分钟')
  assert.equal(result.remaining[0].start, 812.5)
})

test('weekend routines use Sunday 0 and disabled or overnight rows do not spill into another day', () => {
  const s = state({ routines: [routine('Friday', 'class', '10:00', '11:00'),
    routine('Sunday', 'class', '09:00', '10:00', { weekdays: [0] }),
    routine('Saturday', 'available', '14:00', '15:00', { weekdays: [6] }),
    routine('disabled', 'class', '09:00', '10:00', { weekdays: [0], enabled: false }),
    routine('overnight', 'class', '23:00', '01:00', { weekdays: [0] })] })
  assert.deepEqual(routinesForDay(s, '2026-09-19').map(item => item.id), ['Saturday'])
  assert.deepEqual(routinesForDay(s, '2026-09-20').map(item => item.id), ['Sunday'])
  assert.deepEqual(routinesForDay(s, '2026-09-21'), [])
  assert.deepEqual(routinesForDay(s, '2026-02-30'), [])
})

test('overlapping availability and fixed intervals merge before plans consume the remaining ranges', () => {
  const s = state({ routines: [routine('A', 'available', '09:00', '12:00'), routine('B', 'available', '11:00', '14:00'),
    routine('class', 'class', '10:00', '11:00'), routine('break', 'break', '10:30', '11:30')],
  blocks: [block('p1', 'one', '09:30', '10:30'), block('p2', 'two', '12:00', '13:00'), block('p3', 'three', '12:30', '13:30')] })
  const before = structuredClone(s)
  const result = dayCapacity(s, [task('one'), task('two'), task('three')], friday, at('08:00'))
  assert.deepEqual(result.available, [range('09:00', '10:00'), range('11:30', '14:00')])
  assert.deepEqual(result.free, [range('09:00', '09:30'), range('11:30', '12:00'), range('13:30', '14:00')])
  assert.equal(result.totalMin, 210)
  assert.equal(result.scheduledMin, 120)
  assert.equal(result.freeMin, 90)
  assert.deepEqual(new Set(result.conflicts), new Set(['p1', 'p2', 'p3']))
  assert.deepEqual(s, before)
})

test('today remaining only uses free time after now; future equals free and past is zero', () => {
  const s = state({ routines: [routine('evening', 'available', '18:00', '20:00', { weekdays: [4, 5, 6] })],
    blocks: [block('p', 'one', '18:30', '19:00')] })
  const tasks = [task('one')]
  const result = dayCapacity(s, tasks, friday, at('18:20'))
  assert.equal(result.totalMin, 120)
  assert.equal(result.freeMin, 90)
  assert.equal(result.remainingMin, 70)
  assert.equal(result.longestMin, 60)
  assert.deepEqual(result.remaining, [range('18:20', '18:30'), range('19:00', '20:00')])
  assert.equal(dayCapacity(s, tasks, friday, at('20:00')).remainingMin, 0)
  assert.equal(dayCapacity(s, tasks, '2026-09-19', at('18:20')).remainingMin, 120)
  assert.equal(dayCapacity(s, tasks, '2026-09-17', at('18:20')).remainingMin, 0)
})

test('unknown free periods never become availability and all-day deadlines do not occupy time', () => {
  const tasks = [task('due-today', { due: friday, estimateMin: 200 }), task('doing', { status: 'doing' })]
  const unknown = dayCapacity(state({ timetableConfirmed: true, routines: [routine('lesson', 'class', '09:00', '10:00')] }), tasks, friday, at('08:00'))
  assert.equal(unknown.totalMin, 0)
  assert.equal(unknown.freeMin, 0)
  assert.deepEqual(blocksForDay(state(), tasks, friday), [])
  const known = dayCapacity(state({ routines: [routine('free', 'available', '18:00', '20:00')] }), tasks, friday, at('18:00'))
  assert.equal(known.freeMin, 120)
  assert.equal(known.unestimatedCount, 0)
})

test('precise starts and estimates cross midnight while date-only starts or missing estimates never invent blocks', () => {
  const tasks = [task('cross', { startAt: '2026-09-18T23:30:00+08:00', estimateMin: 90 }),
    task('midnight', { startAt: '2026-09-18T23:00:00+08:00', estimateMin: 60 }),
    task('unknown', { startAt: '2026-09-18T18:00:00+08:00' }), task('date-only', { startAt: friday, estimateMin: 30 }),
    task('date-unknown', { startAt: friday }), task('due-only', { due: friday })]
  assert.deepEqual(blocksForDay(state(), tasks, friday).map(item => [item.id, item.start, item.end]),
    [['task:midnight', '23:00', '24:00'], ['task:cross', '23:30', '24:00']])
  assert.deepEqual(blocksForDay(state(), tasks, '2026-09-19').map(item => [item.id, item.start, item.end]), [['task:cross', '00:00', '01:00']])
  assert.equal(dayCapacity(state(), tasks, friday, at('12:00')).unestimatedCount, 2)
  assert.equal(dayCapacity(state(), tasks, '2026-09-19', at('12:00')).unestimatedCount, 0)
  const s = state({ routines: [routine('night', 'available', '00:00', '02:00', { weekdays: [6] })] })
  assert.equal(dayCapacity(s, tasks, '2026-09-19', new Date('2026-09-19T00:30:00+08:00')).remainingMin, 60)
})

test('explicit blocks override task startAt globally, including missing-estimate tasks', () => {
  const tasks = [task('one', { startAt: '2026-09-18T09:00:00+08:00', estimateMin: 60 }), task('two', { startAt: friday })]
  const s = state({ blocks: [block('one-explicit', 'one', '10:00', '11:00'), block('two-tomorrow', 'two', '10:00', '11:00', '2026-09-19')] })
  assert.deepEqual(blocksForDay(s, tasks, friday).map(item => item.id), ['one-explicit'])
  assert.equal(dayCapacity(s, tasks, friday, at('08:00')).unestimatedCount, 0)
  assert.deepEqual(blocksForDay(s, tasks, '2026-09-19').map(item => item.id), ['two-tomorrow'])
  const invalid = state({ blocks: [block('bad', 'one', '20:00', '18:00')] })
  assert.deepEqual(blocksForDay(invalid, tasks, friday).map(item => item.id), ['task:one'])
})

test('deadline conflicts compare full dates and precise timestamps; touching endpoints do not conflict', () => {
  const s = state({ routines: [routine('lesson', 'class', '10:00', '11:00')], blocks: [
    block('touching', 'safe', '11:00', '12:00'), block('next', 'next', '12:00', '13:00'),
    block('late-time', 'late-time', '14:00', '15:00'), block('late-date', 'late-date', '16:00', '17:00'),
    block('by-midnight', 'all-day', '23:00', '24:00'),
  ] })
  const tasks = [task('safe', { due: friday }), task('next', { due: '2026-09-18T13:00:00+08:00' }),
    task('late-time', { due: '2026-09-18T14:30:00+08:00' }), task('late-date', { due: '2025-09-18' }), task('all-day', { due: friday })]
  assert.deepEqual(new Set(dayCapacity(s, tasks, friday, at('00:00')).conflicts), new Set(['late-time', 'late-date']))
  const cross = task('cross', { startAt: '2026-09-18T23:30:00+08:00', estimateMin: 60, due: friday })
  assert.deepEqual(dayCapacity(state(), [cross], friday, at('00:00')).conflicts, ['task:cross'])
  assert.deepEqual(dayCapacity(state(), [cross], '2026-09-19', at('00:00')).conflicts, ['task:cross'])
})

test('dropped, deleted and orphan blocks leave the plan; completed explicit plans retain their actual slot', () => {
  const s = state({ blocks: [block('gone', 'gone', '09:00', '10:00'), block('dropped', 'dropped', '09:00', '10:00'),
    block('deleted', 'deleted', '09:00', '10:00'), block('finished', 'done', '11:00', '12:00')] })
  assert.deepEqual(blocksForDay(s, [task('dropped', { status: 'dropped' }), task('deleted', { deletedAt: '2026-09-18' }), task('done', { status: 'done' })], friday).map(item => item.id), ['finished'])
})

test('carry checklist merges explicit sources and uses per-day checks without saving or guessing from titles', () => {
  const s = state({ routines: [routine('physics', 'class', '09:00', '10:00', { title: '物理课', items: [' 计算器 ', '电脑', ''] })],
    blocks: [block('p1', 'math', '18:00', '19:00'), block('p2', 'robot', '19:00', '20:00')],
    details: { math: details(['计算器', '练习册']), robot: details([]) }, checked: { [friday]: ['计算器'], '2026-09-19': ['练习册'] } })
  const tasks = [task('math', { title: '数学作业', context: ['desk-mac'] }), task('robot', { title: '机器人编程电脑实验', context: ['desk-4090'] })]
  const before = structuredClone({ s, tasks })
  const items = carryItems(s, tasks, friday)
  assert.deepEqual(items, [
    { key: '计算器', label: '计算器', sources: ['物理课', '数学作业'], checked: true, suggested: false },
    { key: '电脑', label: '电脑', sources: ['物理课', '数学作业'], checked: false, suggested: false },
    { key: '练习册', label: '练习册', sources: ['数学作业'], checked: false, suggested: false },
  ])
  assert.deepEqual({ s, tasks }, before)
})

test('computer suggestion needs an explicitly planned desk-mac task, never a robot title or desk-4090', () => {
  const tasks = [task('mac', { context: ['desk-mac'], startAt: friday }),
    task('desktop', { context: ['desk-4090'], startAt: friday }), task('robot', { title: '机器人编程', startAt: friday }),
    task('not-planned', { title: '明天的工作', context: ['desk-mac'], due: friday })]
  assert.deepEqual(carryItems(state(), tasks, friday), [{ key: '电脑', label: '电脑', sources: ['mac'], suggested: true, checked: false }])
})

test('paper submission items remain due today even when work is done; ordinary DDLs do not become plans', () => {
  const tasks = [task('paper', { status: 'done', due: friday }), task('not-planned', { due: friday }),
    task('submitted', { status: 'done', due: friday }), task('future', { due: '2026-09-19' }), task('no-due'),
    task('deleted', { due: friday, deletedAt: '2026-09-18' }), task('cross-local', { due: '2026-09-17T18:00:00Z', status: 'done' })]
  const s = state({ details: {
    paper: details(['纸质报告'], { needsSubmission: true }), 'not-planned': details(['错误：不该出现']),
    submitted: details(['已交的表'], { needsSubmission: true, submittedAt: '2026-09-18T09:00:00+08:00' }),
    future: details(['未来报告'], { needsSubmission: true }), 'no-due': details(['没有日期的报告'], { needsSubmission: true }),
    deleted: details(['已删报告'], { needsSubmission: true }), 'cross-local': details(['当地当天'], { needsSubmission: true }),
  } })
  assert.deepEqual(carryItems(s, tasks, friday).map(item => item.label), ['纸质报告', '当地当天'])
  assert.deepEqual(blocksForDay(s, tasks, friday), [])
})

test('a task moved by an explicit block does not still require items from its old startAt day', () => {
  const tasks = [task('moved', { startAt: friday, context: ['desk-mac'] })]
  const s = state({ blocks: [block('new-date', 'moved', '09:00', '10:00', '2026-09-19')], details: { moved: details(['作品']) } })
  assert.deepEqual(carryItems(s, tasks, friday), [])
  assert.deepEqual(carryItems(s, tasks, '2026-09-19').map(item => item.label), ['作品', '电脑'])
})
