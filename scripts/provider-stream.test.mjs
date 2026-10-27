import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { createCompletion } from '../server/provider.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { getModelSettings, saveModelSettings } from '../server/modelSettings.mjs'
import { localDay } from '../src/home/agenda.ts'
import { finishArguments } from './fixtures/model-receipt.mjs'

process.env.TZ = 'Asia/Shanghai'
const vault = { read: async () => 'sk-FAKE-stream-tests-only', status: async () => true }
const encoder = new TextEncoder()
const chunk = (delta = {}, finish_reason = null) => ({ choices: [{ index: 0, delta, finish_reason }] })
const event = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\r\n\r\n`
const frames = values => `: keep-alive\r\n\r\n${values.map(event).join('')}`
function bytesResponse(raw, { fragment = true } = {}) {
  const bytes = encoder.encode(raw)
  let at = 0, index = 0
  return new Response(new ReadableStream({ pull(controller) {
    if (at === bytes.length) { controller.close(); return }
    const size = fragment ? [1, 2, 5, 3, 7][index++ % 5] : bytes.length
    controller.enqueue(bytes.slice(at, at += Math.min(size, bytes.length - at)))
  } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
const sse = values => bytesResponse(frames(values))
const final = (text = '已保存。', reasoning = ' \n完成核对。\t ') => sse([
  chunk({ reasoning_content: reasoning }), chunk({ content: text }), chunk({}, 'stop'), '[DONE]',
])
const toolFrames = (name, args, { id = randomUUID(), reasoning = ' \n先执行，再汇报。\t ', finish = 'tool_calls', done = true } = {}) => {
  const arg = JSON.stringify(args), nameAt = Math.max(1, Math.floor(name.length / 2)), argAt = Math.floor(arg.length / 2)
  return [chunk({ reasoning_content: reasoning }),
    chunk({ tool_calls: [{ index: 0, id, type: 'function', function: { name: name.slice(0, nameAt), arguments: arg.slice(0, argAt) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: name.slice(nameAt), arguments: arg.slice(argAt) } }] }),
    ...(finish ? [chunk({}, finish)] : []), ...(done ? ['[DONE]'] : [])]
}
const input = (text = '只记录物理作业') => ({ requestId: randomUUID(), conversationId: 'main', text, context: { timezone: 'Asia/Shanghai' } })
const parseSSE = raw => raw.split(/\r?\n\r?\n/u).filter(frame => frame.startsWith('data: ')).map(frame => JSON.parse(frame.slice(6)))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }

async function serviceFixture(t) {
  const db = createDatabase(':memory:'), responses = [], upstream = []
  const fetcher = async (url, options) => {
    upstream.push({ url, body: JSON.parse(options.body) })
    const next = responses.shift()
    if (!next) throw new Error('No fake provider response available')
    return typeof next === 'function' ? next(upstream.at(-1)) : next
  }
  const service = createLocalService({ db, vault, fetcher, dataDirectory: '/tmp/astaria-stream-tests-memory' })
  const server = createServer((req, res) => service.middleware(req, res, () => { res.statusCode = 404; res.end() }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); service.close() })
  const request = (path, body, accept = 'application/json') => fetch(`${base}/api${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'X-Astaria-Local': '1', Origin: base, Accept: accept, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const chat = async value => {
    const response = await request('/chat', value, 'text/event-stream'), raw = await response.text()
    return { response, raw, events: parseSSE(raw) }
  }
  return { db, responses, upstream, request, chat }
}

