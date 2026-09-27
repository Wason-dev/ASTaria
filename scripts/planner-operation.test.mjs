import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-planner-operation-')), filename = join(directory, 'qa.sqlite')
  const connections = new Set()
  const open = () => { const db = createDatabase(filename); connections.add(db); return db }
  t.after(() => { for (const db of connections) db.close(); rmSync(directory, { recursive: true, force: true }) })
  return { db: open(), open }
}
const block = (taskId, patch = {}) => ({ id: randomUUID(), taskId, date: '2026-09-21', start: '18:00', end: '18:35', locked: false, ...patch })
const detail = (patch = {}) => ({ items: ['计算器'], preparation: '整理数据', needsSubmission: true, submittedAt: null, ...patch })
const request = () => ({ requestId: randomUUID(), conversationId: 'main', text: '把报告安排到晚自习', context: {} })
const operation = (db, actions, patch = {}) => ({ id: randomUUID(), requestId: randomUUID(), summary: '已安排报告', actions, expectedRevision: db.getPlanner().revision, ...patch })
const conflict = error => error.status === 409
const invalid = error => error.status === 400

test('AI planner operations produce persistent receipts and undo restores the snapshot with a newer revision', t => {
  const { db, open } = fixture(t), task = db.createTask({ title: '实验报告' })
  const before = db.getPlanner(), proposed = block(task.id)
  const input = operation(db, [{ type: 'save-block', block: proposed }, { type: 'save-details', taskId: task.id, details: detail() }])
  const inputCopy = structuredClone(input), receipt = db.applyPlannerOperation(input)
  assert.deepEqual(input, inputCopy)
  assert.equal(receipt.kind, 'planner'); assert.equal(receipt.undoable, true)
  assert.deepEqual(receipt.changes, []); assert.deepEqual(receipt.plannerBefore, before)
  assert.equal(receipt.plannerAfterRevision, 2)
  assert.deepEqual(db.getPlanner().blocks, [proposed])
  const second = open()
  assert.deepEqual(second.listOperations(), [receipt])
  const undone = second.undoOperation(receipt.id)
  assert.ok(undone.undoneAt)
  assert.deepEqual(db.getPlanner(), { ...before, revision: 3 })
  assert.deepEqual(second.undoOperation(receipt.id), undone)
  assert.equal(db.getPlanner().revision, 3)
})

test('planner operation retries return the original receipt but reject ID reuse with different content', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' }), proposed = block(task.id)
  const input = operation(db, [{ type: 'save-block', block: proposed }]), receipt = db.applyPlannerOperation(input)
  assert.deepEqual(db.applyPlannerOperation(input), receipt)
  assert.equal(db.getPlanner().blocks.length, 1); assert.equal(db.getPlanner().revision, 1)
  for (const patch of [{ expectedRevision: 1 }, { summary: '别的内容' }, { requestId: randomUUID() }, { actions: [{ type: 'delete-block', id: proposed.id }] }]) {
    assert.throws(() => db.applyPlannerOperation({ ...input, ...patch }), conflict)
  }
  db.undoOperation(receipt.id)
  assert.ok(db.applyPlannerOperation(input).undoneAt)
  assert.deepEqual(db.getPlanner().blocks, [])
})

test('planner receipt cannot overwrite later manual changes or stale expected revisions', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' })
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(task.id) }]))
  const later = db.updatePlanner({ type: 'check-item', date: '2026-09-21', key: 'calculator', checked: true }, db.getPlanner().revision)
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner(), later)
  assert.equal(db.listOperations()[0].undoneAt, null)
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: task.id, details: detail() }], { expectedRevision: 0 })), conflict)
  assert.deepEqual(db.getPlanner(), later)
})

test('a conflicting later action rolls back the entire planner batch and its receipt', t => {
  const { db } = fixture(t), first = db.createTask({ title: '甲' }), second = db.createTask({ title: '乙' })
  const before = db.getPlanner()
  assert.throws(() => db.applyPlannerOperation(operation(db, [
    { type: 'save-block', block: block(first.id) },
    { type: 'save-block', block: block(second.id, { start: '18:20', end: '19:00' }) },
  ])), conflict)
  assert.deepEqual(db.getPlanner(), before); assert.deepEqual(db.listOperations(), [])
  assert.throws(() => db.transaction(() => {
    db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: first.id, details: detail() }]))
    throw new Error('outer rollback')
  }), /outer rollback/)
  assert.deepEqual(db.getPlanner(), before); assert.deepEqual(db.listOperations(), [])
})

