import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { transformSync } from 'rolldown/utils'
import { randomUUID } from 'node:crypto'
import { createDatabase } from '../server/database.mjs'
import { createXixi } from '../server/xixi.mjs'
import { publicOperation } from '../server/operationReceipts.mjs'
import { dayCapacity } from '../src/planner/model.ts'

process.env.TZ = 'Asia/Shanghai'

// Run the real receipt, shared conversation UI, conversation hook and durable
// retry helper. Only hook scheduling, HTTP, task storage and the calendar portal
// are synthetic; no sockets, provider, native storage or user database is used.
const runtimeKey = '__astariaReceiptEstimateTest'
const sourceRoot = new URL('../src/', import.meta.url).href
const moduleFor = source => ({ url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true })
const loader = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot)) {
      // This fixture checks receipt behaviour, not memo caching. Returning the
      // original function lets expand() traverse memo and ComponentProps-based
      // forwarding wrappers with their complete props. ComponentProps itself
      // is a type-only import erased by the existing TSX transform.
      if (specifier === 'react') return moduleFor(`export const memo = component => component; export const ${['useState', 'useRef', 'useId', 'useMemo', 'useCallback', 'useEffect', 'useLayoutEffect'].map(name => `${name} = (...args) => globalThis.${runtimeKey}.${name}(...args)`).join(', ')};`)
      if (specifier === '../home/HomeDeadlinePicker') return moduleFor('export const useHomeDeadlinePicker = () => null;')
      if (specifier === '../stores/taskStore') return moduleFor(`export const taskStore = { updateTask: (...args) => globalThis.${runtimeKey}.updateTask(...args), getTask: (...args) => globalThis.${runtimeKey}.getTask(...args) };`)
      if (specifier === './MessageMarkdown') return moduleFor('export const MessageMarkdown = ({content}) => content;')
      if (specifier.startsWith('.') && !/\.[a-z]+$/i.test(specifier)) {
        for (const extension of ['.ts', '.tsx']) if (existsSync(fileURLToPath(new URL(`${specifier}${extension}`, context.parentURL)))) return next(`${specifier}${extension}`, context)
      }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith('.css')) return { format: 'module', source: '', shortCircuit: true }
    if (url.startsWith(sourceRoot) && /\.tsx?$/.test(url)) return { format: 'module', shortCircuit: true,
      source: transformSync(fileURLToPath(url), readFileSync(new URL(url), 'utf8'), { jsx: { runtime: 'automatic' } }).code }
    return next(url, context)
  },
})
const { ConversationLog } = await import('../src/xixi/ConversationLog.tsx')
const { useXixiConversation } = await import('../src/xixi/useXixiConversation.ts')
const { createPendingChatRequestStore } = await import('../src/xixi/pendingChatRequest.ts')
const { receiptEstimateRequest, isReceiptEstimateRequest, receiptEstimateSaveIssue } = await import('../src/xixi/receiptTaskSettings.ts')
loader.deregister()

const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes }); return { promise, resolve } }
const originalTask = { id: 'receipt-task', title: '数学作业', due: '2026-10-16', estimateMin: 30, updatedAt: '2026-10-14T01:00:00.000Z' }
const initialMessages = [{ id: 'created-user', seq: 1, role: 'user', requestId: 'creation', content: '记录作业', createdAt: originalTask.updatedAt }]
const initialOperation = { id: 'creation-receipt', requestId: 'creation', summary: '创建 1 项事项', createdAt: originalTask.updatedAt, readAt: originalTask.updatedAt, createdTasks: [originalTask] }
const connected = { provider: 'local', model: 'synthetic-model', configured: true, cloudConfigured: null }
const children = node => Array.isArray(node) ? node : node?.props?.children === undefined ? [] : [node.props.children]
function find(node, predicate) {
  if (node && !Array.isArray(node) && typeof node === 'object' && predicate(node)) return node
  for (const child of children(node)) { const found = find(child, predicate); if (found) return found }
}
const text = node => node == null || typeof node === 'boolean' ? '' : typeof node !== 'object' ? String(node) : children(node).map(text).join('')

