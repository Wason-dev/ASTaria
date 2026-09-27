import assert from 'node:assert/strict'
import test from 'node:test'
import { decisionProjection } from '../src/xixi/decisionProjection.ts'

const plan = (id, date, start, end, taskId = 'sat') => ({ id, date, start, end, taskId, title: 'SAT' })
const scenario = (extra = {}, decision = {}) => ({
  id: 'scenario', version: 1, status: 'preview', baseRevision: 1,
  date: '2026-09-20', days: 7, mode: 'rest',
  decision: {
    taskId: 'sat', title: 'SAT', strategy: 'defer', recurrence: 'once', todayMin: 30,
    effortMin: 60, baseline: [plan('old', '2026-09-20', '18:00', '19:00')],
    ...decision,
  },
  plans: [plan('new', '2026-09-21', '18:00', '19:00')],
  removedBlockIds: ['old'], unscheduled: [], warnings: [], taskVersions: {},
  createdAt: '2026-09-20T00:00:00Z', ...extra,
})

test('deferring compares real allocations and releases today without claiming completed work', () => {
  const today = decisionProjection(scenario(), 0)
  assert.equal(today.baselineMin, 60)
  assert.equal(today.candidateMin, 0)
  assert.equal(today.deltaMin, -60)
  assert.equal(today.freedTodayMin, 60)
  assert.equal(today.tomorrowAddedMin, 60)
  assert.equal(today.lastPlannedDate, '2026-09-21')
  assert.equal(today.unknownEffort, false)
  assert.deepEqual(today.baseline.map(item => item.id), ['old'])
  assert.deepEqual(today.candidate.map(item => item.id), ['new'])
  const tomorrow = decisionProjection(scenario(), 1)
  assert.equal(tomorrow.baselineMin, 60)
  assert.equal(tomorrow.candidateMin, 60)
  assert.equal(tomorrow.deltaMin, 0)
  assert.ok(!('completedMin' in today))
})

test('a one-off change never accumulates artificial monthly or yearly consequences', () => {
  const input = scenario()
  for (const offset of [6, 7, 89, 364, 365]) {
    const result = decisionProjection(input, offset)
    assert.equal(result.baselineMin, 60)
    assert.equal(result.candidateMin, 60)
    assert.equal(result.deltaMin, 0)
    assert.equal(result.occurrences, 1)
    assert.equal(result.conditional, false)
    assert.equal(result.lastPlannedDate, '2026-09-21')
    assert.equal(result.candidate.length, 1)
  }
})

test('bringing tomorrow work forward exposes today added time and tomorrow released time as negative deltas', () => {
  const input = scenario({ plans: [plan('new', '2026-09-20', '18:00', '19:00')] }, {
    strategy: 'today', recurrence: 'weekly', baseline: [plan('old', '2026-09-21', '18:00', '19:00')],
  })
  for (const offset of [0, 1, 6, 89, 364]) {
    const result = decisionProjection(input, offset)
    // These compare the original two calendar days, never repeated totals.
    assert.equal(result.freedTodayMin, -60)
    assert.equal(result.tomorrowAddedMin, -60)
  }
  assert.equal(decisionProjection(input, 0).deltaMin, 60)
  assert.equal(decisionProjection(input, 1).deltaMin, 0)
})

test('splitting an existing tomorrow allocation keeps retained blocks and measures only the actual shifted amount', () => {
  const input = scenario({ plans: [
    plan('new-today', '2026-09-20', '18:00', '18:20'),
    plan('new-tomorrow', '2026-09-21', '18:20', '19:00'),
  ] }, { strategy: 'split', baseline: [
    plan('retained', '2026-09-20', '17:00', '17:30'),
    plan('old', '2026-09-21', '18:00', '19:00'),
  ] })
  const result = decisionProjection(input, 6)
  assert.equal(result.freedTodayMin, -20)
  assert.equal(result.tomorrowAddedMin, -20)
  assert.equal(result.baselineMin, 90)
  assert.equal(result.candidateMin, 90)
  assert.equal(result.deltaMin, 0)
  const unchanged = decisionProjection(scenario({ plans: [], removedBlockIds: [] }), 6)
  assert.equal(unchanged.freedTodayMin, 0)
  assert.equal(unchanged.tomorrowAddedMin, 0)
})

