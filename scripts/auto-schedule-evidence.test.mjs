import test from 'node:test'
import assert from 'node:assert/strict'
import { initialTaskSchedule } from '../server/autoSchedule.mjs'
import { defaultPlanner } from '../server/planner.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-18' // Friday
const NOW = new Date(`${DATE}T17:00:00+08:00`)
const routine = (id, start, end, patch = {}) => ({
  id, title: '晚自习', kind: 'available', weekdays: [5], start, end, location: '', items: [], enabled: true, ...patch,
})
const classRow = (id, start, end, patch = {}) => ({
  id, title: '物理', kind: 'class', weekdays: [5], start, end, location: '教室', items: [], enabled: true, ...patch,
})
const task = patch => ({ id: 'work', title: '报告', status: 'todo', importance: 2, ...patch })
const schedule = (minutes, ranges, patch = {}, options = {}) => {
  const item = task({ estimateMin: minutes, due: `${DATE}T22:00:00+08:00`, ...patch })
  const state = { ...defaultPlanner(), routines: ranges.map(([start, end], index) => routine(`slot-${index}`, start, end)) }
  return initialTaskSchedule({ state, allTasks: [item], tasks: [item], now: NOW,
    idForBlock: (_, index) => `plan-${index}`, bufferMin: 0, ...options })
}
const evidenceFor = (result, taskId) => result.evidence.find(item => item.taskId === taskId)
const times = result => result.plans.map(({ date, start, end }) => ({ date, start, end }))
const EVIDENCE_KEYS = ['taskId', 'title', 'due', 'totalMin', 'scheduledMin', 'remainingMin', 'constraints',
  'selectionPolicy', 'chosen', 'evaluatedDays', 'truncated', 'relations']
const CONSTRAINT_KEYS = ['date', 'preferredWindow', 'contiguous', 'minSegmentMin', 'bufferMin']
const CHOSEN_KEYS = ['date', 'start', 'end', 'windowTitles']
const DAY_KEYS = ['date', 'classCount', 'occupiedCount', 'maxFreeMin', 'totalFreeMin', 'candidateCount']
const UNSCHEDULED_KEYS = ['taskId', 'title', 'remainingMin', 'reason', 'cause', 'maxFreeMin', 'availableMin', 'alternatives']
const ALTERNATIVE_KEYS = ['date', 'start', 'end', 'minutes']
const CAUSES = new Set(['deadline_passed', 'no_contiguous_slot', 'insufficient_capacity', 'segment_limit'])
const assertShape = result => {
  assert.equal(result.evidence.length, result.allocations.length, 'one evidence item per processed task')
  for (const item of result.evidence) {
    assert.deepEqual(Object.keys(item).sort(), [...EVIDENCE_KEYS].sort())
    assert.ok(!Object.hasOwn(item, 'reason'), 'evidence must not generate a user-facing reason sentence')
    assert.deepEqual(Object.keys(item.constraints).sort(), [...CONSTRAINT_KEYS].sort())
    assert.ok(['first_complete_then_split', 'same_day_contiguous'].includes(item.selectionPolicy))
    for (const chosen of item.chosen) {
      assert.deepEqual(Object.keys(chosen).sort(), [...CHOSEN_KEYS].sort())
      assert.ok(chosen.windowTitles.every(title => typeof title === 'string'))
    }
    for (const day of item.evaluatedDays) {
      assert.deepEqual(Object.keys(day).sort(), [...DAY_KEYS].sort())
      for (const key of ['classCount', 'occupiedCount', 'maxFreeMin', 'totalFreeMin', 'candidateCount']) {
        assert.ok(Number.isInteger(day[key]) && day[key] >= 0, `${key} is a real non-negative minute/count`)
      }
    }
    assert.ok(item.evaluatedDays.length <= 14)
    assert.equal(item.totalMin - item.scheduledMin, item.remainingMin)
  }
  for (const item of result.unscheduled) {
    const keys = UNSCHEDULED_KEYS.concat(item.date === undefined ? [] : ['date'])
    assert.deepEqual(Object.keys(item).sort(), keys.sort())
    assert.ok(CAUSES.has(item.cause), `factual cause enum, got ${item.cause}`)
    assert.ok(Number.isInteger(item.maxFreeMin) && item.maxFreeMin >= 0)
    assert.ok(Number.isInteger(item.availableMin) && item.availableMin >= 0)
    for (const alternative of item.alternatives) {
      assert.deepEqual(Object.keys(alternative).sort(), [...ALTERNATIVE_KEYS].sort())
      assert.ok(alternative.minutes >= Math.min(15, item.remainingMin))
    }
  }
}

