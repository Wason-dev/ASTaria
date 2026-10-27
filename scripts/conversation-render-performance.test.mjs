// Offline component regression: real React DOM, react-markdown, timeline and
// ReceiptDeadline. A small host DOM supplies nodes (no layout/browser claims).
// Only API/task persistence and the external deadline-picker provider are
// replaced. Nothing opens the app, network, database or credentials. TSX is
// transformed in memory with the already installed compiler; no build output.
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { transformSync } from 'rolldown/utils'

const project = fileURLToPath(new URL('../', import.meta.url))
const counts = []
const calls = []
const fixture = globalThis.__conversationRenderTest = {
  record: (kind, key) => counts.push({ kind, key }),
  api: async path => { throw new Error(`Unexpected synthetic API: ${path}`) },
  store: {},
}
const instrumented = new Map([
  ['conversationTimeline', 'conversation?.conversationId'],
  ['SavedHistory', 'conversationId'], ['SavedMessage', 'row.message.id'],
  ['MessageMarkdown', 'content'], ['ReceiptDeadline', 'task.id'],
  ['Reasoning', 'requestId'], ['Sources', 'sources'],
])
const hooks = registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const url = new URL(specifier, context.parentURL)
      if (url.pathname.startsWith(`${project}src/`) && !/\.[a-z]+$/i.test(url.pathname)) {
        for (const ext of ['.ts', '.tsx']) if (existsSync(fileURLToPath(url) + ext)) return { url: url.href + ext, shortCircuit: true }
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.startsWith('file:') || !fileURLToPath(url).startsWith(`${project}src/`)) return next(url, context)
    if (url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    let source
    if (url.endsWith('/xixi/api.ts')) source = 'export const localApi = (...args) => globalThis.__conversationRenderTest.api(...args)'
    else if (url.endsWith('/stores/taskStore.ts')) source = 'export const taskStore = globalThis.__conversationRenderTest.store'
    else if (url.endsWith('/home/HomeDeadlinePicker.tsx')) source = `
      import {createContext, useContext} from 'react'
      export const TestDeadlineContext = createContext(null)
      export const useHomeDeadlinePicker = () => useContext(TestDeadlineContext)`
    else if (/\.tsx?$/.test(url)) {
      const result = transformSync(fileURLToPath(url), readFileSync(new URL(url), 'utf8'), { lang: url.endsWith('.tsx') ? 'tsx' : 'ts', jsx: { runtime: 'automatic' } })
      assert.equal(result.errors.length, 0, `TSX transform: ${url}`)
      source = result.code
      // Runtime probes count executions, including the real markdown parser's
      // caller. Assertions below inspect committed nodes and actual callbacks,
      // never source-string patterns. Probes do not change component identity.
      for (const [name, key] of instrumented) source = source.replace(new RegExp(`(function ${name}\\([\\s\\S]*?\\) \\{)`), `$1\nglobalThis.__conversationRenderTest.record('${name}', ${key});`)
    } else return next(url, context)
    return { format: 'module', source, shortCircuit: true }
  },
})

