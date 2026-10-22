import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

// Match Vite's relative TypeScript resolution while testing the real selectors.
const sourceRoot = new URL('../src/', import.meta.url).href
const resolution = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
      return nextResolve(`${specifier}.ts`, context)
    }
    return nextResolve(specifier, context)
  },
})
const { buildWorkbenchBriefing, collectionExplanations, collectionSchedulingFacts, deadlineContext, scheduleExplanationsFor } = await import('../src/workbench/briefing.ts')
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
const briefing = (tasks, explanations, spent = () => 0, focus = 35, at = now, scheduled = {}, blocks = [], completed = {}) =>
  buildWorkbenchBriefing(tasks, at, focus, spent, scheduled, blocks, completed, explanations)

test('written explanations are read per task and malformed maps never throw', () => {
  const map = { one: ['先按课表空档推进', ' 先按课表空档推进 ', '', 3, null], two: 'not-an-array' }
  assert.deepEqual(scheduleExplanationsFor(map, 'one'), ['先按课表空档推进'])
  assert.deepEqual(scheduleExplanationsFor(map, 'two'), [])
  assert.deepEqual(scheduleExplanationsFor(map, 'missing'), [])
  assert.deepEqual(scheduleExplanationsFor(undefined, 'one'), [])
  assert.deepEqual(scheduleExplanationsFor(null, 'one'), [])
  assert.deepEqual(scheduleExplanationsFor(Object.create({ one: ['inherited field'] }), 'one'), [])
  assert.deepEqual(scheduleExplanationsFor({ one: { 0: 'array-like', length: 1 } }, 'one'), [])
  assert.deepEqual(scheduleExplanationsFor({ one: [null, 7, {}, '真实理由'] }, 'one'), ['真实理由'])
  assert.deepEqual(scheduleExplanationsFor({ one: ['同一句', '同一句'] }, 'one'), ['同一句'])
  assert.deepEqual(scheduleExplanationsFor({}, 'one'), [])
})

test('a written reason replaces only the advice paragraph and its basis', () => {
  const tasks = [task('later', { due: '2026-09-20' }), task('first', { due: '2026-09-17', estimateMin: 35 })]
  const reasons = { first: ['周四傍晚有一段空档，先把阅读推进到下一节', '截止更近，先留出完整一段'] }
  const result = briefing(tasks, reasons)
  assert.equal(result.recommendation.task.id, 'first')
  assert.equal(result.recommendation.summary, reasons.first[0])
  assert.deepEqual(result.recommendation.evidence, reasons.first)
  assert.deepEqual(result.recommendation.explanations, reasons.first)
  // The headline stays the local structural framing; it never quotes the model.
  assert.equal(result.recommendation.headline, '可开始「first」')
  assert.doesNotMatch(result.recommendation.headline, /空档|阅读/)
  // Ordering and startability keep following the local task rules; written
  // explanations never change which task is available or recommended.
  const without = briefing(tasks, {})
  assert.equal(result.availableCount, without.availableCount)
  assert.equal(briefing(tasks, { later: ['这一项的理由'] }).recommendation.task.id, without.recommendation.task.id)
  assert.deepEqual(briefing(tasks, reasons).recommendation.task, tasks[1])
})

test('without a written reason the recommendation shows facts instead of template advice', () => {
  const entry = task('essay', { due: '2026-09-17', estimateMin: 70 })
  const spent = () => 40 * minute
  const result = briefing([entry], {}, spent)
  const recommendation = result.recommendation
  assert.deepEqual(recommendation.explanations, [])
  assert.equal(recommendation.summary, recommendation.facts.join(' · '))
  assert.match(recommendation.summary, /9月17日 · 全天 · 今天截止/)
  assert.match(recommendation.summary, /原预计 70 分钟/)
  assert.match(recommendation.summary, /累计专注 40 分钟，包含历史记录/)
  assert.doesNotMatch(recommendation.summary, /先留出|先补一个用时估计|段专注|一轮估算/)
  assert.ok(recommendation.facts.every(fact => !/一轮估算|小时空闲|课表/.test(fact)))
  // No template evidence panel remains to be mistaken for Xixi's words.
  assert.deepEqual(recommendation.evidence, recommendation.facts)
  assert.doesNotMatch(JSON.stringify(recommendation), /课表|空档|空闲|DeepSeek|AI 已/)
})

test('old or partial explanations for one task never break another task', () => {
  const entry = task('essay', { due: '2026-09-17', estimateMin: 35 })
  const malformed = [undefined, null, {}, { essay: 'not-an-array' }, { essay: [null, 0] }, { other: ['别的任务'] }, Object.create({ essay: ['继承字段'] })]
  for (const map of malformed) {
    const result = briefing([entry], map)
    assert.equal(result.recommendation.task.id, 'essay')
    assert.deepEqual(result.recommendation.explanations, [])
    assert.match(result.recommendation.summary, /9月17日 · 全天 · 今天截止/)
  }
})