test('a new meeting and chained task moves validate the final layout in every action order', t => {
  const { db, open } = fixture(t)
  const meeting = db.createTask({ title: '会议' })
  const sat = db.createTask({ title: 'SAT', due: '2026-09-21', startAt: new Date('2026-09-21T18:00:00').toISOString(), estimateMin: 60 })
  const math = db.createTask({ title: '数学', due: '2026-09-21', startAt: new Date('2026-09-21T19:00:00').toISOString(), estimateMin: 30 })
  const untouchedTask = db.createTask({ title: '其他安排' })
  const satBefore = block(sat.id, { start: '18:00', end: '19:00' })
  const mathBefore = block(math.id, { start: '19:00', end: '19:30' })
  const untouched = block(untouchedTask.id, { start: '20:30', end: '21:00', locked: true })
  for (const value of [satBefore, mathBefore, untouched]) db.updatePlanner({ type: 'save-block', block: value }, db.getPlanner().revision)
  const taskBefore = db.listTasks(), final = [
    block(meeting.id, { start: '18:00', end: '18:30' }),
    { ...satBefore, start: '18:30', end: '19:30' },
    { ...mathBefore, start: '19:30', end: '20:00' },
  ]
  const second = open()
  for (const order of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const before = db.getPlanner()
    const input = operation(db, order.map(index => ({ type: 'save-block', block: final[index] })))
    const originalInput = structuredClone(input), receipt = db.applyPlannerOperation(input)
    const current = second.getPlanner()
    assert.deepEqual(input, originalInput)
    assert.equal(current.revision, before.revision + 3)
    assert.equal(current.blocks.length, 4)
    for (const expected of [...final, untouched]) assert.deepEqual(current.blocks.find(value => value.id === expected.id), expected)
    assert.deepEqual(db.listTasks(), taskBefore, 'DDL, legacy times and unrelated tasks remain unchanged')
    assert.deepEqual(receipt.plannerBefore, before)
    for (const change of receipt.planChanges) {
      assert.deepEqual(change.before, before.blocks.find(value => value.id === change.id) ?? null)
      assert.deepEqual(change.after, final.find(value => value.id === change.id))
    }
    assert.deepEqual(second.applyPlannerOperation(input), receipt)
    assert.deepEqual(db.getPlanner(), current, 'retry must not perform the batch again')
    second.undoOperation(receipt.id)
    assert.deepEqual(db.getPlanner(), { ...before, revision: current.revision + 1 })
  }
})

test('swapping two time slots can include preparation edits without restoring old startAt occupancy', t => {
  const { db } = fixture(t)
  const first = db.createTask({ title: '甲', startAt: new Date('2026-09-21T18:00:00').toISOString(), estimateMin: 30 })
  const second = db.createTask({ title: '乙', startAt: new Date('2026-09-21T18:30:00').toISOString(), estimateMin: 30 })
  const a = block(first.id, { end: '18:30' }), b = block(second.id, { start: '18:30', end: '19:00' })
  for (const value of [a, b]) db.updatePlanner({ type: 'save-block', block: value }, db.getPlanner().revision)
  const before = db.getPlanner()
  const receipt = db.applyPlannerOperation(operation(db, [
    { type: 'save-block', block: { ...a, start: b.start, end: b.end } },
    { type: 'save-details', taskId: first.id, details: detail() },
    { type: 'save-block', block: { ...b, start: a.start, end: a.end } },
  ]))
  assert.deepEqual(db.getPlanner().blocks, [{ ...a, start: b.start, end: b.end }, { ...b, start: a.start, end: a.end }])
  assert.deepEqual(db.getPlanner().details[first.id], detail())
  assert.equal(db.getPlanner().revision, before.revision + 3)
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 4 })
})

test('an eight-block cycle commits as one layout and retains the normal action bound', t => {
  const { db } = fixture(t)
  const times = ['18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00', '21:30', '22:00']
  const original = times.slice(0, -1).map((start, index) => block(db.createTask({ title: `任务${index + 1}` }).id, { start, end: times[index + 1] }))
  for (const value of original) db.updatePlanner({ type: 'save-block', block: value }, db.getPlanner().revision)
  const before = db.getPlanner(), actions = original.map((value, index) => ({ type: 'save-block', block: { ...value, start: times[(index + 1) % 8], end: times[(index + 1) % 8 + 1] } }))
  const receipt = db.applyPlannerOperation(operation(db, actions))
  assert.deepEqual(db.getPlanner().blocks, actions.map(action => action.block))
  assert.equal(receipt.plannerAfterRevision, before.revision + 8)
  assert.throws(() => db.applyPlannerOperation(operation(db, [...actions, actions[0]])), invalid)
  assert.deepEqual(db.getPlanner().blocks, actions.map(action => action.block))
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 9 })
})