test('evidence is additive: legacy plans, allocations and unscheduled reasons stay identical', () => {
  const split = schedule(30, [['18:00', '18:25'], ['19:00', '19:20']])
  assert.deepEqual(times(split), [{ date: DATE, start: '18:00', end: '18:15' }, { date: DATE, start: '19:00', end: '19:15' }])
  assert.deepEqual(split.allocations, [{ taskId: 'work', title: '报告', totalMin: 30, scheduledMin: 30, estimated: false }])
  assert.deepEqual(split.unscheduled, [])
  assert.deepEqual(split.evidence[0].chosen.map(({ date, start, end }) => ({ date, start, end })),
    [{ date: DATE, start: '18:00', end: '18:15' }, { date: DATE, start: '19:00', end: '19:15' }])
  assert.equal(split.evidence[0].due, `${DATE}T22:00:00+08:00`, 'raw due value, not a rewritten/normalized date')
  assert.deepEqual(split.evidence[0].constraints, { date: null, preferredWindow: null, contiguous: false, minSegmentMin: 15, bufferMin: 0 })
  const short = schedule(10, [['18:00', '18:10']])
  assert.deepEqual(times(short), [{ date: DATE, start: '18:00', end: '18:10' }], 'explicit short tasks stay whole')
  assert.equal(short.evidence[0].constraints.minSegmentMin, 10, 'effective floor is clamped to the task itself')
  assertShape(split)
  assertShape(short)

  const complete = schedule(30, [['18:00', '18:25'], ['19:00', '19:30']])
  assert.deepEqual(times(complete), [{ date: DATE, start: '19:00', end: '19:30' }])
  assert.equal(complete.evidence[0].evaluatedDays[0].candidateCount, 2)

  const shortfall = schedule(30, [['18:00', '18:25'], ['19:00', '19:05']])
  assert.deepEqual(times(shortfall), [{ date: DATE, start: '18:00', end: '18:15' }])
  assert.equal(shortfall.allocations[0].scheduledMin, 15)
  assert.equal(shortfall.unscheduled[0].remainingMin, 15)
  assert.equal(shortfall.unscheduled[0].reason, '截止前没有足够的可用连续空档（拆分时每段至少 15 分钟），现有安排保持不变；还剩 15 分钟未安排')
  assert.equal(shortfall.unscheduled[0].cause, 'segment_limit')
  assertShape(shortfall)

  const occurrence = schedule(60, [['18:00', '18:50'], ['18:50', '19:40']], {
    due: undefined,
    occurrence: { seriesId: 'weekly', date: DATE, preferredWindow: '晚自习', placement: 'start', allowFallback: false },
  })
  assert.deepEqual(times(occurrence), [{ date: DATE, start: '18:00', end: '19:00' }])
  assert.deepEqual(occurrence.allocations, [{ taskId: 'work', title: '报告', date: DATE, totalMin: 60, scheduledMin: 60, estimated: false,
    preferredWindow: '晚自习', fallback: false }])
  assert.equal(occurrence.evidence[0].selectionPolicy, 'same_day_contiguous')
  assert.deepEqual(occurrence.evidence[0].constraints, { date: DATE, preferredWindow: '晚自习', contiguous: true, minSegmentMin: 15, bufferMin: 0 })
  assertShape(occurrence)

  const target = '2026-09-24'
  const fixed = task({ id: 'fixed-task', title: '原安排', estimateMin: 30 })
  const homework = task({ id: 'math', title: '数学作业', estimateMin: 30, startAt: DATE, due: `${target}T21:40:00+08:00` })
  const exact = initialTaskSchedule({
    state: { ...defaultPlanner(), routines: [routine('dorm', '20:30', '22:30', { weekdays: [3, 4, 5], title: '宿舍' })],
      blocks: [{ id: 'fixed-plan', taskId: fixed.id, date: target, start: '20:30', end: '21:00', locked: true }] },
    allTasks: [fixed, homework], tasks: [homework], now: NOW, idForBlock: () => 'proposed-math', bufferMin: 10,
    windowByTask: new Map([['math', '宿舍']]), dateByTask: new Map([['math', target]]),
  })
  assert.deepEqual(exact.plans, [{ id: 'proposed-math', taskId: 'math', date: target, start: '21:10', end: '21:40', locked: false }])
  assert.deepEqual(exact.unscheduled, [])
  assert.equal(exact.evidence[0].constraints.date, target)
  assert.equal(exact.evidence[0].constraints.contiguous, true)
  assert.equal(exact.evidence[0].selectionPolicy, 'same_day_contiguous')
  assertShape(exact)
})

