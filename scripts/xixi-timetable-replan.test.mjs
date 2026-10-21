import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { dayCapacity, minuteOf } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'
const date = '2026-10-16', now = new Date('2026-10-12T12:00:00+08:00')
const requestTool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const receipt = payload => JSON.parse(payload.messages.findLast(message => message.role === 'tool').content)
function fixture(t, { locked = false, empty = false, autonomy = 'act' } = {}) {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const edit = action => db.updatePlanner(action, db.getPlanner().revision)
  // The seeded planner includes evening availability. An empty-day fixture
  // must remove that actual availability, rather than only omit our own row.
  for (const routine of db.getPlanner().routines.filter(row => row.kind === 'available')) {
    edit({ type: 'save-routine', routine: { ...routine, enabled: false } })
  }
  const routine = { id: 'wednesday-class', title: '物理', kind: 'class', weekdays: [3], start: '09:00', end: '10:00', location: '', items: [], enabled: true }
  edit({ type: 'save-routine', routine })
  if (!empty) edit({ type: 'save-routine', routine: { ...routine, id: 'wednesday-free', kind: 'available', title: '可安排', start: '10:00', end: '12:00' } })
  const task = db.createTask({ title: '物理复习', estimateMin: 30, due: date })
  edit({ type: 'save-block', block: { id: 'review', taskId: task.id, date, start: '09:10', end: '09:40', locked,
    horizonGroupId: 'physics', horizonGroupTitle: '学习' } })
  db.setPreference('app', { assistant: { autonomy } })
  return { db, task, before: db.getPlanner() }
}
async function change(f, text, options = {}) {
  let round = 0, outcome
  const input = { requestId: randomUUID(), conversationId: 'main', text, context: { page: 'home', timezone: 'Asia/Shanghai' } }
  const xixi = createXixi({ db: f.db, now: () => now, complete: async payload => {
    if (round++ === 0) return requestTool('read_planner', { date })
    if (round === 2) return requestTool('set_day_timetable', { date, sourceWeekday: 3, expectedRevision: receipt(payload).revision, evidence: text, ...options })
    outcome = receipt(payload)
    return { choices: [{ message: { role: 'assistant', content: '已按实际保存的课表和任务时间核对。' } }] }
  } })
  const result = await xixi.chat(input)
  return { result, outcome }
}

test('a real Xixi timetable tool moves the existing conflicting block atomically and one undo restores both', async t => {
  const f = fixture(t)
  const { result, outcome } = await change(f, '这周五按周三课表上课，直接帮我调整')
  assert.equal(result.status, 'completed'); assert.equal(outcome.ok, true)
  assert.equal(result.operations.length, 1)
  assert.equal(outcome.replanning.moves.length, 1)
  const block = f.db.getPlanner().blocks.find(block => block.id === 'review')
  assert.equal(block.taskId, f.task.id); assert.equal(block.date, date)
  assert.equal(minuteOf(block.end) - minuteOf(block.start), 30)
  assert.equal(block.horizonGroupId, 'physics'); assert.equal(block.horizonGroupTitle, '学习')
  assert.ok(block.start >= '10:00'); assert.equal(f.db.getTask(f.task.id).due, date)
  assert.deepEqual(dayCapacity(f.db.getPlanner(), f.db.listTasks(), date, now).conflicts, [])
  assert.equal(result.operations[0].planChanges[0].id, 'review')
  f.db.undoOperation(result.operations[0].id)
  const restored = f.db.getPlanner()
  assert.deepEqual(restored.blocks, f.before.blocks)
  assert.deepEqual(restored.dayOverrides, f.before.dayOverrides)
  assert.deepEqual(restored.routines, f.before.routines)
})

for (const [label, text, options] of [
  ['explicit tool opt-out', '这周五按周三课表上课', { replanConflicts: false }],
  ['natural-language preservation', '这周五按周三课表上课，不要挪任务', {}],
  ['only-timetable request', '只改课表，这周五按周三课表上课', {}],
]) test(`${label} preserves existing task slots`, async t => {
  const f = fixture(t), { result, outcome } = await change(f, text, options)
  assert.equal(result.status, 'completed'); assert.equal(outcome.ok, true)
  assert.equal(outcome.replanning, undefined)
  assert.deepEqual(f.db.getPlanner().blocks, f.before.blocks)
  assert.deepEqual(outcome.day.capacity.conflicts, ['review'])
})