test('free-time sessions keep their scheduling rule and use a written reason when present', () => {
  const goal = task('goal', { freeTimeGoalId: 'goal-1' })
  const blocks = [{ id: 's-1', taskId: 'goal', date: '2026-09-17', start: '18:00', end: '19:00' }]
  const at = new Date('2026-09-17T17:40:00+08:00')
  const plain = briefing([goal], {}, () => 0, 35, at, { goal: 60 }, blocks)
  assert.equal(plain.recommendation.task.id, 'goal')
  assert.equal(plain.recommendation.summary, '今天 18:00–19:00 · 本次 60 分钟')
  assert.doesNotMatch(plain.recommendation.summary, /推进这一次余时安排/)
  const reason = '这段余时安排在晚饭后，先做一次完整练习'
  const written = briefing([goal], { goal: [reason] }, () => 0, 35, at, { goal: 60 }, blocks)
  assert.equal(written.recommendation.summary, reason)
  assert.deepEqual(written.recommendation.evidence, [reason])
})

test('deadline facts stay separate from the local planning caveat', () => {
  const context = deadlineContext(task('essay', { due: '2026-09-17', estimateMin: 70 }), now, 35, () => 40 * minute)
  assert.equal(context.facts.length, 3)
  assert.deepEqual(context.facts, context.evidence.slice(0, 3))
  assert.match(context.facts[0], /9月17日 · 全天 · 今天截止/)
  assert.match(context.facts[1], /^原预计 70 分钟/)
  assert.match(context.facts[2], /^累计专注 40 分钟，包含历史记录/)
  assert.match(context.evidence[3], /一轮估算/)
  assert.ok(context.facts.every(fact => !/一轮估算/.test(fact)))
  // The template suggestion is still available to non-UI callers, but its basis
  // is no longer what the workbench presents as a written explanation.
  assert.match(context.suggestion, /段专注/)
})

test('collection reasons show shared notes once and keep each member title', () => {
  const members = [{ id: 'math', title: '数学练习' }, { id: 'physics', title: '物理报告' }, { id: 'chem', title: '化学整理' }]
  const result = collectionExplanations(members, {
    math: ['周日晚自习统一安排', '数学先做基础题'],
    physics: ['周日晚自习统一安排', '物理等实验数据'],
    chem: ['周日晚自习统一安排'],
  })
  assert.deepEqual(result.common, [{ reason: '周日晚自习统一安排', titles: ['数学练习', '物理报告', '化学整理'] }])
  assert.deepEqual(result.items, [
    { id: 'math', title: '数学练习', reasons: ['数学先做基础题'] },
    { id: 'physics', title: '物理报告', reasons: ['物理等实验数据'] },
  ])
  // Every real note appears once in the grouped panel.
  const shown = [...result.common.map(group => group.reason), ...result.items.flatMap(member => member.reasons)]
  assert.equal(shown.length, new Set(shown).size)
})

test('collection reasons handle empty, partial and malformed projections', () => {
  const members = [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }]
  assert.deepEqual(collectionExplanations(members, undefined), { common: [], items: [] })
  assert.deepEqual(collectionExplanations(members, {}), { common: [], items: [] })
  assert.deepEqual(collectionExplanations(members, { a: 'not-an-array', b: [null, 3] }), { common: [], items: [] })
  assert.deepEqual(collectionExplanations([], { a: ['own note'] }), { common: [], items: [] })
  assert.deepEqual(collectionExplanations(members, { a: ['only A'] }), {
    common: [], items: [{ id: 'a', title: 'A', reasons: ['only A'] }],
  })
  // Two members sharing one title still count as shared, without repeating it.
  assert.deepEqual(collectionExplanations([{ id: 'a', title: '同名' }, { id: 'b', title: '同名' }], { a: ['共同'], b: ['共同'] }).common,
    [{ reason: '共同', titles: ['同名'] }])
})

test('collection fallback facts are labelled scheduling facts, not causal advice', () => {
  const group = {
    kind: 'collection', id: 'collection:1', name: '周末作业', due: '2026-09-18',
    tasks: [task('one', { estimateMin: 30 }), task('two', { estimateMin: 20, status: 'done' })],
    visible: [],
  }
  const facts = collectionSchedulingFacts(group, '9月18日 · 全天', '明天截止', { one: 60 }, id => id === 'one' ? 30 * minute : 0)
  assert.deepEqual(facts, [
    { label: '截止', value: '9月18日 · 全天 · 明天截止' },
    { label: '进度', value: '2 项 · 已完成 1/2 · 剩余估时 30 分钟' },
    { label: '已排', value: '60 分钟' },
    { label: '专注', value: '累计专注 30 分钟' },
  ])
  const cold = collectionSchedulingFacts(group, '9月18日 · 全天', '明天截止')
  assert.deepEqual(cold.map(fact => fact.label), ['截止', '进度', '已排'])
  assert.equal(cold[2].value, '尚未安排时段')
  // No fixed causal sentence may be invented for a group without model notes.
  assert.doesNotMatch(facts.map(fact => fact.value).join(' '), /所以|应该|建议|先留出|可以完成|能完成/)
})