test('evaluated days expose checkable class, occupancy and window minutes', () => {
  const prior = task({ id: 'prior', title: '原安排', estimateMin: 20 })
  const implicit = task({ id: 'implicit', title: '默写', estimateMin: 30, startAt: `${DATE}T07:00:00+08:00` })
  const work = task({ id: 'work', title: '报告', estimateMin: 30, due: `${DATE}T22:00:00+08:00` })
  const result = initialTaskSchedule({
    state: { ...defaultPlanner(), routines: [classRow('class-row', '08:00', '09:00'), routine('eve', '18:00', '20:00')],
      blocks: [{ id: 'prior-block', taskId: prior.id, date: DATE, start: '18:00', end: '18:20', locked: true }],
      dayEvents: [{ id: 'assembly', title: '校会', date: DATE, start: '09:00', end: '10:00', location: '礼堂', items: [] }] },
    allTasks: [work, prior, implicit], tasks: [work], now: NOW, idForBlock: () => 'new', bufferMin: 10,
  })
  assert.deepEqual(times(result), [{ date: DATE, start: '18:30', end: '19:00' }])
  const evidence = result.evidence[0]
  assert.deepEqual(evidence.evaluatedDays, [{ date: DATE, classCount: 2, occupiedCount: 2, maxFreeMin: 90, totalFreeMin: 90, candidateCount: 1 }],
    'classCount includes the fixed day event; occupiedCount includes the implicit startAt interval')
  assert.deepEqual(evidence.chosen, [{ date: DATE, start: '18:30', end: '19:00', windowTitles: ['晚自习'] }])
  assert.equal(evidence.constraints.bufferMin, 10)
  assert.equal(evidence.constraints.minSegmentMin, 15)
  assert.equal(evidence.truncated, false)
  assertShape(result)
})

test('buffer and deadline change the reported effective window exactly like selection', () => {
  const taskItem = task({ id: 'work', title: '报告', estimateMin: 30, due: `${DATE}T19:50:00+08:00` })
  const prior = task({ id: 'prior', title: '原安排', estimateMin: 20 })
  const state = { ...defaultPlanner(), routines: [routine('dorm', '18:00', '20:00'), routine('other', '20:30', '22:00', { title: '宿舍' })],
    blocks: [{ id: 'prior-block', taskId: prior.id, date: DATE, start: '18:00', end: '18:20', locked: true }] }
  const run = bufferMin => initialTaskSchedule({ state, tasks: [taskItem], allTasks: [taskItem, prior], now: NOW,
    idForBlock: () => 'new', bufferMin, windowByTask: new Map([['work', '晚自习']]) })
  const buffered = run(10)
  assert.deepEqual(times(buffered), [{ date: DATE, start: '18:30', end: '19:00' }])
  assert.deepEqual(buffered.evidence[0].evaluatedDays[0],
    { date: DATE, classCount: 0, occupiedCount: 1, maxFreeMin: 80, totalFreeMin: 80, candidateCount: 1 })
  assert.deepEqual(buffered.evidence[0].chosen, [{ date: DATE, start: '18:30', end: '19:00', windowTitles: ['晚自习'] }])
  const unbuffered = run(0)
  assert.deepEqual(times(unbuffered), [{ date: DATE, start: '18:20', end: '18:50' }])
  assert.deepEqual(unbuffered.evidence[0].evaluatedDays[0],
    { date: DATE, classCount: 0, occupiedCount: 1, maxFreeMin: 90, totalFreeMin: 90, candidateCount: 1 })
  assertShape(buffered)
  assertShape(unbuffered)
})