for (const config of [{ locked: true }, { empty: true }]) test(`unmovable ${JSON.stringify(config)} remains visible without pretending to be resolved`, async t => {
  const f = fixture(t, config), { outcome } = await change(f, '这周五按周三课表上课')
  assert.equal(outcome.ok, true); assert.deepEqual(outcome.replanning.moves, [])
  assert.ok(outcome.replanning.unresolved.some(item => item.id === 'review'))
  assert.deepEqual(f.db.getPlanner().blocks, f.before.blocks)
  assert.deepEqual(outcome.day.capacity.conflicts, ['review'])
})

test('propose mode cannot change the timetable or auto-move its task slots', async t => {
  const f = fixture(t, { autonomy: 'propose' }), { outcome, result } = await change(f, '这周五按周三课表上课')
  assert.equal(outcome.ok, false); assert.match(outcome.error, /先提议/u)
  assert.deepEqual(f.db.getPlanner(), f.before); assert.deepEqual(result.operations, [])
})

const qaText = '这周五按周三课表上课，直接帮我调整'
const qaReply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const qaInput = (context = {}) => ({ requestId: randomUUID(), conversationId: 'main', text: qaText,
  context: { page: 'home', timezone: 'Asia/Shanghai', ...context } })
const qaSet = expectedRevision => requestTool('set_day_timetable', {
  date, sourceWeekday: 3, expectedRevision, evidence: qaText,
})
const qaSnapshot = db => ({ planner: db.getPlanner(), tasks: db.listTasks(),
  companion: db.getCompanionState(), operations: db.listOperations() })

// Only the completion transport is scripted. Planner reads, writes, journals,
// retries, session completion and undo all use the real Xixi and SQLite store.
function receiptQA(f) {
  const answers = [], payloads = [], unexpected = []
  const xixi = createXixi({ db: f.db, now: () => now, complete: async payload => {
    payloads.push(payload)
    const answer = answers.shift()
    if (answer instanceof Error) throw answer // Deliberately injected transport failure.
    let response
    try {
      assert.ok(answer, 'unexpected completion request')
      response = typeof answer === 'function' ? await answer(payload) : answer
    } catch (error) { unexpected.push(error); throw error }
    if (response instanceof Error) throw response
    return response
  } })
  return { answers, payloads, async run(input, options) {
    const result = await xixi.chat(input, options)
    assert.deepEqual(unexpected, [], 'Xixi must not swallow an assertion in the scripted transport')
    assert.equal(answers.length, 0, 'all expected completion steps must be exercised')
    return result
  } }
}

function assertCurrentDay(outcome, f, planner = f.db.getPlanner()) {
  assert.equal(outcome.day.date, date)
  assert.equal(outcome.day.dayOverride?.sourceWeekday ?? null, planner.dayOverrides[date]?.sourceWeekday ?? null)
  assert.deepEqual(outcome.day.capacity.conflicts, dayCapacity(planner, f.db.listTasks(), date, now).conflicts)
  for (const row of outcome.day.blocks.items) {
    const actual = planner.blocks.find(block => block.id === row.id)
    assert.ok(actual)
    for (const key of ['taskId', 'date', 'start', 'end', 'locked', 'horizonGroupId', 'horizonGroupTitle']) {
      assert.equal(row[key], actual[key], `receipt ${row.id}.${key} must describe the current stored block`)
    }
  }
  assert.equal(outcome.day.blocks.total, planner.blocks.filter(block => block.date === date).length)
}

