import test from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { createThinkingProgress } from '../server/thinkingProgress.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createDatabase } from '../server/database.mjs'
import { randomUUID } from 'node:crypto'

const reasoning = 'I am comparing the available calendar slots with the requested duration and checking whether any existing courses overlap. '
const response = title => ({ choices: [{ message: { content: JSON.stringify({ title }) } }] })
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
function fixture(overrides = {}) {
  const requests = [], events = [], reply = deferred(), budget = { remaining: 4, inFlight: false }
  const progress = createThinkingProgress({ complete: (payload, options) => { requests.push({ payload, options }); return reply.promise },
    emit: event => events.push(event), round: 2, budget, delayMs: 1, intervalMs: 1, timeoutMs: 1000, ...overrides })
  return { requests, events, reply, budget, ...progress }
}

test('unmarked thinking gets a bounded independent title without tools or transcript mutation', async t => {
  const f = fixture(); t.after(f.stop)
  f.reasoning(reasoning.repeat(40))
  await delay(10)
  assert.equal(f.requests.length, 1)
  const { payload, options } = f.requests[0]
  assert.equal(options.purpose, 'thinking-summary')
  assert.equal(payload.tools, undefined)
  assert.equal(payload.max_tokens, 96)
  assert.equal(payload.messages[1].content.length, 2400)
  f.reply.resolve(response('核对课程与可用时间'))
  await delay(5)
  assert.deepEqual(f.events, [{ type: 'thinking-title', round: 2, title: '核对课程与可用时间' }])
})

test('fast replies and explicit progress markers make no summary requests', async () => {
  const quick = fixture(); quick.reasoning(reasoning); quick.stop()
  const marked = fixture(); marked.reasoning(`【进度】核对课程\n${reasoning}`)
  await delay(10)
  marked.stop()
  assert.equal(quick.requests.length + marked.requests.length, 0)
})

for (const reason of ['reply', 'abort', 'retraction', 'timeout']) test(`${reason} discards a late title and cancels optional work`, async t => {
  const abort = new AbortController()
  let active = true
  const f = fixture({ signal: abort.signal, isActive: () => active, timeoutMs: reason === 'timeout' ? 15 : 1000 }); t.after(f.stop)
  f.reasoning(reasoning); await delay(8)
  assert.equal(f.requests.length, 1)
  if (reason === 'reply') f.stop()
  if (reason === 'abort') abort.abort()
  if (reason === 'retraction') active = false
  if (reason === 'timeout') await delay(25)
  f.reply.resolve(response('核对课程与可用时间')); await delay(5)
  assert.deepEqual(f.events, [])
  if (reason !== 'retraction') assert.equal(f.requests[0].options.signal.aborted, true)
})

test('summary failures are silent and requests stay within turn and round budgets', async t => {
  const budget = { remaining: 3, inFlight: false }, requests = [], events = []
  const options = { budget, delayMs: 1, intervalMs: 1, complete: async () => { requests.push(1); throw new Error('Unavailable') }, emit: event => events.push(event) }
  const first = createThinkingProgress({ ...options, round: 1 }); t.after(first.stop)
  for (let i = 0; i < 4; i++) { first.reasoning(reasoning.repeat(7)); await delay(8) }
  assert.equal(requests.length, 2)
  first.stop()
  const second = createThinkingProgress({ ...options, round: 2 }); t.after(second.stop)
  for (let i = 0; i < 3; i++) { second.reasoning(reasoning.repeat(7)); await delay(8) }
  assert.equal(requests.length, 3)
  assert.deepEqual(events, [])
})

test('actual chat emits a generated title without waiting for it to finish the main response', { timeout: 5000 }, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const answer = deferred(), summary = deferred(), events = [], purposes = []
  const xixi = createXixi({ db, complete: async (_payload, options) => {
    purposes.push(options?.purpose ?? 'chat')
    if (options?.purpose === 'thinking-summary') return summary.promise
    options?.onDelta?.({ type: 'reasoning', delta: reasoning })
    return answer.promise
  } })
  const result = xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '解释一下如何比较课程与空档', context: { timezone: 'Asia/Shanghai' } }, { onEvent: event => events.push(event) })
  await delay(430)
  assert.deepEqual(purposes, ['chat', 'thinking-summary'])
  summary.resolve(response('比较课程与可用空档'))
  await delay(10)
  assert(events.some(event => event.type === 'thinking-title' && event.title === '比较课程与可用空档'))
  answer.resolve({ choices: [{ message: { content: '可以按课程结束时间核对空档。', reasoning_content: reasoning } }] })
  assert.equal((await result).status, 'completed')
  const saved = db.listMessages('main').find(message => message.role === 'assistant')
  assert.equal(saved.reasoningContent, reasoning)
  assert(!JSON.stringify(saved).includes('比较课程与可用空档'))
})

test('actual chat completes even when the optional summarizer never resolves', { timeout: 5000 }, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  let summarySignal
  const xixi = createXixi({ db, complete: async (_payload, options) => {
    if (options?.purpose === 'thinking-summary') { summarySignal = options.signal; return new Promise(() => {}) }
    options?.onDelta?.({ type: 'reasoning', delta: reasoning })
    await delay(430)
    options?.onDelta?.({ type: 'content', delta: '回复已到达。' })
    return { choices: [{ message: { content: '回复已到达。', reasoning_content: reasoning } }] }
  } })
  const events = []
  const result = await xixi.chat({ requestId: randomUUID(), conversationId: 'main', text: '解释一下如何比较课程与空档', context: { timezone: 'Asia/Shanghai' } }, { onEvent: event => events.push(event) })
  assert.equal(result.status, 'completed')
  assert.equal(summarySignal?.aborted, true)
  assert(!events.some(event => event.type === 'thinking-title'))
})