test('fragmented time reports segment_limit with real gaps and only real leftover candidates', () => {
  const result = schedule(45, [['18:00', '18:20'], ['19:00', '19:20'], ['20:00', '20:20']])
  assert.deepEqual(times(result), [{ date: DATE, start: '18:00', end: '18:20' }])
  const unscheduled = result.unscheduled[0]
  assert.equal(unscheduled.cause, 'segment_limit')
  assert.equal(unscheduled.maxFreeMin, 20)
  assert.equal(unscheduled.availableMin, 60)
  assert.deepEqual(unscheduled.alternatives, [
    { date: DATE, start: '19:00', end: '19:20', minutes: 20 },
    { date: DATE, start: '20:00', end: '20:20', minutes: 20 },
  ])
  assert.deepEqual(result.evidence[0].evaluatedDays, [{ date: DATE, classCount: 0, occupiedCount: 0, maxFreeMin: 20, totalFreeMin: 60, candidateCount: 3 }])
  assertShape(result)

  const tiny = schedule(30, [['18:00', '18:10'], ['19:00', '19:10'], ['20:00', '20:10']])
  assert.deepEqual(tiny.plans, [])
  assert.equal(tiny.unscheduled[0].cause, 'segment_limit')
  assert.equal(tiny.unscheduled[0].maxFreeMin, 10)
  assert.equal(tiny.unscheduled[0].availableMin, 30)
  assert.deepEqual(tiny.unscheduled[0].alternatives, [], 'no short filler is ever offered as an alternative')
  assert.deepEqual(tiny.evidence[0].evaluatedDays[0], { date: DATE, classCount: 0, occupiedCount: 0, maxFreeMin: 10, totalFreeMin: 30, candidateCount: 0 })
  assertShape(tiny)
})

test('deadline passed is a factual cause and never invents free capacity', () => {
  const result = schedule(30, [['18:00', '19:00']], { due: '2026-09-17T22:00:00+08:00' })
  assert.deepEqual(result.plans, [])
  assert.equal(result.unscheduled[0].cause, 'deadline_passed')
  assert.equal(result.unscheduled[0].reason, '截止时间已过，未安排过去的时段；还剩 30 分钟未安排')
  assert.equal(result.unscheduled[0].maxFreeMin, 0)
  assert.equal(result.unscheduled[0].availableMin, 0)
  assert.deepEqual(result.unscheduled[0].alternatives, [])
  assert.deepEqual(result.evidence[0].evaluatedDays, [], 'past days are not reported as evaluated capacity')
  assert.deepEqual(result.evidence[0].chosen, [])
  assertShape(result)

  const passedToday = schedule(30, [['18:00', '19:00']], { due: `${DATE}T10:00:00+08:00` })
  assert.deepEqual(passedToday.plans, [])
  assert.equal(passedToday.unscheduled[0].cause, 'deadline_passed')
  assert.equal(passedToday.unscheduled[0].maxFreeMin, 0)
  assert.equal(passedToday.unscheduled[0].availableMin, 0)
  assert.deepEqual(passedToday.evidence[0].evaluatedDays,
    [{ date: DATE, classCount: 0, occupiedCount: 0, maxFreeMin: 0, totalFreeMin: 0, candidateCount: 0 }],
    'the deadline day may be really scanned but reports zero effective capacity after the deadline cut')
  assertShape(passedToday)
})

