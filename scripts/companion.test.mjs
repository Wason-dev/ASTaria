import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createXixi, contextUnits, XIXI_TOOLS } from '../server/xixi.mjs'

process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-19'
const fixture = t => {
  const db = createDatabase(':memory:')
  let now = new Date(`${DATE}T08:00:00+08:00`)
  t.after(() => db.close())
  return { db, companion: createCompanion({ db, now: () => now }), now: () => now, advance: value => { now = new Date(value) } }
}
const task = (db, patch = {}) => db.createTask({ title: '物理报告', due: '2026-09-20', estimateMin: 60, ...patch })
const update = (db, action) => db.updatePlanner(action, db.getPlanner().revision)
const planMinutes = plans => plans.reduce((sum, plan) => sum +
  Number(plan.end.slice(0, 2)) * 60 + Number(plan.end.slice(3)) - Number(plan.start.slice(0, 2)) * 60 - Number(plan.start.slice(3)), 0)

test('preview stays isolated, application has exact receipts, repeated apply is idempotent and undo restores real planner', t => {
  const f = fixture(t), report = task(f.db), before = f.db.getPlanner()
  const preview = f.companion.previewScenario({ date: DATE, mode: 'rebalance', days: 2 })
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.db.getTask(report.id).due, report.due)
  assert.equal(preview.metrics.scheduledMin, 60)
  assert.equal(preview.plans[0].start, '09:10')
  const result = f.companion.applyScenario(preview.id, { expectedVersion: 1 })
  assert.equal(result.scenario.status, 'applied')
  assert.equal(result.operation.planChanges[0].after.taskId, report.id)
  assert.equal(f.db.getPlanner().blocks.length, 1)
  assert.equal(f.companion.applyScenario(preview.id, { expectedVersion: 1 }).operation.id, result.operation.id)
  f.db.undoOperation(result.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  assert.equal(f.companion.listState().scenarios[0].status, 'undone')
  assert.throws(() => f.companion.applyScenario(preview.id, { expectedVersion: 2 }), /已经撤销/)
})

test('rest leaves first day empty without moving DDL; low energy retains deadline load and splits short segments', t => {
  const f = fixture(t), report = task(f.db, { due: `${DATE}T11:00:00+08:00`, estimateMin: 90 })
  const rest = f.companion.previewScenario({ date: DATE, days: 2, mode: 'rest' })
  assert.equal(rest.plans.length, 0)
  assert.equal(rest.unscheduled[0].remainingMin, 90)
  assert.match(rest.unscheduled[0].reason, /截止/)
  const light = f.companion.previewScenario({ date: DATE, days: 1, mode: 'light', budgetMin: 30 })
  assert.equal(light.metrics.scheduledMin, 90)
  assert.ok(light.plans.every(plan => Number(plan.end.slice(3)) - Number(plan.start.slice(3)) <= 35))
  assert.ok(light.warnings.some(item => item.includes('超过轻量目标')))
  assert.equal(f.db.getTask(report.id).due, report.due)
})

test('locked blocks survive preview/apply and missing estimates remain explicitly unplanned', t => {
  const f = fixture(t), locked = task(f.db), unknown = task(f.db, { title: '未知工作量', estimateMin: undefined })
  update(f.db, { type: 'save-block', block: { id: 'locked', taskId: locked.id, date: DATE, start: '10:00', end: '11:00', locked: true } })
  task(f.db, { title: '其他', due: '2026-09-22' })
  const preview = f.companion.previewScenario({ date: DATE, mode: 'rebalance' })
  assert.ok(!preview.removedBlockIds.includes('locked'))
  assert.ok(preview.unscheduled.some(item => item.taskId === unknown.id && item.remainingMin === null))
  f.companion.applyScenario(preview.id, { expectedVersion: 1 })
  assert.equal(f.db.getPlanner().blocks.find(item => item.id === 'locked').locked, true)
})