test('a disconnected reply after the atomic timetable write retries the same request without repeating moves or operations', async t => {
  const { ProviderError } = await import('../server/provider.mjs')
  const f = fixture(t), qa = receiptQA(f), input = qaInput()
  let saved, disconnects = 0
  qa.answers.push(requestTool('read_planner', { date }), payload => qaSet(receipt(payload).revision), payload => {
    saved = receipt(payload)
    return new ProviderError('simulated network disconnect after the saved tool receipt')
  })
  // Losing the stream observer cannot cancel an already committed local write.
  const first = await qa.run(input, { onEvent: event => {
    if (event.type === 'activity' && event.activity.state === 'done' && f.db.listOperations({ requestId: input.requestId }).length) {
      disconnects++
      throw new Error('simulated disconnected stream observer')
    }
  } })
  assert.ok(disconnects > 0)
  assert.equal(saved.ok, true); assert.equal(saved.replanning.moves.length, 1)
  assert.equal(first.status, 'completed')
  assert.equal(first.execution.reply.mode, 'fallback')
  assert.equal(first.operations.length, 1)
  const operation = first.operations[0], after = qaSnapshot(f.db), calls = qa.payloads.length
  assert.deepEqual(operation.plannerBefore, f.before)
  assert.equal(operation.requestedActions.length, 2)
  assert.equal(operation.requestedActions[0].type, 'set-day-template')
  assert.deepEqual(operation.planChanges, saved.replanning.moves.map(move => ({ id: move.before.id, ...move })))
  assert.deepEqual(after.planner.blocks, saved.replanning.moves.map(move => move.after))
  assert.deepEqual(Object.keys(after.planner.dayOverrides), [date])
  assertCurrentDay(saved, f)
  for (let attempt = 0; attempt < 2; attempt++) {
    const retried = await qa.run(input)
    assert.equal(retried.status, 'completed')
    assert.deepEqual(retried.operations, [operation])
    assert.deepEqual(qaSnapshot(f.db), after)
  }
  assert.equal(qa.payloads.length, calls, 'completed retries must not call the model or replan again')
  assert.equal(f.db.listMessages('main').filter(message => message.requestId === input.requestId && message.role === 'user').length, 1)
})