test('SSE reassembles split UTF-8, exact reasoning and interleaved tool argument/name fragments', async () => {
  const emitted = [], requests = [], reasoning = ' \n逐项核对：物理🪐\t ', arguments1 = JSON.stringify({ tasks: [{ title: '物理🪐作业', estimateMin: 20 }] })
  const values = [chunk({ reasoning_content: ' \n逐项' }), chunk({ reasoning_content: '核对：物理🪐\t ' }),
    chunk({ content: '先核对。' }),
    chunk({ tool_calls: [{ index: 1, id: 'read-2', type: 'function', function: { name: 'read_', arguments: '{"task' } },
      { index: 0, id: 'write-1', type: 'function', function: { name: 'create_', arguments: arguments1.slice(0, 15) } }] }),
    chunk({ tool_calls: [{ index: 0, function: { name: 'tasks', arguments: arguments1.slice(15) } },
      { index: 1, function: { name: 'tasks', arguments: 'Id":"physics"}' } }] }),
    chunk({}, 'tool_calls'), { choices: [], usage: { prompt_tokens: 20, completion_tokens: 30 } }, '[DONE]']
  const complete = createCompletion(vault, async (_url, options) => { requests.push(JSON.parse(options.body)); return sse(values) })
  const result = await complete({ messages: [{ role: 'user', content: '创建物理🪐作业' }] }, { onDelta: delta => emitted.push(delta) })
  const message = result.choices[0].message
  assert.equal(requests[0].stream, true)
  assert.equal(message.reasoning_content, reasoning)
  assert.equal(message.content, '先核对。')
  assert.deepEqual(message.tool_calls, [
    { id: 'write-1', type: 'function', function: { name: 'create_tasks', arguments: arguments1 } },
    { id: 'read-2', type: 'function', function: { name: 'read_tasks', arguments: '{"taskId":"physics"}' } },
  ])
  assert.equal(emitted.filter(item => item.type === 'reasoning').map(item => item.delta).join(''), reasoning)
  assert.equal(emitted.filter(item => item.type === 'content').map(item => item.delta).join(''), '先核对。')
  assert.ok(emitted.every(item => ['content', 'reasoning'].includes(item.type)), 'tool arguments stay private until complete')
  assert.deepEqual(result.usage, { prompt_tokens: 20, completion_tokens: 30 })
})

test('streaming output estimates grow before a provider usage frame arrives', async () => {
  const reports = []
  const complete = createCompletion(vault, async () => sse([
    chunk({ reasoning_content: '先核对当前日程。' }), chunk({ content: '已经保存好了。' }), chunk({}, 'stop'), '[DONE]',
  ]))
  await complete({ messages: [{ role: 'user', content: '记录活动' }] }, { onDelta() {}, onContextUsage: usage => reports.push(usage) })
  assert.equal(reports[0].outputTokens, 0)
  assert.ok(reports.at(-1).outputTokens > 0)
  assert.equal(reports.at(-1).source, 'estimate')
})

test('reasoning updates the meter while the stream is still open, then official usage replaces it', async () => {
  const reports = [], firstOutput = deferred(), gate = {}
  const complete = createCompletion(vault, async () => new Response(new ReadableStream({ start(controller) {
    gate.controller = controller
    controller.enqueue(encoder.encode(frames([chunk({ reasoning_content: '正在核对已有时间。' })])))
  } }), { headers: { 'content-type': 'text/event-stream' } }))
  const running = complete({ messages: [{ role: 'user', content: '核对时间' }] }, {
    onDelta() {}, onContextUsage(usage) { reports.push(usage); if (usage.outputTokens > 0) firstOutput.resolve() },
  })
  await firstOutput.promise
  assert.equal(reports.at(-1).source, 'estimate')
  assert.ok(reports.at(-1).outputTokens > 0)
  gate.controller.enqueue(encoder.encode(frames([chunk({ content: '已核对。' }), chunk({}, 'stop'),
    { choices: [], usage: { prompt_tokens: 123, completion_tokens: 45 } }, '[DONE]'])))
  gate.controller.close()
  await running
  assert.equal(reports.at(-1).source, 'provider')
  assert.equal(reports.at(-1).outputTokens, 45)
  assert.equal(reports.at(-1).usedTokens, 168)
})

test('a failed follow-up cannot replace saved tool-round output with its zero preflight estimate', async t => {
  const f = await serviceFixture(t)
  f.responses.push(sse([...toolFrames('create_tasks', { tasks: [{ title: '隔离用量核验' }] }).slice(0, -1),
    { choices: [], usage: { prompt_tokens: 234, completion_tokens: 67 } }, '[DONE]']),
    new Response('unavailable', { status: 503 }))
  const response = await f.chat(input('只记录隔离用量核验'))
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(response.events.at(-1).result.execution.reply.mode, 'fallback')
  const saved = await (await f.request('/conversation?id=main')).json()
  assert.equal(saved.contextUsage.outputTokens, 67)
  assert.equal(saved.contextUsage.source, 'provider')
})