test('scenario rejects stale tasks including unrelated exact-time additions, stale planner, elapsed slots and timezone changes', t => {
  const f = fixture(t), report = task(f.db)
  let preview = f.companion.previewScenario({ date: DATE, mode: 'rebalance' })
  f.db.updateTask(report.id, { title: '新标题' })
  assert.throws(() => f.companion.applyScenario(preview.id, { expectedVersion: 1 }), /任务已有变化/)
  preview = f.companion.previewScenario({ date: DATE, mode: 'rebalance' })
  task(f.db, { title: '新任务' })
  assert.throws(() => f.companion.applyScenario(preview.id, { expectedVersion: 1 }), /任务已有变化/)
  preview = f.companion.previewScenario({ date: DATE, mode: 'rebalance' })
  update(f.db, { type: 'check-item', date: DATE, key: '电脑', checked: true })
  assert.throws(() => f.companion.applyScenario(preview.id, { expectedVersion: 1 }), /时间表已有变化/)
  preview = f.companion.previewScenario({ date: DATE, mode: 'rebalance' })
  f.advance(`${DATE}T10:00:00+08:00`)
  assert.throws(() => f.companion.applyScenario(preview.id, { expectedVersion: 1 }), /时间已有变化/)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})

test('swapping existing slots deletes old placements before saving replacements atomically', t => {
  const f = fixture(t), first = task(f.db, { title: '晚交', due: '2026-09-22' }), second = task(f.db, { title: '早交', due: DATE })
  update(f.db, { type: 'save-block', block: { id: 'first', taskId: first.id, date: DATE, start: '09:10', end: '10:10', locked: false } })
  update(f.db, { type: 'save-block', block: { id: 'second', taskId: second.id, date: DATE, start: '10:20', end: '11:20', locked: false } })
  const before = f.db.getPlanner(), preview = f.companion.previewScenario({ date: DATE, mode: 'rebalance' })
  assert.equal(preview.plans[0].taskId, second.id)
  const { operation } = f.companion.applyScenario(preview.id, { expectedVersion: 1 })
  assert.equal(f.db.getPlanner().blocks[0].taskId, second.id)
  f.db.undoOperation(operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('empty explicit availability does not become an invented full-day window', t => {
  const f = fixture(t)
  task(f.db)
  update(f.db, { type: 'delete-routine', id: 'default-weekend-availability' })
  const preview = f.companion.previewScenario({ date: DATE, days: 1, mode: 'rebalance' })
  assert.equal(preview.plans.length, 0)
  assert.equal(preview.unscheduled.length, 1)
  assert.throws(() => f.companion.applyScenario(preview.id, { expectedVersion: 1 }), /没有可应用/)
})

test('decision preview keeps a baseline and follows today, split, and defer paths without touching planner', t => {
  const f = fixture(t), report = task(f.db, { title: 'SAT 作业', estimateMin: 90 })
  update(f.db, { type: 'save-block', block: { id: 'sat-old', taskId: report.id, date: DATE, start: '09:00', end: '10:00', locked: false } })
  const before = f.db.getPlanner()
  const today = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  assert.deepEqual(today.decision, { taskId: report.id, title: 'SAT 作业', strategy: 'today', recurrence: 'once', todayMin: 30, effortMin: 90,
    baseline: [{ id: 'sat-old', taskId: report.id, title: 'SAT 作业', date: DATE, start: '09:00', end: '10:00' }] })
  assert.equal(today.days, 7)
  assert.equal(planMinutes(today.plans), 90)
  assert.ok(today.plans.every(plan => plan.date === DATE))
  assert.equal(today.removedBlockIds.length, 1)
  assert.equal(f.db.getPlanner().revision, before.revision)
  const split = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'split', recurrence: 'weekly', todayMin: 30 })
  assert.equal(split.decision.recurrence, 'weekly')
  assert.equal(planMinutes(split.plans.filter(item => item.date === DATE)), 30)
  assert.equal(planMinutes(split.plans.filter(item => item.date > DATE)), 60)
  assert.ok(split.warnings.some(item => item.includes('7 天')))
  const defer = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'defer', recurrence: 'once' })
  assert.equal(defer.plans.filter(item => item.date === DATE).length, 0)
  assert.equal(planMinutes(defer.plans), 90)
  assert.deepEqual(f.db.getPlanner(), before)
})