async function fixture(t, options = {}) {
  const globals = ['window', 'document', 'sessionStorage', 'matchMedia', 'requestAnimationFrame', runtimeKey]
  const originals = new Map(globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const storage = new Map(), durable = new Map(), instances = new Map(), effects = []
  globalThis.window = { setInterval: () => 0 }
  globalThis.document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  globalThis.sessionStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }
  globalThis.matchMedia = () => ({ matches: true })
  globalThis.requestAnimationFrame = callback => { callback(); return 0 }
  const pendingStore = createPendingChatRequestStore({ session: globalThis.sessionStorage, adapter: {
    async list() { return [...durable.values()].map(value => structuredClone(value)) },
    async put(scope, request) { durable.set(request.requestId, structuredClone(request)) },
    async remove(scope, ids) { for (const id of ids) durable.delete(id) },
  } })
  let instance, cursor, chat, tree
  let currentTask = structuredClone(originalTask), status = options.disconnected ? { ...connected, configured: false } : connected
  let snapshot = { conversationId: 'receipt-conversation', messages: structuredClone(initialMessages), operations: [structuredClone(initialOperation)] }
  let blocks = [{ id: 'receipt-plan', taskId: originalTask.id, date: '2026-10-14', start: '20:00', end: '20:30', locked: false }]
  let outcome = 'saved', gate = null, failPersistence = false, failPlannerRead = false, active = true
  const calls = { sent: [], updates: [], reads: [], onSent: [], refreshed: 0 }
  let draft = '尚未发送的输入草稿', attachment = '尚未发送的图片'
  const memo = (factory, deps) => {
    const index = cursor++, previous = instance.slots[index]
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) instance.slots[index] = { value: factory(), deps }
    return instance.slots[index].value
  }
  const effect = (callback, deps) => {
    const owner = instance, index = cursor++, previous = owner.slots[index]
    if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
      owner.slots[index] = { deps, cleanup: previous?.cleanup }
      effects.push(() => { owner.slots[index].cleanup?.(); owner.slots[index].cleanup = callback() })
    }
  }
  globalThis[runtimeKey] = {
    useState(initial) {
      const owner = instance, index = cursor++
      if (!(index in owner.slots)) owner.slots[index] = typeof initial === 'function' ? initial() : initial
      return [owner.slots[index], next => { owner.slots[index] = typeof next === 'function' ? next(owner.slots[index]) : next }]
    },
    useRef(initial) { const index = cursor++; return instance.slots[index] ??= { current: initial } },
    useId: () => memo(() => `receipt-test-${instances.size}-${cursor}`, []),
    useMemo: memo, useCallback: (callback, deps) => memo(() => callback, deps), useEffect: effect, useLayoutEffect: effect,
    async updateTask(id, patch, expected) {
      calls.updates.push({ id, patch, expected })
      assert.equal(id, currentTask.id)
      assert.equal(expected, currentTask.updatedAt)
      currentTask = { ...currentTask, ...patch, updatedAt: '2026-10-14T03:00:00.000Z' }
      snapshot.operations[0].createdTasks = [structuredClone(currentTask)]
      return structuredClone(currentTask)
    },
    async getTask() { return structuredClone(currentTask) },
  }
  const save = pendingStore.save.bind(pendingStore)
  t.mock.method(pendingStore, 'save', async request => {
    if (failPersistence) throw Error('synthetic local record failure')
    await save(request)
  })
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls.reads.push(url)
    if (url === '/api/status') return Response.json(status)
    if (url.startsWith('/api/conversation/reasoning')) return Response.json({ status: 'failed', reasoningContent: '', rounds: [] })
    if (url.startsWith('/api/conversation')) { calls.refreshed++; return Response.json(snapshot) }
    if (url === '/api/planner') {
      if (failPlannerRead) throw new TypeError('synthetic planner read failure')
      return Response.json({ revision: 1, blocks, routines: [], details: {}, checked: {} })
    }
    assert.equal(url, '/api/chat', 'unexpected HTTP is blocked by the fixture')
    const request = JSON.parse(init.body)
    calls.sent.push(request)
    assert.equal(request.conversationId, snapshot.conversationId)
    const record = (await pendingStore.list()).find(item => item.requestId === request.requestId)
    assert.ok(record, 'the original request must be durable before transport')
    assert.deepEqual(record.context, request.context)
    if (gate) await gate.promise
    if (outcome === 'failed') throw new TypeError('synthetic connection loss')
    if (outcome === 'saved' || outcome === 'partial' || outcome === 'update-only') {
      const minutes = Number(/改为 (\d+) 分钟/.exec(request.text)[1])
      currentTask = { ...currentTask, estimateMin: minutes, updatedAt: '2026-10-14T02:00:00.000Z' }
      const end = `${String(20 + Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
      if (outcome === 'saved') blocks = [{ ...blocks[0], end }]
      snapshot.operations[0].createdTasks = [structuredClone(currentTask)]
      snapshot.operations = [...snapshot.operations.filter(item => item.id !== 'estimate-saved'), {
        id: 'estimate-saved', requestId: request.requestId, summary: outcome === 'partial' ? '已保存预估时间；排程未完成' : '安排 1 段任务时间',
        details: outcome === 'saved' ? [`2026-10-14 20:00–${end}`] : [], createdAt: currentTask.updatedAt,
      }]
    }
    if (outcome !== 'partial') snapshot.messages = [...snapshot.messages, {
      id: `reply-${request.requestId}`, seq: request.seq ?? 3, role: 'assistant', requestId: request.requestId,
      content: outcome === 'no-save' ? '需要你选择另一个空档。' : '已核对真实保存结果。', createdAt: currentTask.updatedAt,
    }]
    return Response.json({ ...snapshot, requestId: request.requestId, status: outcome === 'partial' ? 'failed' : 'completed', ...(outcome === 'partial' ? { error: '排程尚未完成' } : {}) })
  })
  const call = (key, callback) => { instance = instances.get(key) ?? { slots: [] }; instances.set(key, instance); cursor = 0; return callback() }
  const expand = (node, key) => {
    if (Array.isArray(node)) return node.map((item, index) => expand(item, `${key}/${item?.key ?? index}`))
    if (!node || typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(call(`${key}:${node.type.name}`, () => node.type(node.props)), key)
    return { ...node, props: { ...node.props, children: expand(node.props.children, `${key}/${node.key ?? String(node.type)}`) } }
  }
  const render = () => {
    chat = call('chat-hook', () => useXixiConversation(() => {}, () => {}, pendingStore))
    const props = { chat, active, context: { page: options.page ?? 'home', taskId: 'unrelated-focus', wishId: 'unrelated-wish', freeTimeGoalId: 'unrelated-goal', date: '2040-01-01', timezone: 'Asia/Shanghai' },
      onSettings() {}, onRetracted() {}, onSent(value) { calls.onSent.push(value); draft = ''; attachment = null } }
    tree = expand(call('conversation-log', () => ConversationLog(props)), 'log')
    for (const commit of effects.splice(0)) commit()
    return tree
  }
  const wait = async predicate => {
    for (let attempt = 0; attempt < 40; attempt++) { render(); if (predicate()) return; await tick() }
    assert.fail('synthetic component did not settle')
  }
  const receipt = () => find(tree, node => node.type === 'section' && node.props['aria-label'] === `${currentTask.title}的快捷设置`)
  const button = label => find(receipt(), node => node.type === 'button' && text(node) === label)
  const submitCustom = value => {
    button('自定义').props.onClick(); render()
    find(receipt(), node => node.type === 'input' && node.props.type === 'number').props.onChange({ target: { value } }); render()
    find(receipt(), node => node.type === 'form' && node.props.className === 'xixi-estimate-form').props.onSubmit({ preventDefault() {} })
  }
  t.after(() => {
    for (const owner of instances.values()) for (const slot of owner.slots) slot?.cleanup?.()
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] }
  })
  render(); await tick(); render()
  return { render, wait, button, receipt, submitCustom, calls, pendingStore,
    chat: () => chat, tree: () => tree, task: () => currentTask, draft: () => draft, attachment: () => attachment,
    setOutcome: value => { outcome = value }, setGate: value => { gate = value }, failPersistence: () => { failPersistence = true },
    failPlannerRead: () => { failPlannerRead = true },
    setConnected: () => { status = connected }, setActive: value => { active = value },
  }
}

test('receipt requests select only their existing task and retain page/timezone', () => {
  for (const page of ['home', 'workbench', 'calendar', 'timetable']) {
    const context = { page, timezone: 'Asia/Shanghai', taskId: 'other', wishId: 'wish', freeTimeGoalId: 'goal', date: '2040-01-01' }
    const request = receiptEstimateRequest(originalTask, 45, context)
    assert.deepEqual(request.context, { page, timezone: context.timezone, taskId: originalTask.id })
    assert.equal(context.taskId, 'other')
    assert.match(request.text, /数学作业.*45 分钟/)
    assert.match(request.text, /读取.*最新日程.*检查冲突.*重新安排/)
    assert.equal(isReceiptEstimateRequest(request.text), true)
  }
  assert.equal(isReceiptEstimateRequest('我估计需要45分钟'), false)
  for (const minutes of [0, 1.5, 1441, NaN]) assert.throws(() => receiptEstimateRequest(originalTask, minutes, { page: 'home', timezone: 'Asia/Shanghai' }))
})

for (const page of ['home', 'workbench']) test(`${page}: shortcut sends once through the original conversation, preserves drafts and refreshes receipts`, async t => {
  const f = await fixture(t, { page })
  const gate = deferred(); f.setGate(gate)
  const click = f.button('45分').props.onClick
  click(); click()
  await f.wait(() => f.calls.sent.length === 1)
  assert.deepEqual(f.calls.sent[0].context, { page, taskId: originalTask.id, timezone: 'Asia/Shanghai' })
  assert.equal(f.calls.updates.length, 0)
  assert.ok(!text(f.tree()).includes(f.calls.sent[0].text), 'generated instruction has no user bubble while sending')
  assert.equal(f.task().estimateMin, 30)
  assert.match(text(f.receipt()), /正在交给析熙核对安排/)
  assert.doesNotMatch(text(f.receipt()), /正在保存/)
  assert.equal(f.button('60分').props.disabled, true)
  assert.equal(f.button('今天').props.disabled, true)
  assert.equal((await f.pendingStore.list()).length, 1)
  gate.resolve()
  await f.wait(() => f.receipt().props['aria-busy'] === false)
  assert.equal(f.calls.sent.length, 1)
  assert.equal(f.task().estimateMin, 45)
  assert.equal(f.task().due, originalTask.due)
  assert.match(text(f.receipt()), /45 分钟/)
  assert.match(text(f.receipt()), /实际保存以回执为准/)
  assert.doesNotMatch(text(f.receipt()), /预估时间已保存|日程保持不变/)
  assert.ok(f.calls.refreshed >= 2, 'completion rereads createdTasks')
  assert.deepEqual(await f.pendingStore.list(), [])
  assert.deepEqual(f.calls.onSent, [])
  assert.equal(f.draft(), '尚未发送的输入草稿')
  assert.equal(f.attachment(), '尚未发送的图片')
})

test('custom estimates validate before sending and use the same receipt callback', async t => {
  const f = await fixture(t, { page: 'workbench' })
  f.submitCustom('0'); await tick(); f.render()
  assert.equal(f.calls.sent.length, 0)
  assert.equal(f.calls.updates.length, 0)
  assert.match(text(f.receipt()), /整数分钟/)
  f.submitCustom('73')
  await f.wait(() => f.task().estimateMin === 73 && !f.receipt().props['aria-busy'])
  assert.match(f.calls.sent[0].text, /73 分钟/)
  assert.equal(f.calls.sent[0].context.taskId, originalTask.id)
  assert.equal(f.calls.updates.length, 0)
})

test('a completed conversation without a save never optimistically changes the estimate', async t => {
  const f = await fixture(t); f.setOutcome('no-save')
  f.button('60分').props.onClick()
  await f.wait(() => f.calls.sent.length === 1 && !f.receipt().props['aria-busy'])
  assert.equal(f.task().estimateMin, 30)
  assert.match(text(f.tree()), /需要你选择另一个空档/)
  assert.match(text(f.receipt()), /预估时间尚未确认保存为 60 分钟/)
  assert.doesNotMatch(text(f.receipt()), /预估时间已保存|已重排|已经排/)
})

test('a completed update-only reply is rejected by saved-task and planner verification', async t => {
  const f = await fixture(t); f.setOutcome('update-only')
  f.button('60分').props.onClick()
  await f.wait(() => f.calls.sent.length === 1 && !f.receipt().props['aria-busy'])
  assert.equal(f.task().estimateMin, 60)
  assert.match(text(f.receipt()), /尚未同步.*预估 60 分钟，已排 30 分钟/)
  assert.doesNotMatch(text(f.receipt()), /实际保存以回执为准|已重排/)
})

test('a failed final planner read leaves saved results unconfirmed without a local write or automatic resend', async t => {
  const f = await fixture(t); f.failPlannerRead()
  f.button('60分').props.onClick()
  await f.wait(() => f.calls.sent.length === 1 && !f.receipt().props['aria-busy'])
  assert.match(text(f.receipt()), /实际保存结果暂时无法核对/)
  assert.doesNotMatch(text(f.receipt()), /实际保存以回执为准|已重排/)
  assert.equal(f.calls.sent.length, 1)
  assert.equal(f.calls.updates.length, 0)
  assert.equal(f.task().estimateMin, 60, 'a read failure never rolls back a real commit')
})

test('two different estimate choices before React renders cannot race into two requests', async t => {
  const f = await fixture(t), gate = deferred()
  f.setGate(gate)
  const first = f.button('45分').props.onClick, second = f.button('60分').props.onClick
  first(); second()
  await f.wait(() => f.calls.sent.length === 1)
  assert.match(f.calls.sent[0].text, /45 分钟/)
  gate.resolve()
  await f.wait(() => !f.receipt().props['aria-busy'])
  assert.equal(f.calls.sent.length, 1)
})

test('failed receipt sends keep the retry ID; chat retry preserves draft and attachment', async t => {
  const f = await fixture(t); f.setOutcome('failed')
  f.button('60分').props.onClick()
  await f.wait(() => f.calls.sent.length === 1 && !f.receipt().props['aria-busy'])
  const [pending] = await f.pendingStore.list()
  assert.equal(pending.requestId, f.calls.sent[0].requestId)
  assert.ok(!text(f.tree()).includes(pending.text), 'failed send exposes retry without the generated instruction')
  assert.equal(f.task().estimateMin, 30)
  assert.match(text(f.receipt()), /发送或处理尚未完成.*聊天.*重试/)
  assert.doesNotMatch(text(f.receipt()), /已保存|已重排/)
  f.setOutcome('saved')
  const retry = find(f.tree(), node => node.type === 'button' && text(node) === '重试')
  retry.props.onClick()
  // The component dispatches this event with void; observe the completed
  // request rather than assuming its onClick returns the async action.
  await f.wait(() => f.calls.sent.length === 2 && !f.chat().busy)
  assert.equal(f.calls.sent.length, 2)
  assert.equal(f.calls.sent[1].requestId, pending.requestId)
  assert.deepEqual(f.calls.sent[1].context, pending.context)
  assert.deepEqual(await f.pendingStore.list(), [])
  assert.equal(f.draft(), '尚未发送的输入草稿')
  assert.equal(f.attachment(), '尚未发送的图片')
  assert.deepEqual(f.calls.onSent, [])
})

test('partial saves refresh the task snapshot while still reporting unfinished processing', async t => {
  const f = await fixture(t); f.setOutcome('partial')
  f.button('60分').props.onClick()
  await f.wait(() => f.calls.sent.length === 1 && !f.receipt().props['aria-busy'])
  assert.equal(f.task().estimateMin, 60)
  assert.match(text(f.receipt()), /60 分钟/)
  assert.match(text(f.receipt()), /发送或处理尚未完成/)
  assert.doesNotMatch(text(f.receipt()), /已重排|预估时间已保存/)
  assert.equal((await f.pendingStore.list()).length, 1)
  assert.ok(f.calls.refreshed >= 2)
})

test('disconnected and failed persistence preflight never modify tasks or send a request', async t => {
  const f = await fixture(t, { disconnected: true })
  f.button('45分').props.onClick()
  await f.wait(() => !f.receipt().props['aria-busy'])
  assert.match(text(f.receipt()), /尚未连接模型.*设置.*API.*本地模型/)
  assert.equal(f.calls.sent.length, 0)
  assert.equal(f.calls.updates.length, 0)
  assert.equal(f.task().estimateMin, 30)
  f.setConnected(); await f.chat().refreshStatus(); f.render(); f.failPersistence()
  f.button('45分').props.onClick()
  await f.wait(() => !f.receipt().props['aria-busy'])
  assert.equal(f.calls.sent.length, 0)
  assert.equal(f.calls.updates.length, 0)
  assert.equal(f.task().estimateMin, 30)
  assert.match(f.chat().error, /本机发送记录/)
})

test('receipt sending rechecks a stale connection status and respects inactive conversations', async t => {
  const f = await fixture(t, { disconnected: true })
  f.setConnected(); f.button('60分').props.onClick()
  await f.wait(() => f.calls.sent.length === 1 && !f.receipt().props['aria-busy'])
  assert.equal(f.task().estimateMin, 60)
  f.setActive(false); f.render()
  assert.equal(f.button('45分').props.disabled, true)
  f.button('45分').props.onClick(); await tick(); f.render()
  assert.equal(f.calls.sent.length, 1)
})

test('DDL shortcuts still save directly using the snapshot refreshed after chat', async t => {
  const f = await fixture(t)
  f.button('60分').props.onClick()
  await f.wait(() => f.calls.sent.length === 1 && !f.receipt().props['aria-busy'])
  f.button('明天').props.onClick()
  await f.wait(() => f.calls.updates.length === 1 && !f.receipt().props['aria-busy'])
  assert.equal(f.calls.sent.length, 1)
  assert.deepEqual(Object.keys(f.calls.updates[0].patch), ['due'])
  assert.equal(f.calls.updates[0].expected, '2026-10-14T02:00:00.000Z')
  assert.equal(f.task().estimateMin, 60)
  assert.match(text(f.receipt()), /截止时间已保存/)
})

const providerDate = '2026-10-14'
const providerNow = new Date(`${providerDate}T16:00:00+08:00`)
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null,
  tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const toolResult = request => JSON.parse(request.messages.findLast(message => message.role === 'tool').content)

function providerFixture(t, { conflict = false } = {}) {
  const db = createDatabase(':memory:'), responses = [], requests = [], assertions = []
  t.after(() => db.close())
  const task = db.createTask({ title: '数学作业', due: '2026-10-16', estimateMin: 30 })
  const original = { id: 'original-task-slot', taskId: task.id, date: providerDate, start: '18:00', end: '18:30', locked: false }
  const update = action => db.updatePlanner(action, db.getPlanner().revision)
  update({ type: 'import-routines', routines: [{ id: 'study', title: '晚自习', kind: 'available', weekdays: [3],
    start: '18:00', end: '22:00', enabled: true, location: '', items: [] }] })
  update({ type: 'save-block', block: original })
  let other
  if (conflict) {
    const otherTask = db.createTask({ title: '已经确认的其他作业', estimateMin: 45, due: '2026-10-16' })
    other = { id: 'other-slot', taskId: otherTask.id, date: providerDate, start: '18:30', end: '19:15', locked: false }
    update({ type: 'save-block', block: other })
  }
  const request = receiptEstimateRequest(task, 60, { page: 'workbench', timezone: 'Asia/Shanghai', taskId: 'unrelated', date: '2040-01-01', wishId: 'unrelated-wish', freeTimeGoalId: 'unrelated-goal' })
  const input = { requestId: randomUUID(), conversationId: 'main', ...request }
  const xixi = createXixi({ db, now: () => providerNow, complete: async payload => {
    requests.push(payload)
    const next = responses.shift()
    assert.ok(next, 'unexpected scripted provider round')
    if (next instanceof Error) throw next
    try { return typeof next === 'function' ? next(payload) : next }
    catch (error) { assertions.push(error); throw error }
  } })
  const read = () => {
    responses.push(tool('read_tasks', { taskId: task.id }), payload => {
      assert.equal(toolResult(payload).tasks[0].id, task.id)
      return tool('read_planner', { date: providerDate })
    })
  }
  const saveEstimate = () => responses.push(payload => {
    assert.equal(toolResult(payload).revision, db.getPlanner().revision)
    return tool('update_task', { taskId: task.id, expectedUpdatedAt: db.getTask(task.id).updatedAt, patch: { estimateMin: 60 } })
  })
  const plan = (start = '18:00', end = '19:00') => responses.push(() => tool('plan_tasks', {
    expectedRevision: db.getPlanner().revision, plans: [{ id: original.id, taskId: task.id, date: providerDate, start, end }],
  }))
  return { db, task, original, other, input, requests, responses, read, saveEstimate, plan,
    async run() { const result = await xixi.chat(input); assert.deepEqual(assertions, [], 'provider assertions cannot be swallowed as a failed reply'); return result },
  }
}

test('scripted provider extends the existing plan and projects the saved estimate into the creation receipt', async t => {
  const f = providerFixture(t), beforeCount = f.db.listTasks().length
  f.read(); f.saveEstimate(); f.plan(); f.responses.push(reply('已经按新的时长安排。'))
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(result.execution.status, 'verified')
  assert.deepEqual(f.db.getPlanner().blocks.find(item => item.id === f.original.id), { ...f.original, end: '19:00' })
  assert.equal(f.db.getTask(f.task.id).estimateMin, 60)
  assert.equal(f.db.getTask(f.task.id).due, f.task.due)
  assert.equal(f.db.listTasks().length, beforeCount, 'reuse the original task, without another create_tasks')
  assert.equal(receiptEstimateSaveIssue(f.db.getTask(f.task.id), 60, f.db.getPlanner().blocks), null)
  const creation = publicOperation({ ...initialOperation, changes: [{ table: 'tasks', id: f.task.id, before: null, after: f.task }] }, f.db, [])
  assert.equal(creation.createdTasks[0].estimateMin, 60)
  const environment = JSON.parse(f.requests[0].messages.find(message => message.content?.startsWith('当前环境与数据库资料')).content.split('\n').slice(1).join('\n'))
  assert.equal(environment.selectedTask.id, f.task.id)
  assert.ok(result.operations.some(operation => operation.kind === 'planner'))
  const rounds = f.requests.length, operationCount = f.db.listOperations().length
  const replay = await f.run()
  assert.equal(f.requests.length, rounds, 'replaying the same completed request never invokes the provider again')
  assert.equal(f.db.listOperations().length, operationCount)
  assert.deepEqual(replay.operations, result.operations)
})

test('scripted provider moves the same task to a full free slot when extension conflicts, preserving other confirmed work', async t => {
  const f = providerFixture(t, { conflict: true })
  f.read(); f.saveEstimate(); f.plan('19:15', '20:15'); f.responses.push(reply('避开原有作业，改到后面的完整空档。'))
  const result = await f.run()
  assert.equal(result.execution.status, 'verified')
  assert.deepEqual(f.db.getPlanner().blocks.find(item => item.id === f.original.id), { ...f.original, start: '19:15', end: '20:15' })
  assert.deepEqual(f.db.getPlanner().blocks.find(item => item.id === f.other.id), f.other)
  assert.deepEqual(dayCapacity(f.db.getPlanner(), f.db.listTasks(), providerDate, providerNow).conflicts, [])
  assert.equal(receiptEstimateSaveIssue(f.db.getTask(f.task.id), 60, f.db.getPlanner().blocks), null)
})

test('a conflicting provider plan fails atomically; an estimate-only partial save is not a completed reschedule', async t => {
  const f = providerFixture(t, { conflict: true }), before = structuredClone(f.db.getPlanner().blocks)
  f.read(); f.saveEstimate(); f.plan(); f.responses.push(reply('都已经安排完成了。'))
  const result = await f.run()
  assert.deepEqual(f.db.getPlanner().blocks, before)
  assert.equal(f.db.getTask(f.task.id).estimateMin, 60)
  assert.equal(result.execution.status, 'partial')
  assert.ok(result.execution.failures.length > 0)
  assert.match(receiptEstimateSaveIssue(f.db.getTask(f.task.id), 60, f.db.getPlanner().blocks), /尚未同步.*已排 30 分钟/)
  assert.ok(result.messages.some(message => message.executionNotice?.issues.length))
})

test('a provider that only updates estimateMin can complete its reply, but saved-data verification rejects the unsynced calendar', async t => {
  const f = providerFixture(t), before = structuredClone(f.db.getPlanner())
  f.read(); f.saveEstimate(); f.responses.push(reply('已经重新排好了。'))
  const result = await f.run()
  assert.equal(result.status, 'completed', 'transport completion alone is not schedule completion')
  assert.equal(f.db.getTask(f.task.id).estimateMin, 60)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.ok(!result.operations.some(operation => operation.kind === 'planner'))
  assert.match(receiptEstimateSaveIssue(f.db.getTask(f.task.id), 60, f.db.getPlanner().blocks), /尚未同步/)
})

test('a provider saying done without tools cannot satisfy the receipt save check', async t => {
  const f = providerFixture(t), before = structuredClone(f.db.getPlanner())
  f.responses.push(reply('都已经完成并排好了。'))
  const result = await f.run()
  assert.equal(result.status, 'completed')
  assert.equal(f.db.getTask(f.task.id).estimateMin, 30)
  assert.deepEqual(f.db.getPlanner(), before)
  assert.equal(result.operations.length, 0)
  assert.match(receiptEstimateSaveIssue(f.db.getTask(f.task.id), 60, f.db.getPlanner().blocks), /尚未确认保存/)
})

test('provider interruption preserves committed estimate and original plan, leaving an unfinished result', async t => {
  const f = providerFixture(t), before = structuredClone(f.db.getPlanner().blocks)
  f.read(); f.saveEstimate(); f.responses.push(Error('synthetic provider interruption'))
  const result = await f.run()
  assert.ok(result.messages.some(message => message.executionNotice?.replyUnavailable), 'a reply interruption is explicit even when a prior commit keeps the transport completed')
  assert.equal(f.db.getTask(f.task.id).estimateMin, 60)
  assert.deepEqual(f.db.getPlanner().blocks, before)
  assert.match(receiptEstimateSaveIssue(f.db.getTask(f.task.id), 60, f.db.getPlanner().blocks), /尚未同步/)
})

test('a provider cannot resize a locked original plan even when it says the reschedule completed', async t => {
  const f = providerFixture(t)
  f.db.updatePlanner({ type: 'save-block', block: { ...f.original, locked: true } }, f.db.getPlanner().revision)
  const before = structuredClone(f.db.getPlanner().blocks)
  f.read(); f.saveEstimate(); f.plan(); f.responses.push(reply('重新安排完成。'))
  const result = await f.run()
  assert.equal(result.execution.status, 'partial')
  assert.deepEqual(f.db.getPlanner().blocks, before)
  assert.match(receiptEstimateSaveIssue(f.db.getTask(f.task.id), 60, f.db.getPlanner().blocks), /尚未同步/)
})