for (const cause of ['batch overlap', 'unrelated block', 'legacy startAt', 'fixed course', 'deadline', 'locked block', 'finished task', 'invalid fields']) {
  test(`final batch rejects ${cause} and rolls back every move, preparation edit and receipt`, t => {
    const { db, open } = fixture(t)
    const meeting = db.createTask({ title: '会议' }), sat = db.createTask({ title: 'SAT' }), math = db.createTask({ title: '数学' })
    const a = block(sat.id, { start: '18:00', end: '19:00' })
    const b = block(math.id, { start: '19:00', end: '19:30', locked: cause === 'locked block' })
    for (const value of [a, b]) db.updatePlanner({ type: 'save-block', block: value }, db.getPlanner().revision)
    const proposed = [block(meeting.id, { start: '18:00', end: '18:30' }), { ...a, start: '18:30', end: '19:30' }, { ...b, start: '19:30', end: '20:00', locked: false }]
    if (cause === 'batch overlap') Object.assign(proposed[2], { start: '19:15', end: '19:45' })
    if (cause === 'unrelated block') {
      const other = db.createTask({ title: '不相关任务' })
      db.updatePlanner({ type: 'save-block', block: block(other.id, { start: '19:45', end: '20:15' }) }, db.getPlanner().revision)
    }
    if (cause === 'legacy startAt') db.createTask({ title: '遗留精确安排', startAt: new Date('2026-09-21T19:45:00').toISOString(), estimateMin: 30 })
    if (cause === 'fixed course') db.updatePlanner({ type: 'save-routine', routine: { id: 'fixed-evening-course', title: '固定课程', kind: 'class', weekdays: [1], start: '19:45', end: '20:15', location: '学校', items: [], enabled: true } }, db.getPlanner().revision)
    if (cause === 'deadline') db.updateTask(sat.id, { due: new Date('2026-09-21T19:15:00').toISOString() })
    if (cause === 'finished task') db.updateTask(math.id, { status: 'done' })
    if (cause === 'invalid fields') proposed[2].unknown = true
    const before = db.getPlanner(), taskBefore = db.listTasks(), second = open()
    const input = operation(db, [{ type: 'save-details', taskId: sat.id, details: detail() }, ...proposed.map(value => ({ type: 'save-block', block: value }))])
    assert.throws(() => db.applyPlannerOperation(input), cause === 'invalid fields' ? invalid : conflict)
    assert.deepEqual(db.getPlanner(), before)
    assert.deepEqual(second.getPlanner(), before)
    assert.deepEqual(db.listTasks(), taskBefore)
    assert.deepEqual(db.listOperations(), [])
  })
}

test('mixed block deletion and replacement uses final occupancy while preserving all remaining placements', t => {
  const { db } = fixture(t), first = db.createTask({ title: '甲' }), second = db.createTask({ title: '乙' })
  const original = block(first.id, { start: '18:00', end: '19:00' })
  const retained = block(second.id, { start: '19:00', end: '19:30' })
  for (const value of [original, retained]) db.updatePlanner({ type: 'save-block', block: value }, db.getPlanner().revision)
  const replacement = block(first.id, { start: '18:30', end: '19:00' }), before = db.getPlanner()
  const receipt = db.applyPlannerOperation(operation(db, [
    { type: 'save-block', block: replacement },
    { type: 'save-details', taskId: first.id, details: detail() },
    { type: 'delete-block', id: original.id },
  ]))
  assert.deepEqual(db.getPlanner().blocks, [retained, replacement])
  assert.deepEqual(receipt.planChanges, [{ id: replacement.id, before: null, after: replacement }, { id: original.id, before: original, after: null }])
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner(), { ...before, revision: before.revision + 4 })
})

test('batch saves validate against a day template applied later in the same transaction', t => {
  const { db } = fixture(t), task = db.createTask({ title: '临时调课冲突' })
  db.updatePlanner({ type: 'save-routine', routine: { id: 'tuesday-class', title: '周二课程', kind: 'class', weekdays: [2], start: '18:00', end: '19:00', location: '', items: [], enabled: true } }, db.getPlanner().revision)
  const before = db.getPlanner()
  assert.throws(() => db.applyPlannerOperation(operation(db, [
    { type: 'save-block', block: block(task.id) },
    { type: 'set-day-template', date: '2026-09-21', sourceWeekday: 2 },
  ])), conflict)
  assert.deepEqual(db.getPlanner(), before)
  assert.deepEqual(db.listOperations(), [])
})

