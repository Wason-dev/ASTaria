import assert from 'node:assert/strict'
import { registerHooks, stripTypeScriptTypes } from 'node:module'
import test from 'node:test'

const root = new URL('../src/xixi/', import.meta.url).href
const hook = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(root) && specifier.startsWith('.') && !specifier.endsWith('.ts')) return nextResolve(`${specifier}.ts`, context)
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.startsWith(root) && url.endsWith('.ts')) return { ...result, format: 'module', source: stripTypeScriptTypes(String(result.source), { mode: 'transform' }) }
    return result
  },
})
const { readChatStream, advanceChatStream, restoreChatReasoning, reasoningHeadline, chatThinkingHeadline } = await import('../src/xixi/stream.ts')
const { chatApi, LocalApiError } = await import('../src/xixi/api.ts')
hook.deregister()

const result = { requestId: 'request-one', conversationId: 'main', status: 'completed', messages: [], operations: [] }
const frame = (event, newline = '\n') => `data: ${JSON.stringify(event)}${newline}${newline}`
const encode = text => new TextEncoder().encode(text)
const streamFrom = chunks => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk); controller.close() } })
const draft = () => ({ requestId: 'request-one', conversationId: 'main', round: -1, content: '', reasoningContent: '', phase: 'thinking' })

test('generated titles survive SSE parsing, stay in their round, and disappear on content or execution', async () => {
  let current = advanceChatStream(draft(), { type: 'round', round: 1 })
  await readChatStream(streamFrom([frame({ type: 'thinking-title', round: 1, title: '核对课程与可用时间' }), frame({ type: 'result', result })]), event => { current = advanceChatStream(current, event) })
  assert.equal(chatThinkingHeadline(current), '核对课程与可用时间')
  current = advanceChatStream(current, { type: 'content', round: 1, delta: '答' })
  current = advanceChatStream(current, { type: 'thinking-title', round: 1, title: '迟到的标题' })
  assert.equal(chatThinkingHeadline(current), null)
  current = advanceChatStream(current, { type: 'round', round: 2 })
  current = advanceChatStream(current, { type: 'thinking-title', round: 1, title: '旧轮次标题' })
  assert.equal(chatThinkingHeadline(current), null, 'earlier visible prose remains visible during a following tool round')
  current = advanceChatStream(current, { type: 'thinking-title', round: 2, title: '继续核对课程' })
  current = advanceChatStream(current, { type: 'phase', phase: 'executing' })
  assert.equal(current.thinkingTitle, undefined)
  assert.equal(chatThinkingHeadline(current), null)
})

test('thinking titles accept complete marked lines without leaking ordinary or partial reasoning', () => {
  for (const text of ['', 'The user says: "我要看你的思考小标题" — I want to see your', '【进度】核对', '【进度】\n', '【进度】' + '长'.repeat(25) + '\n', '正文中引用【进度】不是标题\n']) {
    assert.equal(reasoningHeadline(text), '正在思考')
  }
  assert.equal(reasoningHeadline('【进度】核对课程与空档\n完整思考正文'), '核对课程与空档')
  assert.equal(reasoningHeadline('【进度】读取日程\r\n正文\n【进度】检查重叠\n更多正文'), '检查重叠')
  assert.equal(reasoningHeadline('【进度】读取日程\n正文\n【进度】核对'), '读取日程')
})

test('thinking titles follow current rounds and disappear with the first reply token', () => {
  let current = advanceChatStream(draft(), { type: 'reasoning', round: 1, delta: '【进度】读取日程\n内部思考' })
  assert.equal(chatThinkingHeadline(current), '读取日程')
  current = advanceChatStream(current, { type: 'content', round: 1, delta: '好' })
  assert.equal(chatThinkingHeadline(current), null)
  assert.equal(chatThinkingHeadline({ ...current, phase: 'thinking' }), null, 'even an out-of-order phase cannot restore a title over reply text')
  current = advanceChatStream(current, { type: 'round', round: 2 })
  assert.equal(chatThinkingHeadline(current), null, 'a new round keeps earlier reply text visible')
  current = advanceChatStream(current, { type: 'reasoning', round: 2, delta: '【进度】检查重叠\n新一轮思考' })
  assert.equal(chatThinkingHeadline(current), null, 'titles do not reappear above retained reply text')
  assert.equal(chatThinkingHeadline({ ...current, phase: 'executing' }), null)
  assert.equal(chatThinkingHeadline({ ...current, phase: 'replying' }), null)
})

test('SSE preserves UTF-8 and CRLF boundaries even when every byte arrives separately', async () => {
  const events = [
    { type: 'round', round: 1 }, { type: 'reasoning', round: 1, delta: '先检查空课 🌌' },
    { type: 'phase', phase: 'replying' }, { type: 'content', round: 1, delta: '今天有两项事项' }, { type: 'result', result },
  ]
  const bytes = encode(': heartbeat\r\n\r\n' + events.map(event => frame(event, '\r\n')).join(''))
  const received = []
  assert.deepEqual(await readChatStream(streamFrom([...bytes].map(byte => Uint8Array.of(byte))), event => received.push(event)), result)
  assert.deepEqual(received, events)
})

