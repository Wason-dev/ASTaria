import assert from 'node:assert/strict'
import test from 'node:test'
import { createHorizonActivityStream } from '../server/horizonActivity.mjs'

const dates = ['2026-09-26', '2026-09-27', '2026-09-28']
const update = (index, summary = `保留第 ${index + 1} 项的连续空档`, action = 'keep') => ({ index, action, summary })
const finalResult = value => ({ choices: [{ message: { content: JSON.stringify(value) } }] })
function fixture(count = 9) {
  const prepared = Array.from({ length: count }, (_, index) => ({ id: `plan-${index}` }))
  const snap = { dates, movable: prepared.map((plan, index) => ({ ...plan, title: `事项 ${index + 1}` })) }
  const input = { assignedDates: Object.fromEntries(prepared.map((plan, index) => [plan.id, dates[index % dates.length]])) }
  const events = []
  const stream = createHorizonActivityStream({ input, snap, prepared, activity: event => events.push(event) })
  return { stream, events, prepared, snap, input }
}

test('complete update objects publish before the final plan, but incomplete JSON never appears', () => {
  const { stream, events } = fixture()
  const first = JSON.stringify(update(0, '先保留数学作业的完整半小时'))
  stream.push('{"updates":[')
  stream.push(first.slice(0, -1))
  assert.deepEqual(events, [])
  stream.push(first.slice(-1))
  assert.deepEqual(events, [{ id: 'model-review:0', source: 'model', state: 'proposed', title: '建议沿用「事项 1」', detail: '先保留数学作业的完整半小时', itemIds: ['plan-0'], day: 0 }])
  stream.push(','); stream.push(JSON.stringify(update(1, '往后移动五分钟，留出切换时间', 'adjust')))
  assert.equal(events.length, 2); assert.equal(events[1].title, '建议微调「事项 2」'); assert.equal(events[1].day, 1)
  stream.push('],"plans":[]}')
  assert.equal(events.length, 2)
})

test('all single split positions, including the updates key, produce the same public activities', () => {
  const raw = JSON.stringify({ updates: [update(0), update(1, '改到下一段连续空档', 'adjust')], plans: [] })
  const expected = fixture(); expected.stream.push(raw)
  for (let boundary = 0; boundary <= raw.length; boundary++) {
    const { stream, events } = fixture()
    stream.push(raw.slice(0, boundary)); stream.push(raw.slice(boundary))
    assert.deepEqual(events, expected.events, `chunk boundary ${boundary}`)
  }
})

test('one-character chunks safely decode escaped quotes, backslashes, braces, and Chinese text', () => {
  const summary = '「Ex2C」保留 "a{b}[c]"，路径 C:\\习题；括号 } { 不结束条目 🌌'
  const raw = ' \n{ "updates" : [ ' + JSON.stringify(update(2, summary, 'adjust')) + ' ], "plans": [] }'
  const { stream, events } = fixture()
  for (const character of raw) stream.push(character)
  assert.equal(events.length, 1)
  assert.equal(events[0].detail, summary); assert.equal(events[0].day, 2)
})

test('unknown, negative, fractional, string and missing indices never enter the activity feed', () => {
  const invalid = [-1, 99, 0.5, '0', null, undefined].map(index => ({ index, action: 'keep', summary: '不能显示' }))
  for (const entry of invalid) {
    const { stream, events } = fixture()
    stream.push(JSON.stringify({ updates: [entry, update(1)] }))
    assert.deepEqual(events.map(event => event.itemIds), [['plan-1']])
  }
})

test('extra fields and invalid actions are rejected without consuming their index', () => {
  for (const entry of [
    { ...update(0), reasoning: 'private reasoning' },
    { ...update(0), payload: { secret: [']', '{', '\\"'] } },
    { ...update(0), action: 'delete' },
    { ...update(0), action: 'KEEP' },
    { ...update(0), action: null },
    { index: 0, summary: '没有 action' },
  ]) {
    const { stream, events } = fixture()
    stream.push(JSON.stringify({ updates: [entry, update(0, '真正的公开摘要')] }))
    assert.equal(events.length, 1)
    assert.equal(events[0].detail, '真正的公开摘要')
    assert.doesNotMatch(JSON.stringify(events), /private reasoning|secret|payload/)
  }
})

test('invalid summaries cannot leak objects, control characters, empty text, or oversized content', () => {
  for (const summary of ['', '   ', null, [], { content: 'private' }, 'x'.repeat(161), 'a\nb', '\u007f', '\u0000']) {
    const { stream, events } = fixture()
    stream.push(JSON.stringify({ updates: [update(0, summary), update(0, ' 有效摘要 ')] }))
    assert.equal(events.length, 1)
    assert.equal(events[0].detail, '有效摘要')
  }
  const { stream, events } = fixture()
  stream.push(JSON.stringify({ updates: [update(0, 'x'.repeat(160))] }))
  assert.equal(events.length, 1); assert.equal(events[0].detail.length, 160)
})

