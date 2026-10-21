import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { parseDocument } from 'htmlparser2'
import { createServer } from 'vite'

// Load the real component with no project Vite plugins: this fixture never
// starts the local service, opens application data, or contacts a model.
let server, ConversationLog
before(async () => {
  server = await createServer({ configFile: false, root: new URL('..', import.meta.url).pathname,
    server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' })
  ;({ ConversationLog } = await server.ssrLoadModule('/src/xixi/ConversationLog.tsx'))
})
after(async () => { await server?.close() })

const source = (fetchStatus = 'ok', overrides = {}) => ({ url: 'https://example.com/fixture', title: 'Fixture source',
  fetchStatus, fetchedAt: '2026-10-12T00:00:00.000Z', ...overrides })
const find = (node, predicate) => [node, ...(node.children ?? []).flatMap(child => find(child, predicate))].filter(predicate)
const hasClass = value => node => node.attribs?.class?.split(' ').includes(value)
const text = node => node.type === 'text' ? node.data : (node.children ?? []).map(text).join('')
function render({ sources, retractedAt, excludeFromContext, content = '模型原文。', stream } = {}) {
  const chat = { conversation: { conversationId: 'fixture', operations: [], messages: stream ? [] : [{ id: 'reply', seq: 1, role: 'assistant', content,
    createdAt: '2026-10-12T00:00:00.000Z', sources, retractedAt, excludeFromContext }] }, status: { configured: true }, stream, sending: Boolean(stream) }
  return parseDocument(renderToStaticMarkup(createElement(ConversationLog, { chat, active: true, context: {}, onSettings() {}, onSent() {}, onRetracted() {} })))
}

test('the actual conversation renders a collapsed source section outside Markdown with truthful statuses', () => {
  const root = render({ sources: [source('failed'), source('empty', { url: 'https://example.com/empty' }), source('ok', { url: 'https://example.com/read' })], content: '模型声称日期确定。' })
  const details = find(root, hasClass('xixi-sources'))[0]
  assert.equal(details.name, 'details')
  assert.equal(details.attribs.open, undefined)
  const markdown = find(root, hasClass('xixi-markdown'))[0]
  assert.equal(text(markdown), '模型声称日期确定。')
  assert.equal(find(markdown, hasClass('xixi-sources')).length, 0)
  assert.match(text(details), /1 页已读取 · 2 页未读到正文/u)
  assert.match(text(details), /读取失败 · 无法核实/u)
  assert.match(text(details), /正文为空 · 无法核实/u)
  assert.doesNotMatch(text(details), /核验成功|已核实|已验证/u)
  for (const link of find(details, node => node.name === 'a')) {
    assert.equal(link.attribs.target, '_blank')
    assert.equal(link.attribs.rel, 'noopener noreferrer')
  }
  assert.equal(find(details, node => node.name === 'time')[0].attribs.datetime, '2026-10-12T00:00:00.000Z')
})

test('duplicate URLs collapse to one source, and a URL used as its title is displayed only once', () => {
  const duplicate = source('failed', { url: 'https://example.com/', title: 'https://example.com' })
  const root = render({ sources: [duplicate, duplicate] })
  const details = find(root, hasClass('xixi-sources'))[0]
  assert.equal(find(details, node => node.name === 'li').length, 1)
  assert.equal(find(details, node => node.name === 'a').length, 1)
  assert.equal(find(details, hasClass('xixi-source-address')).length, 0)
  assert.equal(text(details).split('example.com').length - 1, 1)
})

test('an empty source list is a system state, and retracted or context-excluded records never show sources', () => {
  const empty = render({ sources: [] })
  assert.equal(find(empty, hasClass('xixi-sources')).length, 0)
  const status = find(empty, hasClass('xixi-source-empty'))[0]
  assert.equal(status.attribs.role, 'status')
  assert.match(text(status), /未读到网页正文/u)
  for (const hidden of [{ retractedAt: '2026-10-12T00:00:00.000Z' }, { excludeFromContext: true }]) {
    assert.equal(find(render({ sources: [source()], ...hidden }), hasClass('xixi-sources')).length, 0)
  }
})

test('live source metadata renders independently of temporary model prose', () => {
  const stream = { requestId: 'fixture-stream', conversationId: 'fixture', round: 2, content: '还在生成的模型原文。', reasoningContent: '', phase: 'replying', sources: [source('failed')] }
  const root = render({ stream })
  const markdown = find(root, hasClass('xixi-markdown'))[0]
  assert.equal(text(markdown), stream.content)
  assert.equal(find(markdown, hasClass('xixi-sources')).length, 0)
  assert.match(text(find(root, hasClass('xixi-sources'))[0]), /未读到可用正文/u)
})

test('legacy messages have no extra source chrome, and invalid public URLs never become links', () => {
  assert.equal(find(render(), hasClass('xixi-sources')).length, 0)
  const unsafe = render({ sources: [source('ok', { url: 'javascript:alert(1)' })] })
  assert.equal(find(unsafe, node => node.name === 'a').length, 0)
})
