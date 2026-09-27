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
const { HORIZON_PHASES, advanceHorizonProgress, advanceHorizonActivity, parseHorizonActivity, horizonProgressCopy, isHorizonResult, readHorizonStream, horizonOrderApi } = await import('../src/xixi/horizonProgress.ts')
const { isHorizonGroupingResult, horizonGroupingApi } = await import('../src/xixi/horizonGroupingApi.ts')
const { LocalApiError } = await import('../src/xixi/api.ts')
hook.deregister()

const result = {
  date: '2026-09-26', days: 3, revision: 8, snapshotKey: 'snapshot-key', asOf: '2026-09-26T06:00:00Z',
  items: [{ id: 'block-one', taskId: 'task-one', title: '数学作业 🌌', date: '2026-09-26', start: '20:00', end: '20:30', durationMin: 30, movable: true }],
  groups: [{ id: 'group-one', title: '数学', day: 0, tasks: [{ id: 'block-one', title: '数学作业 🌌', minutes: 30 }] }],
  operation: { id: 'operation-one' }, summary: '已调整数学作业的顺序',
}
const frame = (event, newline = '\n') => `data: ${JSON.stringify(event)}${newline}${newline}`
const encode = text => new TextEncoder().encode(text)
const streamFrom = chunks => new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encode(chunk) : chunk); controller.close() } })
const unknown = error => !(error instanceof LocalApiError)

test('Horizon SSE preserves Chinese, emoji and CRLF split at every byte', async () => {
  const events = [...HORIZON_PHASES.map(phase => ({ type: 'phase', phase })), { type: 'result', result }]
  const bytes = encode(': heartbeat\r\n\r\n' + events.map(event => frame(event, '\r\n')).join(''))
  const phases = []
  assert.deepEqual(await readHorizonStream(streamFrom([...bytes].map(byte => Uint8Array.of(byte))), phase => phases.push(phase)), result)
  assert.deepEqual(phases, HORIZON_PHASES)
})

test('Horizon accepts multiline data and ignores unknown events without exposing model prose', async () => {
  const hidden = ['content', 'reasoning', 'tool'].map(type => frame({ type, delta: 'private provider text', arguments: 'private' })).join('')
  const phases = []
  const multiline = 'data: {"type":"phase",\ndata: "phase":"receiving"}\n\n'
  const received = await readHorizonStream(streamFrom([hidden + frame({ type: 'phase', phase: 'unrecognized' }) + multiline + frame({ type: 'result', result })]), phase => phases.push(phase))
  assert.deepEqual(received, result)
  assert.deepEqual(phases, ['receiving'])
})

test('a saving phase, EOF, or an unterminated terminal frame never counts as a saved receipt', async () => {
  for (const chunks of [[], [frame({ type: 'phase', phase: 'saving' })], [`data: ${JSON.stringify({ type: 'result', result })}`]]) {
    await assert.rejects(readHorizonStream(streamFrom(chunks), () => {}), unknown)
  }
})

test('incomplete nested result structures stay uncertain rather than completing the UI', async () => {
  assert.equal(isHorizonResult(result), true)
  assert.equal(isHorizonResult({ ...result, operation: null, replayed: true }), true)
  for (const invalid of [null, { summary: 'saved' }, { ...result, days: 7 }, { ...result, revision: -1 },
    { ...result, operation: {} }, { ...result, groups: [{}] }, { ...result, groups: [{ ...result.groups[0], tasks: [{}] }] },
    { ...result, items: [{ ...result.items[0], movable: 'true' }] }, { ...result, snapshotKey: '' }]) {
    assert.equal(isHorizonResult(invalid), false)
    await assert.rejects(readHorizonStream(streamFrom([frame({ type: 'result', result: invalid })]), () => {}), unknown)
  }
})

test('explicit stream errors preserve their real cause and HTTP status', async () => {
  for (const status of [400, 409, 503]) {
    await assert.rejects(readHorizonStream(streamFrom([frame({ type: 'error', error: '今晚空档不足', status })]), () => {}),
      error => error instanceof LocalApiError && error.status === status && error.message === '今晚空档不足')
  }
  for (const event of [{ type: 'error', error: 'broken' }, { type: 'error', error: 'broken', status: 200 }]) {
    await assert.rejects(readHorizonStream(streamFrom([frame(event)]), () => {}), unknown)
  }
})