for (const manual of ['none', 'move', 'delete']) test(`recovery before a tool receipt reuses the operation and reads the current day after manual ${manual}`, async t => {
  const f = fixture(t), qa = receiptQA(f), input = qaInput(), cancellation = new AbortController()
  const edit = action => f.db.updatePlanner(action, f.db.getPlanner().revision)
  // A later user-selected template must also survive retry of the earlier one.
  edit({ type: 'save-routine', routine: { id: 'monday-class', title: '周一课程', kind: 'class', weekdays: [1],
    start: '13:00', end: '14:00', location: '', items: [], enabled: true } })
  edit({ type: 'save-routine', routine: { id: 'monday-free', title: '周一可安排', kind: 'available', weekdays: [1],
    start: '14:00', end: '17:00', location: '', items: [], enabled: true } })
  const before = f.db.getPlanner(), tasks = f.db.listTasks()
  let originalCall
  qa.answers.push(requestTool('read_planner', { date }), payload => {
    const response = qaSet(receipt(payload).revision)
    originalCall = response.choices[0].message.tool_calls[0]
    return response
  })
  // This boundary is after the real transaction, but before recordOutcome and
  // the tool-message journal. No fake operation or planner snapshot is seeded.
  const first = await qa.run(input, { signal: cancellation.signal, onEvent: event => {
    if (event.type === 'activity' && event.activity.id === `tool:${originalCall?.id}` && event.activity.state === 'done') {
      cancellation.abort(new Error('simulated interrupted response before journaling'))
    }
  } })
  assert.equal(cancellation.signal.aborted, true)
  assert.equal(first.status, 'failed')
  assert.equal(first.operations.length, 1)
  const operation = first.operations[0], committed = f.db.getPlanner()
  assert.deepEqual(operation.plannerBefore, before)
  assert.equal(operation.requestedActions.length, 2)
  assert.equal(operation.planChanges.length, 1)
  assert.deepEqual(committed.blocks, operation.planChanges.map(change => change.after))
  assert.equal(f.db.listMessages('main').some(message => message.role === 'tool' && message.toolCallId === originalCall.id), false)
  if (manual !== 'none') {
    edit({ type: 'set-day-template', date, sourceWeekday: 1 })
    if (manual === 'move') edit({ type: 'save-block', block: { ...committed.blocks[0], start: '14:30', end: '15:00',
      locked: true, horizonGroupTitle: '用户后来的修改' } })
    else edit({ type: 'delete-block', id: 'review' })
  }
  const latest = qaSnapshot(f.db), outcomes = []
  let repeatedCall
  qa.answers.push(payload => {
    outcomes.push(receipt(payload)) // The original missing journal was recovered before the model resumed.
    return requestTool('read_planner', { date })
  }, payload => {
    assert.equal(receipt(payload).revision, latest.planner.revision)
    const response = qaSet(receipt(payload).revision)
    repeatedCall = response.choices[0].message.tool_calls[0]
    return response
  }, payload => {
    outcomes.push(receipt(payload))
    return qaReply('沿用原操作，当前安排以最新日历为准，后续手工修改保留。')
  })
  const retried = await qa.run(input)
  assert.equal(retried.status, 'completed')
  assert.equal(outcomes.length, 2)
  assert.notEqual(repeatedCall.id, originalCall.id, 'the provider retried with a different call ID')
  assert.deepEqual(retried.operations, [operation])
  for (const outcome of outcomes) {
    assert.equal(outcome.ok, true); assert.equal(outcome.reused, true)
    assert.equal(outcome.operation.id, operation.id)
    assert.deepEqual(outcome.originalMoves, operation.planChanges)
    assert.equal(outcome.replanning, undefined, 'old destinations must be labelled as history, not newly saved moves')
    assert.match(outcome.notice, /当前.*以 day 为准/u)
    assertCurrentDay(outcome, f, latest.planner)
  }
  if (manual === 'move') {
    assert.notEqual(outcomes[0].originalMoves[0].after.start, latest.planner.blocks[0].start)
    assert.equal(outcomes[0].day.blocks.items.find(block => block.id === 'review').start, '14:30')
    assert.equal(outcomes[0].day.blocks.items.find(block => block.id === 'review').locked, true)
  }
  if (manual === 'delete') assert.equal(outcomes[0].day.blocks.items.some(block => block.id === 'review'), false)
  assert.deepEqual(qaSnapshot(f.db), latest, 'recovery must not roll back or refill the later user plan')
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.equal(f.db.listMessages('main').filter(message => message.requestId === input.requestId && message.role === 'user').length, 1)
  const calls = qa.payloads.length
  await qa.run(input)
  assert.equal(qa.payloads.length, calls)
  assert.deepEqual(qaSnapshot(f.db), latest)
})