// Enough DOM for React's mutation/event host. It deliberately has no geometry,
// CSS, selection engine or parser, so browser/selection/paint QA stays separate.
class HostNode {
  constructor(type, name, doc) {
    this.nodeType = type; this.nodeName = name; this.tagName = name
    this.ownerDocument = doc; this.parentNode = null; this.childNodes = []
    this.attributes = new Map(); this.style = {}; this.listeners = new Map()
    this.scrollTop = 0; this.scrollHeight = 1000; this.clientHeight = 300
  }
  get firstChild() { return this.childNodes[0] ?? null }
  get lastChild() { return this.childNodes.at(-1) ?? null }
  get nextSibling() { const a = this.parentNode?.childNodes; return a?.[a.indexOf(this) + 1] ?? null }
  get previousSibling() { const a = this.parentNode?.childNodes; return a?.[a.indexOf(this) - 1] ?? null }
  appendChild(node) { return this.insertBefore(node, null) }
  insertBefore(node, before) {
    node.parentNode?.removeChild(node)
    const at = before ? this.childNodes.indexOf(before) : this.childNodes.length
    assert.ok(at >= 0); this.childNodes.splice(at, 0, node); node.parentNode = this; return node
  }
  removeChild(node) { const i = this.childNodes.indexOf(node); assert.ok(i >= 0); this.childNodes.splice(i, 1); node.parentNode = null; return node }
  set textContent(text) {
    for (const node of this.childNodes) node.parentNode = null
    this.childNodes = []
    if (text !== '') this.appendChild(this.ownerDocument.createTextNode(String(text)))
  }
  get textContent() { return this.childNodes.map(node => node.textContent).join('') }
  setAttribute(name, value) { this.attributes.set(name, String(value)) }
  removeAttribute(name) { this.attributes.delete(name) }
  getAttribute(name) { return this.attributes.get(name) ?? null }
  setAttributeNS(_namespace, name, value) { this.setAttribute(name, value) }
  removeAttributeNS(_namespace, name) { this.removeAttribute(name) }
  addEventListener(type, listener) { const a = this.listeners.get(type) ?? []; a.push(listener); this.listeners.set(type, a) }
  removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(item => item !== listener)) }
  querySelectorAll(selector) { return findAll(this, node => [...selector.matchAll(/\[([^=\]]+)(?:=([^\]]+))?\]/g)].every(([, name, value]) => node.getAttribute(name) !== null && (value === undefined || node.getAttribute(name) === value))) }
  contains(node) { return this === node || this.childNodes.some(child => child.contains?.(node)) }
  focus() { this.ownerDocument.activeElement = this }
  scrollIntoView() {}
  scrollTo({ top }) { this.scrollTop = top; calls.push(['scroll', top]) }
  get dataset() { return Object.fromEntries([...this.attributes].filter(([name]) => name.startsWith('data-')).map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase()), value])) }
}
class HostText extends HostNode {
  constructor(value, doc) { super(3, '#text', doc); this.nodeValue = value }
  get textContent() { return this.nodeValue }
  set textContent(value) { this.nodeValue = value }
}
const document = new HostNode(9, '#document', null)
document.ownerDocument = document
document.createElement = name => Object.assign(new HostNode(1, name.toUpperCase(), document), { namespaceURI: 'http://www.w3.org/1999/xhtml' })
document.createElementNS = (namespaceURI, name) => Object.assign(document.createElement(name), { namespaceURI })
document.createTextNode = value => new HostText(value, document)
document.documentElement = document.createElement('html')
document.body = document.createElement('body')
document.documentElement.appendChild(document.body)
document.activeElement = document.body
const window = { document, location: { href: 'http://synthetic.invalid/' }, HTMLElement: HostNode, HTMLIFrameElement: class {}, addEventListener() {}, removeEventListener() {}, dispatchEvent(event) { calls.push(['event', event.type, event.detail]) } }
document.defaultView = window
globalThis.window = window; globalThis.document = document
globalThis.HTMLElement = HostNode; globalThis.Node = HostNode
globalThis.IS_REACT_ACT_ENVIRONMENT = true
globalThis.matchMedia = () => ({ matches: true })
globalThis.requestAnimationFrame = callback => setTimeout(() => callback(0), 0)
globalThis.cancelAnimationFrame = clearTimeout
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent: 'Synthetic React DOM host', clipboard: { writeText: async text => calls.push(['copy', text]) } } })
const observers = []
globalThis.IntersectionObserver = class {
  constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this) }
  observe(node) { this.targets.add(node) }
  unobserve(node) { this.targets.delete(node) }
  disconnect() { this.targets.clear() }
}

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { ConversationLog } = await import('../src/xixi/ConversationLog.tsx')
const { MessageMarkdown } = await import('../src/xixi/MessageMarkdown.tsx')
const { conversationTimeline, mergeConversation, mergeOperationReceipt } = await import('../src/xixi/conversationTimeline.ts')
const { TestDeadlineContext } = await import('../src/home/HomeDeadlinePicker.tsx')
const { ContextMeter } = await import('../src/xixi/ContextMeter.tsx')
const { receiptEstimateRequest } = await import('../src/xixi/receiptTaskSettings.ts')
const h = React.createElement
const act = React.act
const at = '2026-10-15T00:00:00.000Z'
const clone = value => structuredClone(value)
const message = (id, role, seq, extra = {}) => ({ id: `${id}:${role}`, requestId: id, role, seq, content: `${role} ${id}`, createdAt: at, ...extra })
const operation = (id, extra = {}) => ({ id: `op:${id}`, requestId: id, summary: `已安排 ${id}`, createdAt: at, readAt: null, undoneAt: null, createdTasks: [{ id: `task:${id}`, title: `事项 ${id}`, estimateMin: 30, due: '2026-10-16', updatedAt: at }], ...extra })
const source = (title = '完整来源') => ({ url: 'https://example.invalid/reference', title, fetchStatus: 'ok', fetchedAt: at })
const state = (messages, operations = [], extra = {}) => ({ conversationId: 'main', messages, operations, ...extra })
function findAll(node, predicate) { return node.childNodes.flatMap(child => [...(child.nodeType === 1 && predicate(child) ? [child] : []), ...findAll(child, predicate)]) }
const byAttr = (node, name, value) => findAll(node, item => item.getAttribute(name) === value)
const byClass = (node, name) => findAll(node, item => (item.getAttribute('class') ?? '').split(' ').includes(name))
const button = (node, text) => findAll(node, item => item.tagName === 'BUTTON' && item.textContent === text)[0]
const propsOf = node => node[Object.keys(node).find(key => key.startsWith('__reactProps$'))]
async function click(node) { assert.ok(node, 'action node exists'); await act(async () => { await propsOf(node).onClick({ preventDefault() {}, stopPropagation() {} }) }) }
const count = kind => counts.filter(item => item.kind === kind).length
const snapshot = () => Object.fromEntries([...instrumented.keys()].map(kind => [kind, count(kind)]))
const delta = baseline => Object.fromEntries(Object.entries(snapshot()).map(([kind, value]) => [kind, value - baseline[kind]]))

function chatFor(conversation, extra = {}) {
  return {
    conversation, stream: null, interruptedReasoning: {}, status: { configured: true }, loading: false,
    loadError: '', sending: false, busy: false, olderLoading: false, olderError: '', undoing: null, retracting: null,
    send: async (...args) => { calls.push(['send', ...args]); return true },
    undo: async id => { calls.push(['undo', id]) }, refresh: async () => { calls.push(['refresh']) },
    markRead: async ids => { calls.push(['read', ids]) }, loadOlder: async () => true,
    retryMessage: async id => { calls.push(['retry', id]); return true },
    retractMessage: async entry => { calls.push(['retract', entry.id]); return true }, ...extra,
  }
}
async function mount(chat, extra = {}) {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container)
  let props = { chat, active: true, context: { page: 'home', timezone: 'Asia/Shanghai' }, onSettings() {}, onSent: text => calls.push(['sent', text]), onRetracted: (...args) => calls.push(['retracted', ...args]), ...extra }
  let picker = null
  const render = async () => act(async () => root.render(h(TestDeadlineContext.Provider, { value: picker }, h(ConversationLog, props))))
  await render()
  return {
    container, get props() { return props },
    update: async patch => { props = { ...props, ...patch }; await render() },
    picker: async value => { picker = value; await render() },
    unmount: async () => { await act(async () => root.unmount()); document.body.removeChild(container) },
  }
}

