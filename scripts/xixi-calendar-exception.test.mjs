import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { dayCapacity, routinesForDay } from '../src/planner/model.ts'

// This suite owns the assistant entry point for `set_calendar_exception`.
// The planner batch semantics and the durable action whitelist are already
// pinned by scripts/planner-day-exceptions.test.mjs; here every write goes
// through a real createXixi().chat against an in-memory database and a
// scripted provider, so the assertions are about what the user is shown:
// the execution receipt, retries that must not write twice, undo, and a
// backup round-trip that must keep the receipt auditable.
process.env.TZ = 'Asia/Shanghai'

const NOW = new Date('2026-09-19T12:00:00+08:00') // a Saturday
const START = '2026-10-01' // a Thursday, so the weekly class is visible again after a restore
const END = '2026-10-07'
const SPAN = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07']
const OUTSIDE = '2026-10-08'
const HOLIDAY_TEXT = '国庆放假，10月1日到10月7日都停课，课表清空'
const RESTORE_TEXT = '假期结束，10月1日到10月7日恢复原课表'
const THURSDAY = { id: 'thursday-class', title: '物理实验', kind: 'class', weekdays: [4], start: '09:00', end: '10:00', location: '实验室', items: ['实验手册'], enabled: true }
const EVENT = { id: 'ceremony', title: '校庆典礼', date: '2026-10-03', start: '15:00', end: '16:00', location: '礼堂', items: ['活动手册'] }

const answer = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const call = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const readSpan = () => call('read_planner', { date: START, days: 7 })
const exceptionCall = (kind, revision, evidence) => call('set_calendar_exception', { date: START, endDate: END, kind, expectedRevision: revision, evidence })
const contextReceipt = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)
const storedMessages = db => db.listMessages('main', { limit: 200 })
const toolReceipts = db => storedMessages(db).filter(message => message.role === 'tool').map(message => JSON.parse(message.content))
const slots = rows => rows.map(row => [row.start, row.end, row.title])
const finalReply = result => result.messages.findLast(message => message.role === 'assistant' && !message.toolCalls?.length)?.content
const input = (text, requestId = randomUUID()) => ({ requestId, conversationId: 'main', text, context: { timezone: 'Asia/Shanghai' } })

function fixture(t) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const update = action => db.updatePlanner(action, db.getPlanner().revision)
  update({ type: 'import-routines', routines: [THURSDAY] })
  // A real task slot and a single-day event inside the span must survive a holiday.
  const task = db.createTask({ title: '假期里的作业', due: END, estimateMin: 30 })
  update({ type: 'save-block', block: { id: 'holiday-task', taskId: task.id, date: '2026-10-03', start: '13:00', end: '13:30', locked: false } })
  update({ type: 'save-day-event', event: EVENT })
  const script = [], requests = [], providerFailures = []
  // Each chat opens a fresh Xixi, so a retry below really re-enters the
  // service like a restarted local process instead of a warm in-memory object.
  const chat = async value => {
    const result = await createXixi({ db, now: () => NOW, complete: async request => {
      requests.push(request)
      const next = script.shift()
      assert.ok(next, 'unexpected provider dispatch')
      try { return typeof next === 'function' ? await next(request) : next }
      catch (error) { providerFailures.push(error); throw error }
    } }).chat(value)
    assert.deepEqual(providerFailures, [], 'provider assertions must not become silent failures')
    return result
  }
  return { db, script, requests, chat }
}