test('an interrupted stream retains measured output even without a final usage frame', async t => {
  const f = await serviceFixture(t)
  f.responses.push(sse([chunk({ reasoning_content: '已有的推理输出，需要保留用量。' })]))
  await f.chat(input('解释当前时间'))
  const saved = await (await f.request('/conversation?id=main')).json()
  assert.equal(saved.contextUsage.source, 'estimate')
  assert.ok(saved.contextUsage.outputTokens > 0)
})

test('malformed tool fragment fields are rejected instead of being silently coerced to strings', async () => {
  for (const patch of [{ id: 12 }, { type: false }, { function: null }, { function: [] }, { function: { name: 0 } },
    { function: { arguments: { tasks: [] } } }, { function: { arguments: false } }]) {
    const complete = createCompletion(vault, async () => sse([
      chunk({ tool_calls: [{ index: 0, id: 'malformed', type: 'function', function: { name: 'create_tasks', arguments: '' }, ...patch }] }),
      chunk({}, 'tool_calls'), '[DONE]',
    ]))
    await assert.rejects(complete({ messages: [{ role: 'user', content: '测试' }] }, { onDelta() {} }), /流式回复中断/u)
  }
})

for (const interruption of ['eof', 'length', 'aborted', 'insufficient_system_resource', 'content_filter', 'missing-finish', 'broken-json', 'overwritten-finish']) test(`incomplete stream ${interruption} never executes accumulated tools`, async t => {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  const values = toolFrames('create_tasks', { tasks: [{ title: '绝不能提前执行' }] }, {
    done: interruption !== 'eof', finish: interruption === 'missing-finish' ? null : ['length', 'aborted', 'insufficient_system_resource', 'content_filter'].includes(interruption) ? interruption : 'tool_calls',
  })
  const raw = interruption === 'broken-json' ? frames(values.slice(0, 3)) + 'data: {not-json}\n\n'
    : interruption === 'overwritten-finish' ? frames([...values.slice(0, 3), chunk({}, 'length'), chunk({}, 'tool_calls'), '[DONE]']) : frames(values)
  const complete = createCompletion(vault, async () => bytesResponse(raw))
  const xixi = createXixi({ db, complete }), deltas = []
  const result = await xixi.chat(input(), { onEvent: event => deltas.push(event) })
  assert.equal(result.status, 'failed')
  assert.equal(db.listTasks().length, 0)
  assert.equal(db.listOperations().length, 0)
  assert.ok(!deltas.some(event => event.phase === 'executing'))
  const reason = { length: '长度上限', aborted: '停止了生成', insufficient_system_resource: '资源不足', content_filter: '内容过滤' }[interruption]
  if (reason) assert.ok(result.error.includes(reason), 'the saved failure explains the actual terminal reason')
})

test('stream setting off returns JSON end to end and never requests upstream SSE', async t => {
  const f = await serviceFixture(t)
  saveModelSettings(f.db, { ...getModelSettings(f.db), streamResponses: false })
  f.responses.push(new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '完整回复', reasoning_content: '原样思考' }, finish_reason: 'stop' }] }),
    { headers: { 'content-type': 'application/json' } }))
  const response = await f.request('/chat', input('普通聊一句'), 'text/event-stream')
  assert.match(response.headers.get('content-type'), /application\/json/u)
  const result = await response.json()
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.at(-1).content, '完整回复')
  assert.equal(f.upstream[0].body.stream, false)
})

