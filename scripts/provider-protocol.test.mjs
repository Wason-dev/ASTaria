import test from 'node:test'
import assert from 'node:assert/strict'
import { inspectAssistantProtocol, normalizeAssistantProtocol, RESPONSE_PROTOCOL_ERROR } from '../server/provider-protocol.mjs'

const question = '今天19:50—21:45已经排了两段，原来的任务还在\n你想怎么调整？'
const options = ['数学放到今晚', '重排今天的两段', '不动今天，看看明天']
const envelope = (prompt = question, choices = options) => `<｜DSML｜calls>\n<｜DSML｜invoke name="ask_user">\n<｜DSML｜parameter name="question" string="true">${prompt}</｜DSML｜parameter>\n<｜DSML｜parameter name="options" string="false">${JSON.stringify(choices)}</｜DSML｜parameter>\n</｜DSML｜invoke>\n</｜DSML｜calls>`
const doubleBarEnvelope = value => value.replaceAll('｜DSML｜', '｜｜DSML｜｜ ')
const escapedEnvelope = value => value.replace(/<[^<>]*>/gu, tag => tag.replace(/[<>|｜_"/]/gu, character => `\\${character}`))

test('screenshot ask_user envelope becomes readable question and choices without executable tools', () => {
  assert.deepEqual(inspectAssistantProtocol(envelope()), { kind: 'question', content: question, question: { options } })
  const normalized = normalizeAssistantProtocol({ role: 'assistant', content: envelope() })
  assert.deepEqual(normalized.question.options, options)
  assert.equal(normalized.tool_calls, undefined)
  assert.equal(normalized.content, question)
})

test('ASCII bars, fullwidth bars, whitespace, prompt alias and attribute order recover identically', () => {
  for (const variant of [envelope().replaceAll('｜', '|'), envelope().replaceAll('｜DSML｜', ' | DSML ｜ '),
    envelope().replace('name="question" string="true"', 'string="true" name="prompt"'),
    `\n \t${envelope().replaceAll('"ask_user"', "'ask_user'")}\n`]) {
    assert.equal(inspectAssistantProtocol(variant).kind, 'question')
    assert.equal(inspectAssistantProtocol(variant).content, question)
  }
})

test('repeated delimiters and Markdown-escaped question envelopes recover without changing presentation text', () => {
  const prompt = String.raw`选 A\_1，还是 C:\Users\计划？`
  const choices = [String.raw`A\_1`, String.raw`C:\Users\计划`]
  const source = envelope(prompt, choices)
  for (const variant of [doubleBarEnvelope(source),
    source.replaceAll('｜DSML｜', '||| DSML ||| '),
    source.replaceAll('｜DSML｜', ' ｜ | ｜ \t DSML \n | ｜ | '),
    escapedEnvelope(source), escapedEnvelope(doubleBarEnvelope(source)), escapedEnvelope(escapedEnvelope(source)),
    doubleBarEnvelope(source).replaceAll('ask_user', String.raw`ask\_user`).replaceAll('</', String.raw`\</`)]) {
    assert.deepEqual(inspectAssistantProtocol(variant), { kind: 'question', content: prompt, question: { options: choices } }, variant)
    const normalized = normalizeAssistantProtocol({ role: 'assistant', content: variant })
    assert.equal(normalized.protocolError, undefined)
    assert.equal(normalized.tool_calls, undefined)
  }
})

test('the leaked double-bar timetable write is blocked even with escaped tool names and closing tags', () => {
  const leaked = String.raw`<｜｜DSML｜｜ calls>
<｜｜DSML｜｜ invoke name="set\_day\_timetable">
<｜｜DSML｜｜ parameter name="date" string="true">2026-09-19\</｜｜DSML｜｜ parameter>
<｜｜DSML｜｜ parameter name="slots" string="false">[]\</｜｜DSML｜｜ parameter>
\</｜｜DSML｜｜ invoke>
\</｜｜DSML｜｜ calls>`
  for (const value of [leaked, leaked.replaceAll('｜', '|'), escapedEnvelope(leaked),
    leaked.slice(0, leaked.indexOf('slots')), `我来调整今天的安排。\n${leaked}`]) {
    assert.equal(inspectAssistantProtocol(value).kind, 'invalid', value)
    const normalized = normalizeAssistantProtocol({ role: 'assistant', content: value,
      tool_calls: [{ type: 'function', function: { name: 'set_day_timetable', arguments: '{}' } }],
      toolCalls: [{ name: 'set_day_timetable', input: {} }] })
    assert.equal(normalized.protocolError, true)
    assert.equal(normalized.content, RESPONSE_PROTOCOL_ERROR)
    assert.equal(normalized.tool_calls, undefined)
    assert.equal(normalized.toolCalls, undefined)
  }
})

test('partial repeated or escaped delimiters cannot become ordinary assistant text', () => {
  for (const value of ['<｜｜DSML', '<|||DSML', '< | ｜ | DSML', String.raw`\<\|\|DSML`, String.raw`\\<\\|\\|DSML`,
    String.raw`\<\/\｜\｜DSML\｜\｜ parameter`, '<｜｜DSML｜｜ calls',
    doubleBarEnvelope(envelope()).slice(0, -10),
    escapedEnvelope(envelope()).replace('ask\\_user', 'set\\_day\\_timetable')]) {
    const result = inspectAssistantProtocol(value)
    assert.equal(result.kind, 'invalid', value)
    assert.equal(result.content, RESPONSE_PROTOCOL_ERROR)
  }
})

test('valid XML entities in question and JSON options are decoded conservatively', () => {
  const value = envelope('先看 A &amp; B，还是 &quot;下一步&quot;？', ['A & B', '下一步']).replace('["A & B","下一步"]', '[&quot;A &amp; B&quot;,&quot;下一步&quot;]')
  assert.deepEqual(inspectAssistantProtocol(value), { kind: 'question', content: '先看 A & B，还是 "下一步"？', question: { options: ['A & B', '下一步'] } })
})

test('partial, mixed, unknown and multiple calls never escape as source or execute', () => {
  const invalid = [
    '<｜DSML｜calls>', '<|DSML', envelope().slice(0, -10), `我先问你\n${envelope()}`, `${envelope()}\n好了`,
    envelope().replace('ask_user', 'create_tasks'), envelope().replace('ask_user', 'unknown'),
    `${envelope()}${envelope()}`,
    envelope().replace('</｜DSML｜calls>', '<｜DSML｜invoke name="create_tasks"></｜DSML｜invoke></｜DSML｜calls>'),
    envelope().replace('name="question"', 'name="unexpected"'),
    envelope().replace('string="false"', 'string="true"'),
    envelope().replace('name="ask_user"', 'name="ask_user" name="create_tasks"'),
    envelope().replace('name="question" string="true"', 'name="question" string="true" unsafe="yes"'),
    envelope().replace('</｜DSML｜invoke>', '<｜DSML｜parameter name="prompt" string="true">重复</｜DSML｜parameter></｜DSML｜invoke>'),
    envelope(' ', options), envelope(question, ['一个']), envelope(question, ['重复', '重复']),
    envelope(question, ['字'.repeat(81), '其他']), envelope(question, { a: '对象' }),
    envelope('<｜DSML｜invoke name="create_tasks">坏内容</｜DSML｜invoke>', options),
    envelope('&lt;｜DSML｜calls&gt;', options),
    envelope('&lt;｜｜DSML｜｜ calls&gt;', options),
    envelope(question, [String.raw`\<\|\|DSML\|\| calls>`, '其他']),
  ]
  for (const value of invalid) {
    const result = inspectAssistantProtocol(value)
    assert.equal(result.kind, 'invalid', value)
    assert.equal(result.content, RESPONSE_PROTOCOL_ERROR)
    assert.doesNotMatch(result.content, /DSML/)
    const normalized = normalizeAssistantProtocol({ role: 'assistant', content: value })
    assert.equal(normalized.protocolError, true)
    assert.equal(normalized.tool_calls, undefined)
  }
})

test('ordinary Markdown, code fences and inline code are presentation data, not protocol calls', () => {
  for (const content of ['**明天的安排**\n- 数学\n- 物理', 'DSML 是一种格式', '<div>普通 HTML 文本</div>',
    `示例：\n\`\`\`xml\n${envelope()}\n\`\`\`\n这只是一段代码`,
    `~~~xml\n${envelope()}\n~~~`, '例子 `<|DSML|calls>` 是标签',
    '用 `` `<｜DSML｜calls>` `` 引用代码',
    `示例：\n\`\`\`xml\n${doubleBarEnvelope(envelope())}\n\`\`\``,
    `例子 \`${escapedEnvelope(doubleBarEnvelope(envelope())).split('\n')[0]}\` 是标签`]) {
    assert.deepEqual(inspectAssistantProtocol(content), { kind: 'plain', content })
  }
})

test('unfinished fences and real control text outside a code example are rejected', () => {
  assert.equal(inspectAssistantProtocol(`\`\`\`xml\n${envelope()}`).kind, 'invalid')
  assert.equal(inspectAssistantProtocol(`\`\`\`xml\n样例\n\`\`\`\n${envelope()}`).kind, 'invalid')
})

test('native calls pass untouched, while recovered questions cannot accompany native writes', () => {
  const native = { role: 'assistant', content: null, tool_calls: [{ type: 'function', function: { name: 'create_tasks', arguments: '{}' } }] }
  assert.equal(normalizeAssistantProtocol(native), native)
  const mixed = normalizeAssistantProtocol({ ...native, content: envelope() })
  assert.equal(mixed.protocolError, true)
  assert.equal(mixed.tool_calls, undefined)
  assert.equal(mixed.content, RESPONSE_PROTOCOL_ERROR)
  const alternative = normalizeAssistantProtocol({ role: 'assistant', content: escapedEnvelope(doubleBarEnvelope(envelope())),
    toolCalls: [{ name: 'set_day_timetable', input: {} }] })
  assert.equal(alternative.protocolError, true)
  assert.equal(alternative.toolCalls, undefined)
  assert.equal(alternative.content, RESPONSE_PROTOCOL_ERROR)
})