test('a holiday span is applied through the assistant chat and reported in its execution receipt', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  f.script.push(readSpan(), request => exceptionCall('holiday', contextReceipt(request).revision, HOLIDAY_TEXT),
    answer('10月1日到10月7日已按假期处理，课表清空；任务和校庆典礼都保留'))
  const result = await f.chat(input(HOLIDAY_TEXT))

  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.execution.reply.mode, 'model')
  assert.equal(finalReply(result), '10月1日到10月7日已按假期处理，课表清空；任务和校庆典礼都保留')
  assert.deepEqual(result.execution.failures, [])
  assert.deepEqual(result.execution.steps.map(step => [step.name, step.status]),
    [['read_planner', 'completed'], ['set_calendar_exception', 'committed']])
  assert.equal(result.operations.length, 1)
  const receipt = result.operations[0]
  assert.equal(receipt.kind, 'planner')
  assert.equal(receipt.summary, '2026-10-01 至 2026-10-07 假期，常规课表已清空')
  assert.deepEqual(receipt.requestedActions, [{ type: 'set-day-exception', date: START, endDate: END, kind: 'holiday' }])
  assert.equal(receipt.undoable, true)
  assert.equal(receipt.undoneAt, null)
  assert.equal(receipt.plannerBefore.revision, before.revision)
  assert.equal(receipt.plannerAfterRevision, before.revision + 1)
  assert.deepEqual(result.execution.commits,
    [{ stepId: result.execution.steps[1].id, operationId: receipt.id, summary: receipt.summary }])

  // The receipt handed back to the model names the same durable write and its evidence.
  const outcome = toolReceipts(f.db).at(-1)
  assert.equal(outcome.ok, true)
  assert.equal(outcome.revision, before.revision + 1)
  assert.equal(outcome.operation.id, receipt.id)
  const userMessage = storedMessages(f.db).find(message => message.role === 'user' && message.requestId === result.requestId)
  assert.deepEqual(outcome.evidenceSourceIds, [userMessage.id])

  // Durable calendar state: seven holiday days inside the span, nothing outside it.
  const state = f.db.getPlanner()
  assert.equal(state.revision, before.revision + 1)
  assert.deepEqual(Object.keys(state.dayExceptions).sort(), SPAN)
  for (const date of SPAN) {
    assert.deepEqual(state.dayExceptions[date], { date, kind: 'holiday' })
    // A cancelled timetable never erases a single-day event, which still shows.
    assert.deepEqual(slots(routinesForDay(state, date)), date === '2026-10-03' ? [['15:00', '16:00', '校庆典礼']] : [])
  }
  assert.equal(dayCapacity(state, f.db.listTasks(), START, NOW).totalMin, 0)
  // The holiday clears the timetable, not the user's own facts.
  assert.deepEqual(state.blocks, before.blocks)
  assert.deepEqual(state.routines, before.routines)
  assert.deepEqual(state.dayEvents, before.dayEvents)
  assert.deepEqual(slots(routinesForDay(state, OUTSIDE)), [['09:00', '10:00', '物理实验'], ['18:00', '20:00', '晚自习']])
  // Two hours of evening availability remain outside the span.
  assert.equal(dayCapacity(state, f.db.listTasks(), OUTSIDE, NOW).totalMin, 120)
})