test('prose streamed before remember survives the tool round, final response and reload', async t => {
  const f=await serviceFixture(t)
  f.responses.push(sse([chunk({content:'这段分析应该一直保留。'}),...toolFrames('remember',{
    content:'喜欢温柔的交流',evidence:'我喜欢你温柔点',scope:'global',kind:'preference',
  })]),final('偏好也记下了。'))
  const request=input('我喜欢你温柔点')
  const response=await f.chat(request)
  const result=response.events.findLast(event=>event.type==='result').result
  assert.equal(result.status,'completed')
  assert.equal(f.db.listMemories().length,1)
  const prose=result.messages.filter(message=>message.role==='assistant').map(message=>message.content)
  assert.deepEqual(prose,['这段分析应该一直保留。','偏好也记下了。'])
  assert.ok(result.messages.every(message=>!message.toolCalls),'raw tool arguments stay private')
  const restored=await(await f.request('/conversation?id=main')).json()
  assert.deepEqual(restored.messages.filter(message=>message.role==='assistant').map(message=>message.content),prose)
})

for (const effort of ['low', 'high', 'max']) for (const streaming of [true, false]) test(`normal chat preserves ${effort} thinking without an 1800-token ceiling (stream=${streaming})`, async t => {
  const f = await serviceFixture(t)
  saveModelSettings(f.db, { ...getModelSettings(f.db), reasoningEffort: effort, streamResponses: streaming })
  f.responses.push(({ body }) => {
    assert.equal(body.thinking.type, 'enabled')
    assert.equal(body.reasoning_effort, effort)
    assert.equal(Object.hasOwn(body, 'max_tokens'), false, 'a reply-only budget must not truncate the reasoning before its final answer')
    return streaming ? final('今天的安排已经核对。') : Response.json({ choices: [{ message: { role: 'assistant', content: '今天的安排已经核对。', reasoning_content: '完整思考' }, finish_reason: 'stop' }] })
  })
  const response = await f.request('/chat', input('帮我理理今天干什么'), 'text/event-stream')
  const result = streaming ? parseSSE(await response.text()).at(-1).result : await response.json()
  assert.equal(result.status, 'completed')
  assert.equal(result.messages.at(-1).content, '今天的安排已经核对。')
  assert.equal(getModelSettings(f.db).reasoningEffort, effort)
})

test('service streams phases and final durable state, while same request id replay never repeats writes', async t => {
  const f = await serviceFixture(t), request = input(), think = ' \n记录真实任务。\t '
  f.responses.push(sse(toolFrames('create_tasks', { tasks: [{ title: '物理课前三题', estimateMin: 30 }] }, { reasoning: think })), final('已经记录物理课前三题。'))
  const first = await f.chat(request)
  assert.match(first.response.headers.get('content-type'), /text\/event-stream/u)
  for (const phase of ['thinking', 'executing', 'replying']) assert.ok(first.events.some(event => event.type === 'phase' && event.phase === phase))
  const result = first.events.at(-1).result
  assert.equal(first.events.at(-1).type, 'result')
  assert.equal(result.status, 'completed')
  assert.equal(f.db.listTasks().length, 1)
  assert.ok(f.upstream.length >= 2 && f.upstream.every(request => !Object.hasOwn(request.body, 'max_tokens')), 'tool and final-response rounds both preserve the thinking budget')
  assert.equal(result.operations.length, 1)
  assert.equal(result.operations[0].createdTasks[0].id, f.db.listTasks()[0].id)
  assert.equal(result.messages.at(-1).content, '已经记录物理课前三题。')
  assert.ok(result.messages.at(-1).reasoningContent.startsWith(think))
  const stored = f.db.listMessages('main', { limit: 100 }).filter(message => message.role === 'assistant')
  assert.equal(stored[0].reasoningContent, think)
  const fromGET = await (await f.request('/conversation?id=main')).json()
  assert.deepEqual(result.messages, fromGET.messages)
  const count = f.upstream.length, repeat = await f.chat(request)
  assert.equal(f.upstream.length, count)
  assert.deepEqual(repeat.events.map(event => event.type), ['result'])
  assert.equal(repeat.events[0].result.operations[0].id, result.operations[0].id)
  assert.equal(f.db.listTasks().length, 1)
})