test('timeline shares complete unchanged rows and invalidates real data changes', () => {
  const user = message('a', 'user', 1, { hasSavedReasoning: true }), reply = message('a', 'assistant', 3)
  const pending = message('b', 'user', 4, { delivery: 'failed' })
  const current = state([user, reply, pending, message('hidden', 'tool', 5)], [operation('a'), operation('b'), operation('unloaded')], { companionActions: [{ id: 'link', requestId: 'a', kind: 'goal', label: '完整目标', createdAt: at }] })
  const before = conversationTimeline(current)
  const equal = conversationTimeline(clone(current), before)
  assert.equal(equal, before)
  assert.ok(equal.every((row, index) => row === before[index]))
  const changed = clone(current)
  changed.messages[1].content = 'different content'
  changed.operations[1].readAt = at
  changed.operations[1].createdTasks[0].estimateMin = 45
  const after = conversationTimeline(changed, before)
  assert.equal(after[0], before[0]); assert.notEqual(after[1], before[1]); assert.notEqual(after[2], before[2])
  assert.equal(after[1].message.content, 'different content')
  assert.equal(after[2].operations[0].createdTasks[0].estimateMin, 45)
  assert.deepEqual(after.flatMap(row => row.operations.map(op => [row.message.id, op.id])), [[reply.id, 'op:a'], [pending.id, 'op:b']])
  const finished = mergeConversation(current, state([message('b', 'assistant', 6)], current.operations))
  assert.equal(conversationTimeline(finished).at(-1).operations[0].id, 'op:b')
  const withdrawn = mergeConversation(finished, state([{ ...user, content: '已撤回', retractedAt: at }], current.operations))
  const rows = conversationTimeline(withdrawn)
  assert.equal(rows[0].operations[0].id, 'op:a'); assert.equal(rows[0].companionActions.length, 0)
  assert.ok(!rows.some(row => row.message.id === reply.id))
  const combined = mergeOperationReceipt(current, operation('a', { relatedOperationIds: ['op:b'], summary: '整批已撤销', undoneAt: at }))
  assert.equal(combined.operations.filter(op => ['op:a', 'op:b'].includes(op.id)).length, 1)
})

test('40 saved long replies: 32 token updates and 16 focus/composer renders do no historical work', async t => {
  const long = '# 完整正文\n\n' + '**保留所有文字** 与 [来源](https://example.invalid/)\n\n'.repeat(60) + '正文终点'
  const thought = '思考正文'.repeat(800) + '思考终点'
  const messages = Array.from({ length: 40 }, (_, i) => [message(`saved${i}`, 'user', i * 3), message(`saved${i}`, 'assistant', i * 3 + 2, { content: `${i}\n${long}`, reasoningContent: thought, sources: [source()] })]).flat()
  const conversation = state(messages, Array.from({ length: 10 }, (_, i) => operation(`saved${i}`)))
  const stream = { requestId: 'live', conversationId: 'main', round: 1, content: '开始', reasoningContent: '', phase: 'replying' }
  const chat = chatFor(conversation, { sending: true, busy: true, stream })
  const initialBaseline = snapshot()
  const view = await mount(chat); t.after(view.unmount)
  const initial = delta(initialBaseline)
  assert.equal(initial.conversationTimeline, 1); assert.equal(initial.SavedMessage, 80)
  assert.equal(initial.MessageMarkdown, 41); assert.equal(initial.ReceiptDeadline, 10)
  assert.equal(byAttr(view.container, 'data-message-id', 'saved39:assistant')[0].textContent.includes('正文终点'), true)
  assert.equal(byClass(view.container, 'xixi-reasoning').length, 40)
  assert.equal(byClass(view.container, 'xixi-reasoning-content').length, 40)
  assert.ok(byClass(view.container, 'xixi-reasoning-content').every(node => node.textContent.endsWith('思考终点')))
  assert.equal(byClass(view.container, 'xixi-sources').length, 40)
  const historyNode = byAttr(view.container, 'data-message-id', 'saved0:assistant')[0]
  const selectedTextNode = byClass(historyNode, 'xixi-markdown')[0].firstChild
  const baseline = snapshot()
  for (let i = 0; i < 32; i++) await view.update({ chat: { ...chat, stream: { ...stream, content: stream.content + '字'.repeat(i + 1) } } })
  const streaming = delta(baseline)
  assert.equal(streaming.conversationTimeline, 0); assert.equal(streaming.SavedHistory, 0); assert.equal(streaming.SavedMessage, 0)
  assert.equal(streaming.ReceiptDeadline, 0); assert.equal(streaming.MessageMarkdown, 32)
  const focusBaseline = snapshot()
  for (let i = 0; i < 16; i++) await view.update({ chat: { ...view.props.chat }, context: { page: 'workbench', taskId: `focus${i}`, elapsed: i }, children: h('p', null, `草稿 ${i}`) })
  const focus = delta(focusBaseline)
  for (const kind of instrumented.keys()) assert.equal(focus[kind], 0, `${kind} skips timer/input changes`)
  assert.equal(byAttr(view.container, 'data-message-id', 'saved0:assistant')[0], historyNode)
  assert.equal(byClass(historyNode, 'xixi-markdown')[0].firstChild, selectedTextNode, 'unchanged host nodes stay selectable')
  t.diagnostic(JSON.stringify({ savedReplies: 40, receiptEditors: 10, tokenUpdates: 32, streamRenders: streaming, focusAndInputUpdates: 16, focusRenders: focus }))
})