test('an explicit requested date never splits and reports contiguous evidence', () => {
  const target = '2026-09-21'
  const fixed = task({ id: 'fixed-task', title: '原安排', estimateMin: 30 })
  const base = due => ({
    state: { ...defaultPlanner(), routines: [routine('dorm', '20:30', '22:30', { weekdays: [1], title: '宿舍' })],
      blocks: [{ id: 'fixed-plan', taskId: fixed.id, date: target, start: '20:30', end: '21:00', locked: true }] },
    allTasks: [fixed, task({ id: 'math', title: '数学作业', estimateMin: 30, startAt: DATE, due })],
  })
  const run = (due, options = {}) => {
    const fixture = base(due)
    return initialTaskSchedule({ ...fixture, tasks: [fixture.allTasks[1]], now: NOW, idForBlock: () => 'proposed-math',
      bufferMin: 10, windowByTask: new Map([['math', '宿舍']]), dateByTask: new Map([['math', target]]), ...options })
  }
  const short = run(`${target}T21:35:00+08:00`)
  assert.deepEqual(short.plans, [])
  assert.equal(short.unscheduled[0].date, target)
  assert.equal(short.unscheduled[0].cause, 'insufficient_capacity')
  assert.equal(short.unscheduled[0].maxFreeMin, 25)
  assert.equal(short.unscheduled[0].availableMin, 25)
  assert.deepEqual(short.unscheduled[0].alternatives, [])
  assert.equal(short.evidence[0].constraints.contiguous, true)
  assert.equal(short.evidence[0].evaluatedDays[0].candidateCount, 0)

  const fits = run(`${target}T21:40:00+08:00`)
  assert.deepEqual(times(fits), [{ date: target, start: '21:10', end: '21:40' }])
  const fitsEvidence = fits.evidence[0]
  assert.equal(fitsEvidence.selectionPolicy, 'same_day_contiguous')
  assert.deepEqual(fitsEvidence.chosen, [{ date: target, start: '21:10', end: '21:40', windowTitles: ['宿舍'] }])
  assert.deepEqual(fitsEvidence.evaluatedDays, [{ date: target, classCount: 0, occupiedCount: 1, maxFreeMin: 30, totalFreeMin: 30, candidateCount: 1 }])

  const fragmented = initialTaskSchedule({
    state: { ...defaultPlanner(), routines: [routine('dorm2', '20:30', '21:50', { weekdays: [1], title: '宿舍' }),
      classRow('gap-1', '20:50', '21:00', { weekdays: [1] }), classRow('gap-2', '21:20', '21:30', { weekdays: [1] })] },
    allTasks: [task({ id: 'math', title: '数学作业', estimateMin: 30 })],
    tasks: [task({ id: 'math', title: '数学作业', estimateMin: 30 })], now: NOW, idForBlock: () => 'p', bufferMin: 0,
    windowByTask: new Map([['math', '宿舍']]), dateByTask: new Map([['math', target]]),
  })
  assert.deepEqual(fragmented.plans, [], 'a requested day waits for one complete slot instead of splitting')
  assert.equal(fragmented.unscheduled[0].cause, 'no_contiguous_slot')
  assert.equal(fragmented.unscheduled[0].maxFreeMin, 20)
  assert.equal(fragmented.unscheduled[0].availableMin, 60)
  assert.deepEqual(fragmented.unscheduled[0].alternatives, [])
  assert.deepEqual(fragmented.evidence[0].evaluatedDays[0],
    { date: target, classCount: 2, occupiedCount: 0, maxFreeMin: 20, totalFreeMin: 60, candidateCount: 0 })
  assertShape(fits)
  assertShape(fragmented)
})