test('multiple data lines and many events in one chunk decode correctly without exposing tools', async () => {
  const multiline = 'data: {"type":"content",\ndata: "round":1,"delta":"回复"}\n\n'
  const unknown = frame({ type: 'tool', arguments: 'never render this' })
  const received = []
  await readChatStream(streamFrom([unknown + multiline + frame({ type: 'result', result })]), event => received.push(event))
  assert.deepEqual(received.map(event => event.type), ['content', 'result'])
  assert.equal(received[0].delta, '回复')
})

test('source metadata streams outside prose, survives rounds, and validates the final persisted message', async () => {
  const source = { url: 'https://github.com/fixture/repo', title: 'https://github.com/fixture/repo', fetchStatus: 'failed', fetchedAt: '2026-10-12T00:00:00.000Z' }
  const received = []
  let current = draft()
  const final = { ...result, messages: [{ id: 'reply', role: 'assistant', content: '仓库未能打开，可以贴出 README。', sources: [source] }] }
  const events = [{ type: 'sources', sources: [source, source] }, { type: 'round', round: 2 }, { type: 'content', round: 2, delta: final.messages[0].content }, { type: 'result', result: final }]
  assert.deepEqual(await readChatStream(streamFrom(events.map(event => frame(event))), event => { received.push(event); current = advanceChatStream(current, event) }), final)
  assert.deepEqual(current.sources, [source])
  assert.equal(current.content, final.messages[0].content)
  assert.deepEqual(received[0], { type: 'sources', sources: [source] })
  for (const sources of [[{ ...source, content: 'page body must never enter this event' }], Array(7).fill(source), [{ ...source, fetchStatus: 'verified' }], [{ ...source, fetchedAt: 'yesterday' }]]) {
    await assert.rejects(readChatStream(streamFrom([frame({ type: 'sources', sources })]), () => {}), /连接已中断/u)
    await assert.rejects(readChatStream(streamFrom([frame({ type: 'result', result: { ...final, messages: [{ ...final.messages[0], sources }] } })]), () => {}), /连接已中断/u)
  }
})

test('end of transport without a complete result is never accepted as completion', async () => {
  const received = []
  await assert.rejects(readChatStream(streamFrom([frame({ type: 'content', round: 1, delta: '已为你创建' })]), event => received.push(event)), /连接已中断/)
  assert.deepEqual(received.map(event => event.type), ['content'])
  await assert.rejects(readChatStream(streamFrom([`data: ${JSON.stringify({ type: 'result', result })}`]), () => {}), /连接已中断/)
  await assert.rejects(readChatStream(streamFrom([frame({ type: 'result', result: { content: 'not durable state' } })]), () => {}), /连接已中断/)
})

test('server errors and broken JSON clear the transport instead of manufacturing a reply', async () => {
  await assert.rejects(readChatStream(streamFrom([frame({ type: 'error', error: '模型连接失败' })]), () => {}), /模型连接失败/)
  await assert.rejects(readChatStream(streamFrom(['data: {broken}\n\n']), () => {}), /连接已中断/)
  const broken = new ReadableStream({ start(controller) { controller.error(new TypeError('terminated')) } })
  await assert.rejects(readChatStream(broken, () => {}), /连接已中断/)
})