test('same-ID/same-length text, reasoning, sources and receipts update; equal cloned rows skip work', async t => {
  const conversation = state([message('a', 'user', 1), message('a', 'assistant', 2, { content: '**AAAA**', reasoningContent: 'thought A', sources: [source('来源A')] }), message('b', 'user', 3), message('b', 'assistant', 4, { content: '**BBBB**' })], [operation('a'), operation('b')])
  const view = await mount(chatFor(conversation)); t.after(view.unmount)
  const untouched = byAttr(view.container, 'data-message-id', 'b:assistant')[0]
  const next = clone(conversation)
  next.messages[1].content = '**CCCC**'; next.messages[1].reasoningContent = 'thought C'; next.messages[1].sources = [source('来源C')]
  const baseline = snapshot()
  await view.update({ chat: { ...view.props.chat, conversation: next } })
  const changed = delta(baseline)
  assert.equal(changed.MessageMarkdown, 1); assert.equal(changed.SavedMessage, 1); assert.equal(changed.ReceiptDeadline, 0)
  const row = byAttr(view.container, 'data-message-id', 'a:assistant')[0]
  assert.match(row.textContent, /CCCC/); assert.match(row.textContent, /thought C/); assert.match(row.textContent, /来源C/)
  assert.equal(byAttr(view.container, 'data-message-id', 'b:assistant')[0], untouched)
  const receipt = clone(next)
  receipt.operations[0].summary = '更新回执'; receipt.operations[0].readAt = at
  receipt.operations[0].createdTasks[0] = { ...receipt.operations[0].createdTasks[0], due: '2026-10-19', estimateMin: 45, updatedAt: '2026-10-15T01:00:00.000Z' }
  const receiptBaseline = snapshot()
  await view.update({ chat: { ...view.props.chat, conversation: receipt } })
  assert.equal(delta(receiptBaseline).MessageMarkdown, 0); assert.equal(delta(receiptBaseline).SavedMessage, 1)
  assert.match(row.textContent, /更新回执/); assert.match(row.textContent, /2026\/10\/19/); assert.match(row.textContent, /45 分钟/)
  assert.equal(byAttr(row, 'data-operation-id', 'op:a')[0].getAttribute('data-unread'), 'false')
  const equalBaseline = snapshot()
  await view.update({ chat: { ...view.props.chat, conversation: clone(receipt) } })
  assert.equal(delta(equalBaseline).SavedMessage, 0); assert.equal(delta(equalBaseline).ReceiptDeadline, 0)
  const undone = clone(receipt); undone.operations[0].undoneAt = at
  await view.update({ chat: { ...view.props.chat, conversation: undone } })
  assert.match(row.textContent, /已撤销/); assert.equal(byClass(row, 'xixi-receipt-deadline').length, 0)
})

test('memo boundaries retain quick answers, latest context, retry, copy, retraction and receipt actions', async t => {
  const failed = message('failed', 'user', 1, { delivery: 'failed', attachments: [{ name: 'synthetic.png', data: 'data:image/png;base64,c3ludGhldGlj', mime: 'image/png', size: 9 }] })
  const question = message('question', 'assistant', 2, { content: '请选择', question: { options: ['选项A', '选项B'] }, executionNotice: { issues: ['尚待核对'], replyUnavailable: true } })
  const conversation = state([failed, question], [operation('question')])
  const view = await mount(chatFor(conversation)); t.after(view.unmount)
  const newContext = { page: 'workbench', taskId: 'latest-task', timezone: 'Asia/Shanghai' }
  await view.update({ context: newContext, chat: { ...view.props.chat, send: async (...args) => { calls.push(['latestSend', ...args]); return true } } })
  await click(button(view.container, '选项B'))
  assert.deepEqual(calls.findLast(call => call[0] === 'latestSend'), ['latestSend', '选项B', newContext])
  await click(button(view.container, '重试')); assert.deepEqual(calls.findLast(call => call[0] === 'retry'), ['retry', 'failed'])
  await click(byClass(view.container, 'xixi-message-copy')[0]); assert.deepEqual(calls.findLast(call => call[0] === 'copy'), ['copy', failed.content])
  await click(button(view.container, '撤回')); assert.deepEqual(calls.findLast(call => call[0] === 'retracted'), ['retracted', failed.content, failed.attachments])
  await click(button(view.container, '撤销')); assert.deepEqual(calls.findLast(call => call[0] === 'undo'), ['undo', 'op:question'])
  const readObserver = observers.findLast(observer => observer.targets.size > 0)
  await act(async () => readObserver.callback([...readObserver.targets].map(target => ({ target, isIntersecting: true, intersectionRatio: 1 }))))
  assert.deepEqual(calls.findLast(call => call[0] === 'read'), ['read', ['op:question']])
  await view.update({ active: false })
  assert.equal(propsOf(button(view.container, '选项A')).disabled, true)
  assert.equal(propsOf(button(view.container, '撤回')).disabled, true)
})

test('estimate action uses the original receipt task, validates saved schedule, keeps drafts, and releases locks', async t => {
  const op = operation('estimate')
  const conversation = state([message('estimate', 'assistant', 1)], [op])
  const view = await mount(chatFor(conversation), { children: h('textarea', { value: '保留草稿', readOnly: true }) }); t.after(view.unmount)
  let resolveSend
  const pending = new Promise(resolve => { resolveSend = resolve })
  fixture.store.getTask = async id => ({ ...op.createdTasks[0], id, estimateMin: 45 })
  fixture.api = async path => { assert.equal(path, '/planner'); return { blocks: [{ taskId: op.createdTasks[0].id, date: '2026-10-15', start: '10:00', end: '10:45' }] } }
  await view.update({ context: { page: 'workbench', taskId: 'unrelated', timezone: 'Asia/Shanghai' }, chat: { ...view.props.chat, send: async (...args) => { calls.push(['estimateSend', ...args]); return pending } } })
  const sentBefore = calls.filter(call => call[0] === 'sent').length
  await click(button(view.container, '45分'))
  const sent = calls.findLast(call => call[0] === 'estimateSend')
  assert.deepEqual(sent.slice(1), Object.values(receiptEstimateRequest(op.createdTasks[0], 45, view.props.context)))
  assert.match(view.container.textContent, /30 分钟/); assert.match(view.container.textContent, /正在交给析熙/)
  assert.equal(propsOf(button(view.container, '60分')).disabled, true)
  await act(async () => resolveSend(true))
  assert.match(view.container.textContent, /请查看聊天中的处理结果/)
  assert.equal(calls.filter(call => call[0] === 'sent').length, sentBefore)
  assert.equal(propsOf(findAll(view.container, node => node.tagName === 'TEXTAREA')[0]).value, '保留草稿')
  fixture.api = async () => ({ blocks: [] })
  await view.update({ chat: { ...view.props.chat, send: async () => true } })
  await click(button(view.container, '45分'))
  assert.match(view.container.textContent, /尚未同步|尚未确认/)
  assert.equal(propsOf(button(view.container, '60分')).disabled, false)
})