test('a concurrent planner edit blocks a stale batch and cannot be erased by retry or undo', t => {
  const { db, open } = fixture(t), first = db.createTask({ title: '甲' }), second = db.createTask({ title: '乙' })
  const a = block(first.id, { end: '18:30' }), b = block(second.id, { start: '18:30', end: '19:00' })
  for (const value of [a, b]) db.updatePlanner({ type: 'save-block', block: value }, db.getPlanner().revision)
  const input = operation(db, [{ type: 'save-block', block: { ...a, start: b.start, end: b.end } }, { type: 'save-block', block: { ...b, start: a.start, end: a.end } }])
  const other = open()
  const edited = other.updatePlanner({ type: 'check-item', date: '2026-09-21', key: 'calculator', checked: true }, other.getPlanner().revision)
  assert.throws(() => db.applyPlannerOperation(input), conflict)
  assert.deepEqual(db.getPlanner(), edited)
  assert.deepEqual(db.listOperations(), [])
  const freshInput = { ...input, expectedRevision: edited.revision }, receipt = db.applyPlannerOperation(freshInput)
  const later = other.updatePlanner({ type: 'check-item', date: '2026-09-21', key: 'book', checked: true }, other.getPlanner().revision)
  assert.deepEqual(db.applyPlannerOperation(freshInput), receipt)
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner(), later)
  assert.equal(db.listOperations()[0].undoneAt, null)
})

test('retracted turns cannot schedule new planner operations and existing receipts remain explicitly undoable', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' }), input = request()
  db.beginTurn(input)
  const planned = operation(db, [{ type: 'save-block', block: block(task.id) }], { requestId: input.requestId })
  const receipt = db.applyPlannerOperation(planned)
  db.retractRequest(input)
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: task.id, details: detail() }], { requestId: input.requestId })), conflict)
  assert.throws(() => db.applyPlannerOperation(planned), conflict)
  assert.equal(db.getPlanner().blocks.length, 1)
  db.undoOperation(receipt.id)
  assert.deepEqual(db.getPlanner().blocks, [])
})

test('undo refuses to restore task references deleted after their block was removed', t => {
  const { db } = fixture(t), task = db.createTask({ title: '删除任务' }), proposed = block(task.id)
  db.updatePlanner({ type: 'save-block', block: proposed }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: proposed.id }]))
  const revision = db.getPlanner().revision
  db.deleteTask(task.id)
  // No planner reference remains to clean, so revision alone cannot detect this.
  assert.equal(db.getPlanner().revision, revision)
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner().blocks, [])
  assert.equal(db.listOperations()[0].undoneAt, null)
})

test('completed tasks continue occupying recorded blocks and legacy slots; dropped tasks release them', t => {
  const { db } = fixture(t), first = db.createTask({ title: '已完成' }), second = db.createTask({ title: '待开始' }), proposed = block(first.id)
  db.updatePlanner({ type: 'save-block', block: proposed }, 0)
  db.updateTask(first.id, { status: 'done' })
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id) }])), conflict)
  db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: first.id, details: detail({ submittedAt: '2026-09-19T00:00:00Z' }) }]))
  assert.equal(db.getPlanner().details[first.id].submittedAt, '2026-09-19T00:00:00.000Z')
  db.updateTask(first.id, { status: 'dropped' })
  db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id) }]))
  const legacy = db.createTask({ title: '做完的旧安排', status: 'done', startAt: new Date('2026-09-21T20:00:00').toISOString(), estimateMin: 60 })
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id, { start: '20:20', end: '20:40' }) }])), conflict)
  db.updateTask(legacy.id, { status: 'dropped' })
  db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: block(second.id, { start: '20:20', end: '20:40' }) }]))
})

test('AI planner accepts only bounded permitted actions and preserves locked blocks', t => {
  const { db } = fixture(t), task = db.createTask({ title: '报告' }), locked = block(task.id, { locked: true })
  db.updatePlanner({ type: 'save-block', block: locked }, 0)
  const before = db.getPlanner()
  for (const actions of [[], Array(9).fill({ type: 'save-details', taskId: task.id, details: detail() }), [{ type: 'import-routines', routines: [] }], [{ type: 'check-item', date: '2026-09-21', key: 'book', checked: true }]]) {
    assert.throws(() => db.applyPlannerOperation(operation(db, actions)), invalid)
  }
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: locked.id }])), conflict)
  assert.throws(() => db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: { ...locked, locked: false } }])), conflict)
  assert.deepEqual(db.getPlanner(), before); assert.deepEqual(db.listOperations(), [])
})

