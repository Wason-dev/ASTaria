import test from 'node:test'
import assert from 'node:assert/strict'
import { freeTimeCompletionAction, isFreeTimeSessionTask, planBlockCompleted, taskDayCompletion } from '../src/planner/completion.ts'

const DAY = '2026-09-28', TOMORROW = '2026-09-29', COMPLETED = '2026-09-28T01:30:00.000Z'
const task = (patch = {}) => ({ id: 'goal-task', title: '阅读', freeTimeGoalId: 'reading', status: 'todo', ...patch })
const block = (id, date = DAY, taskId = 'goal-task') => ({ id, taskId, date, start: '09:00', end: '09:30', locked: false })
const state = (blocks, completedFreeTimeSessions) => ({ blocks, completedFreeTimeSessions })

test('a goal completed on one date remains incomplete on its other scheduled dates', () => {
  const today = block('today'), tomorrow = block('tomorrow', TOMORROW)
  const planner = state([today, tomorrow], { today: COMPLETED })
  assert.equal(planBlockCompleted(task(), planner, today), true)
  assert.equal(planBlockCompleted(task(), planner, tomorrow), false)
  assert.deepEqual(taskDayCompletion(task(), planner, DAY), { done: true, label: '本日已完成' })
  assert.deepEqual(taskDayCompletion(task(), planner, TOMORROW), { done: false, label: '' })
})

test('a daily goal card is only complete when every session that day is complete', () => {
  const first = block('first'), second = { ...block('second'), start: '10:00', end: '10:30' }
  const planner = state([first, second, block('later', TOMORROW), block('other', DAY, 'another-task')], { first: COMPLETED, other: COMPLETED, later: COMPLETED })
  assert.deepEqual(taskDayCompletion(task(), planner, DAY), { done: false, label: '已完成 1/2 次' })
  const complete = { ...planner, completedFreeTimeSessions: { ...planner.completedFreeTimeSessions, second: COMPLETED } }
  assert.deepEqual(taskDayCompletion(task(), complete, DAY), { done: true, label: '本日已完成' })
  assert.equal(planBlockCompleted(task(), complete, first), true)
  assert.equal(planBlockCompleted(task(), complete, second), true)
})

test('ordinary tasks continue using their whole-task completion status', () => {
  const ordinary = task({ freeTimeGoalId: undefined }), session = block('first')
  const planner = state([session], { first: COMPLETED })
  assert.equal(planBlockCompleted(ordinary, planner, session), false)
  assert.deepEqual(taskDayCompletion(ordinary, planner, DAY), { done: false, label: '' })
  assert.equal(planBlockCompleted({ ...ordinary, status: 'done' }, planner, session), true)
  assert.deepEqual(taskDayCompletion({ ...ordinary, status: 'done' }, planner, TOMORROW), { done: true, label: '已完成' })
  assert.equal(freeTimeCompletionAction(ordinary, planner, session.id), null)
})

test('missing completion state or missing saved sessions never count as completed', () => {
  const session = block('first'), planner = state([session])
  assert.equal(planBlockCompleted(task(), planner, session), false)
  assert.equal(planBlockCompleted(task(), planner), false)
  assert.equal(planBlockCompleted(undefined, planner, session), false)
  assert.deepEqual(taskDayCompletion(task(), planner, DAY), { done: false, label: '' })
  assert.deepEqual(taskDayCompletion(task(), planner, TOMORROW), { done: false, label: '' })
  assert.deepEqual(taskDayCompletion(task(), state([], { orphan: COMPLETED }), DAY), { done: false, label: '' })
})

test('completion actions target the selected persisted session and reopening checks its completion version', () => {
  const planner = state([block('first'), block('second')], { first: COMPLETED })
  assert.deepEqual(freeTimeCompletionAction(task(), planner, 'first'), {
    path: '/companion/free-time/reopen', input: { sessionId: 'first', expectedCompletedAt: COMPLETED }, completed: true,
  })
  assert.deepEqual(freeTimeCompletionAction(task(), planner, 'second'), {
    path: '/companion/free-time/complete', input: { sessionId: 'second', expectedSession: { taskId: 'goal-task', date: '2026-09-28', start: '09:00', end: '09:30' } }, completed: false,
  })
  assert.equal(freeTimeCompletionAction(task(), planner, 'unsaved-draft'), null)
  assert.equal(freeTimeCompletionAction(task(), planner), null)
  assert.equal(freeTimeCompletionAction(task({ id: 'different-task' }), planner, 'first'), null)
  assert.equal(planBlockCompleted(task({ id: 'different-task' }), planner, planner.blocks[0]), false)
})

test('object prototype names and non-string completion records do not complete sessions', () => {
  for (const id of ['constructor', 'toString', '__proto__', 'custom']) {
    const session = block(id)
    for (const history of [{}, { [id]: true }, { [id]: {} }, Object.create({ [id]: COMPLETED })]) {
      const planner = state([session], history)
      assert.equal(planBlockCompleted(task(), planner, session), false, id)
      assert.equal(taskDayCompletion(task(), planner, DAY).done, false, id)
      assert.deepEqual(freeTimeCompletionAction(task(), planner, id), {
        path: '/companion/free-time/complete', input: { sessionId: id, expectedSession: { taskId: 'goal-task', date: '2026-09-28', start: '09:00', end: '09:30' } }, completed: false,
      })
    }
    const valid = state([session], { [id]: COMPLETED })
    assert.equal(planBlockCompleted(task(), valid, session), true)
  }
})

test('legacy finished or dropped backing tasks keep their task-level path without implicit restoration', () => {
  const session = block('first'), planner = state([session], { first: COMPLETED })
  for (const status of ['done', 'dropped']) {
    const previous = task({ status })
    assert.equal(isFreeTimeSessionTask(previous), false)
    assert.equal(freeTimeCompletionAction(previous, planner, session.id), null)
    assert.equal(planBlockCompleted(previous, planner, session), status === 'done')
  }
  assert.equal(isFreeTimeSessionTask(task({ status: 'doing' })), true)
})

test('day-clipped overnight blocks retain their original session completion identity', () => {
  const original = { ...block('overnight'), start: '23:30', end: '00:30' }
  const clipped = { ...original, date: TOMORROW, start: '00:00' }
  const planner = state([original], { overnight: COMPLETED })
  assert.equal(planBlockCompleted(task(), planner, clipped), true)
  assert.deepEqual(taskDayCompletion(task(), planner, TOMORROW, [clipped]), { done: true, label: '本日已完成' })
})

test('completion projections and actions do not mutate task or block data or copy read-only fields into writes', () => {
  const selected = task(), planner = state([block('first')], { first: COMPLETED })
  const before = structuredClone({ selected, planner })
  const action = freeTimeCompletionAction(selected, planner, 'first')
  taskDayCompletion(selected, planner, DAY)
  planBlockCompleted(selected, planner, planner.blocks[0])
  assert.deepEqual({ selected, planner }, before)
  assert.deepEqual(Object.keys(action.input).sort(), ['expectedCompletedAt', 'sessionId'])
  assert.equal(selected.status, 'todo')
})