test('ReceiptDeadline local edits and picker context still render through ancestor memo', async t => {
  const op = operation('picker')
  const view = await mount(chatFor(state([message('picker', 'assistant', 1)], [op]))); t.after(view.unmount)
  const host = document.createElement('div'); document.body.appendChild(host); t.after(() => document.body.removeChild(host))
  let pickerState
  const picker = { draft: null, presentedDraft: null, host, close() {}, update() {}, isCurrent: () => true, open: draft => { pickerState = draft } }
  const before = snapshot(); await view.picker(picker)
  assert.ok(delta(before).ReceiptDeadline > 0, 'real useContext invalidates the editor through memo')
  assert.equal(delta(before).MessageMarkdown, 0)
  await click(button(view.container, '日期 / 时刻')); assert.equal(pickerState.title, op.createdTasks[0].title)
  await view.picker({ ...picker, draft: { ...pickerState, token: 1 }, presentedDraft: { ...pickerState, token: 1 } })
  assert.ok(host.textContent.includes('保存截止时间'), 'real portal remains connected')
  // A real local DDL save uses the current task edit token and refresh callback.
  fixture.store.updateTask = async (id, patch, updatedAt) => { calls.push(['taskPatch', id, patch, updatedAt]); return { ...op.createdTasks[0], ...patch, updatedAt: '2026-10-15T02:00:00.000Z' } }
  fixture.api = async () => ({ blocks: [] })
  await click(button(view.container, '明天'))
  assert.equal(calls.findLast(call => call[0] === 'taskPatch')[1], op.createdTasks[0].id)
  assert.deepEqual(calls.findLast(call => call[0] === 'refresh'), ['refresh'])
  assert.ok(count('ReceiptDeadline') > before.ReceiptDeadline)
})

test('prepend preserves scroll anchor, following streams scroll, and a foreign stream is hidden', async t => {
  const current = state([message('now', 'user', 10), message('now', 'assistant', 11)], [], { hasOlder: true, oldestSeq: 10 })
  let resolveOlder
  const loading = new Promise(resolve => { resolveOlder = resolve })
  const view = await mount(chatFor(current, { loadOlder: () => loading })); t.after(view.unmount)
  const log = byClass(view.container, 'xixi-conversation')[0]
  log.scrollTop = 120; log.scrollHeight = 1000
  await act(async () => { void propsOf(button(view.container, '更早的对话')).onClick() })
  log.scrollHeight = 1700
  const older = state([message('old', 'user', 1), message('old', 'assistant', 2), ...current.messages], [], { oldestSeq: 1, hasOlder: false })
  await view.update({ chat: { ...view.props.chat, conversation: older } })
  assert.equal(log.scrollTop, 820)
  await act(async () => resolveOlder(true))
  const stream = { requestId: 'live', conversationId: 'main', round: 1, content: '流式正文', reasoningContent: '', phase: 'replying' }
  await view.update({ chat: { ...view.props.chat, sending: true, stream } })
  assert.equal(log.scrollTop, 820, 'reading older history does not jump to bottom')
  propsOf(log).onScroll({ currentTarget: Object.assign(log, { scrollTop: 1400 }) })
  await view.update({ chat: { ...view.props.chat, stream: { ...stream, content: '流式正文追加' } } })
  assert.equal(log.scrollTop, 1700)
  await view.update({ chat: { ...view.props.chat, stream: { ...stream, conversationId: 'elsewhere' } } })
  assert.equal(byClass(view.container, 'xixi-stream').length, 0)
})

test('null/loading conversation and topic changes invalidate the scoped timeline safely', async t => {
  const view = await mount(chatFor(null, { loading: true })); t.after(view.unmount)
  assert.match(view.container.textContent, /正在读我们的对话/)
  const first = state([message('same', 'assistant', 1, { content: '第一个对话' })], [operation('same')])
  await view.update({ chat: chatFor(first) })
  assert.match(view.container.textContent, /第一个对话/)
  const before = snapshot()
  await view.update({ chat: chatFor({ ...first, conversationId: 'second', messages: [message('same', 'assistant', 1, { content: '第二个对话' })] }) })
  assert.equal(delta(before).conversationTimeline, 1)
  assert.match(view.container.textContent, /第二个对话/)
  assert.ok(!view.container.textContent.includes('第一个对话'))
  await view.update({ chat: chatFor(null) })
  assert.match(view.container.textContent, /我在，慢慢说/)
})