test('retry after an interrupted scheduling stream continues the saved task instead of duplicating it', async t => {
  const f = await serviceFixture(t), tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
  const date = localDay(tomorrow)
  f.db.updatePlanner({ type: 'save-routine', routine: { id: 'test-evening', title: '晚自习', kind: 'available', weekdays: [0, 1, 2, 3, 4, 5, 6],
    start: '18:00', end: '20:00', location: '', items: [], enabled: true } }, f.db.getPlanner().revision)
  const request = input(`${date} 18:00–18:30 做物理作业，创建并排进去`)
  f.responses.push(sse(toolFrames('create_tasks', { tasks: [{ title: '物理作业', estimateMin: 30, startAt: date }] })),
    sse(toolFrames('read_planner', { date }, { done: false })))
  const failed = (await f.chat(request)).events.at(-1).result
  assert.equal(failed.status, 'failed')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.getPlanner().blocks.length, 0)
  const taskId = f.db.listTasks()[0].id
  f.responses.push(sse(toolFrames('read_planner', { date })), () => sse(toolFrames('plan_tasks', { expectedRevision: f.db.getPlanner().revision,
    plans: [{ taskId, date, start: '18:00', end: '18:30' }] })), ({ body }) => sse(toolFrames('finish_response',
    finishArguments(body, '已经排入明天18:00。', '明晚18:00–18:30 是真实空档，所以把物理作业放在这一段。'))))
  const done = (await f.chat(request)).events.at(-1).result
  assert.equal(done.status, 'completed')
  assert.equal(f.db.listTasks().length, 1)
  assert.equal(f.db.getPlanner().blocks.length, 1)
  assert.equal(f.db.getPlanner().blocks[0].taskId, taskId)
  assert.equal(f.db.listMessages('main', { limit: 100 }).filter(message => message.role === 'user').length, 1)
})

test('retracting an active stream suppresses later text and reasoning and prevents pending tool writes', async t => {
  const f = await serviceFixture(t), started = deferred(), request = input(), gate = {}
  f.responses.push(() => new Response(new ReadableStream({ start(controller) {
    gate.controller = controller
    controller.enqueue(encoder.encode(frames([chunk({ reasoning_content: '撤回前的思考' })])))
    started.resolve()
  } }), { headers: { 'content-type': 'text/event-stream' } }))
  const running = f.chat(request)
  await started.promise
  const retraction = await (await f.request('/messages/retract', { requestId: request.requestId, conversationId: 'main' })).json()
  assert.ok(retraction)
  gate.controller.enqueue(encoder.encode(frames([chunk({ reasoning_content: 'LATE_PRIVATE_REASONING' }), chunk({ content: 'LATE_PRIVATE_TEXT' }),
    ...toolFrames('create_tasks', { tasks: [{ title: '不应该落地' }] }, { reasoning: 'LATE_PRIVATE_REASONING' })])))
  gate.controller.close()
  const finished = await running
  assert.ok(!finished.raw.includes('LATE_PRIVATE'))
  assert.equal(finished.events.at(-1).result.status, 'failed')
  assert.equal(f.db.listTasks().length, 0)
  assert.equal(f.db.listMessages('main', { limit: 100 }).filter(message => message.role === 'assistant').length, 0)
})

for (const removal of ['history-source', 'conversation']) test(`removing ${removal} stops later stream disclosure before the provider finishes`, async t => {
  const f = await serviceFixture(t), started = deferred(), request = input('接着刚才的话继续'), gate = {}
  const source = f.db.appendMessage({ conversationId: 'main', role: 'user', content: '这是稍后会撤回的背景。' })
  if (removal === 'conversation') f.db.createConversation()
  f.responses.push(() => new Response(new ReadableStream({ start(controller) {
    gate.controller = controller
    controller.enqueue(encoder.encode(frames([chunk({ reasoning_content: '背景仍然有效时的思考' })])))
    started.resolve()
  } }), { headers: { 'content-type': 'text/event-stream' } }))
  const running = f.chat(request)
  await started.promise
  if (removal === 'history-source') f.db.retractMessage(source.id)
  else f.db.deleteConversation('main')
  gate.controller.enqueue(encoder.encode(frames([chunk({ reasoning_content: 'AFTER_REMOVAL_THOUGHT' }),
    chunk({ content: 'AFTER_REMOVAL_TEXT' }), chunk({}, 'stop'), '[DONE]'])))
  gate.controller.close()
  const finished = await running
  assert.ok(!finished.raw.includes('AFTER_REMOVAL'), 'provenance removal must stop provisional content, not only final persistence')
  assert.equal(f.db.listTasks().length, 0)
  if (removal === 'history-source') assert.equal(finished.events.at(-1).result.status, 'failed')
  else assert.ok(finished.events.some(event => event.type === 'error'))
})