test('bad JSON, invalid UTF-8 and failed transport preserve unknown save state', async () => {
  await assert.rejects(readHorizonStream(streamFrom(['data: {broken}\n\n']), () => {}), unknown)
  await assert.rejects(readHorizonStream(streamFrom([Uint8Array.of(0xff)]), () => {}), unknown)
  const broken = new ReadableStream({ start(controller) { controller.error(new Error('connection lost')) } })
  await assert.rejects(readHorizonStream(broken, () => {}), unknown)
})

test('both complete and unterminated oversized frames are rejected before parsing', async () => {
  const oversized = 'data: ' + ' '.repeat(2 * 1024 * 1024)
  await assert.rejects(readHorizonStream(streamFrom([oversized]), () => {}), unknown)
  await assert.rejects(readHorizonStream(streamFrom([oversized + '\n\n' + frame({ type: 'result', result })]), () => {}), unknown)
})

test('abort cancels an idle reader and emits no late state', async () => {
  let cancelled = false
  const controller = new AbortController(), phases = []
  const body = new ReadableStream({ cancel() { cancelled = true } })
  const pending = readHorizonStream(body, phase => phases.push(phase), controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error.name === 'AbortError')
  assert.equal(cancelled, true)
  assert.deepEqual(phases, [])
})

test('Horizon request advertises streaming, preserves payload and awaits a durable receipt', async t => {
  const body = { date: result.date, groups: [{ id: 'group-one', day: 0, itemIds: ['block-one'] }], expectedRevision: 7, snapshotKey: 'before-key', requestId: 'same-retry-id' }
  const controller = new AbortController(), phases = []
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++
    assert.equal(url, '/api/companion/horizon-order')
    assert.equal(init.headers.Accept, 'text/event-stream')
    assert.equal(init.headers['X-ASTaria-Local'], '1')
    assert.equal(init.signal, controller.signal)
    assert.deepEqual(JSON.parse(init.body), body)
    return new Response(streamFrom([frame({ type: 'phase', phase: 'checking' }) + frame({ type: 'result', result })]), { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
  })
  assert.deepEqual(await horizonOrderApi(body, phase => phases.push(phase), controller.signal), result)
  assert.deepEqual(phases, ['checking'])
  assert.equal(calls, 1)
})

test('JSON compatibility accepts a replay receipt without manufacturing intermediate phases', async t => {
  const replay = { ...result, replayed: true, operation: null }
  t.mock.method(globalThis, 'fetch', async () => Response.json(replay))
  const phases = []
  assert.deepEqual(await horizonOrderApi({}, phase => phases.push(phase)), replay)
  assert.deepEqual(phases, [])
})

test('HTTP validation failures keep their status and are not retried automatically', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return Response.json({ error: '日程已更新，请重新读取' }, { status: 409 }) })
  await assert.rejects(horizonOrderApi({}, () => {}), error => error instanceof LocalApiError && error.status === 409 && error.message === '日程已更新，请重新读取')
  assert.equal(calls, 1)
})

test('interrupted response leaves the original request ID intact for an explicit retry', async t => {
  const submissions = [], body = { requestId: 'same-retry-id', groups: [] }
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    submissions.push(JSON.parse(init.body))
    return new Response(streamFrom([frame({ type: 'phase', phase: 'saving' })]), { headers: { 'Content-Type': 'text/event-stream' } })
  })
  await assert.rejects(horizonOrderApi(body, () => {}), unknown)
  assert.deepEqual(submissions, [body])
  assert.equal(body.requestId, 'same-retry-id')
})