test('decision handles unknown effort explicitly and applies atomically with undo', t => {
  const f = fixture(t), unknown = task(f.db, { title: '工作量未知', estimateMin: undefined })
  const noPlan = f.companion.previewDecision({ date: DATE, taskId: unknown.id, strategy: 'today', recurrence: 'once' })
  assert.equal(noPlan.decision.effortMin, null)
  assert.ok(noPlan.unscheduled.some(item => item.remainingMin === null))
  update(f.db, { type: 'save-block', block: { id: 'unknown-old', taskId: unknown.id, date: DATE, start: '11:00', end: '12:00', locked: false } })
  const preview = f.companion.previewDecision({ date: DATE, taskId: unknown.id, strategy: 'today', recurrence: 'once' })
  assert.equal(preview.decision.effortMin, 60)
  const before = f.db.getPlanner()
  const applied = f.companion.applyScenario(preview.id, { expectedVersion: 1 })
  assert.equal(applied.scenario.status, 'applied')
  assert.ok(f.db.getPlanner().revision > before.revision)
  f.db.undoOperation(applied.operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
})

test('decision captures full committed effort before removal and explains today spillover', t => {
  const f = fixture(t), report = task(f.db, { estimateMin: 30, due: '2026-09-22' })
  update(f.db, { type: 'save-block', block: { id: 'longer-existing', taskId: report.id, date: DATE, start: '21:00', end: '22:00', locked: false } })
  const retained = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'split', recurrence: 'once' })
  assert.equal(retained.decision.effortMin, 60)
  assert.equal(planMinutes(retained.plans), 60)
  assert.ok(retained.warnings.some(item => item.includes('长于任务估时 30 分钟')))
  f.advance(`${DATE}T21:00:00+08:00`)
  const spill = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  assert.equal(planMinutes(spill.plans.filter(plan => plan.date === DATE)), 40)
  assert.equal(planMinutes(spill.plans.filter(plan => plan.date > DATE)), 20)
  assert.ok(spill.warnings.some(item => item.includes('20 分钟需在随后几天补完')))
})

test('decision rejects historical, closed, empty, and invalid inputs', t => {
  const f = fixture(t), report = task(f.db)
  const valid = { date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' }
  for (const patch of [{ strategy: 'always' }, { recurrence: 'daily' }, { todayMin: 0 }, { todayMin: 30.5 }, { date: '2026-02-30' }, { days: 365 }]) {
    assert.throws(() => f.companion.previewDecision({ ...valid, ...patch }))
  }
  assert.throws(() => f.companion.previewDecision({ date: '2026-09-18', taskId: report.id, strategy: 'today', recurrence: 'once' }), /今天或未来/)
  assert.throws(() => f.companion.previewDecision({ date: DATE, taskId: '', strategy: 'today', recurrence: 'once' }), /任务标识/)
  f.db.updateTask(report.id, { status: 'done' })
  assert.throws(() => f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' }), /完成或已放下/)
})

test('decision preserves hard deadlines and reports unsatisfied effort instead of pushing it beyond the deadline', t => {
  const f = fixture(t), report = task(f.db, { due: `${DATE}T10:00:00+08:00`, estimateMin: 90 })
  const today = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  assert.equal(planMinutes(today.plans), 50)
  assert.equal(today.unscheduled[0].remainingMin, 40)
  assert.ok(today.plans.every(plan => new Date(`${plan.date}T${plan.end}:00+08:00`) <= new Date(report.due)))
  const defer = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'defer', recurrence: 'weekly' })
  assert.equal(defer.plans.length, 0)
  assert.equal(defer.unscheduled[0].remainingMin, 90)
  assert.match(defer.unscheduled[0].reason, /截止/)
  assert.equal(f.db.getTask(report.id).due, report.due)
})

test('decision never invents availability and keeps unrelated work unchanged through apply and undo', t => {
  const f = fixture(t), report = task(f.db), unrelated = task(f.db, { title: '保持原样', startAt: `${DATE}T12:00:00+08:00` })
  update(f.db, { type: 'save-block', block: { id: 'unrelated', taskId: unrelated.id, date: DATE, start: '10:00', end: '11:00', locked: false } })
  const before = f.db.getPlanner(), originalTask = f.db.getTask(unrelated.id)
  const preview = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  assert.ok(preview.plans.every(plan => plan.taskId === report.id))
  assert.equal(preview.removedBlockIds.length, 0)
  const { operation } = f.companion.applyScenario(preview.id, { expectedVersion: 1 })
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === 'unrelated'), before.blocks[0])
  assert.deepEqual(f.db.getTask(unrelated.id), originalTask)
  f.db.undoOperation(operation.id)
  assert.deepEqual(f.db.getPlanner().blocks, before.blocks)
  for (const routine of f.db.getPlanner().routines.filter(item => item.kind === 'available')) update(f.db, { type: 'delete-routine', id: routine.id })
  const empty = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  assert.equal(empty.plans.length, 0)
  assert.equal(empty.unscheduled[0].remainingMin, 60)
  assert.throws(() => f.companion.applyScenario(empty.id, { expectedVersion: 1 }), /没有可应用/)
})