test('midnight refreshes date shortcuts once without remounting the open deadline editor', async t => {
  const NativeDate = globalThis.Date
  let now = new NativeDate(2026, 9, 15, 23, 59).getTime()
  globalThis.Date = class extends NativeDate {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  t.after(() => { globalThis.Date = NativeDate })
  const view = await mount(chatFor(state([message('midnight', 'assistant', 1)], [operation('midnight')]))); t.after(view.unmount)
  assert.equal(propsOf(button(view.container, '今天'))['aria-pressed'], false)
  await click(button(view.container, '日期 / 时刻'))
  const editor = byClass(view.container, 'xixi-deadline-reveal')[0]
  assert.equal(editor.getAttribute('data-open'), 'true')
  const baseline = snapshot()
  now += 120_000
  await view.update({ context: { page: 'workbench', elapsed: 1 } })
  assert.equal(propsOf(button(view.container, '今天'))['aria-pressed'], true)
  assert.equal(delta(baseline).ReceiptDeadline, 1); assert.equal(delta(baseline).MessageMarkdown, 0)
  assert.equal(delta(baseline).conversationTimeline, 0)
  assert.equal(byClass(view.container, 'xixi-deadline-reveal')[0], editor)
  assert.equal(editor.getAttribute('data-open'), 'true')
  const next = snapshot()
  await view.update({ context: { page: 'workbench', elapsed: 2 } })
  assert.equal(delta(next).ReceiptDeadline, 0)
})

test('receipt visibility observation follows reanchoring even when the operation array stays identical', async t => {
  const operations = [operation('moving')]
  const user = message('moving', 'user', 1)
  const view = await mount(chatFor(state([user], operations))); t.after(view.unmount)
  const oldReceipt = byAttr(view.container, 'data-operation-id', 'op:moving')[0]
  const oldObserver = observers.at(-1)
  assert.ok(oldObserver.targets.has(oldReceipt))
  await view.update({ chat: { ...view.props.chat, conversation: state([user, message('moving', 'assistant', 2)], operations) } })
  const receipt = byAttr(view.container, 'data-operation-id', 'op:moving')[0]
  assert.notEqual(receipt, oldReceipt)
  assert.equal(oldObserver.targets.size, 0)
  assert.ok(observers.at(-1).targets.has(receipt))
  const before = calls.filter(call => call[0] === 'read').length
  await act(async () => observers.at(-1).callback([{ target: receipt, isIntersecting: true, intersectionRatio: .5 }]))
  assert.equal(calls.filter(call => call[0] === 'read').length, before)
  await act(async () => observers.at(-1).callback([{ target: receipt, isIntersecting: true, intersectionRatio: .75 }]))
  assert.deepEqual(calls.findLast(call => call[0] === 'read'), ['read', ['op:moving']])
})

test('thinking controls mount before provider text and copy feedback replaces the same button label', async t => {
  const stream = { requestId: 'waiting', conversationId: 'main', round: -1, phase: 'thinking', content: '', reasoningContent: '' }
  const view = await mount(chatFor(state([message('waiting', 'user', 1)]), { sending: true, busy: true, stream })); t.after(view.unmount)
  const reasoning = byClass(view.container, 'xixi-reasoning')[0]
  const copy = button(reasoning, '复制本次全部思考')
  assert.ok(reasoning)
  assert.equal(byClass(reasoning, 'xixi-reasoning-toggle')[0].textContent, '思考中')
  assert.notEqual(copy.getAttribute('disabled'), null)
  assert.equal(byClass(view.container, 'xixi-stream-status')[0].textContent, '正在思考')
  await click(byClass(reasoning, 'xixi-reasoning-toggle')[0])
  assert.match(reasoning.textContent, /正在等待模型返回思考内容/u)
  const thought = '【进度】核对当前安排\n完整思考内容'
  await view.update({ chat: { ...view.props.chat, stream: { ...stream, round: 1, reasoningContent: thought, reasoningRounds: [{ id: 'live:1', round: 1, content: thought }] } } })
  assert.equal(byClass(view.container, 'xixi-reasoning')[0], reasoning, 'first token does not insert a new reasoning row')
  assert.equal(button(reasoning, '复制本次全部思考'), copy)
  assert.equal(copy.getAttribute('disabled'), null)
  await click(copy)
  assert.deepEqual(calls.findLast(call => call[0] === 'copy'), ['copy', thought])
  assert.equal(copy.textContent, '已复制')
  assert.equal(copy.getAttribute('data-label'), '复制本次全部思考')
  assert.equal(byClass(reasoning, 'xixi-reasoning-copy')[0].childNodes.length, 1, 'success adds no second row')
})

test('thinking title replaces only the waiting status while full reasoning expansion and copy survive transitions', async t => {
  const thought = '【进度】读取真实安排\n' + '完整思考'.repeat(600) + '思考末尾'
  const rounds = [{ id: 'round1', round: 1, content: thought }, { id: 'round2', round: 2, content: '【进度】核对时间冲突\n第二段末尾' }]
  const user = message('thinking', 'user', 1, { hasSavedReasoning: true })
  const stream = { requestId: 'thinking', conversationId: 'main', round: 2, phase: 'thinking', content: '', reasoningContent: rounds.map(part => part.content).join('\n\n'), reasoningRounds: rounds }
  fixture.api = async path => {
    assert.ok(path.startsWith('/conversation/reasoning?'))
    return { reasoningContent: stream.reasoningContent, rounds, status: 'completed' }
  }
  const view = await mount(chatFor(state([user], [operation('thinking')]), { sending: true, busy: true, stream })); t.after(view.unmount)
  assert.equal(byClass(view.container, 'xixi-reasoning-toggle').length, 1)
  assert.equal(byClass(view.container, 'xixi-stream-status')[0].textContent, '核对时间冲突')
  assert.equal(byClass(view.container, 'xixi-reasoning')[0].getAttribute('data-expanded'), 'false')
  assert.doesNotMatch(view.container.textContent, /模型曾|模型正在/u)
  await click(byClass(view.container, 'xixi-reasoning-toggle')[0])
  assert.equal(byClass(view.container, 'xixi-reasoning')[0].getAttribute('data-expanded'), 'true')
  assert.ok(byClass(view.container, 'xixi-reasoning-content')[0].textContent.includes(thought))
  await view.update({ chat: { ...view.props.chat, stream: { ...stream, phase: 'replying', content: '好' } } })
  assert.equal(byClass(view.container, 'xixi-stream-status')[0].textContent, '正在回复')
  assert.equal(byAttr(view.container, 'data-thinking-headline', 'true').length, 0)
  assert.equal(byClass(view.container, 'xixi-reasoning')[0].getAttribute('data-expanded'), 'true')
  const finished = state([user, message('thinking', 'assistant', 3, { content: '完整回复' })], [operation('thinking')])
  await view.update({ chat: { ...view.props.chat, conversation: finished, sending: false, busy: false, stream: null } })
  const saved = byClass(view.container, 'xixi-reasoning')[0]
  assert.equal(byClass(view.container, 'xixi-reasoning').length, 1)
  assert.equal(saved.getAttribute('data-expanded'), 'true')
  assert.ok(saved.textContent.includes(thought)); assert.match(saved.textContent, /第二段末尾/u)
  assert.equal(byClass(view.container, 'xixi-stream-status').length, 0)
  await click(button(saved, '复制完整思考'))
  assert.deepEqual(calls.findLast(call => call[0] === 'copy'), ['copy', stream.reasoningContent])
  const retry = { ...stream, phase: 'replying', content: '正在补充' }
  await view.update({ chat: { ...view.props.chat, sending: true, busy: true, stream: retry } })
  assert.equal(byClass(view.container, 'xixi-reasoning').length, 1)
  assert.equal(byClass(view.container, 'xixi-reasoning')[0].getAttribute('data-expanded'), 'true')
  const failed = state([{ ...user, delivery: 'failed' }], finished.operations)
  await view.update({ chat: { ...view.props.chat, conversation: failed, sending: false, busy: false, stream: null, interruptedReasoning: { thinking: retry } } })
  const interrupted = byClass(view.container, 'xixi-reasoning')[0]
  assert.equal(interrupted.getAttribute('data-expanded'), 'true'); assert.match(interrupted.textContent, /回复中断/u)
  assert.ok(interrupted.textContent.includes(thought))
  const withdrawn = state([{ ...user, retractedAt: at }], finished.operations)
  await view.update({ chat: { ...view.props.chat, conversation: withdrawn } })
  assert.equal(byClass(view.container, 'xixi-reasoning').length, 0)
  assert.equal(byAttr(view.container, 'data-operation-id', 'op:thinking').length, 1)
  assert.match(view.container.textContent, /已撤回/)
})

test('pending answers respect draft revision and receipt retries never clear the composer', async t => {
  const task = operation('created').createdTasks[0]
  const estimate = receiptEstimateRequest(task, 45, { page: 'home', timezone: 'Asia/Shanghai' })
  const failed = message('retry-estimate', 'user', 1, { content: estimate.text, delivery: 'failed' })
  const question = message('ask', 'assistant', 2, { question: { options: ['选定'] } })
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const view = await mount(chatFor(state([failed, question]), { send: async () => pending })); t.after(view.unmount)
  const baseline = calls.filter(call => call[0] === 'sent').length
  await click(button(view.container, '重试'))
  assert.equal(calls.filter(call => call[0] === 'sent').length, baseline)
  await click(button(view.container, '选定'))
  await click(button(view.container, '撤回'))
  await act(async () => finish(true))
  assert.equal(calls.filter(call => call[0] === 'sent').length, baseline, 'a withdrawal while waiting protects the restored draft')
})

test('hidden estimate requests preserve natural replies, receipts, failures and cancellation without empty bubbles', async t => {
  const task = operation('created').createdTasks[0]
  const request = receiptEstimateRequest(task, 60, { page: 'home', timezone: 'Asia/Shanghai' })
  const input = message('adjust', 'user', 1, { content: request.text, taskId: task.id })
  const naturalReply = '这次原时段能放下，我把结束时间延到了 19:00。'
  const reply = message('adjust', 'assistant', 2, { content: naturalReply })
  const receipt = operation('adjust', { summary: '安排 1 段任务时间', details: ['2026-10-17 18:00–19:00'], createdTasks: undefined })
  const view = await mount(chatFor(state([input, reply], [receipt]))); t.after(view.unmount)
  assert.equal(byAttr(view.container, 'data-message-id', input.id).length, 0)
  assert.equal(byClass(view.container, 'xixi-markdown')[0].textContent, naturalReply)
  assert.equal(byAttr(view.container, 'data-operation-id', receipt.id).length, 1)
  assert.ok(!view.container.textContent.includes(request.text))
  // Reload/history snapshots use the same component, not just optimistic state.
  await view.update({ chat: chatFor(clone(state([input, reply], [receipt]))) })
  assert.equal(byAttr(view.container, 'data-message-id', input.id).length, 0)
  const failed = { ...input, delivery: 'failed' }
  await view.update({ chat: chatFor(state([failed], [receipt])) })
  assert.match(view.container.textContent, /估时调整尚未完成/)
  assert.ok(!view.container.textContent.includes(request.text))
  assert.equal(byAttr(view.container, 'data-operation-id', receipt.id).length, 1)
  await click(button(view.container, '重试'))
  assert.deepEqual(calls.at(-1), ['retry', input.requestId])
  const stream = { requestId: input.requestId, conversationId: 'main', round: -1, phase: 'thinking', content: '', reasoningContent: '' }
  await view.update({ chat: chatFor(state([{ ...input, delivery: 'sending' }]), { stream, sending: true, busy: true }) })
  assert.equal(byAttr(view.container, 'data-message-id', input.id).length, 0)
  const restoredDrafts = calls.filter(call => call[0] === 'retracted').length
  await click(button(view.container, '取消调整'))
  assert.equal(calls.filter(call => call[0] === 'retracted').length, restoredDrafts, 'internal request never enters the composer')
  const withdrawn = { ...input, inputKind: 'receipt-estimate', content: '已撤回', retractedAt: at }
  await view.update({ chat: chatFor(state([withdrawn], [receipt])) })
  assert.ok(!view.container.textContent.includes('已撤回'))
  assert.equal(byAttr(view.container, 'data-operation-id', receipt.id).length, 1)
  const ordinary = { ...input, content: '请把这项作业改为60分钟，我还想说明一下原因。' }
  await view.update({ chat: chatFor(state([ordinary])) })
  assert.ok(view.container.textContent.includes(ordinary.content))
  assert.equal(byAttr(view.container, 'data-role', 'user').length, 1)
})

test('assistant pipe tables render transparent semantic rows; code examples remain code', async t => {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container); t.after(async () => { await act(async () => root.unmount()); document.body.removeChild(container) })
  const table = '| 遇到 | 变成 |\n|---|---|\n| 1/α + 1/β | (α+β)/(αβ) |\n| α² + β² | (α+β)² − 2αβ |\n| (α−β)² | (α+β)² − 4αβ |\n| α³ + β³ | (α+β)³ − 3αβ(α+β) |'
  await act(async () => root.render(h(MessageMarkdown, { content: table })))
  assert.equal(findAll(container, node => node.tagName === 'TABLE').length, 1)
  assert.equal(findAll(container, node => node.tagName === 'TH').length, 2)
  assert.equal(findAll(container, node => node.tagName === 'TD').length, 8)
  assert.equal(findAll(container, node => node.tagName === 'TH')[0].getAttribute('scope'), 'col')
  assert.equal(byClass(container, 'xixi-markdown-table')[0].getAttribute('tabindex'), '0')
  assert.match(container.textContent, /α³ \+ β³/)
  await act(async () => root.render(h(MessageMarkdown, { content: '```text\n' + table + '\n```' })))
  assert.equal(findAll(container, node => node.tagName === 'TABLE').length, 0)
  assert.equal(findAll(container, node => node.tagName === 'PRE').length, 1)
  assert.ok(container.textContent.includes(table))
  await act(async () => root.render(h(MessageMarkdown, { content: '价格 $5，另一个是 $10。' })))
  assert.equal(byClass(container, 'xixi-math').length, 0)
  assert.equal(container.textContent, '价格 $5，另一个是 $10。')
})

