import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkOrder } from '../server/workOrder.mjs'

test('an occurrence verifies requested minutes independently of a later estimate edit', () => {
  const order = createWorkOrder({ requestId: 'repeat-edit', conversationId: 'chat', userMessageId: 'msg' })
  order.expectSchedule('sat', 20, '每天20分钟', { date: '2026-09-22' })
  const task = { id: 'sat', status: 'todo', estimateMin: 45, occurrence: { seriesId: 'sat-week', date: '2026-09-22' } }
  const block = { id: 'sat-slot', taskId: 'sat', date: '2026-09-22', start: '19:40', end: '20:00' }
  order.checkScheduleBlocks([block], [task], '2026-09-22')
  assert.equal(order.value.scheduleRequirements[0].status, 'verified')
  order.checkScheduleBlocks([{ ...block, end: '19:50' }], [task], '2026-09-22')
  assert.equal(order.value.scheduleRequirements[0].status, 'pending')
  order.checkScheduleBlocks([{ ...block, end: '19:50' }, { ...block, id: 'split', start: '19:50' }], [task], '2026-09-22')
  assert.equal(order.value.scheduleRequirements[0].status, 'pending')
})

test('a work order records commits separately from the reply channel', () => {
  const order = createWorkOrder({ requestId: 'req', conversationId: 'chat', userMessageId: 'msg' })
  const step = order.step('call-1', 'create_tasks')
  order.commit(step, { id: 'op-1', summary: '创建事项' })
  assert.equal(order.verify(), 'verified')
  order.finishReply('fallback')
  assert.equal(order.value.status, 'verified')
  assert.equal(order.value.reply.mode, 'fallback')
  assert.equal(order.value.commits[0].operationId, 'op-1')
})

test('a failed required step remains partial and cannot be acknowledged as verified', () => {
  const order = createWorkOrder({ requestId: 'req-2', conversationId: 'chat', userMessageId: 'msg-2' })
  const first = order.step('call-1', 'create_tasks')
  order.commit(first, { id: 'op-2', summary: '创建事项' })
  const second = order.step('call-2', 'plan_tasks')
  order.fail(second, '日历窗口未读')
  assert.equal(order.verify(), 'partial')
  assert.equal(order.value.reply.mode, 'pending')
  assert.equal(order.value.failures.length, 1)
})

test('an interrupted step and bounded execution remain incomplete after a commit', () => {
  const input = { requestId: 'req-3', conversationId: 'chat', userMessageId: 'msg-3' }
  const order = createWorkOrder(input)
  order.commit(order.step('write', 'create_tasks'), { id: 'op-3', summary: '创建事项' })
  order.step('read', 'read_planner')
  const resumed = createWorkOrder(input, { progress: order.snapshot() })
  assert.equal(resumed.verify(), 'partial')
  resumed.succeed(resumed.step('read', 'read_planner'))
  resumed.pending('工具轮次达到上限，后续步骤未核验')
  assert.equal(resumed.verify(), 'partial')
  resumed.clearPending()
  assert.equal(resumed.verify(), 'verified')
})

test('retrying a failed step retains one failure and clears it after success', () => {
  const order = createWorkOrder({ requestId: 'req-4', conversationId: 'chat', userMessageId: 'msg-4' })
  const step = order.step('read', 'read_planner')
  order.fail(step, '读取失败')
  order.fail(step, '再次读取失败')
  assert.equal(order.value.failures.length, 1)
  order.succeed(step)
  assert.equal(order.verify(), 'completed')
  assert.equal(order.value.failures.length, 0)
})

test('starting a retry cannot erase an interrupted execution before it resumes successfully', () => {
  const input = { requestId: 'req-5', conversationId: 'chat', userMessageId: 'msg-5' }
  const order = createWorkOrder(input)
  order.commit(order.step('write', 'create_tasks'), { id: 'op-5', summary: '创建事项' })
  order.interrupt('工具轮次达到上限，后续步骤未核验')
  const retry = createWorkOrder(input, { progress: order.snapshot() })
  retry.resume()
  assert.equal(retry.verify(), 'partial')
  retry.clearInterruption()
  assert.equal(retry.verify(), 'verified')
})

test('scheduling one task does not complete another task or an insufficient partial allocation', () => {
  const order = createWorkOrder({ requestId: 'req-6', conversationId: 'chat', userMessageId: 'msg-6' })
  order.commit(order.step('write', 'create_tasks'), { id: 'op-6', summary: '创建事项' })
  order.expectSchedule('report', 60, '报告还剩40分钟未安排')
  order.checkSchedules(new Map([['other-task', 60], ['report', 20]]))
  order.clearPending()
  assert.equal(order.verify(), 'partial')
  order.checkSchedules(new Map([['report', 60]]))
  assert.equal(order.verify(), 'verified')
})

test('saved plan receipts cannot reduce an existing 60 minute obligation to a 20 minute allocation', () => {
  const order = createWorkOrder({ requestId: 'req-7', conversationId: 'chat', userMessageId: 'msg-7' })
  order.commit(order.step('write', 'create_tasks'), { id: 'op-7', summary: '创建报告' })
  order.expectSchedule('report', 60, '报告还剩40分钟未安排')
  const task = { id: 'report', title: '报告', estimateMin: 60, status: 'todo' }
  const first = { id: 'first-block', taskId: task.id, date: '2026-09-19', start: '18:00', end: '18:20' }
  order.expectPlans([first])
  order.checkScheduleBlocks([first], [task], '2026-09-18')
  assert.equal(order.verify(), 'partial')
  assert.equal(order.value.scheduleRequirements[0].minutes, 60)
  assert.equal(order.value.scheduleRequirements[0].status, 'pending')
  const remaining = { id: 'remaining-block', taskId: task.id, date: '2026-09-19', start: '18:20', end: '19:00' }
  order.expectPlans([remaining])
  order.checkScheduleBlocks([first, remaining], [task], '2026-09-18')
  assert.equal(order.verify(), 'verified')
  assert.equal(order.value.scheduleRequirements[0].status, 'verified')
})