test('a restored span brings the weekly timetable back and blocks replaying the older holiday receipt', async t => {
  const f = fixture(t), weekly = f.db.getPlanner()
  f.script.push(readSpan(), request => exceptionCall('holiday', contextReceipt(request).revision, HOLIDAY_TEXT), answer('假期已记下'))
  const holiday = await f.chat(input(HOLIDAY_TEXT))
  assert.deepEqual(routinesForDay(f.db.getPlanner(), START), [])
  f.script.push(readSpan(), request => exceptionCall('restored', contextReceipt(request).revision, RESTORE_TEXT),
    answer('10月1日到10月7日已恢复原课表'))
  const restored = await f.chat(input(RESTORE_TEXT))

  assert.equal(restored.status, 'completed')
  assert.equal(restored.execution.status, 'verified')
  const receipt = restored.operations[0]
  assert.deepEqual(receipt.requestedActions, [{ type: 'set-day-exception', date: START, endDate: END, kind: 'restored' }])
  assert.equal(receipt.summary, '2026-10-01 至 2026-10-07 已恢复原每周课表')
  assert.equal(toolReceipts(f.db).at(-1).operation.id, receipt.id)
  const state = f.db.getPlanner()
  assert.equal(state.revision, weekly.revision + 2)
  for (const date of SPAN) assert.deepEqual(state.dayExceptions[date], { date, kind: 'restored' })
  assert.deepEqual(slots(routinesForDay(state, START)), [['09:00', '10:00', '物理实验'], ['18:00', '20:00', '晚自习']])
  assert.equal(dayCapacity(state, f.db.listTasks(), START, NOW).totalMin, 120)

  // A receipt that is no longer the latest change can never be replayed blindly.
  assert.throws(() => f.db.undoOperation(holiday.operations[0].id), error => error.status === 409)
  assert.deepEqual(f.db.getPlanner(), state)
  // Undo of the latest receipt rolls the calendar back to the holiday layer.
  f.db.undoOperation(receipt.id)
  const undone = f.db.getPlanner()
  assert.equal(undone.revision, state.revision + 1)
  for (const date of SPAN) assert.deepEqual(undone.dayExceptions[date], { date, kind: 'holiday' })
  assert.deepEqual(routinesForDay(undone, START), [])
})

test('replaying a completed request or resuming an interrupted one never writes the calendar twice', async t => {
  const f = fixture(t)
  // Both attempts submit the identical call, which is what a provider retry
  // produces: same request, same dates, same evidence, same expected revision.
  const request = input(HOLIDAY_TEXT), revision = f.db.getPlanner().revision
  f.script.push(readSpan(), () => exceptionCall('holiday', revision, HOLIDAY_TEXT), answer('假期已记下'))
  const first = await f.chat(request)
  const applied = f.db.getPlanner(), receipt = first.operations[0]
  assert.equal(first.execution.status, 'verified')
  assert.equal(f.requests.length, 3)
  assert.equal(applied.revision, revision + 1)

  // 1) An identical, already-completed request is answered from durable state.
  const replayed = await f.chat(request)
  assert.equal(replayed.status, 'completed')
  assert.equal(f.requests.length, 3, 'a completed request must not reach the provider again')
  assert.deepEqual(replayed.operations.map(operation => operation.id), [receipt.id])
  assert.deepEqual(f.db.getPlanner(), applied)
  assert.equal(toolReceipts(f.db).length, 2)

  // 2) An interrupted turn resumes: the model repeats the identical call and the
  //    stored operation is reused instead of writing a second receipt.
  f.db.finishTurn(request.requestId, { status: 'failed', error: 'interrupted acknowledgement' })
  f.script.push(() => exceptionCall('holiday', revision, HOLIDAY_TEXT), answer('这次已经记下了'))
  const resumed = await f.chat(request)
  assert.equal(resumed.status, 'completed')
  assert.equal(resumed.execution.status, 'verified')
  assert.equal(finalReply(resumed), '这次已经记下了')
  assert.deepEqual(resumed.operations.map(operation => operation.id), [receipt.id])
  assert.deepEqual(f.db.getPlanner(), applied)
  assert.deepEqual(f.db.listOperations({ requestId: request.requestId }).map(operation => operation.id), [receipt.id])
  const reused = toolReceipts(f.db).at(-1)
  assert.equal(reused.ok, true)
  assert.equal(reused.reused, true)
  assert.equal(reused.operation.id, receipt.id)
  assert.equal(f.db.getPlanner().revision, revision + 1)
})