test('malformed JSON fallback and fetch failure remain unknown', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({ summary: 'not a receipt' }))
  await assert.rejects(horizonOrderApi({}, () => {}), unknown)
  globalThis.fetch.mock.mockImplementation(async () => new Response('{broken', { headers: { 'Content-Type': 'application/json' } }))
  await assert.rejects(horizonOrderApi({}, () => {}), unknown)
  globalThis.fetch.mock.mockImplementation(async () => { throw new Error('network unavailable') })
  await assert.rejects(horizonOrderApi({}, () => {}), unknown)
})

test('progress only completes observed phases and never moves forward merely because time passed', () => {
  let progress = { phase: 'submitting', completed: [] }
  progress = advanceHorizonProgress(progress, 'checking')
  assert.deepEqual(progress.completed, [])
  progress = advanceHorizonProgress(progress, 'waiting')
  assert.deepEqual(progress.completed, ['checking'], 'skipped preparing phase must not be invented')
  assert.equal(advanceHorizonProgress(progress, 'waiting'), progress)
  assert.equal(advanceHorizonProgress(progress, 'checking'), progress)
  const early = horizonProgressCopy(progress, 2), late = horizonProgressCopy(progress, 75)
  assert.equal(early.current, late.current)
  assert.deepEqual(early.completed, late.completed)
  assert.equal(early.reassurance, '')
  assert.match(late.reassurance, /原日程还没有改动/)
  assert.equal(late.elapsed, '1 分 15 秒')
  for (const phase of ['thinking', 'receiving']) assert.match(horizonProgressCopy({ phase, completed: [] }, 25).reassurance, /等待模型/)
  for (const phase of ['submitting', 'checking', 'preparing', 'validating', 'saving']) assert.equal(horizonProgressCopy({ phase, completed: [] }, 25).reassurance, '')
  progress = advanceHorizonProgress(progress, 'receiving')
  progress = advanceHorizonProgress(progress, 'validating')
  assert.deepEqual(horizonProgressCopy(progress, 8).completed, ['模型已响应', '方案已收到'])
  progress = advanceHorizonProgress(progress, 'saving')
  assert.equal(horizonProgressCopy(progress, 10).current, '正在保存新安排')
  assert.ok(!horizonProgressCopy(progress, 10).completed.some(step => step.includes('已保存')))
})

test('structured activity is bounded plain text and model states never become save receipts', () => {
  const activity = { id:'review-math', source:'model', state:'proposed', title:'检查数学作业', detail:'<b>保留原时长</b>', itemIds:['block-one', 'block-one'], day:0 }
  assert.deepEqual(parseHorizonActivity({ ...activity, reasoning:'hidden' }), { ...activity, itemIds:['block-one'] })
  assert.equal(parseHorizonActivity({ ...activity, state:'done' }).source, 'model')
  for (const invalid of [{ ...activity, state:'saved' }, { ...activity, title:'x'.repeat(161) }, { ...activity, detail:'x'.repeat(601) },
    { ...activity, source:'provider' }, { ...activity, day:3 }, { ...activity, itemIds:[null] }, { ...activity, itemIds:Array(129).fill('block-one') }]) {
    assert.equal(parseHorizonActivity(invalid), null)
  }
})

test('activity updates deduplicate replays, retain completed local facts, and bound history without declaring saved', () => {
  const running = { id:'capacity', source:'local', state:'running', title:'核对今天空档' }
  let progress = advanceHorizonActivity({ phase:'checking', completed:[] }, running)
  assert.equal(advanceHorizonActivity(progress, { ...running }), progress)
  progress = advanceHorizonActivity(progress, { ...running, state:'done', title:'今天剩余 90 分钟，待排 60 分钟' })
  assert.equal(advanceHorizonActivity(progress, running), progress)
  assert.equal(progress.activities.length, 1)
  progress = advanceHorizonActivity(progress, { id:'capacity', source:'model', state:'proposed', title:'保留数学的 30 分钟安排' })
  assert.equal(progress.activities.length, 2, 'a model ID cannot overwrite a local fact')
  for (let index=0;index<30;index++) progress=advanceHorizonActivity(progress,{id:`review-${index}`,source:'model',state:'proposed',title:`建议 ${index}`})
  assert.equal(progress.activities.length,24)
  assert.equal(progress.phase,'checking','activities do not fake stage completion')
  assert.equal(horizonProgressCopy(progress,30).activity.title,'建议 29')
  progress=advanceHorizonProgress(progress,'waiting')
  assert.equal(progress.activities.length,24,'real phase transitions preserve the activity trail')
})

