import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createRouteAnalysis } from '../server/routeAnalysis.mjs'
import { ProviderError } from '../server/provider.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-19'
const fixture = t => {
  const db = createDatabase(':memory:')
  let at = new Date(`${DATE}T08:00:00+08:00`)
  const now = () => at, companion = createCompanion({ db, now })
  const task = db.createTask({ title: 'SAT 阅读', estimateMin: 60, due: '2026-09-21', notes: '核对三篇文章' })
  t.after(() => db.close())
  return { db, task, companion, now, advance: value => { at = new Date(value) },
    input: { taskId: task.id, date: DATE, question: '今天先做半小时，剩下的明天做，会怎样？' } }
}
const update = (f, block) => f.db.updatePlanner({ type: 'save-block', block: { locked: false, taskId: f.task.id, date: DATE, ...block } }, f.db.getPlanner().revision)
const output = (f, patch = {}) => ({ plans: [
  { taskId: f.task.id, date: DATE, start: '09:10', end: '09:40' },
  { taskId: f.task.id, date: '2026-09-20', start: '09:10', end: '09:40' },
], current: '当前还没有这项任务的安排。', candidate: '先完成一部分，明天继续。',
benefits: ['今天保留一些空闲。'], costs: ['明天仍要留半小时。'], risks: ['明天出现新任务时可能挤压剩余工作。'],
recovery: ['今天结束前写下明天的第一步。'], observations: ['观察半小时后是否能完成一篇文章。'], assumptions: ['任务估时仍为一小时。'],
trends: Object.fromEntries(['week', 'fourWeeks', 'threeMonths', 'oneYear'].map(key => [key, {
  condition: '如果只在这一次分成两天，且明天按时继续', summary: '本周或许可以完成；单次选择无法判断长期变化。', uncertainty: '后续任务与实际进度未知。',
}])), unscheduledReason: '', ...patch })
const completion = value => ({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(value) } }] })
const service = (f, complete) => createRouteAnalysis({ ...f, complete })
const chatSource = f => {
  const requestId = randomUUID(), turn = f.db.beginTurn({ requestId, conversationId: 'main', text: f.input.question, context: { timezone: 'Asia/Shanghai', date: DATE } })
  return { kind: 'conversation', messageId: turn.userMessageId, evidence: f.input.question, actionId: randomUUID(), requestId }
}