test('weekly projections count partial cycles by each plan date, including the inclusive year boundary', () => {
  const input = scenario({}, { recurrence: 'weekly' })
  const expected = [
    [0, 60, 0, 1], [1, 60, 60, 1], [6, 60, 60, 1],
    [7, 120, 60, 2], [8, 120, 120, 2], [89, 780, 780, 13],
    [364, 3180, 3120, 53], [365, 3180, 3180, 53],
  ]
  for (const [offset, baseline, candidate, occurrences] of expected) {
    const result = decisionProjection(input, offset)
    assert.equal(result.baselineMin, baseline, `baseline at ${offset}`)
    assert.equal(result.candidateMin, candidate, `candidate at ${offset}`)
    assert.equal(result.deltaMin, candidate - baseline)
    assert.equal(result.occurrences, occurrences)
    assert.equal(result.conditional, true)
    // Repetitions do not manufacture actual future calendar blocks.
    assert.equal(result.candidate.length, 1)
    assert.equal(result.lastPlannedDate, '2026-09-21')
  }
})

test('the complete first-week distribution repeats rather than effort estimate times week count', () => {
  const input = scenario({ plans: [
    plan('next-day', '2026-09-21', '18:00', '18:30'),
    plan('last-day', '2026-09-26', '23:30', '24:00'),
  ] }, { recurrence: 'weekly', effortMin: 180 })
  assert.equal(decisionProjection(input, 0).candidateMin, 0)
  assert.equal(decisionProjection(input, 1).candidateMin, 30)
  assert.equal(decisionProjection(input, 5).candidateMin, 30)
  assert.equal(decisionProjection(input, 6).candidateMin, 60)
  assert.equal(decisionProjection(input, 8).candidateMin, 90)
  assert.equal(decisionProjection(input, 13).candidateMin, 120)
  assert.equal(decisionProjection(input, 364).candidateMin, 3120)
})

test('all horizon offsets match independent day-by-day accumulation for one-off and weekly distributions', () => {
  const baselineDistribution = [45, 0, 25, 0, 90, 10, 5]
  const candidateDistribution = [0, 30, 0, 80, 15, 0, 50]
  const distributionPlans = (prefix, distribution) => distribution.flatMap((minutes, day) => minutes ? [
    plan(`${prefix}-${day}`, `2026-09-${20 + day}`, '18:00', `${18 + Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`),
  ] : [])
  const baseline = distributionPlans('baseline', baselineDistribution)
  for (const recurrence of ['once', 'weekly']) {
    const input = scenario({ plans: distributionPlans('candidate', candidateDistribution), removedBlockIds: baseline.map(item => item.id) }, { recurrence, baseline })
    let expectedBaseline = 0, expectedCandidate = 0
    for (let offset = 0; offset <= 365; offset++) {
      if (recurrence === 'weekly' || offset < 7) {
        expectedBaseline += baselineDistribution[offset % 7]
        expectedCandidate += candidateDistribution[offset % 7]
      }
      const result = decisionProjection(input, offset)
      assert.equal(result.baselineMin, expectedBaseline, `${recurrence} baseline at ${offset}`)
      assert.equal(result.candidateMin, expectedCandidate, `${recurrence} candidate at ${offset}`)
      assert.equal(result.deltaMin, expectedCandidate - expectedBaseline, `${recurrence} delta at ${offset}`)
    }
  }
})

test('locked and started baseline blocks survive while only explicitly removed blocks are replaced', () => {
  const input = scenario({ plans: [plan('new', '2026-09-21', '18:00', '18:30')] }, { baseline: [
    plan('old', '2026-09-20', '18:30', '19:00'),
    plan('locked', '2026-09-20', '18:00', '18:30'),
  ] })
  const result = decisionProjection(input, 6)
  assert.deepEqual(result.candidate.map(item => item.id), ['locked', 'new'])
  assert.equal(result.baselineMin, 60)
  assert.equal(result.candidateMin, 60)
  assert.equal(result.freedTodayMin, 30)
  assert.equal(result.tomorrowAddedMin, 30)
})

test('unknown effort remains explicit even with visible allocated time', () => {
  for (const effortMin of [null, undefined, NaN, Infinity, 0, -1]) {
    const result = decisionProjection(scenario({}, { effortMin, recurrence: 'weekly' }), 89)
    assert.equal(result.unknownEffort, true)
    assert.equal(result.candidateMin, 780)
  }
  const empty = decisionProjection(scenario({ plans: [], removedBlockIds: [] }, { effortMin: null, baseline: [] }), 364)
  assert.equal(empty.candidateMin, 0)
  assert.equal(empty.unknownEffort, true)
  assert.equal(empty.lastPlannedDate, undefined)
})