test('fragmented activity SSE only exposes validated activity records and never treats them as a receipt', async () => {
  const valid={id:'model-1',source:'model',state:'proposed',title:'数学放在物理之后',detail:'避免连续切换材料',itemIds:['block-one'],day:0}
  const bytes=encode(frame({type:'activity',activity:{...valid,state:'saved'}},'\r\n')+frame({type:'reasoning',delta:'hidden'},'\r\n')+frame({type:'activity',activity:valid},'\r\n')+frame({type:'result',result},'\r\n'))
  const activities=[]
  assert.deepEqual(await readHorizonStream(streamFrom([...bytes].map(byte=>Uint8Array.of(byte))),()=>{},undefined,activity=>activities.push(activity)),result)
  assert.deepEqual(activities,[valid])
  await assert.rejects(readHorizonStream(streamFrom([frame({type:'activity',activity:valid})]),()=>{},undefined,()=>{}),unknown)
})

test('reschedule flags survive complete snapshots but wrong types do not', () => {
  const flagged={...result,items:result.items.map(item=>({...item,needsReschedule:true})),groups:result.groups.map(group=>({...group,tasks:group.tasks.map(task=>({...task,needsReschedule:true}))}))}
  assert.equal(isHorizonResult(flagged),true)
  assert.equal(isHorizonResult({...flagged,items:[{...flagged.items[0],needsReschedule:'yes'}]}),false)
})

test('smart grouping must preserve each actual block, its day, title, duration and reschedule flag', () => {
  const suggestion={snapshotKey:result.snapshotKey,groups:result.groups.map(group=>({...group,id:'suggested-group',title:'集中完成数学'}))}
  assert.equal(isHorizonGroupingResult(suggestion,result),true)
  for(const invalid of [{...suggestion,snapshotKey:'stale'}, {...suggestion,groups:[]},
    {...suggestion,groups:[suggestion.groups[0],suggestion.groups[0]]},
    {...suggestion,groups:[{...suggestion.groups[0],day:1}]},
    {...suggestion,groups:[{...suggestion.groups[0],tasks:[{...result.groups[0].tasks[0],minutes:99}]}]},
    {...suggestion,groups:[{...suggestion.groups[0],tasks:[{...result.groups[0].tasks[0],id:'invented'}]}]}]) assert.equal(isHorizonGroupingResult(invalid,result),false)
  const seven=Array.from({length:7},(_,index)=>({...result.groups[0].tasks[0],id:`block-${index}`}))
  const larger={...result,groups:[{...result.groups[0],tasks:seven.slice(0,6)},{...result.groups[0],id:'group-two',tasks:seven.slice(6)}]}
  assert.equal(isHorizonGroupingResult({snapshotKey:result.snapshotKey,groups:[{...result.groups[0],tasks:seven}]},larger),false,'suggestions must respect the six-item group limit')
})

test('smart grouping reuses SSE safely and forwards an abortable suggestion request', async t => {
  const suggestion={snapshotKey:result.snapshotKey,groups:result.groups},controller=new AbortController(),activities=[]
  const activity={id:'group-plan',source:'model',state:'proposed',title:'把数学安排放在一组'}
  t.mock.method(globalThis,'fetch',async(url,init)=>{
    assert.equal(url,'/api/companion/horizon-groups')
    assert.equal(init.signal,controller.signal)
    assert.deepEqual(JSON.parse(init.body),{date:result.date,expectedRevision:result.revision,snapshotKey:result.snapshotKey,requestId:'group-request'})
    return new Response(streamFrom([frame({type:'activity',activity})+frame({type:'result',result:suggestion})]),{headers:{'Content-Type':'text/event-stream'}})
  })
  assert.deepEqual(await horizonGroupingApi(result,'group-request',()=>{},controller.signal,activity=>activities.push(activity)),suggestion)
  assert.deepEqual(activities,[activity])
})