test('a widest-day Xixi receipt saves at most seven of nine conflicts in eight actions and one undo restores everything', async t => {
  const f = fixture(t), edit = action => f.db.updatePlanner(action, f.db.getPlanner().revision)
  for (const routine of f.db.getPlanner().routines.filter(row => ['wednesday-class', 'wednesday-free'].includes(row.id))) {
    edit({ type: 'save-routine', routine: { ...routine, start: routine.kind === 'class' ? '09:00' : '00:00',
      end: routine.kind === 'class' ? '14:00' : '23:59' } })
  }
  const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  for (let index = 0; index < 9; index++) {
    const task = index ? f.db.createTask({ title: `独立复习 ${index + 1}`, estimateMin: 20, due: date }) : f.task
    const start = 9 * 60 + 10 + index * 30
    edit({ type: 'save-block', block: { id: index ? `review-${index + 1}` : 'review', taskId: task.id, date,
      start: clock(start), end: clock(start + 20), locked: false, horizonGroupId: `subject-${index}`, horizonGroupTitle: `分组 ${index}` } })
  }
  const before = f.db.getPlanner(), tasks = f.db.listTasks(), { result, outcome } = await change(f, qaText)
  assert.equal(result.status, 'completed'); assert.equal(outcome.ok, true)
  assert.equal(result.operations.length, 1)
  const operation = result.operations[0], movedIds = new Set(outcome.replanning.moves.map(move => move.before.id))
  const retained = before.blocks.filter(block => !movedIds.has(block.id)), after = f.db.getPlanner()
  assert.equal(movedIds.size, 7)
  assert.equal(operation.requestedActions.length, 8)
  assert.deepEqual(operation.requestedActions[0], { type: 'set-day-template', date, sourceWeekday: 3 })
  assert.deepEqual(operation.requestedActions.slice(1), outcome.replanning.moves.map(move => ({ type: 'save-block', block: move.after })))
  assert.deepEqual(operation.plannerBefore, before)
  assert.deepEqual(operation.planChanges, outcome.replanning.moves.map(move => ({ id: move.before.id, ...move })))
  assert.match(operation.summary, /已调整 7 段/u)
  assert.deepEqual(new Set(outcome.replanning.unresolved.map(item => item.id)), new Set(retained.map(block => block.id)))
  assert.equal(retained.length, 2)
  for (const block of retained) {
    const item = outcome.replanning.unresolved.find(item => item.id === block.id)
    assert.equal(item.taskId, block.taskId)
    assert.match(item.reason, /最多移动 7 段.*未处理.*原时段保留/u)
    assert.deepEqual(after.blocks.find(item => item.id === block.id), block)
  }
  assert.deepEqual(new Set(outcome.day.capacity.conflicts), new Set(retained.map(block => block.id)))
  assert.deepEqual(new Set(dayCapacity(after, tasks, date, now).conflicts), new Set(retained.map(block => block.id)))
  assert.match(outcome.notice, /unresolved.*仍存在.*不能声称全部消除/u)
  for (const { before: original, after: moved } of outcome.replanning.moves) {
    assert.equal(moved.date, date)
    assert.equal(minuteOf(moved.end) - minuteOf(moved.start), minuteOf(original.end) - minuteOf(original.start))
    assert.deepEqual({ ...moved, start: original.start, end: original.end }, original)
    assert.deepEqual(after.blocks.find(block => block.id === moved.id), moved)
  }
  const undone = f.db.undoOperation(operation.id), restored = f.db.getPlanner()
  assert.ok(undone.undoneAt)
  assert.deepEqual({ ...restored, revision: before.revision }, before)
  assert.deepEqual(f.db.listTasks(), tasks)
  assert.equal(f.db.listOperations().length, 1)
  assert.ok(f.db.listOperations()[0].undoneAt)
})

