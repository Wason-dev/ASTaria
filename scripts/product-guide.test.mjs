import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, XIXI_TOOLS } from '../server/xixi.mjs'
import { getModelSettings, saveModelSettings } from '../server/modelSettings.mjs'
import { getPreferences, savePreferences } from '../server/preferences.mjs'
import { TASK_RECEIPT_CAPABILITIES } from '../src/domain/receiptCapabilities.ts'
import { DEADLINE_TIME_SHORTCUTS, deadlineShortcuts } from '../src/xixi/deadlineShortcuts.ts'
import { ESTIMATE_SHORTCUTS, parseReceiptEstimate } from '../src/xixi/receiptTaskSettings.ts'

const facts = request => JSON.parse(request.messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n'))
function fixture(t, tool = false) {
  const db = createDatabase(':memory:')
  t.after(() => db.close())
  const requests = []
  const xixi = createXixi({ db, now: () => new Date('2026-09-23T15:35:00+08:00'), complete: async request => {
    requests.push(request)
    return { choices: [{ message: tool && requests.length === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'read-product-facts', type: 'function', function: {
        name: typeof tool === 'string' ? 'read_product_guide' : 'read_tasks',
        arguments: typeof tool === 'string' ? JSON.stringify({ section: tool }) : '{}',
      } }] }
      : { role: 'assistant', content: '测试回复' } }] }
  } })
  return { db, requests, chat: () => xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '看看这个事项', context: { page: 'home', timezone: 'Asia/Shanghai' } }) }
}

test('every tool round receives the shipped product map with only registered assistant tools', async t => {
  const f = fixture(t, true)
  await f.chat()
  assert.equal(f.requests.length, 2)
  const available = new Set(XIXI_TOOLS.map(tool => tool.function.name))
  for (const request of f.requests) {
    const { productGuide, uiCapabilities } = facts(request)
    assert.deepEqual(Object.values(productGuide.pages).map(page => page.name), ['首页', '工作台', '日程', '余时', '弦轨', '设置'])
    for (const page of Object.values(productGuide.pages)) for (const name of page.tools) assert.ok(available.has(name), name)
    assert.deepEqual(productGuide.pages.strings.tools, [], 'dragging and committing strings is a user interface action')
    assert.match(productGuide.records.plan, /不删除事项或DDL/)
    assert.match(productGuide.pages['free-time'].behavior, /已有时段保留/)
    assert.deepEqual(uiCapabilities.taskCreationReceipt, TASK_RECEIPT_CAPABILITIES)
  }
})

test('the assistant receives the same DDL and estimate options as the actual receipt controls', async t => {
  const f = fixture(t)
  await f.chat()
  const { deadline, estimate, saving } = facts(f.requests[0]).uiCapabilities.taskCreationReceipt
  assert.deepEqual(deadline.dateShortcuts, deadlineShortcuts(new Date(2026, 8, 23)).map(item => item.label))
  assert.deepEqual(deadline.timeShortcuts, DEADLINE_TIME_SHORTCUTS)
  assert.deepEqual(estimate.minuteShortcuts, ESTIMATE_SHORTCUTS)
  assert.equal(parseReceiptEstimate(String(estimate.customMin)), estimate.customMin)
  assert.equal(parseReceiptEstimate(String(estimate.customMax)), estimate.customMax)
  assert.equal(saving.requiresChat, false)
  assert.equal(saving.updatesExistingTask, true)
  assert.equal(saving.reschedulesCalendar, false)
})

test('a later message sees current user settings and task edits without leaking connection details', async t => {
  const f = fixture(t)
  const task = f.db.createTask({ title: 'business作业' })
  await f.chat()
  f.db.updateTask(task.id, { due: '2026-09-24', estimateMin: 45 })
  const model = getModelSettings(f.db)
  saveModelSettings(f.db, { ...model, reasoningEffort: 'max', streamResponses: false, contextBudget: { mode: 'off', maxUnits: 96000 },
    local: { ...model.local, baseUrl: 'http://127.0.0.1:12345/v1' } })
  const preferences = getPreferences(f.db)
  savePreferences(f.db, { expected: preferences, value: { ...preferences, focus: { focusMin: 40, restMin: 10 }, assistant: { ...preferences.assistant, personality: 'medium' } } })
  await f.chat()
  const context = facts(f.requests.at(-1))
  assert.equal(context.tasks.find(item => item.id === task.id).estimateMin, 45)
  assert.equal(context.tasks.find(item => item.id === task.id).due, '2026-09-24')
  assert.equal(f.db.listTasks().length, 1)
  assert.deepEqual(context.applicationSettings.focus, { focusMin: 40, restMin: 10 })
  assert.equal(context.assistantPreferences.personality, 'medium')
  assert.equal(context.applicationSettings.model.reasoningEffort, 'max')
  assert.equal(context.applicationSettings.model.streamResponses, false)
  assert.deepEqual(context.applicationSettings.model.contextBudget, { mode: 'off', applicationLimit: null })
  assert.doesNotMatch(JSON.stringify(context.applicationSettings), /baseUrl|apiKey|127\.0\.0\.1/)
})

test('small local contexts retain live tasks and can read complete product chapters from the compact index', async t => {
  const f = fixture(t, 'settings')
  f.db.setPreference('model-connection', { provider: 'local' })
  f.db.setPreference('app', { assistant: { autonomy: 'propose', useMemory: false, useHistory: false } })
  for (let index = 0; index < 20; index++) f.db.createTask({ title: `保留当前任务${index}`, estimateMin: 20 })
  await f.chat()
  const context = facts(f.requests[0])
  assert.equal(context.productGuide.compact, true)
  assert.equal(context.productGuide.readMore.tool, 'read_product_guide')
  assert.equal(context.tasks.length, 20)
  assert.equal(context.applicationSettings.model.provider, 'local')
  const result = JSON.parse(f.requests[1].messages.findLast(message => message.role === 'tool').content)
  assert.equal(result.section, 'settings')
  assert.equal(result.content.name, '设置')
  assert.match(result.content.userControls, /流式输出和上下文预算/)
  assert.equal(f.db.listTasks().length, 20)
  assert.equal(f.db.getPlanner().blocks.length, 0)
})