test('occurrence evidence stays same-day, whole and window-faithful', () => {
  const fragmented = schedule(20, [['18:00', '18:10'], ['18:20', '18:30']], {
    due: undefined,
    occurrence: { seriesId: 'weekly', date: DATE, preferredWindow: '晚自习', placement: 'start', allowFallback: false },
  })
  assert.deepEqual(fragmented.plans, [])
  assert.equal(fragmented.unscheduled[0].cause, 'no_contiguous_slot')
  assert.equal(fragmented.unscheduled[0].maxFreeMin, 10)
  assert.equal(fragmented.unscheduled[0].availableMin, 20)
  assert.deepEqual(fragmented.unscheduled[0].alternatives, [])
  assert.equal(fragmented.unscheduled[0].reason, `${DATE} 的「晚自习」没有可用的完整 20 分钟空档；保留当天实例，不拆段、不挪到其他日期`)
  assert.deepEqual(fragmented.evidence[0].evaluatedDays, [{ date: DATE, classCount: 0, occupiedCount: 0, maxFreeMin: 10, totalFreeMin: 20, candidateCount: 0 }])

  const past = schedule(20, [['18:00', '19:00']], {
    due: undefined,
    occurrence: { seriesId: 'weekly', date: '2026-09-17', preferredWindow: '晚自习', placement: 'start', allowFallback: false },
  })
  assert.equal(past.unscheduled[0].cause, 'deadline_passed')
  assert.deepEqual(past.evidence[0].evaluatedDays, [])
  assert.deepEqual(past.unscheduled[0].alternatives, [])

  const other = task({ id: 'other', title: '已安排', estimateMin: 120, importance: 1 })
  const fallbackTask = task({ id: 'fb', title: '练习', estimateMin: 30, startAt: DATE,
    occurrence: { seriesId: 's', date: DATE, preferredWindow: '晚自习', placement: 'start', allowFallback: true } })
  const fallback = initialTaskSchedule({
    state: { ...defaultPlanner(), routines: [routine('study', '18:00', '20:00'), routine('dorm', '20:30', '22:30', { title: '宿舍' })],
      blocks: [{ id: 'study-block', taskId: other.id, date: DATE, start: '18:00', end: '20:00', locked: true }] },
    allTasks: [other, fallbackTask], tasks: [fallbackTask], now: NOW, idForBlock: () => 'fb-block', bufferMin: 10,
  })
  assert.deepEqual(times(fallback), [{ date: DATE, start: '20:30', end: '21:00' }])
  assert.equal(fallback.allocations[0].fallback, true)
  assert.equal(fallback.evidence[0].constraints.preferredWindow, '晚自习')
  assert.deepEqual(fallback.evidence[0].chosen, [{ date: DATE, start: '20:30', end: '21:00', windowTitles: ['宿舍'] }],
    'evidence shows the window the slot really landed in')
  assert.equal(fallback.evidence[0].evaluatedDays[0].occupiedCount, 1)
  assertShape(fragmented)
  assertShape(past)
  assertShape(fallback)
})

test('duplicate same-day instances occupy each other without splitting or moving', () => {
  const first = task({ id: 'inst-a', title: '单词背诵', estimateMin: 20, startAt: DATE,
    occurrence: { seriesId: 'series-a', date: DATE, preferredWindow: '晚自习', placement: 'start', allowFallback: true } })
  const second = task({ id: 'inst-b', title: '课文朗读', estimateMin: 20, startAt: DATE,
    occurrence: { seriesId: 'series-b', date: DATE, preferredWindow: '晚自习', placement: 'start', allowFallback: true } })
  const result = initialTaskSchedule({ state: { ...defaultPlanner(), routines: [routine('w', '18:00', '18:30')] },
    allTasks: [first, second], tasks: [first, second], now: NOW, idForBlock: (id, index) => `${id}-${index}`, bufferMin: 0 })
  assert.deepEqual(times(result), [{ date: DATE, start: '18:00', end: '18:20' }])
  assert.deepEqual(result.evidence.map(item => item.taskId), ['inst-a', 'inst-b'])
  const blocked = evidenceFor(result, 'inst-b')
  assert.deepEqual(blocked.chosen, [])
  assert.equal(blocked.evaluatedDays[0].occupiedCount, 1, 'the earlier instance is real occupancy')
  assert.equal(blocked.evaluatedDays[0].maxFreeMin, 10)
  assert.equal(result.unscheduled[0].taskId, 'inst-b')
  assert.equal(result.unscheduled[0].cause, 'insufficient_capacity')
  assert.equal(result.unscheduled[0].maxFreeMin, 10)
  assert.equal(result.unscheduled[0].availableMin, 10)
  assert.deepEqual(result.unscheduled[0].alternatives, [])
  assert.ok(result.plans.every(block => block.date === DATE), 'never pushes an instance to another day')
  assertShape(result)
})

