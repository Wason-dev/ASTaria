import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkOrder } from '../server/workOrder.mjs'

const input = { requestId: 'event-request', conversationId: 'chat', userMessageId: 'msg' }
const event = (patch = {}) => ({ id: 'anniversary', title: '校庆', date: '2026-09-23', start: '17:00', end: '20:00', ...patch })
const order = () => createWorkOrder(input)
const committed = () => {
  const value = order()
  value.commit(value.step('save', 'save_day_events'), { id: 'event-write', summary: '保存校庆' })
  return value
}

test('event receipts verify their exact saved identity, title, date and times against live state', () => {
  const value = committed(), original = event()
  value.expectEvents([original])
  original.start = '16:00'
  assert.equal(value.value.eventRequirements[0].start, '17:00', 'requirements do not keep caller references')
  assert.equal(value.verify(), 'partial')
  value.checkEvents([event()])
  assert.equal(value.verify(), 'verified')
  for (const live of [[], [event({ id: 'another' })], [event({ title: '别的活动' })], [event({ date: '2026-09-24' })],
    [event({ start: '17:30' })], [event({ end: '19:30' })]]) {
    value.checkEvents(live)
    assert.equal(value.value.eventRequirements[0].status, 'pending')
    assert.equal(value.verify(), 'partial', 'a concurrent deletion or edit invalidates the saved receipt')
    value.checkEvents([event()])
    assert.equal(value.verify(), 'verified')
  }
  value.checkEvents([event({ location: '礼堂', items: ['水杯'] })])
  assert.equal(value.verify(), 'verified')
})

test('each event needs its own live match and missing events fail without a commit', () => {
  const value = order(), second = event({ id: 'evening-class', title: '课程', start: '20:15', end: '21:15' })
  value.expectEvents([event(), second])
  value.checkEvents([event()])
  assert.equal(value.verify(), 'failed')
  assert.deepEqual(value.value.eventRequirements.map(item => item.status), ['verified', 'pending'])
  value.checkEvents([event(), second])
  assert.equal(value.verify(), 'completed')
})

test('event and task obligations remain independent even when identities and time ranges match', () => {
  const value = committed(), fixed = event(), task = { id: fixed.id, title: fixed.title, status: 'todo' }
  const block = { id: 'planned', taskId: task.id, date: fixed.date, start: fixed.start, end: fixed.end }
  value.expectEvents([fixed])
  value.expectSchedule(task.id, 180, '任务仍需安排', { slot: { date: fixed.date, start: fixed.start, end: fixed.end }, mustComplete: true })
  value.checkEvents([fixed]); value.checkScheduleBlocks([], [task], fixed.date)
  assert.equal(value.value.scheduleRequirements[0].status, 'pending')
  assert.equal(value.verify(), 'partial')
  value.checkEvents([]); value.checkScheduleBlocks([block], [task], fixed.date)
  assert.equal(value.value.eventRequirements[0].status, 'pending')
  assert.equal(value.verify(), 'partial')
  value.checkEvents([fixed])
  assert.equal(value.verify(), 'verified')
})

test('a later explicit edit updates the event goal without duplicate obligations', () => {
  const value = committed()
  value.expectEvents([event()]); value.checkEvents([event()])
  value.expectEvents([event({ date: '2026-09-24', start: '16:00', title: '校庆调整' })])
  assert.equal(value.value.eventRequirements.length, 1)
  value.checkEvents([event()])
  assert.equal(value.verify(), 'partial')
  value.checkEvents([event({ date: '2026-09-24', start: '16:00', title: '校庆调整' })])
  assert.equal(value.verify(), 'verified')
})

test('undo cancellation survives checks, old receipt replay and persisted work-order resume', () => {
  const value = committed()
  value.expectEvents([event()]); value.checkEvents([event()]); value.cancelEvent(event().id)
  value.checkEvents([]); value.expectEvents([event()])
  assert.equal(value.value.eventRequirements[0].status, 'cancelled')
  assert.equal(value.verify(), 'verified')
  const restarted = createWorkOrder(input, { progress: value.snapshot() })
  restarted.resume(); restarted.checkEvents([]); restarted.expectEvents([event()])
  assert.equal(restarted.value.eventRequirements[0].status, 'cancelled')
  assert.equal(restarted.verify(), 'verified')
})

test('persisted live event obligations recheck after restart and legacy work orders remain valid', () => {
  const value = committed()
  value.expectEvents([event()]); value.checkEvents([event()])
  const restarted = createWorkOrder(input, { progress: value.snapshot() })
  restarted.resume(); restarted.checkEvents([])
  assert.equal(restarted.verify(), 'partial')
  restarted.checkEvents([event()])
  assert.equal(restarted.verify(), 'verified')
  const legacy = committed(), restored = createWorkOrder(input, { progress: legacy.snapshot() })
  assert.equal(restored.value.eventRequirements, undefined)
  restored.checkEvents([]); restored.cancelEvent('missing')
  assert.equal(restored.verify(), 'verified')
})
