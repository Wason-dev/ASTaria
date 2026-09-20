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