test('decision counts held time once, retains locked and started blocks, and moves only the selected week', t => {
  const f = fixture(t), report = task(f.db, { estimateMin: 150, due: '2026-10-01' })
  for (const block of [
    { id: 'started', date: DATE, start: '07:30', end: '08:30' },
    { id: 'locked', date: DATE, start: '10:00', end: '10:30', locked: true },
    { id: 'outside-week', date: '2026-09-27', start: '10:00', end: '10:30' },
    { id: 'movable', date: DATE, start: '12:00', end: '13:00' },
  ]) update(f.db, { type: 'save-block', block: { locked: false, taskId: report.id, ...block } })
  const preview = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'defer', recurrence: 'weekly' })
  assert.deepEqual(preview.removedBlockIds, ['movable'])
  assert.equal(preview.decision.effortMin, 150)
  assert.equal(planMinutes(preview.plans), 60)
  assert.ok(preview.decision.baseline.some(block => block.id === 'started'))
  assert.ok(!preview.decision.baseline.some(block => block.id === 'outside-week'))
  f.companion.applyScenario(preview.id, { expectedVersion: 1 })
  assert.ok(['started', 'locked', 'outside-week'].every(id => f.db.getPlanner().blocks.some(block => block.id === id)))
  assert.equal(planMinutes(f.db.getPlanner().blocks.filter(block => !['started', 'locked', 'outside-week'].includes(block.id))), 60)
})

test('decision preserves exact legacy startAt and ignores stale legacy fallback while replacing explicit blocks', t => {
  const f = fixture(t), report = task(f.db, { startAt: `${DATE}T09:00:00+08:00` })
  const exact = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'defer', recurrence: 'once' })
  assert.equal(exact.plans.length, 0)
  assert.equal(exact.removedBlockIds.length, 0)
  assert.equal(exact.decision.baseline[0].start, '09:00')
  assert.ok(exact.warnings.some(item => item.includes('精确开始时间')))
  update(f.db, { type: 'save-block', block: { id: 'newer-plan', taskId: report.id, date: DATE, start: '10:00', end: '11:00', locked: false } })
  const replacement = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  assert.equal(replacement.plans[0].start, '09:10')
  f.companion.applyScenario(replacement.id, { expectedVersion: 1 })
  assert.equal(f.db.getPlanner().blocks[0].start, '09:10')
  assert.equal(f.db.getTask(report.id).startAt, report.startAt)
})

test('decision rejects stale planner, task, buffer, and elapsed previews without partial writes', t => {
  const f = fixture(t), report = task(f.db)
  const preview = () => f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  let result = preview()
  update(f.db, { type: 'check-item', date: DATE, key: '书', checked: true })
  assert.throws(() => f.companion.applyScenario(result.id, { expectedVersion: 1 }), /时间表已有变化/)
  result = preview()
  task(f.db, { title: '新加入的确切时间', startAt: `${DATE}T09:00:00+08:00` })
  assert.throws(() => f.companion.applyScenario(result.id, { expectedVersion: 1 }), /任务已有变化/)
  result = preview()
  f.db.setPreference('app', { scheduling: { bufferMin: 20 } })
  assert.throws(() => f.companion.applyScenario(result.id, { expectedVersion: 1 }), /缓冲设置已有变化/)
  result = preview()
  f.advance(`${DATE}T14:00:00+08:00`)
  assert.throws(() => f.companion.applyScenario(result.id, { expectedVersion: 1 }), /时间已有变化/)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.db.listOperations().length, 0)
})

test('decision rolls back planner changes when saving the applied receipt fails', t => {
  const f = fixture(t), report = task(f.db)
  const preview = f.companion.previewDecision({ date: DATE, taskId: report.id, strategy: 'today', recurrence: 'once' })
  const before = f.db.getPlanner()
  const faulty = createCompanion({ db: { ...f.db, saveCompanionState: () => { throw new Error('simulated disk failure') } }, now: f.now })
  assert.throws(() => faulty.applyScenario(preview.id, { expectedVersion: 1 }), /simulated disk failure/)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(f.db.listOperations().length, 0)
  assert.equal(f.db.getCompanionState().scenarios.find(item => item.id === preview.id).status, 'preview')
})