test('context ring renders actual proportion, clamps full state, and never reuses another model measurement', async t => {
  const container=document.createElement('div');document.body.appendChild(container)
  const root=createRoot(container);t.after(async()=>{await act(async()=>root.unmount());document.body.removeChild(container)})
  const usage={modelKey:'a'.repeat(64),model:'deepseek-flash',capacity:1000000,inputTokens:240000,outputTokens:10000,usedTokens:250000,source:'provider',updatedAt:at}
  const status={configured:true,model:'deepseek-flash',contextModelKey:usage.modelKey,contextCapacity:1000000}
  const render=async(data=usage,chosen=status)=>act(async()=>root.render(h(ContextMeter,{chat:chatFor(state([],[],{contextUsage:data}),{status:chosen})})))
  await render()
  assert.equal(byClass(container,'xixi-context-used')[0].getAttribute('stroke-dasharray'),'25 100')
  assert.match(byClass(container,'xixi-context-control')[0].getAttribute('aria-label'),/250,000 tokens \/ 1M/)
  await render({...usage,inputTokens:1000000,usedTokens:1010000})
  assert.equal(byClass(container,'xixi-context-used')[0].getAttribute('stroke-dasharray'),'100 100')
  await render(usage,{...status,contextModelKey:'b'.repeat(64),model:'deepseek-v4-pro'})
  assert.equal(byClass(container,'xixi-context-used')[0].getAttribute('stroke-dasharray'),'0 100')
  assert.match(byClass(container,'xixi-context-control')[0].getAttribute('aria-label'),/等待下一次请求统计/)
})