for (const association of ['block', 'details']) {
  test(`undoing AI task creation preserves a user's later planner ${association} and the entire task batch`, t => {
    const { db } = fixture(t)
    const shape = db.createTask({ title: 'shape only' })
    db.deleteTask(shape.id)
    const tasks = ['one', 'two'].map(title => ({ ...shape, id: randomUUID(), title, deletedAt: null }))
    const receipt = db.applyOperation({ id: randomUUID(), requestId: randomUUID(), summary: '创建两件事项',
      changes: tasks.map(task => ({ table: 'tasks', id: task.id, before: null, after: task })) })
    db.updatePlanner(association === 'block'
      ? { type: 'save-block', block: block(tasks[0].id, { locked: true }) }
      : { type: 'save-details', taskId: tasks[0].id, details: detail() }, 0)
    const before = db.getPlanner()
    assert.throws(() => db.undoOperation(receipt.id), conflict)
    assert.deepEqual(db.getPlanner(), before)
    for (const task of tasks) assert.deepEqual(db.getTask(task.id), task)
    assert.equal(db.listOperations()[0].undoneAt, null)
  })
}

for (const due of ['2026-09-20', new Date('2026-09-21T18:34:00').toISOString()]) {
  test(`undoing a removed block rechecks the task's later deadline (${due})`, t => {
    const { db } = fixture(t), task = db.createTask({ title: '截止修改', due: '2026-09-22' }), proposed = block(task.id)
    db.updatePlanner({ type: 'save-block', block: proposed }, 0)
    const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: proposed.id }]))
    db.updateTask(task.id, { due })
    const before = db.getPlanner()
    assert.throws(() => db.undoOperation(receipt.id), error => conflict(error) && /截止时间/u.test(error.message))
    assert.deepEqual(db.getPlanner(), before)
    assert.equal(db.listOperations()[0].undoneAt, null)
  })
}

test('undoing a moved block rejects a later precise task occupying its old position', t => {
  const { db } = fixture(t), task = db.createTask({ title: '被挪动的任务' }), other = db.createTask({ title: '后来安排' }), original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'save-block', block: { ...original, start: '19:00', end: '19:35' } }]))
  db.updateTask(other.id, { startAt: new Date('2026-09-21T18:20:00').toISOString(), estimateMin: 60 })
  const before = db.getPlanner()
  assert.throws(() => db.undoOperation(receipt.id), error => conflict(error) && /开始时间/u.test(error.message))
  assert.deepEqual(db.getPlanner(), before)
  assert.equal(db.listOperations()[0].undoneAt, null)
})

test('undo restores valid completed history and uses final explicit blocks instead of superseded legacy start times', t => {
  const { db } = fixture(t), task = db.createTask({ title: '已完成历史', due: '2026-09-21' }), other = db.createTask({ title: '另有明确安排' })
  const original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  db.updatePlanner({ type: 'save-block', block: block(other.id, { start: '20:00', end: '20:35' }) }, 1)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: original.id }]))
  db.updateTask(task.id, { status: 'done' })
  db.updateTask(other.id, { startAt: new Date('2026-09-21T18:20:00').toISOString(), estimateMin: 60 })
  assert.ok(db.undoOperation(receipt.id).undoneAt)
  assert.deepEqual(db.getPlanner().blocks.find(item => item.id === original.id), original)
  assert.equal(db.getTask(task.id).status, 'done')
})

test('undo of preparation alone preserves unchanged history even if the task subsequently has a deadline conflict', t => {
  const { db } = fixture(t), task = db.createTask({ title: '既有历史', due: '2026-09-22' }), original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'save-details', taskId: task.id, details: detail() }]))
  db.updateTask(task.id, { due: '2026-09-20' })
  assert.ok(db.undoOperation(receipt.id).undoneAt)
  assert.deepEqual(db.getPlanner().blocks, [original])
  assert.deepEqual(db.getPlanner().details, {})
})

test('undo cannot restore time after a later fixed course edit and leaves that course intact', t => {
  const { db } = fixture(t), task = db.createTask({ title: '课表后来修改' }), original = block(task.id)
  db.updatePlanner({ type: 'save-block', block: original }, 0)
  const receipt = db.applyPlannerOperation(operation(db, [{ type: 'delete-block', id: original.id }]))
  db.updatePlanner({ type: 'save-routine', routine: { id: 'late-course', title: '新增课程', kind: 'class', weekdays: [1], start: '18:00', end: '19:00', location: '学校', items: [], enabled: true } }, 2)
  const before = db.getPlanner()
  assert.throws(() => db.undoOperation(receipt.id), conflict)
  assert.deepEqual(db.getPlanner(), before)
})