test('real facts and model judgments remain separate; preview leaves tasks and planner untouched and apply/undo use existing receipts', async t => {
  const f = fixture(t), requests = [], before = f.db.getPlanner(), taskBefore = f.db.getTask(f.task.id)
  f.companion.saveHandoff({ taskId: f.task.id, progress: '第一篇已看过', obstacle: '需要对答案', nextStep: '从错题开始', materials: [] })
  const route = await service(f, async payload => { requests.push(payload); return completion(output(f)) }).analyze(f.input)
  const context = JSON.parse(requests[0].messages[1].content)
  assert.equal(context.facts.task.id, f.task.id)
  assert.equal(context.facts.task.estimateMin, 60)
  assert.equal(context.facts.timeline.length, 7)
  assert.equal(context.companion.handoff.nextStep, '从错题开始')
  assert.equal(context.choice.recurrence, 'once')
  assert.equal(requests[0].response_format.type, 'json_object')
  assert.equal(requests[0].tools, undefined)
  assert.equal(route.routeAnalysis.kind, 'model-judgment')
  assert.equal(route.routeAnalysis.conditional, true)
  assert.deepEqual(route.routeAnalysis.facts.candidate, route.plans)
  assert.equal(route.routeAnalysis.current, output(f).current)
  assert.ok(route.routeAnalysis.facts.verified.every(value => !value.includes('或许')))
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.getTask(f.task.id), taskBefore)
  const applied = f.companion.applyScenario(route.id, { expectedVersion: 1 })
  assert.equal(applied.operation.planChanges.length, 2)
  assert.match(applied.operation.summary, /候选路线/)
  assert.equal(f.db.getTask(f.task.id).due, taskBefore.due)
  f.db.undoOperation(applied.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('one invalid model candidate is corrected once using validation feedback, without staging the rejected output', async t => {
  const f = fixture(t), requests = []
  const route = await service(f, async payload => {
    requests.push(payload)
    return completion(output(f, requests.length === 1 ? { plans: [{ taskId: f.task.id, date: DATE, start: '07:00', end: '08:00' }] } : {}))
  }).analyze(f.input)
  assert.equal(requests.length, 2)
  assert.match(JSON.parse(requests[1].messages[1].content).correction, /已经开始/)
  assert.equal(f.db.getCompanionState().scenarios.length, 1)
  assert.equal(route.plans[0].start, '09:10')
})

for (const [label, change] of [
  ['another task', f => ({ plans: [{ taskId: 'other-task', date: DATE, start: '09:10', end: '10:10' }] })],
  ['outside seven days', f => ({ plans: [{ taskId: f.task.id, date: '2026-09-27', start: '09:10', end: '10:10' }] })],
  ['invented fields', () => ({ taskPatch: { due: '2027-09-19' } })],
  ['invented facts', () => ({ facts: { estimateMin: 500 } })],
  ['invalid calendar date', f => ({ plans: [{ taskId: f.task.id, date: '2026-02-30', start: '09:10', end: '10:10' }] })],
  ['invalid clock', f => ({ plans: [{ taskId: f.task.id, date: DATE, start: '09:70', end: '10:10' }] })],
  ['reversed time', f => ({ plans: [{ taskId: f.task.id, date: DATE, start: '10:10', end: '09:10' }] })],
  ['invented capacity', f => ({ plans: [{ taskId: f.task.id, date: DATE, start: '22:10', end: '23:10' }] })],
  ['above known effort', f => ({ plans: [{ taskId: f.task.id, date: DATE, start: '09:10', end: '11:10' }] })],
  ['overlapping candidate slots', f => ({ plans: [{ taskId: f.task.id, date: DATE, start: '09:10', end: '09:40' }, { taskId: f.task.id, date: DATE, start: '09:30', end: '10:00' }] })],
  ['missing buffer between candidates', f => ({ plans: [{ taskId: f.task.id, date: DATE, start: '09:10', end: '09:40' }, { taskId: f.task.id, date: DATE, start: '09:45', end: '10:15' }] })],
  ['unconditional long-term claim', f => ({ trends: { ...output(f).trends, oneYear: { condition: '', summary: '一定成功', uncertainty: '没有' } } })],
  ['invented improvement percentage', f => ({ trends: { ...output(f).trends, oneYear: { condition: '坚持', summary: '能力提高30%', uncertainty: '可能有变化' } } })],
]) test(`rejects ${label} after one correction and never writes a scenario`, async t => {
  const f = fixture(t), before = f.db.getPlanner()
  let calls = 0
  await assert.rejects(service(f, async () => { calls++; return completion(output(f, change(f))) }).analyze(f.input), ProviderError)
  assert.equal(calls, 2)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('fixed blocks, unrelated work, locks and outside-week commitments survive route apply', async t => {
  const f = fixture(t)
  f.db.updateTask(f.task.id, { estimateMin: 180, due: '2026-10-01' })
  const other = f.db.createTask({ title: '另一个任务', estimateMin: 30 })
  update(f, { id: 'unrelated', taskId: other.id, start: '11:00', end: '11:30' })
  update(f, { id: 'locked', start: '12:00', end: '13:00', locked: true })
  update(f, { id: 'outside', date: '2026-09-28', start: '18:00', end: '19:00' })
  update(f, { id: 'movable', start: '14:00', end: '15:00' })
  const before = f.db.getPlanner()
  const route = await service(f, async () => completion(output(f))).analyze(f.input)
  assert.deepEqual(route.removedBlockIds, ['movable'])
  assert.equal(route.routeAnalysis.facts.heldMin, 120)
  assert.equal(route.routeAnalysis.facts.remainingMin, 60)
  f.companion.applyScenario(route.id, { expectedVersion: 1 })
  for (const id of ['unrelated', 'locked', 'outside']) assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === id), before.blocks.find(block => block.id === id))
})

test('DDL and real occupied slots are checked independently of model claims', async t => {
  const f = fixture(t)
  f.db.updateTask(f.task.id, { due: `${DATE}T09:30:00+08:00` })
  await assert.rejects(service(f, async () => completion(output(f))).analyze(f.input), /DDL/)
  f.db.updateTask(f.task.id, { due: '2026-09-21' })
  const other = f.db.createTask({ title: '已占用', estimateMin: 60 })
  update(f, { id: 'occupied', taskId: other.id, start: '09:00', end: '10:00' })
  await assert.rejects(service(f, async () => completion(output(f))).analyze(f.input), /冲突/)
})

test('unknown effort yields no invented plan and precise startAt remains protected', async t => {
  const f = fixture(t)
  f.db.updateTask(f.task.id, { estimateMin: undefined })
  await assert.rejects(service(f, async () => completion(output(f))).analyze(f.input), /工作量/)
  const unknown = await service(f, async () => completion(output(f, { plans: [], unscheduledReason: '需要先确认实际预计用时。' }))).analyze(f.input)
  assert.equal(unknown.unscheduled[0].remainingMin, null)
  f.db.updateTask(f.task.id, { estimateMin: 60, startAt: `${DATE}T09:00:00+08:00` })
  await assert.rejects(service(f, async () => completion(output(f))).analyze(f.input), /受保护/)
  const exact = await service(f, async () => completion(output(f, { plans: [] }))).analyze(f.input)
  assert.equal(exact.routeAnalysis.facts.exactStartProtected, true)
  assert.equal(exact.routeAnalysis.facts.baseline[0].start, '09:00')
  assert.equal(exact.removedBlockIds.length, 0)
})

test('empty availability cannot turn into an invented free day', async t => {
  const f = fixture(t)
  for (const routine of f.db.getPlanner().routines) f.db.updatePlanner({ type: 'delete-routine', id: routine.id }, f.db.getPlanner().revision)
  const route = await service(f, async payload => {
    assert.deepEqual(JSON.parse(payload.messages[1].content).facts.availableWindows, [])
    return completion(output(f, { plans: [], unscheduledReason: '没有明确空闲。' }))
  }).analyze(f.input)
  assert.equal(route.unscheduled[0].remainingMin, 60)
  assert.throws(() => f.companion.applyScenario(route.id, { expectedVersion: 1 }), /没有可应用/)
})

test('provider failure and malformed responses fail explicitly without invented fallback judgments', async t => {
  const f = fixture(t)
  let calls = 0
  await assert.rejects(service(f, async () => { calls++; throw new ProviderError('本地模型未接受请求') }).analyze(f.input), /路线推演未完成.*本地模型/)
  assert.equal(calls, 1)
  await assert.rejects(service(f, async () => { throw new Error('secret upstream body') }).analyze(f.input), error => error instanceof ProviderError && !error.message.includes('secret'))
  await assert.rejects(service(f, async () => ({ choices: [{ message: { content: '不是 JSON' } }] })).analyze(f.input), /JSON/)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
})

test('changed facts during completion reject the preview and saved previews retain revision protection', async t => {
  const f = fixture(t)
  await assert.rejects(service(f, async () => {
    f.db.updateTask(f.task.id, { title: '更新过的任务' })
    return completion(output(f))
  }).analyze(f.input), /资料已有变化/)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
  const route = await service(f, async () => completion(output(f))).analyze(f.input)
  f.db.updatePlanner({ type: 'check-item', date: DATE, key: '书', checked: true }, f.db.getPlanner().revision)
  assert.throws(() => f.companion.applyScenario(route.id, { expectedVersion: 1 }), /时间表已有变化/)
})

test('invalid user choices are rejected before any model request', async t => {
  const f = fixture(t)
  let calls = 0
  const analyze = service(f, async () => { calls++; return completion(output(f)) }).analyze
  for (const patch of [{ taskId: 'missing' }, { date: '2026-02-30' }, { date: '2026-09-18' }, { question: '' }, { recurrence: 'daily' }, { plans: [] }]) await assert.rejects(analyze({ ...f.input, ...patch }))
  f.db.updateTask(f.task.id, { status: 'done' })
  await assert.rejects(analyze(f.input), /已完成/)
  assert.equal(calls, 0)
})

test('model route and legacy decision previews survive backup validation and remain archived after restore', async t => {
  const f = fixture(t)
  const route = await service(f, async () => completion(output(f))).analyze(f.input)
  f.companion.previewDecision({ taskId: f.task.id, date: DATE, strategy: 'split', recurrence: 'once', todayMin: 5 })
  const backup = f.db.exportData()
  assert.equal(f.db.importData(backup).restored, true)
  const restored = f.companion.listState({ date: DATE }).scenarios.find(item => item.id === route.id)
  assert.equal(restored.routeAnalysis.question, f.input.question)
  assert.equal(restored.status, 'discarded')
  assert.equal(f.db.importData(f.db.exportData()).restored, true)
})

test('elapsed original slots cannot become a fresh movable preview while the model is thinking', async t => {
  const f = fixture(t)
  update(f, { id: 'will-start', start: '08:30', end: '09:30' })
  await assert.rejects(service(f, async () => {
    f.advance(`${DATE}T08:35:00+08:00`)
    return completion(output(f, { plans: [{ taskId: f.task.id, date: '2026-09-20', start: '09:10', end: '10:10' }] }))
  }).analyze(f.input), /已经开始/)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
})

test('cross-midnight legacy facts remain factual and can be backed up without creating new placements', async t => {
  const f = fixture(t)
  f.db.updateTask(f.task.id, { startAt: `${DATE}T23:30:00+08:00` })
  const route = await service(f, async () => completion(output(f, { plans: [] }))).analyze(f.input)
  assert.equal(route.routeAnalysis.facts.baseline[0].end, '24:00')
  assert.equal(route.routeAnalysis.facts.baseline[1].start, '00:00')
  assert.equal(f.db.importData(f.db.exportData()).restored, true)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('chat route retains verified source and action replay returns the same preview without another provider call', async t => {
  const f = fixture(t), source = chatSource(f)
  let calls = 0
  const analyzer = service(f, async () => { calls++; return completion(output(f)) })
  const first = await analyzer.analyze(f.input, source), second = await analyzer.analyze(f.input, source)
  assert.equal(second.id, first.id)
  assert.equal(calls, 1)
  assert.deepEqual(first.source, { kind: source.kind, messageId: source.messageId, evidence: source.evidence, actionId: source.actionId })
  assert.equal(f.db.getCompanionState().scenarios.length, 1)
  await assert.rejects(analyzer.analyze({ ...f.input, question: '不同选择' }, source), /不同来源或选择/)
  f.companion.discardScenario(first.id, { expectedVersion: 1 })
  assert.equal((await analyzer.analyze(f.input, source)).status, 'discarded')
  assert.equal(calls, 1)
})

test('retracting the source while provider is pending rejects the result and cannot resurrect a draft on retry', async t => {
  const f = fixture(t), source = chatSource(f), before = f.db.getPlanner()
  let release, calls = 0
  const analyzer = service(f, async () => { calls++; await new Promise(resolve => { release = resolve }); return completion(output(f)) })
  const pending = analyzer.analyze(f.input, source)
  f.db.retractMessage(source.messageId)
  release()
  await assert.rejects(pending, /撤回|失效/)
  await assert.rejects(analyzer.analyze(f.input, source), /撤回|失效/)
  assert.equal(calls, 1)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('a saved chat draft disappears with its source and replay never revives it', async t => {
  const f = fixture(t), source = chatSource(f)
  let calls = 0
  const analyzer = service(f, async () => { calls++; return completion(output(f)) })
  await analyzer.analyze(f.input, source)
  f.db.retractMessage(source.messageId)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
  await assert.rejects(analyzer.analyze(f.input, source), /撤回|失效/)
  assert.equal(calls, 1)
})

test('invented chat sources and evidence are rejected before provider dispatch', async t => {
  const f = fixture(t), source = chatSource(f)
  const assistant = f.db.appendMessage({ conversationId: 'main', requestId: source.requestId, role: 'assistant', content: f.input.question })
  let calls = 0
  const analyzer = service(f, async () => { calls++; return completion(output(f)) })
  for (const patch of [{ messageId: 'missing-message' }, { requestId: 'invented-request' }, { evidence: '这不是用户原话' }, { messageId: assistant.id }, { kind: 'user' }, { actionId: '' }]) {
    await assert.rejects(analyzer.analyze(f.input, { ...source, ...patch }))
  }
  assert.equal(calls, 0)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
})

test('parallel invocations of a stable chat action persist only one scenario', async t => {
  const f = fixture(t), source = chatSource(f), releases = []
  const analyzer = service(f, async () => { await new Promise(resolve => releases.push(resolve)); return completion(output(f)) })
  const first = analyzer.analyze(f.input, source), second = analyzer.analyze(f.input, source)
  for (const release of releases) release()
  const results = await Promise.all([first, second])
  assert.equal(results[0].id, results[1].id)
  assert.equal(f.db.getCompanionState().scenarios.length, 1)
})

test('long-term free-time goals are rejected before model inference without changing their frequency', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  f.db.updateTask(f.task.id, { freeTimeGoalId: 'python-goal' })
  let calls = 0
  await assert.rejects(service(f, async () => { calls++; return completion(output(f)) }).analyze(f.input), /余时长期目标/)
  assert.equal(calls, 0)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
})

test('route facts respect the configured model budget before provider dispatch without losing stored detail', async t => {
  const f = fixture(t)
  f.db.setPreference('model-connection', { contextBudget: { mode: 'custom', maxUnits: 8000 } })
  f.db.updateTask(f.task.id, { subSteps: Array.from({ length: 60 }, (_, i) => ({ id: `step-${i}`, title: `步骤${i}`, detail: '需要仔细核对资料'.repeat(60) })) })
  const before = { tasks: f.db.listTasks(), planner: f.db.getPlanner() }
  let calls = 0
  await assert.rejects(service(f, async () => { calls++; return completion(output(f)) }).analyze(f.input), /上下文预算/)
  assert.equal(calls, 0)
  assert.deepEqual(f.db.listTasks(), before.tasks)
  assert.deepEqual(f.db.getPlanner(), before.planner)
  assert.equal(f.db.getCompanionState().scenarios.length, 0)
})