test('real markdown keeps safe links, code, full text and image alt without remote resources', async t => {
  const container = document.createElement('div'); document.body.appendChild(container)
  const root = createRoot(container); t.after(async () => { await act(async () => root.unmount()); document.body.removeChild(container) })
  const content = '# 标题\n\n**完整粗体** [安全](https://example.invalid/) [邮件](mailto:test@example.invalid) [危险](javascript:alert(1))\n\n![替代文本](https://example.invalid/image.png)\n\n<script>bad()</script>\n\n```ts\nconst full = 42\n```\n\n终点'
  await act(async () => root.render(h(MessageMarkdown, { content })))
  assert.match(container.textContent, /完整粗体/); assert.match(container.textContent, /const full = 42/); assert.match(container.textContent, /终点/)
  assert.match(container.textContent, /替代文本/); assert.equal(findAll(container, node => node.tagName === 'IMG' || node.tagName === 'SCRIPT').length, 0)
  assert.deepEqual(findAll(container, node => node.tagName === 'A').map(node => node.getAttribute('href')), ['https://example.invalid/', 'mailto:test@example.invalid'])
  const baseline = count('MessageMarkdown')
  await act(async () => root.render(h(MessageMarkdown, { content })))
  assert.equal(count('MessageMarkdown'), baseline)
  await act(async () => root.render(h(MessageMarkdown, { content: content.replace('终点', '末端') })))
  assert.equal(count('MessageMarkdown'), baseline + 1); assert.match(container.textContent, /末端/)
})

test.after(() => { hooks.deregister(); delete globalThis.__conversationRenderTest })


test('batch creations expose each DDL/estimate editor immediately and keep undo on the actual batch', async () => {
  const tasks = ['读书', '练习英语', '散步'].map((title, n) => ({ id: `new-${n}`, title, due: '2026-10-26', estimateMin: 30, updatedAt: at }))
  const op = operation('new-batch', { createdTasks: tasks, scheduledCount: 2, undoLabel: '撤销创建与安排', details: ['已保存三项'] })
  const view = await mount(chatFor(state([message('new-batch', 'user', 1)], [op])))
  try {
    assert.equal(byClass(view.container, 'xixi-receipt-task-settings').length, 3)
    assert.equal(byClass(view.container, 'xixi-receipt-task').length, 3)
    for (const task of tasks) {
      const editor = byAttr(view.container, 'aria-label', `${task.title}的快捷设置`)[0]
      assert.ok(editor)
      for (let parent = editor; parent; parent = parent.parentNode) assert.equal(parent.getAttribute?.('inert'), null)
      assert.match(editor.textContent, /DDL/)
      assert.match(editor.textContent, /预估时间/)
    }
    assert.equal(byClass(view.container, 'xixi-undo').length, 1)
    await click(byClass(view.container, 'xixi-undo')[0])
    assert.deepEqual(calls.at(-1), ['undo', op.id])
  } finally { await view.unmount() }
})
