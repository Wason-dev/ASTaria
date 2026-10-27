// Fork A repro: live stream vs persisted transcript across tool paths.
// In-memory SQLite, scripted model, real /api/chat and /api/conversation routes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { registerHooks } from 'node:module'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { createServiceCore } from '../server/serviceCore.mjs'

process.env.TZ = 'Asia/Shanghai'
// Load the client reducer from the worktree and from the HEAD snapshot.
const ROOTS = [new URL('../src/', import.meta.url).href]
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (ROOTS.some(root => context.parentURL?.startsWith(root)) && specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/u.test(specifier)) return next(`${specifier}.ts`, context)
  return next(specifier, context)
} })
const work = await import('../src/xixi/stream.ts')
hooks.deregister()

const NOW = new Date('2026-09-29T07:00:00+08:00')
const call = (name, args, id = randomUUID()) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })
function harness(t, script, setup) {
  const db = createDatabase(':memory:'); t.after(() => db.close())
  setup?.(db)
  let index = 0
  const complete = async (payload, options = {}) => {
    if (options.purpose === 'thinking-summary') return { choices: [{ message: { role: 'assistant', content: '{"title":"核对请求"}' } }] }
    const step = script[Math.min(index++, script.length - 1)]
    for (const delta of step.stream ?? []) options.onDelta?.({ type: 'content', delta })
    return { choices: [{ index: 0, finish_reason: step.message.tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: '', ...step.message } }] }
  }
  const service = createServiceCore({ db, vault: { status: async () => true }, complete,
    xixiFactory: options => createXixi({ ...options, now: () => NOW }), completionScope: new AsyncLocalStorage() })
  return { db, service, get calls() { return index } }
}
async function chat(f, text) {
  const requestId = randomUUID(), events = []
  const result = await f.service.dispatch('/api/chat', { requestId, conversationId: 'main', text, context: { timezone: 'Asia/Shanghai', page: 'home' } },
    { headers: { accept: 'text/event-stream' }, startStream: () => event => events.push(structuredClone(event)) })
  const reloaded = await f.service.dispatch('/api/conversation?id=main')
  return { requestId, events, result, reloaded }
}
function replay(reducer, requestId, events) {
  let draft = { requestId, conversationId: 'main', round: -1, reasoningContent: '', content: '', phase: 'thinking' }
  const frames = []
  for (const event of events) {
    const next = reducer.advanceChatStream(draft, event)
    if (next !== draft) { draft = next; frames.push({ type: event.type, round: draft.round, phase: draft.phase, content: draft.content, activity: draft.activities?.at(-1)?.title }) }
  }
  return { last: draft, frames }
}
const saved = (state, requestId) => state.messages.filter(m => m.requestId === requestId && m.role === 'assistant').map(m => m.content)

test('A finish_response: prose before a terminal tool is preserved in the saved transcript', async t => {
  const lead = '先说结论：今晚只需要复习第三章。'
  const f = harness(t, [{ stream: [lead], message: { content: lead, tool_calls: [call('finish_response', { content: '第三章的重点是导数的应用。' })] } }])
  const r = await chat(f, '今晚该复习什么？')
  const live = replay(work, r.requestId, r.events).last.content
  console.log('CASE_A', JSON.stringify({ status: r.result.status, live, saved: saved(r.reloaded, r.requestId) }))
  assert.equal(r.result.status, 'completed')
  assert.ok(live.includes(lead), 'the lead-in was visible while streaming')
  assert.ok(saved(r.reloaded, r.requestId).some(text => text.includes(lead)), 'saved terminal-tool lead remains visible after reload')
})

test('B ask_user: a lead-in streamed before the question survives reload', async t => {
  const lead = '这两章你都还没复习。'
  const f = harness(t, [{ stream: [lead], message: { content: lead, tool_calls: [call('ask_user', { prompt: '想先复习哪一章？', options: ['第三章', '第四章'] })] } }])
  const r = await chat(f, '帮我决定先复习什么')
  const live = replay(work, r.requestId, r.events).last.content
  console.log('CASE_B', JSON.stringify({ status: r.result.status, live, saved: saved(r.reloaded, r.requestId) }))
  assert.equal(r.result.status, 'completed')
  assert.ok(live.includes(lead))
  assert.ok(saved(r.reloaded, r.requestId).some(text => text.includes(lead)))
})

test('C control: prose before an ordinary tool call is kept identically live and after reload', async t => {
  const lead = '我先看一下你现有的事项。', final = '你现在没有未完成的事项。'
  const f = harness(t, [{ stream: [lead], message: { content: lead, tool_calls: [call('read_tasks', {})] } }, { stream: [final], message: { content: final } }])
  const r = await chat(f, '我还有什么没做？')
  const live = replay(work, r.requestId, r.events).last.content
  console.log('CASE_C', JSON.stringify({ status: r.result.status, live, saved: saved(r.reloaded, r.requestId) }))
  assert.equal(r.result.status, 'completed')
  assert.equal(saved(r.reloaded, r.requestId).join('\n\n'), live)
})

test('D scheduling nudge: discarded rounds remove false completion claims from the live bubble', async t => {
  const claim = '好的，已经把数学作业安排在明天 19:00–20:00。', again = '已经安排好了。'
  const f = harness(t, [
    { stream: [claim], message: { content: claim } },
    { message: { content: '', tool_calls: [call('read_planner', { date: '2026-09-30' })] } },
    { stream: [again], message: { content: again } },
  ], db => db.createTask({ title: '数学作业' }))
  const r = await chat(f, '把数学作业安排在明天 19:00-20:00')
  const workFrames = replay(work, r.requestId, r.events).frames
  const executing = frames => frames.filter(frame => frame.round === 2 && frame.activity && frame.phase === 'executing').at(-1) ?? frames.filter(frame => frame.round === 2).at(-1)
  const peak = frames => frames.reduce((best, frame) => frame.content.length > best.length ? frame.content : best, '')
  console.log('CASE_D', JSON.stringify({ status: r.result.status, error: r.result.error, modelCalls: f.calls,
    workDuringTool: executing(workFrames)?.content,
    workPeak: peak(workFrames),  saved: saved(r.reloaded, r.requestId) }))
  assert.equal(r.result.status, 'failed')
  assert.ok(!saved(r.reloaded, r.requestId).some(text => text.includes('已经')), 'nothing claiming success is persisted')
  assert.equal(executing(workFrames).content, '', 'discarded prose is gone before the next tool begins')

})


test('SSE discard frames reach the real parser and preserve other saved round prose',async()=>{
  const requestId=randomUUID()
  const events=[{type:'round',round:1},{type:'content',round:1,delta:'已读取资料。'},
    {type:'round',round:2},{type:'content',round:2,delta:'虚假的完成声明'},
    {type:'round-discarded',round:2},{type:'round',round:3},{type:'content',round:3,delta:'仍需选择时间。'}]
  const result={requestId,conversationId:'main',status:'completed',messages:[],operations:[]}
  const bytes=new TextEncoder().encode([...events,{type:'result',result}].map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''))
  let draft={requestId,conversationId:'main',round:-1,reasoningContent:'',content:'',phase:'thinking'}
  const stream=new ReadableStream({start(controller){controller.enqueue(bytes);controller.close()}})
  await work.readChatStream(stream,event=>{draft=work.advanceChatStream(draft,event)})
  assert.equal(draft.content,'已读取资料。\n\n仍需选择时间。')
})