test('past plans never count as finished work and zero-buffer preference remains zero', t => {
  const f = fixture(t), report = task(f.db)
  update(f.db, { type: 'save-block', block: { id: 'yesterday', taskId: report.id, date: '2026-09-18', start: '18:00', end: '19:00', locked: false } })
  f.db.setPreference('app', { scheduling: { bufferMin: 0 } })
  const preview = f.companion.previewScenario({ date: DATE, days: 1, mode: 'light' })
  assert.equal(preview.metrics.scheduledMin, 60)
  assert.equal(preview.bufferMin, 0)
  assert.equal(preview.plans[0].start, '09:00')
  assert.ok(preview.warnings.some(item => item.includes('过去计划不代表已完成')))
  f.companion.applyScenario(preview.id, { expectedVersion: 1 })
  assert.equal(f.db.getPlanner().blocks.length, 3)
})

test('handoffs are versioned, retain provenance and disappear when source is retracted; manual edits survive original source retraction', t => {
  const f = fixture(t), report = task(f.db)
  const message = f.db.appendMessage({ conversationId: 'main', role: 'user', content: '左轮读数不稳定，下一步查接线' })
  const source = { kind: 'conversation', messageId: message.id, evidence: message.content }
  const initial = f.companion.saveHandoff({ taskId: report.id, progress: '程序能跑', obstacle: '左轮读数不稳定', nextStep: '查接线', materials: [], expectedVersion: 0 }, source)
  assert.equal(initial.version, 1)
  assert.equal(initial.source.messageId, message.id)
  assert.throws(() => f.companion.saveHandoff({ ...initial, source: undefined }), /不支持的字段/)
  assert.throws(() => f.companion.clearHandoff(report.id, 0), /其他窗口/)
  const next = f.companion.saveHandoff({ taskId: report.id, progress: '接线已查', obstacle: '', nextStep: '校准', materials: ['电路图'], expectedVersion: 1 })
  f.db.retractMessage(message.id)
  assert.equal(f.companion.listState().handoffs[0].version, next.version)
  f.companion.clearHandoff(report.id, next.version)
  assert.deepEqual(f.companion.listState().handoffs, [])
})

test('wishes use actual free time, preserve explicit conditions, and support pause/resume/expiry/delete without tasks', t => {
  const f = fixture(t)
  const wish = f.companion.saveWish({ content: '拍夕阳', evidence: '想拍夕阳', minutes: 60, items: ['相机'], expiresAt: '2026-09-20T23:00:00+08:00' })
  let state = f.companion.listState({ date: DATE, days: 1 })
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(state.opportunities[0].needsConfirmation, true)
  assert.deepEqual(state.opportunities[0].items, ['相机'])
  f.companion.updateWish(wish.id, { status: 'paused', expectedVersion: 1 })
  assert.equal(f.companion.listState().opportunities.length, 0)
  f.companion.updateWish(wish.id, { status: 'active', expectedVersion: 2 })
  assert.ok(f.companion.listState().opportunities.length > 0)
  f.advance('2026-09-21T08:00:00+08:00')
  state = f.companion.listState()
  assert.equal(state.wishes[0].status, 'expired')
  assert.equal(state.opportunities.length, 0)
  f.companion.updateWish(wish.id, { status: 'deleted', expectedVersion: 3 })
  assert.equal(f.db.getCompanionState().wishes.length, 0)
})

test('source evidence cannot be invented and retraction removes derived companion state', t => {
  const f = fixture(t), message = f.db.appendMessage({ conversationId: 'main', role: 'user', content: '想看海' })
  const source = { kind: 'conversation', messageId: message.id, evidence: '想看海' }
  assert.throws(() => f.companion.saveWish({ content: '登山', evidence: '我想登山' }, source), /连续原话/)
  f.companion.saveWish({ content: '看海', evidence: '想看海' }, source)
  f.companion.previewScenario({ date: DATE, mode: 'rest' }, source)
  f.db.retractMessage(message.id)
  assert.deepEqual(f.db.getCompanionState().wishes, [])
  assert.deepEqual(f.db.getCompanionState().scenarios, [])
})