test('Xixi keeps a genuinely completed free-time session while moving its todo goal task sibling', async t => {
  const [{ createCompanion }, { createFreeTime }] = await Promise.all([
    import('../server/companion.mjs'), import('../server/freeTime.mjs'),
  ])
  const f = fixture(t), edit = action => f.db.updatePlanner(action, f.db.getPlanner().revision)
  edit({ type: 'delete-block', id: 'review' })
  edit({ type: 'save-routine', routine: { id: 'friday-free', title: '原定周五余时', kind: 'available', weekdays: [5],
    start: '09:00', end: '12:00', location: '', items: [], enabled: true } })
  const companion = createCompanion({ db: f.db, now: () => now }), freeTime = createFreeTime({ db: f.db, now: () => now })
  const goal = companion.saveFreeTimeGoal({ title: '物理余时目标', minPerWeek: 2, sessionMin: 30, sessionMax: 30 })
  const scheduled = freeTime.schedule({ date })
  assert.equal(scheduled.addedSessions.length, 2)
  const completed = scheduled.addedSessions.find(block => block.date === date)
  assert.ok(completed); assert.equal(completed.start, '09:00')
  const sibling = { ...scheduled.addedSessions.find(block => block.id !== completed.id), date, start: '09:40', end: '10:10' }
  edit({ type: 'save-block', block: sibling })
  const completion = freeTime.completeSession({ sessionId: completed.id, feedback: 'continue', nextStep: '下次接着核对公式' })
  assert.equal(completion.goalId, goal.id)
  assert.equal(f.db.getTask(completed.taskId).status, 'todo')
  assert.equal(completed.locked, false); assert.equal(sibling.taskId, completed.taskId)
  assert.equal(f.db.getPlanner().completedFreeTimeSessions, undefined)
  assert.equal(freeTime.plannerState().completedFreeTimeSessions[completed.id], completion.completedAt)
  const before = f.db.getPlanner(), history = f.db.getCompanionState(), tasks = f.db.listTasks()
  const { result, outcome } = await change(f, qaText)
  assert.equal(result.operations.length, 1); assert.equal(outcome.ok, true)
  assert.deepEqual(outcome.replanning.moves.map(move => move.before.id), [sibling.id])
  assert.deepEqual(outcome.replanning.unresolved.map(item => [item.id, item.taskId]), [[completed.id, completed.taskId]])
  assert.match(outcome.replanning.unresolved[0].reason, /本次余时已完成/u)
  assert.deepEqual(f.db.getPlanner().blocks.find(block => block.id === completed.id), completed)
  assert.equal(f.db.getPlanner().blocks.find(block => block.id === sibling.id).start, '10:00')
  assert.deepEqual(outcome.day.capacity.conflicts, [completed.id])
  assert.deepEqual(result.operations[0].planChanges.map(change => change.id), [sibling.id])
  assert.equal(result.operations[0].requestedActions.length, 2)
  assert.deepEqual(f.db.listTasks(), tasks); assert.deepEqual(f.db.getCompanionState(), history)
  const sessions = freeTime.state({ date }).freeTimeSessions
  assert.equal(sessions.find(session => session.id === completed.id).completed, true)
  assert.equal(sessions.find(session => session.id === sibling.id).completed, false)
  f.db.undoOperation(result.operations[0].id)
  assert.deepEqual({ ...f.db.getPlanner(), revision: before.revision }, before)
  assert.deepEqual(f.db.getCompanionState(), history, 'undoing the timetable must not reopen a completed session')
  assert.equal(f.db.listOperations().length, 2, 'the earlier real free-time schedule has its own unchanged receipt')
  assert.equal(f.db.listOperations().find(operation => operation.id === scheduled.operation.id).undoneAt, null)
})

test('a timezone mismatch rejects the timetable and all prospective moves without a business write', async t => {
  const f = fixture(t), qa = receiptQA(f), input = qaInput({ timezone: 'UTC' }), before = qaSnapshot(f.db)
  let read, outcome
  qa.answers.push(requestTool('read_planner', { date }), payload => {
    read = receipt(payload)
    return qaSet(read.revision)
  }, payload => { outcome = receipt(payload); return qaReply('先统一日程与页面时区，再调整课表。') })
  const result = await qa.run(input)
  assert.equal(read.timezoneMatches, false)
  assert.equal(read.timezone, 'Asia/Shanghai'); assert.equal(read.userTimezone, 'UTC')
  assert.equal(outcome.ok, false); assert.match(outcome.error, /时区/u)
  assert.equal(outcome.replanning, undefined)
  assert.deepEqual(result.operations, [])
  assert.deepEqual(qaSnapshot(f.db), before)
})

test('a stale expectedRevision after the planner read preserves the concurrent user edit and writes no operation', async t => {
  const f = fixture(t), qa = receiptQA(f), input = qaInput()
  let readRevision, concurrent, outcome
  qa.answers.push(requestTool('read_planner', { date }), payload => {
    readRevision = receipt(payload).revision
    f.db.updatePlanner({ type: 'save-block', block: { ...f.db.getPlanner().blocks[0], start: '11:00', end: '11:30',
      horizonGroupTitle: '另一窗口手工调整' } }, readRevision)
    concurrent = qaSnapshot(f.db)
    return qaSet(readRevision)
  }, payload => { outcome = receipt(payload); return qaReply('安排已有更新，需要重新读取后再调整。') })
  const result = await qa.run(input)
  assert.ok(concurrent.planner.revision > readRevision)
  assert.equal(outcome.ok, false); assert.match(outcome.error, /其他窗口更新.*重新读取/u)
  assert.equal(outcome.replanning, undefined)
  assert.deepEqual(result.operations, [])
  assert.deepEqual(qaSnapshot(f.db), concurrent)
  assert.equal(f.db.getPlanner().dayOverrides[date], undefined)
  assert.equal(f.db.getPlanner().blocks[0].start, '11:00')
})