test('conversation context meter streams, survives reload and resets on a new topic or model switch', async t => {
  const f=await serviceFixture(t)
  f.responses.push(sse([chunk({content:'已核对。'}),chunk({},'stop'),{choices:[],usage:{prompt_tokens:125000,completion_tokens:500}},'[DONE]']))
  const request=input('解释一下如何比较日程和空档')
  const response=await f.chat(request)
  const measurements=response.events.filter(event=>event.type==='context-usage')
  assert.equal(measurements[0].usage.source,'estimate')
  assert.equal(measurements.at(-1).usage.usedTokens,125500)
  assert.equal(f.upstream[0].body.stream_options.include_usage,true)
  const saved=await (await f.request('/conversation?id=main')).json()
  assert.equal(saved.contextUsage.usedTokens,125500)
  const fresh=await (await f.request('/conversations',{})).json()
  assert.equal(fresh.contextUsage,null)
  saveModelSettings(f.db,{...getModelSettings(f.db),cloudModel:'deepseek-v4-pro'})
  assert.equal((await (await f.request('/conversation?id=main')).json()).contextUsage,null)
  saveModelSettings(f.db,{...getModelSettings(f.db),cloudModel:'deepseek-flash'})
  f.db.retractMessage(f.db.getTurn(request.requestId).userMessageId)
  assert.equal((await (await f.request('/conversation?id=main')).json()).contextUsage,null)
})

test('unlimited context keeps history beyond 160 and 1000 messages and the meter measures the growing dispatch', async t => {
  const f = await serviceFixture(t)
  saveModelSettings(f.db, { ...getModelSettings(f.db), contextBudget: { mode: 'off', maxUnits: 48000 } })
  const ids = []
  for (let i = 0; i < 605; i++) {
    const requestId = randomUUID()
    ids.push(f.db.appendMessage({ conversationId: 'main', requestId, role: 'user', content: `history-${i}` }).id)
    f.db.appendMessage({ conversationId: 'main', requestId, role: 'assistant', content: `answer-${i}` })
  }
  f.db.retractMessage(ids[3])
  const { contextUnits } = await import('../server/contextBudget.mjs')
  const respond = ({ body }) => {
    assert.ok(body.messages.some(message => message.content === 'history-0'))
    assert.ok(body.messages.some(message => message.content === 'answer-604'))
    assert.equal(body.messages.some(message => message.content === 'history-3'), false)
    return sse([chunk({ content: '已看完' }), chunk({}, 'stop'),
      { choices: [], usage: { prompt_tokens: contextUnits(body), completion_tokens: 20 } }, '[DONE]'])
  }
  f.responses.push(respond, respond)
  const first = await f.chat(input('接着聊这段内容'))
  const firstUsage = first.events.filter(e => e.type === 'context-usage').at(-1).usage
  const second = await f.chat(input('再补充一段信息。'.repeat(200)))
  const secondUsage = second.events.filter(e => e.type === 'context-usage').at(-1).usage
  assert.equal(f.upstream.length, 2, 'no summary request added while application limits are off')
  assert.ok(secondUsage.usedTokens > firstUsage.usedTokens)
  assert.equal(secondUsage.inputTokens, contextUnits(f.upstream[1].body))
  assert.equal(f.upstream[1].body.messages.filter(m => m.content === 'history-0').length, 1)
  const saved = await (await f.request('/conversation?id=main')).json()
  assert.deepEqual(saved.contextUsage, secondUsage)
})