test('new service instance sees saved companion records and timeline derives real DDL and preparation', t => {
  const f = fixture(t), report = task(f.db, { due: DATE })
  f.companion.saveWish({ content: '散步', evidence: '散步' })
  update(f.db, { type: 'save-details', taskId: report.id, details: { items: ['报告打印件'], preparation: '', needsSubmission: true, submittedAt: null } })
  const second = createCompanion({ db: f.db, now: f.now }).listState({ date: DATE, days: 1 })
  assert.equal(second.wishes.length, 1)
  assert.equal(second.timeline[0].deadlines[0].taskId, report.id)
  assert.ok(second.opportunities.some(item => item.kind === 'carry' && item.items.includes('报告打印件')))
})

const toolReply = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const reply = text => ({ choices: [{ message: { role: 'assistant', content: text } }] })
const input = text => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', page: 'home', date: DATE } })

test('AI preview tool remains a draft and preference gates writes, memory and history', async t => {
  const f = fixture(t)
  task(f.db)
  f.db.appendMessage({ conversationId: 'main', role: 'user', content: '旧的私密内容' })
  f.db.setPreference('app', { assistant: { autonomy: 'propose', useMemory: false, useHistory: false } })
  const outputs = [], requests = [], responses = [toolReply('create_tasks', { tasks: [{ title: '不应创建' }] }), toolReply('preview_scenario', { date: DATE, mode: 'light', evidence: '今天累了' }), reply('先试排一版')]
  const xixi = createXixi({ db: f.db, now: f.now, complete: async payload => {
    requests.push(payload)
    const last = payload.messages.findLast(message => message.role === 'tool')
    if (last) outputs.push(JSON.parse(last.content))
    return responses.shift()
  } })
  const result = await xixi.chat(input('今天累了'))
  assert.equal(result.status, 'completed')
  assert.match(outputs[0].error, /先提议/)
  assert.equal(outputs[1].scenario.status, 'preview')
  assert.equal(f.db.getPlanner().blocks.length, 0)
  assert.equal(f.db.listTasks().length, 1)
  assert.doesNotMatch(JSON.stringify(requests[0]), /旧的私密内容/)
})

test('temporary exceptions preserve long-term memory and original evidence', async t => {
  const f = fixture(t)
  const original = f.db.appendMessage({ conversationId: 'main', role: 'user', content: '以后我都想早睡' })
  const memory = f.db.rememberMemory({ content: '习惯早睡', evidence: original.content, sourceMessageId: original.id, kind: 'preference', lifetime: 'long-term' })
  const responses = [toolReply('remember', { content: '今晚晚睡', evidence: '今晚例外晚睡', scope: 'global', kind: 'context', lifetime: 'temporary', expiresAt: '2027-09-20T00:00:00+08:00', replacesId: memory.id }), reply('这次单独记')]
  const xixi = createXixi({ db: f.db, now: f.now, complete: async () => responses.shift() })
  const result = await xixi.chat(input('今晚例外晚睡'))
  assert.equal(result.operations.length, 0)
  assert.equal(f.db.listMemories()[0].content, '习惯早睡')
  assert.equal(f.db.listMemories()[0].evidence, original.content)
  assert.ok(result.messages.some(message => message.role === 'tool' && message.content.includes('长期习惯继续保留')))
})

test('large companion records and 50 wishes keep automatic context and explicit reads bounded', async t => {
  const f = fixture(t), report = task(f.db)
  for (let index = 0; index < 50; index++) f.companion.saveWish({ content: `愿望${index}：${'甲'.repeat(400)}`, evidence: '乙'.repeat(1600) })
  f.companion.saveHandoff({ taskId: report.id, progress: '甲'.repeat(1500), obstacle: '乙'.repeat(1500), nextStep: '丙'.repeat(1500), materials: ['资料'.repeat(120)] })
  const responses = [toolReply('read_companion', { date: DATE, days: 7 }), reply('读好了')], requests = []
  const xixi = createXixi({ db: f.db, now: f.now, complete: async payload => { requests.push(payload); return responses.shift() } })
  const request = input('接着做这个任务'); request.context.taskId = report.id
  const result = await xixi.chat(request)
  assert.equal(result.status, 'completed')
  assert.ok(requests.every(payload => contextUnits(payload.messages) + contextUnits(XIXI_TOOLS) < 14000))
  const returned = JSON.parse(result.messages.find(message => message.role === 'tool').content)
  assert.equal(returned.counts.wishes, 50)
  assert.equal(returned.truncated, true)
})
