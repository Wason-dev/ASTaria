import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi, HARD_INPUT_UNITS } from '../server/xixi.mjs'
import { contextUnits } from '../server/contextBudget.mjs'
import { getModelSettings, saveModelSettings, validateContextBudget, resolveContextBudget } from '../server/modelSettings.mjs'

const input = text => ({ requestId: randomUUID(), conversationId: 'budget-test', text, context: { timezone: 'Asia/Shanghai' } })
const reply = content => ({ choices: [{ message: { role: 'assistant', content, reasoning_content: '' } }] })

test('budget settings migrate, validate, persist and survive backup without altering Max', t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const legacy = getModelSettings(db)
  assert.deepEqual(legacy.contextBudget, { mode: 'auto', maxUnits: 48000 })
  assert.deepEqual(resolveContextBudget({ provider: 'local' }), { enabled: true, soft: 16000, hard: 24000, turns: 4 })
  assert.equal(resolveContextBudget({}).hard, 48000)
  for (const setting of [{ mode: 'off', maxUnits: 128000 }, { mode: 'custom', maxUnits: 128000 }, { mode: 'auto', maxUnits: 128000 }]) {
    const saved = saveModelSettings(db, { ...legacy, contextBudget: setting })
    assert.deepEqual(getModelSettings(db).contextBudget, setting)
    assert.equal(saved.reasoningEffort, 'max')
    const restored = createDatabase(':memory:')
    try { restored.importData(db.exportData()); assert.deepEqual(getModelSettings(restored).contextBudget, setting) } finally { restored.close() }
  }
  for (const value of [null, false, { mode: 'bad' }, { mode: 'custom', maxUnits: 0 }, { mode: 'custom', maxUnits: 7999 }, { mode: 'custom', maxUnits: 8001 }, { mode: 'custom', maxUnits: 2049000 }, { mode: 'custom', maxUnits: '48000' }, { mode: 'off', extra: true }]) {
    assert.throws(() => validateContextBudget(value))
  }
  assert.equal(resolveContextBudget({ contextBudget: { mode: 'off' } }).hard, Infinity)
  assert.equal(resolveContextBudget({ contextBudget: { mode: 'custom', maxUnits: 128000 } }).hard, 128000)
})

for (const mode of ['auto', 'custom', 'off']) test(`${mode} budget changes dispatch behavior rather than only the saved label`, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  saveModelSettings(db, { ...getModelSettings(db), contextBudget: { mode, maxUnits: 128000 } })
  const old = input('之前讨论的任务资料'), turn = db.beginTurn(old)
  const thought = '旧思考'.repeat(16000)
  const final = db.appendMessage({ conversationId: old.conversationId, requestId: old.requestId, role: 'assistant', content: '以前核对过资料。', reasoningContent: thought })
  db.finishTurn(old.requestId, { status: 'completed' })
  let sent
  const xixi = createXixi({ db, complete: async request => { sent = request; return reply('当前请求正常完成。') } })
  assert.equal((await xixi.chat(input('继续'))).status, 'completed')
  const archived = sent.messages.some(message => message.content?.startsWith('已归档的历史回合'))
  assert.equal(archived, mode === 'auto')
  if (mode !== 'auto') {
    assert.equal(sent.messages.find(message => message.content === final.content)?.reasoning_content, thought)
    assert.ok(contextUnits(sent.messages) + contextUnits(sent.tools) > HARD_INPUT_UNITS)
  }
  assert.equal(db.getMessage(final.id).reasoningContent, thought)
  assert.ok(sent.messages.some(message => message.content === db.getMessage(turn.userMessageId).content))
})

test('disabled budget passes a long current thinking/tool chain intact and skips automatic summaries', async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  saveModelSettings(db, { ...getModelSettings(db), contextBudget: { mode: 'off', maxUnits: 48000 } })
  // Enough historical turns to trigger summarizing in automatic mode.
  for (let n = 0; n < 12; n++) {
    const old = input(`历史请求${n}`)
    db.beginTurn(old)
    db.appendMessage({ conversationId: old.conversationId, requestId: old.requestId, role: 'assistant', content: `历史回复${n}`, reasoningContent: `思考${n}` })
    db.finishTurn(old.requestId, { status: 'completed' })
  }
  const current = input('核对资料'), requests = []
  const thought = '反复检查当前资料。'.repeat(8000)
  const tool = { id: 'budget-off-read', type: 'function', function: { name: 'read_tasks', arguments: '{}' } }
  const xixi = createXixi({ db, complete: async request => {
    requests.push(structuredClone(request))
    return requests.length === 1 ? { choices: [{ message: { role: 'assistant', content: '', reasoning_content: thought, tool_calls: [tool] } }] } : reply('已经读取。')
  } })
  assert.equal((await xixi.chat(current)).status, 'completed')
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.response_format === undefined))
  assert.equal(db.getSummary(current.conversationId), null)
  assert.ok(requests[0].messages.some(message => message.content === '历史请求0'))
  assert.ok(contextUnits(requests[1].messages) + contextUnits(requests[1].tools) > HARD_INPUT_UNITS)
  assert.equal(requests[1].messages.find(message => message.tool_calls)?.reasoning_content, thought)
  const stored = db.listMessages(current.conversationId, { limit: 160 }).find(message => message.toolCallId === tool.id)
  assert.equal(requests[1].messages.find(message => message.tool_call_id === tool.id).content, stored.content)
})