test('no availability and partial allocations do not become a false completion prediction', () => {
  const empty = decisionProjection(scenario({ plans: [], unscheduled: [{ taskId: 'sat', title: 'SAT', reason: '空闲不足', remainingMin: 60 }] }), 6)
  assert.equal(empty.candidateMin, 0)
  assert.equal(empty.lastPlannedDate, undefined)
  const partial = decisionProjection(scenario({ plans: [plan('partial', '2026-09-21', '18:00', '18:20')] }), 364)
  assert.equal(partial.candidateMin, 20)
  assert.equal(partial.deltaMin, -40)
  assert.equal(partial.lastPlannedDate, '2026-09-21')
})

test('projections are confined to the selected task and first seven dates', () => {
  const input = scenario({ plans: [
    plan('selected', '2026-09-21', '18:00', '19:00'),
    plan('other-task', '2026-09-21', '18:00', '20:00', 'math'),
    plan('before', '2026-09-19', '18:00', '19:00'),
    plan('beyond', '2026-09-27', '18:00', '19:00'),
  ] })
  assert.deepEqual(decisionProjection(input, 365).candidate.map(item => item.id), ['selected'])
  const legacy = decisionProjection(scenario({ decision: undefined }), 365)
  assert.deepEqual(legacy.baseline, [])
  assert.deepEqual(legacy.candidate, [])
  assert.equal(legacy.unknownEffort, true)
})

test('calendar arithmetic is stable over DST and across month, year and leap-day boundaries', () => {
  const originalTimezone = process.env.TZ
  try {
    for (const zone of ['Asia/Shanghai', 'America/New_York', 'Europe/Berlin']) {
      process.env.TZ = zone
      for (const [date, nextDay] of [['2026-03-08', '2026-03-09'], ['2026-11-01', '2026-11-02'], ['2026-12-31', '2027-01-01'], ['2028-02-28', '2028-02-29']]) {
        const input = scenario({ date, plans: [plan('new', nextDay, '18:00', '19:00')] }, { recurrence: 'weekly', baseline: [plan('old', date, '18:00', '19:00')] })
        assert.equal(decisionProjection(input, 0).candidateMin, 0, `${zone} ${date}`)
        assert.equal(decisionProjection(input, 1).candidateMin, 60, `${zone} ${date}`)
        assert.equal(decisionProjection(input, 7).candidateMin, 60, `${zone} ${date}`)
        assert.equal(decisionProjection(input, 8).candidateMin, 120, `${zone} ${date}`)
      }
    }
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ
    else process.env.TZ = originalTimezone
  }
})

test('invalid dates, invalid durations and unbounded offsets never create fictitious allocations', () => {
  const input = scenario({ plans: [
    plan('invalid-date', '2026-09-31', '18:00', '19:00'),
    plan('invalid-start', '2026-09-21', '24:15', '25:00'),
    plan('reverse', '2026-09-21', '19:00', '18:00'),
    plan('empty', '2026-09-21', '18:00', '18:00'),
    plan('valid', '2026-09-21', '23:30', '24:00'),
  ] }, { recurrence: 'weekly' })
  assert.deepEqual(decisionProjection(input, 6).candidate.map(item => item.id), ['valid'])
  assert.equal(decisionProjection(input, 1.9).candidateMin, 30)
  assert.equal(decisionProjection(input, -1).candidateMin, 0)
  assert.equal(decisionProjection(input, NaN).candidateMin, 0)
  assert.equal(decisionProjection(input, 9999).candidateMin, 1590)
  assert.equal(decisionProjection(scenario({ date: '2026-02-30' }), 6).candidateMin, 0)
})

test('projection preserves every input object and returns independent plan objects', () => {
  const input = scenario()
  const before = structuredClone(input)
  const freeze = value => {
    if (value && typeof value === 'object') {
      Object.values(value).forEach(freeze)
      Object.freeze(value)
    }
    return value
  }
  freeze(input)
  const result = decisionProjection(input, 364)
  result.baseline[0].title = 'changed locally'
  result.candidate[0].date = '2030-01-01'
  assert.deepEqual(input, before)
})