test('abort cancels an idle reader and never emits an old result', async () => {
  let cancelled = false
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const controller = new AbortController()
  const received = []
  const pending = readChatStream(body, event => received.push(event), controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(cancelled, true)
  assert.deepEqual(received, [])
})

test('a new tool round preserves earlier thoughts and prose and appends the following reply', () => {
  let current = advanceChatStream(draft(), { type: 'round', round: 1 })
  current = advanceChatStream(current, { type: 'reasoning', round: 1, delta: '先检查' })
  current = advanceChatStream(current, { type: 'content', round: 1, delta: '准备安排' })
  assert.equal(current.reasoningContent, '先检查')
  assert.equal(current.phase, 'replying')
  current = advanceChatStream(current, { type: 'phase', phase: 'executing' })
  assert.equal(current.phase, 'executing')
  current = advanceChatStream(current, { type: 'round', round: 2 })
  assert.equal(current.content, '准备安排')
  assert.equal(current.reasoningContent, '先检查')
  assert.deepEqual(current.reasoningRounds, [{ id: 'live:1', round: 1, content: '先检查' }])
  assert.equal(current.phase, 'thinking')
  current = advanceChatStream(current, { type: 'reasoning', round: 2, delta: '已得到工具结果' })
  const next = advanceChatStream(current, { type: 'content', round: 2, delta: '已核对安排' })
  assert.equal(next.content,'准备安排\n\n已核对安排')
  assert.equal(next.reasoningContent, '先检查\n\n已得到工具结果')
  assert.deepEqual(next.reasoningRounds.map(item => item.content), ['先检查', '已得到工具结果'])
  assert.equal(advanceChatStream(next, { type: 'content', round: 1, delta: '过时内容' }), next)
  assert.equal(advanceChatStream(next, { type: 'result', result }), next, 'final state is handled separately and never folded into the draft')
  assert.equal(next.requestId, 'request-one')
})

test('duplicate round notifications do not erase or replay already visible reasoning', () => {
  let current = advanceChatStream(draft(), { type: 'reasoning', round: 1, delta: '已读取' })
  assert.equal(advanceChatStream(current, { type: 'round', round: 1 }), current)
  current = advanceChatStream(current, { type: 'reasoning', round: 1, delta: '完整日程' })
  assert.equal(current.reasoningContent, '已读取完整日程')
  current = advanceChatStream(current, { type: 'reasoning', round: 2, delta: '已读取完整日程' })
  assert.equal(current.reasoningRounds.length, 2, 'identical text in distinct real rounds is not incorrectly deduplicated')
  assert.equal(advanceChatStream(current, { type: 'reasoning', round: 1, delta: '旧传输' }), current)
})

test('retry restores persisted rounds once and keeps new round numbers in a separate namespace', () => {
  const saved = { reasoningContent: '调用前\n\n调用后', rounds: [{ id: 'db-first', content: '调用前' }, { id: 'db-second', content: '调用后' }] }
  let current = restoreChatReasoning(draft(), saved)
  current = advanceChatStream(current, { type: 'round', round: 1 })
  current = advanceChatStream(current, { type: 'reasoning', round: 1, delta: '继续未完成的操作' })
  assert.equal(current.reasoningContent, '调用前\n\n调用后\n\n继续未完成的操作')
  assert.deepEqual(current.reasoningRounds.map(item => item.id), ['saved:db-first', 'saved:db-second', 'live:1'])
  assert.deepEqual(saved.rounds, [{ id: 'db-first', content: '调用前' }, { id: 'db-second', content: '调用后' }], 'restoration must not mutate the durable snapshot')
})

test('older saved-reasoning responses still restore the complete exact transcript', () => {
  const content = '  第一段\n\n第二段\t '
  const current = restoreChatReasoning(draft(), { reasoningContent: content })
  assert.equal(current.reasoningContent, content)
  assert.deepEqual(current.reasoningRounds, [{ id: 'saved:previous', content }])
})

test('transport failure leaves every received reasoning round available for interruption display and copy', async () => {
  let current = draft()
  const events = [
    { type: 'reasoning', round: 1, delta: '调用前完整思考\t' },
    { type: 'phase', phase: 'executing' },
    { type: 'round', round: 2 },
    { type: 'reasoning', round: 2, delta: '第二段已接收的部分' },
  ]
  await assert.rejects(readChatStream(streamFrom([events.map(event => frame(event)).join('')]), event => { current = advanceChatStream(current, event) }), /连接已中断/)
  assert.equal(current.reasoningContent, '调用前完整思考\t\n\n第二段已接收的部分')
  assert.equal(current.reasoningRounds.length, 2)
  assert.equal(current.content, '', 'unfinished thoughts must never manufacture a completed reply')
})

test('chat request advertises SSE and returns only the terminal state', async t => {
  const body = { requestId: 'request-one', text: '安排一下', conversationId: 'main' }
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls += 1
    assert.equal(url, '/api/chat')
    assert.equal(init.headers.Accept, 'text/event-stream')
    assert.equal(init.headers['X-ASTaria-Local'], '1')
    assert.equal(init.signal, controller.signal)
    assert.deepEqual(JSON.parse(init.body), body)
    return new Response(streamFrom([frame({ type: 'content', round: 1, delta: '处理中' }) + frame({ type: 'result', result })]), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
  })
  const events = []
  assert.deepEqual(await chatApi(body, event => events.push(event), controller.signal), result)
  assert.equal(calls, 1)
  assert.deepEqual(events.map(event => event.type), ['content', 'result'])
})

test('disabled streaming still accepts JSON final state and preserves failed status', async t => {
  const failed = { ...result, status: 'failed', error: '部分安排未完成', operations: [{ id: 'saved-operation' }] }
  t.mock.method(globalThis, 'fetch', async () => Response.json(failed))
  const events = []
  assert.deepEqual(await chatApi({}, event => events.push(event)), failed)
  assert.deepEqual(events, [])
})

test('validation errors keep their HTTP status and never trigger a second request', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls += 1; return Response.json({ error: '消息已撤回' }, { status: 409 }) })
  await assert.rejects(chatApi({ requestId: 'request-one' }, () => {}), error => error instanceof LocalApiError && error.status === 409 && error.message === '消息已撤回')
  assert.equal(calls, 1)
})

test('interrupted chat never retries itself or changes the caller request ID', async t => {
  const submitted = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    submitted.push(JSON.parse(init.body))
    return new Response(streamFrom([frame({ type: 'content', round: 1, delta: '临时内容' })]), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  const body = { requestId: 'same-retry-id', conversationId: 'main', text: '安排课程' }
  await assert.rejects(chatApi(body, () => {}), /连接已中断/)
  assert.deepEqual(submitted, [body])
  assert.equal(body.requestId, 'same-retry-id')
})