test('duplicate indices in streaming output and final fallback publish once, preserving the first public note', () => {
  const { stream, events } = fixture()
  stream.push(JSON.stringify({ updates: [update(0, '第一条'), update(0, '重复条目'), update(1)] }))
  stream.finish(finalResult({ updates: [update(0, '最终重复条目'), update(1), update(2)] }))
  stream.finish(finalResult({ updates: [update(0), update(2)] }))
  assert.deepEqual(events.map(event => event.id), ['model-review:0', 'model-review:1', 'model-review:2'])
  assert.equal(events[0].detail, '第一条')
})

test('both streamed and non-streamed results publish at most six review activities', () => {
  const updates = Array.from({ length: 9 }, (_, index) => update(index))
  const streamed = fixture(); streamed.stream.push(JSON.stringify({ updates })); streamed.stream.finish(finalResult({ updates }))
  const finished = fixture(); finished.stream.finish(finalResult({ updates }))
  assert.equal(streamed.events.length, 6)
  assert.deepEqual(streamed.events.map(event => event.id), updates.slice(0, 6).map(({ index }) => `model-review:${index}`))
  assert.deepEqual(finished.events, streamed.events)
})

test('finishing without a streamed prefix recovers structured updates even when another property is first', () => {
  const { stream, events } = fixture()
  const raw = JSON.stringify({ plans: [], updates: [update(2, '后天的空档够用')] })
  stream.push(raw)
  assert.deepEqual(events, [])
  stream.finish({ choices: [{ message: { content: raw } }] })
  assert.equal(events.length, 1); assert.equal(events[0].detail, '后天的空档够用')
  assert.equal(events[0].state, 'proposed')
})

test('results with no updates never fabricate model activity from plans or prose', () => {
  for (const value of [{ plans: [] }, { summary: '析熙正在整理' }, { plans: [{ updates: [update(0)] }] }, { updates: null }, { updates: {} }]) {
    const { stream, events } = fixture()
    stream.push(JSON.stringify(value)); stream.finish(finalResult(value))
    assert.deepEqual(events, [])
  }
})

test('reasoning fields and event-shaped objects never enter the activity feed', () => {
  const { stream, events } = fixture()
  stream.push({ type: 'reasoning', delta: 'private reasoning text' })
  stream.push(undefined); stream.push(null); stream.push(42)
  stream.finish({ choices: [{ message: { reasoning_content: JSON.stringify({ updates: [update(0, 'private thought')] }) } }] })
  stream.finish({ choices: [{ message: { reasoning: JSON.stringify({ updates: [update(0, 'another private thought')] }), content: '{"plans":[]}' } }] })
  assert.deepEqual(events, [])
  stream.finish({ choices: [{ message: { reasoning_content: 'hidden private reasoning', content: JSON.stringify({ updates: [update(1, '只保留公开操作摘要')] }) } }] })
  assert.equal(events.length, 1); assert.equal(events[0].detail, '只保留公开操作摘要')
  assert.doesNotMatch(JSON.stringify(events), /private|thought|reasoning/)
})

test('closed update arrays prevent later plan objects or nested update lookalikes from being streamed', () => {
  const { stream, events } = fixture()
  stream.push('{"updates":[' + JSON.stringify(update(0)) + ']')
  stream.push(',"plans":[' + JSON.stringify(update(1, '应忽略')) + '],"other":{"updates":[' + JSON.stringify(update(2)) + ']}}')
  assert.deepEqual(events.map(event => event.id), ['model-review:0'])
})

test('malformed and oversized final results are ignored without leaking partial JSON', () => {
  for (const content of ['{', '{"updates":[', 'not JSON', '[', null, 5, ' '.repeat(80_001), '{"updates":[' + ' '.repeat(80_000)]) {
    const { stream, events } = fixture()
    assert.doesNotThrow(() => stream.finish({ choices: [{ message: { content } }] }))
    assert.deepEqual(events, [])
  }
  const { stream, events } = fixture()
  assert.doesNotThrow(() => stream.finish(null)); assert.doesNotThrow(() => stream.finish({}))
  assert.deepEqual(events, [])
})

test('an oversized streaming buffer stops accepting more chunks without emitting their contents', () => {
  const { stream, events } = fixture()
  stream.push(' '.repeat(79_995))
  stream.push('{"updates":[' + JSON.stringify(update(0)) + ']}')
  stream.push(JSON.stringify({ updates: [update(1)] }))
  assert.deepEqual(events, [])
})

test('long item titles are bounded independently from the public summary', () => {
  const { stream, events, snap } = fixture()
  snap.movable[0].title = '题'.repeat(150)
  stream.push(JSON.stringify({ updates: [update(0)] }))
  assert.equal(events[0].title, `建议沿用「${'题'.repeat(110)}」`)
})

test('non-streaming fallback and live streaming both keep the first six valid unique entries', () => {
  const updates = [update(99), update(0), update(0, '重复序号'), { ...update(1), extra: 'reject' }, ...Array.from({ length: 7 }, (_, index) => update(index + 1))]
  const streamed = fixture(); streamed.stream.push(JSON.stringify({ updates }))
  const finished = fixture(); finished.stream.finish(finalResult({ updates }))
  assert.equal(streamed.events.length, 6)
  assert.deepEqual(finished.events, streamed.events)
  assert.deepEqual(finished.events.map(event => event.id), Array.from({ length: 6 }, (_, index) => `model-review:${index}`))
})