test('a duplicated identical call inside one turn reuses the committed operation', async t => {
  const f = fixture(t)
  const revision = f.db.getPlanner().revision
  f.script.push(readSpan(), () => exceptionCall('holiday', revision, HOLIDAY_TEXT),
    () => exceptionCall('holiday', revision, HOLIDAY_TEXT), answer('假期已记下'))
  const result = await f.chat(input(HOLIDAY_TEXT))

  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.equal(result.operations.length, 1)
  assert.deepEqual(result.operations.map(operation => operation.id), result.execution.commits.map(commit => commit.operationId))
  assert.equal(result.execution.steps.filter(step => step.name === 'set_calendar_exception').length, 2)
  assert.equal(f.db.getPlanner().revision, revision + 1)
  assert.equal(f.db.listOperations({ requestId: result.requestId }).length, 1)
  const receipts = toolReceipts(f.db)
  assert.equal(receipts.length, 3)
  assert.equal(receipts[1].reused, undefined)
  assert.equal(receipts[2].reused, true)
  assert.equal(receipts[2].operation.id, receipts[1].operation.id)
})

test('an exception without a fresh read is refused and leaves the calendar untouched', async t => {
  const f = fixture(t), before = f.db.getPlanner()
  f.script.push(() => exceptionCall('holiday', before.revision, HOLIDAY_TEXT), answer('请先读取这些日期'))
  const result = await f.chat(input(HOLIDAY_TEXT))

  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'failed')
  assert.deepEqual(result.operations, [])
  assert.deepEqual(f.db.getPlanner(), before)
  assert.deepEqual(f.db.listOperations(), [])
  const refused = toolReceipts(f.db).at(-1)
  assert.equal(refused.ok, false)
  assert.match(refused.error, /先.*读取|read_planner/u)
  assert.match(finalReply(result), /没有保存新的变更|尚未完成/u)
})

test('exporting and re-importing a backup keeps the exception receipt auditable but read-only', async t => {
  const f = fixture(t)
  const request = input(HOLIDAY_TEXT)
  f.script.push(readSpan(), request => exceptionCall('holiday', contextReceipt(request).revision, HOLIDAY_TEXT), answer('假期已记下'))
  const applied = await f.chat(request)
  const receipt = applied.operations[0]
  const backup = f.db.exportData()

  // The exported file keeps the write itself, not just the resulting calendar.
  const exported = JSON.parse(backup.tables.operations.find(row => row.id === receipt.id).document)
  assert.equal(exported.kind, 'planner')
  assert.equal(exported.undoable, true)
  assert.deepEqual(exported.requestedActions, [{ type: 'set-day-exception', date: START, endDate: END, kind: 'holiday' }])

  // Clear every holiday day, then restore the backup.
  for (const date of SPAN) f.db.updatePlanner({ type: 'clear-day-exception', date }, f.db.getPlanner().revision)
  assert.deepEqual(f.db.getPlanner().dayExceptions, {})
  assert.equal(f.db.importData(backup).restored, true)
  const state = f.db.getPlanner()
  assert.deepEqual(Object.keys(state.dayExceptions).sort(), SPAN)
  assert.deepEqual(routinesForDay(state, START), [])
  assert.deepEqual(state.dayEvents, [EVENT])

  // The receipt survives as read-only history that still matches what was written.
  const history = f.db.listOperations().find(operation => operation.id === receipt.id)
  assert.equal(history.requestId, receipt.requestId)
  assert.equal(history.summary, receipt.summary)
  assert.equal(history.createdAt, receipt.createdAt)
  assert.equal(history.undoneAt, null)
  assert.equal(history.kind, 'restored')
  assert.equal(history.undoable, false)
  assert.throws(() => f.db.undoOperation(receipt.id), error => error.status === 409 && /恢复备份/u.test(error.message))
  const stored = toolReceipts(f.db).find(outcome => outcome.operation?.id === receipt.id)
  assert.equal(stored.ok, true)
  assert.equal(stored.revision, receipt.plannerAfterRevision)

  // Replaying the same request reports the restored receipt instead of writing again.
  const replayed = await f.chat(request)
  assert.equal(replayed.status, 'completed')
  assert.deepEqual(replayed.operations.map(operation => [operation.id, operation.kind, operation.undoable]), [[receipt.id, 'restored', false]])
  assert.equal(f.requests.length, 3, 'no provider dispatch after a backup restore')
  assert.deepEqual(f.db.getPlanner(), state)
})