test('a missing named window reports zero rather than claiming other free time', () => {
  const windowTask = task({ id: 'work', title: '报告', estimateMin: 30, due: '2026-09-20T22:00:00+08:00' })
  const filtered = initialTaskSchedule({ state: { ...defaultPlanner(), routines: [routine('morning', '08:00', '10:00', {
      title: '宿舍', weekdays: [0, 1, 2, 3, 4, 5, 6],
    })] },
    allTasks: [windowTask], tasks: [windowTask], now: NOW, idForBlock: () => 'p', bufferMin: 0,
    windowByTask: new Map([['work', '晚自习']]) })
  assert.deepEqual(filtered.plans, [], 'never silently places outside the requested window')
  assert.equal(filtered.evidence[0].constraints.preferredWindow, '晚自习')
  assert.deepEqual(filtered.evidence[0].evaluatedDays, [DATE, '2026-09-19', '2026-09-20'].map(date =>
    ({ date, classCount: 0, occupiedCount: 0, maxFreeMin: 0, totalFreeMin: 0, candidateCount: 0 })),
  'three real days were scanned; two hours of outside-window capacity each day is never claimed as free')
  assert.equal(filtered.unscheduled[0].cause, 'insufficient_capacity')
  assert.equal(filtered.unscheduled[0].maxFreeMin, 0)
  assert.equal(filtered.unscheduled[0].availableMin, 0)
  assert.deepEqual(filtered.unscheduled[0].alternatives, [])
  assertShape(filtered)
})

test('due dates bound the scan: an unscanned Saturday is never invented as an alternative', () => {
  const friday = task({ id: 'work', title: '报告', estimateMin: 30, due: DATE })
  const result = initialTaskSchedule({ state: { ...defaultPlanner(), routines: [routine('sat', '09:00', '22:00', { weekdays: [6] })] },
    allTasks: [friday], tasks: [friday], now: NOW, idForBlock: () => 'p', bufferMin: 0 })
  assert.deepEqual(result.plans, [])
  assert.equal(result.unscheduled[0].cause, 'insufficient_capacity')
  assert.equal(result.unscheduled[0].maxFreeMin, 0)
  assert.deepEqual(result.unscheduled[0].alternatives, [])
  assert.deepEqual(result.evidence[0].evaluatedDays.map(day => day.date), [DATE])
  assert.ok(result.evidence[0].evaluatedDays.every(day => day.date <= DATE))
  assertShape(result)
})

test('long bounded scans cap evaluated days at 14 and mark truncation honestly', () => {
  const tiny = Array.from({ length: 7 }, (_, index) => routine(`tiny-${index}`, '18:00', '18:05', { weekdays: [index] }))
  const longTask = task({ id: 'long', title: '复习', estimateMin: 30, due: '2026-10-08' })
  const result = initialTaskSchedule({ state: { ...defaultPlanner(), routines: tiny }, allTasks: [longTask], tasks: [longTask],
    now: NOW, idForBlock: () => 'x', bufferMin: 0 })
  const evidence = result.evidence[0]
  assert.equal(evidence.evaluatedDays.length, 14)
  assert.equal(evidence.evaluatedDays[0].date, '2026-09-18')
  assert.equal(evidence.evaluatedDays.at(-1).date, '2026-10-01')
  assert.equal(evidence.truncated, true)
  assert.equal(evidence.evaluatedDays.reduce((sum, day) => sum + day.totalFreeMin, 0), 70, 'only recorded days are inspectable')
  assert.ok(result.unscheduled[0].availableMin > 70, 'aggregate facts still describe every really scanned day')
  assert.equal(result.unscheduled[0].maxFreeMin, 5)
  assert.equal(result.unscheduled[0].cause, 'segment_limit')
  assert.deepEqual(result.unscheduled[0].alternatives, [])
  assertShape(result)

  const boundaryTask = task({ id: 'work', title: '报告', estimateMin: 30, due: '2026-10-01' })
  const boundary = initialTaskSchedule({ state: { ...defaultPlanner(), routines: [] }, allTasks: [boundaryTask],
    tasks: [boundaryTask], now: NOW, idForBlock: () => 'p', bufferMin: 0 })
  assert.equal(boundary.evidence[0].evaluatedDays.length, 14, 'exactly fourteen scanned days fit without truncation')
  assert.equal(boundary.evidence[0].truncated, false)
  assert.equal(boundary.evidence[0].evaluatedDays[0].date, '2026-09-18')
  assert.equal(boundary.evidence[0].evaluatedDays.at(-1).date, '2026-10-01')

  const horizonTask = task({ id: 'work', title: '报告', estimateMin: 30, due: '2028-10-18' })
  const horizon = initialTaskSchedule({ state: { ...defaultPlanner(), routines: [] }, allTasks: [horizonTask],
    tasks: [horizonTask], now: NOW, idForBlock: () => 'p', bufferMin: 0 })
  assert.equal(horizon.evidence[0].evaluatedDays.length, 14)
  assert.equal(horizon.evidence[0].truncated, true, 'the 366-day search horizon is a bounded evaluation')
  assertShape(boundary)
  assertShape(horizon)

  const farDate = '2026-10-08'
  const far = task({ id: 'far', title: '总复习', estimateMin: 30, due: '2026-10-13' })
  const scheduled = initialTaskSchedule({
    state: { ...defaultPlanner(), routines: [],
      dayOverrides: { [farDate]: { date: farDate, sourceWeekday: 4, routines: [routine('far-slot', '18:00', '19:00', { weekdays: [4] })] } } },
    allTasks: [far], tasks: [far], now: NOW, idForBlock: () => 'far-plan', bufferMin: 0,
  })
  assert.deepEqual(times(scheduled), [{ date: farDate, start: '18:00', end: '18:30' }])
  assert.equal(scheduled.evidence[0].evaluatedDays.length, 14)
  assert.equal(scheduled.evidence[0].truncated, true)
  assert.ok(!scheduled.evidence[0].evaluatedDays.some(day => day.date === farDate), 'chosen day beyond the recorded window is only reported via chosen')
  assert.deepEqual(scheduled.evidence[0].chosen, [{ date: farDate, start: '18:00', end: '18:30', windowTitles: ['晚自习'] }])
  assertShape(scheduled)
})

test('a task without a due date scans exactly its bounded week', () => {
  const noDue = task({ id: 'work', title: '报告', estimateMin: 30 })
  const result = initialTaskSchedule({ state: { ...defaultPlanner(), routines: [] }, allTasks: [noDue], tasks: [noDue],
    now: NOW, idForBlock: () => 'p', bufferMin: 0 })
  assert.equal(result.evidence[0].evaluatedDays.length, 7)
  assert.deepEqual(result.evidence[0].evaluatedDays.map(day => day.date),
    ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'])
  assert.equal(result.evidence[0].truncated, false)
  assert.equal(result.unscheduled[0].cause, 'insufficient_capacity')
  assertShape(result)
})

test('evidence has one item per processed task and none for filtered tasks', () => {
  const todo = task({ id: 'a', title: '报告', estimateMin: 30 })
  const doing = task({ id: 'b', title: '练习', status: 'doing', importance: 3, estimateMin: 20, due: '2026-09-20' })
  const done = task({ id: 'c', title: '已完成', status: 'done', importance: 3, estimateMin: 20 })
  const goal = task({ id: 'd', title: '余时目标', estimateMin: 20, freeTimeGoalId: 'goal-1' })
  const result = initialTaskSchedule({ state: { ...defaultPlanner(), routines: [routine('e', '18:00', '19:00')] },
    allTasks: [todo, doing, done, goal], tasks: [todo, doing, done, goal], now: NOW, idForBlock: (id, index) => `${id}-${index}`, bufferMin: 5 })
  assert.deepEqual(result.evidence.map(item => item.taskId), result.allocations.map(item => item.taskId))
  assert.deepEqual(result.evidence.map(item => item.taskId), ['b', 'a'])
  assertShape(result)
})
