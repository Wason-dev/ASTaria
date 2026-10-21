import test from 'node:test'
import assert from 'node:assert/strict'
import initSqlJs from 'sql.js'
import { readFile } from 'node:fs/promises'
import { createDatabase } from '../server/database.mjs'
import { createMobileSession } from '../mobile/runtime/session.mjs'
import { checkedSnapshot, serialCalls } from '../mobile/runtime/snapshots.mjs'
import { mobileTransport } from '../mobile/runtime/transport.mjs'
import { mobilePlatformRequests } from '../mobile/runtime/platformApi.mjs'
import { localRequestLimit } from '../src/xixi/requestLimits.ts'
import { CHAT_IMAGE_MAX_BASE64_LENGTH } from '../src/xixi/chatImagePolicy.ts'
import { randomUUID } from 'node:crypto'

const SQL = await initSqlJs()
const [persona, working] = await Promise.all(['persona', 'working'].map(name => readFile(new URL(`../server/prompts/${name}.md`, import.meta.url), 'utf8')))
const serviceOptions = { persona, working, vault: { status: async () => false, read: async () => { throw Error('No key in test') } } }

test('phone first-run glass defaults to soft and preserves an explicitly saved clear choice', async () => {
  const saved = storage()
  let session = await createMobileSession({ SQL, storage: saved, serviceOptions })
  const initial = await session.call('/api/preferences')
  assert.equal(initial.glass, 'soft')
  assert.deepEqual(await session.call('/api/onboarding'), { completed: false })
  await session.call('/api/preferences', { expected: initial, value: { ...initial, glass: 'clear' } })
  await session.close()
  session = await createMobileSession({ SQL, storage: saved, serviceOptions })
  assert.equal((await session.call('/api/preferences')).glass, 'clear')
  await session.close()
})
function storage() {
  let bytes, fail = false
  return { load: async () => bytes?.slice(), save: async value => { if (fail) throw Error('quota'); bytes = value.slice() }, setFail: value => { fail = value }, bytes: () => bytes?.slice() }
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }
const reply = content => ({ choices: [{ message: { role: 'assistant', content } }] })
const chat = (conversationId = 'main') => ({ requestId: randomUUID(), conversationId, text: '你好', context: { timezone: 'Asia/Shanghai', page: 'home' } })
const promptly = async action => {
  let timer
  try { return await Promise.race([action, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('local request blocked on cloud completion')), 2000) })]) }
  finally { clearTimeout(timer) }
}

test('mobile chat uses the shared direct-page search and persists sources outside the reply', async () => {
  const saved = storage(), pages = [], requests = []
  const url = 'https://github.com/fixture/repo'
  const session = await createMobileSession({ SQL, storage: saved, serviceOptions: { ...serviceOptions,
    vault: { status: async () => true, read: async () => { throw Error('direct page must not read a search key') } },
    fetcher: async () => { throw Error('direct page must not query a model search endpoint') },
    pageFetcher: async (url, options) => { pages.push({ url, signal: options.signal }); return {
      content: '公开仓库 README：安装后可以离线记录事项。', fetchStatus: 'ok', fetchedAt: '2026-10-12T01:02:03.000Z',
    } },
    complete: async payload => {
      requests.push(payload)
      return requests.length === 1 ? { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{
        id: randomUUID(), type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: url }) },
      }] } }] } : reply('README 说明可以离线记录事项。')
    },
  } })
  const { providerSettings: settings } = await session.call('/api/status')
  await session.call('/api/settings/provider', { ...settings, webSearch: { enabled: true, maxUses: 2 } })
  const result = await session.call('/api/chat', { ...chat(), text: `请读这个仓库 ${url}` })
  assert.equal(result.status, 'completed')
  assert.deepEqual(pages.map(page => page.url), [url])
  assert.equal(pages[0].signal.aborted, false)
  const assistant = result.messages.at(-1)
  assert.equal(assistant.content, 'README 说明可以离线记录事项。')
  assert.equal(assistant.sources[0].fetchStatus, 'ok')
  assert.equal(assistant.sources[0].url, url)
  assert.doesNotMatch(assistant.content, /来源核验/u)
  const restored = await createMobileSession({ SQL, storage: saved, serviceOptions })
  const transcript = await restored.call('/api/conversation')
  assert.deepEqual(transcript.messages.at(-1).sources, assistant.sources)
  await restored.close(); await session.close()
})

test('a write arriving during snapshot save is persisted before either request claims success', async () => {
  const saved = storage(), session = await createMobileSession({ SQL, storage: saved, serviceOptions })
  const began = deferred(), release = deferred(), oldSave = saved.save
  let saves = 0
  saved.save = async bytes => { if (++saves === 1) { began.resolve(); await release.promise } await oldSave(bytes) }
  const first = session.call('/api/tasks/create', { title: '先写入' })
  await began.promise
  let secondDone = false
  const second = session.call('/api/tasks/create', { title: '保存期间的新写入' }).then(value => { secondDone = true; return value })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(secondDone, false)
  release.resolve()
  await Promise.all([first, second])
  assert.equal(saves, 2, 'the second revision requires a second physical snapshot save')
  const restored = await createMobileSession({ SQL, storage: saved, serviceOptions })
  assert.deepEqual(new Set((await restored.call('/api/tasks')).map(task => task.title)), new Set(['先写入', '保存期间的新写入']))
  await restored.close(); await session.close()
})

test('cloud completion does not block local tasks, and duplicate conversation turns stay protected', async () => {
  const started = deferred(), release = deferred(), secondStarted = deferred()
  let completions = 0
  const session = await createMobileSession({ SQL, storage: storage(), serviceOptions: { ...serviceOptions,
    vault: { status: async () => true }, complete: async () => { (++completions === 1 ? started : secondStarted).resolve(); await release.promise; return reply('你好。') },
  } })
  const first = session.call('/api/chat', chat())
  await started.promise
  const created = await promptly(session.call('/api/tasks/create', { title: '聊天时仍能保存' }))
  assert.equal((await promptly(session.call('/api/tasks')))[0].id, created.id)
  await assert.rejects(promptly(session.call('/api/chat', chat())), /处理中|正在|未完成|进行/u)
  const other = await promptly(session.call('/api/conversations', {}))
  const separate = session.call('/api/chat', chat(other.conversationId))
  await promptly(secondStarted.promise)
  release.resolve()
  assert.equal((await first).status, 'completed'); assert.equal((await separate).status, 'completed')
  await session.close()
})

test('a streamed operation is acknowledged only after its snapshot is durable', async () => {
  const saved = storage(), started = deferred(), release = deferred(), events = []
  let replies = 0, hold = false
  const originalSave = saved.save
  saved.save = async bytes => { if (hold) { started.resolve(); await release.promise; hold = false } return originalSave(bytes) }
  const session = await createMobileSession({ SQL, storage: saved, serviceOptions: { ...serviceOptions,
    vault: { status: async () => true }, complete: async () => {
      if (replies++) return reply('考试日期已记下。')
      hold = true
      return { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: {
        name: 'create_tasks', arguments: JSON.stringify({ tasks: [{ title: '物理第一次月考', due: '2026-10-22', scheduleMode: 'record-only' }] }),
      } }] } }] }
    },
  } })
  const input = { ...chat(), text: '记下10月22日物理第一次月考，不占用时间' }
  const savedActivity = event => event.type === 'activity' && event.activity.id.startsWith('tool:') && event.activity.state === 'done'
  const pending = session.call('/api/chat', input, { headers: { accept: 'text/event-stream' }, startStream: () => event => events.push(event) })
  await started.promise
  assert.equal(events.some(savedActivity), false)
  release.resolve()
  assert.equal((await pending).status, 'completed')
  assert.ok(events.some(savedActivity))
  const restored = await createMobileSession({ SQL, storage: saved, serviceOptions })
  assert.equal((await restored.call('/api/tasks'))[0].title, '物理第一次月考')
  await restored.close(); await session.close()
})

test('the shared settings routes call the mobile secure-vault save contract', async () => {
  let secret, removed = false
  const session = await createMobileSession({ SQL, storage: storage(), serviceOptions: { ...serviceOptions,
    vault: { status: async () => Boolean(secret), read: async () => secret, save: async value => { secret = value }, remove: async () => { removed = true; secret = undefined } },
  } })
  assert.equal((await session.call('/api/settings/key', { key: 'test-fixture-key' })).configured, true)
  assert.equal(secret, 'test-fixture-key')
  const backup = JSON.stringify(await session.call('/api/data/export'))
  assert.ok(!backup.includes(secret), 'API keys never enter backups or synchronization data')
  assert.equal((await session.call('/api/settings/key/remove', {})).configured, false)
  assert.equal(removed, true)
  await session.close()
})
test('a real mobile SQLite snapshot restores the same tasks, planner and backup semantics', async () => {
  const saved = storage(), session = await createMobileSession({ SQL, storage: saved, serviceOptions })
  const task = await session.call('/api/tasks/create', { title: '手机离线待办', estimateMin: 30, inbox: false })
  assert.equal((await session.call('/api/tasks'))[0].id, task.id)
  const planner = await session.call('/api/planner'), backup = await session.call('/api/data/export')
  const desktop = createDatabase(':memory:')
  try {
    desktop.importData(backup)
    assert.equal(desktop.listTasks()[0].title, task.title)
    assert.deepEqual(desktop.getPlanner().routines, planner.routines)
    assert.deepEqual(desktop.getPlanner().blocks, planner.blocks)
    assert.deepEqual(desktop.getPlanner().details, planner.details)
    assert.equal(desktop.getPlanner().revision, planner.revision + 1, 'backup replacement invalidates earlier revisions')
  } finally { desktop.close() }
  await session.close()
  const restored = await createMobileSession({ SQL, storage: saved, serviceOptions })
  assert.deepEqual(await restored.call('/api/tasks'), [task])
  assert.deepEqual(await restored.call('/api/planner'), planner)
  assert.equal((await restored.call('/api/platform/reminder-snapshot')).tasks[0].id, task.id)
  await restored.close()
})
test('a save failure rejects a mutation and cannot resurrect it after restart', async () => {
  const saved = storage(), session = await createMobileSession({ SQL, storage: saved, serviceOptions })
  await session.call('/api/tasks/create', { title: '已确认保存' })
  const before = saved.bytes(); saved.setFail(true)
  await assert.rejects(session.call('/api/tasks/create', { title: '不得伪报保存' }), /没有确认成功/u)
  assert.deepEqual(saved.bytes(), before)
  await assert.rejects(session.call('/api/tasks'), /存储尚未恢复/u)
  saved.setFail(false)
  const restored = await createMobileSession({ SQL, storage: saved, serviceOptions })
  assert.deepEqual((await restored.call('/api/tasks')).map(task => task.title), ['已确认保存'])
  await restored.close()
})
test('corrupt existing bytes fail startup without resetting or writing over them', async () => {
  let saves = 0
  await assert.rejects(createMobileSession({ SQL, storage: { load: async () => new Uint8Array(400), save: async () => { saves++ } }, serviceOptions }), /原数据已保留/u)
  assert.equal(saves, 0)
  const bytes = new SQL.Database().export()
  assert.throws(() => checkedSnapshot(bytes, '0'.repeat(64)), /校验失败/u)
})
test('mobile uses shared stale-write and undo checks rather than a divergent task schema', async () => {
  const session = await createMobileSession({ SQL, storage: storage(), serviceOptions })
  const task = await session.call('/api/tasks/create', { title: '同一套校验' })
  await assert.rejects(session.call('/api/tasks/update', { id: task.id, patch: { title: '错误覆盖' }, expectedUpdatedAt: '2000-01-01T00:00:00Z' }), /更新|变化/u)
  assert.equal((await session.call('/api/tasks'))[0].title, task.title)
  await assert.rejects(session.call('/api/settings/provider', { provider: 'local' }), /暂不安装本地模型/u)
  await session.close()
})
test('serialized persistence waits for acknowledgement and resumes after a rejected callback', async () => {
  const serial = serialCalls(), order = []; let release
  const first = serial(async () => { order.push('first'); await new Promise(resolve => { release = resolve }); throw Error('failed') })
  const second = serial(() => { order.push('second'); return 'saved' })
  await Promise.resolve(); assert.deepEqual(order, ['first']); release()
  await assert.rejects(first); assert.equal(await second, 'saved'); assert.deepEqual(order, ['first', 'second'])
})
test('only chat permits expanded image requests; backups and other writes retain separate bounds', () => {
  assert.ok(localRequestLimit('/api/chat').bytes > CHAT_IMAGE_MAX_BASE64_LENGTH)
  assert.equal(localRequestLimit('/api/tasks/create').bytes, 4 * 1024 * 1024)
  assert.equal(localRequestLimit('/api/chat-extra').bytes, 4 * 1024 * 1024)
  assert.ok(localRequestLimit('/api/data/import').bytes > 4 * 1024 * 1024)
})
test('mobile transport handles local APIs only and preserves external fetch and validation', async () => {
  const paths = [], external = []
  const fetch = mobileTransport({ origin: 'https://localhost', request: async path => { paths.push(path); return { ok: true } }, fallback: async (...args) => { external.push(args); return Response.json({ external: true }) } })
  assert.deepEqual(await (await fetch('/api/tasks', { headers: { 'X-ASTaria-Local': '1' } })).json(), { ok: true })
  assert.equal((await fetch('/api/tasks')).status, 403)
  assert.equal((await fetch('/api/tasks', { method: 'POST', headers: { 'X-ASTaria-Local': '1', 'Content-Type': 'text/plain' }, body: '{}' })).status, 415)
  await fetch('https://example.org/api/tasks'); await fetch('/assets/app.js')
  assert.deepEqual(paths, ['/api/tasks']); assert.equal(external.length, 2)
})
test('mobile chat events are provisional and final success follows the request acknowledgement', async () => {
  let release
  const fetch = mobileTransport({ origin: 'https://localhost', request: async (_path, _body, options) => {
    options.onEvent({ type: 'activity', activity: { id: 'a', stage: 'reading', state: 'running', title: '读取' } })
    await new Promise(resolve => { release = resolve }); return { saved: true }
  }, fallback: () => { throw Error('unexpected network') } })
  const response = await fetch('/api/chat', { method: 'POST', headers: { 'X-ASTaria-Local': '1', 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: '{}' })
  const reader = response.body.getReader(), text = new TextDecoder()
  assert.match(text.decode((await reader.read()).value), /activity/u)
  release(); assert.match(text.decode((await reader.read()).value), /"type":"result".*"saved":true/u)
  assert.equal((await reader.read()).done, true)
})

test('canceling the chat stream cancels its worker request and ignores late events', async () => {
  const release = deferred(); let signal, event
  const fetch = mobileTransport({ origin: 'https://localhost', request: async (_path, _input, options) => {
    signal = options.signal; event = options.onEvent
    event({ type: 'phase', phase: 'thinking' }); await release.promise
    event({ type: 'phase', phase: 'replying' }); return { saved: true }
  }, fallback: () => { throw Error('unexpected network') } })
  const response = await fetch('/api/chat', { method: 'POST', headers: { 'X-ASTaria-Local': '1', 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: '{}' })
  const reader = response.body.getReader(); await reader.read(); await reader.cancel()
  assert.equal(signal.aborted, true)
  release.resolve(); await new Promise(resolve => setImmediate(resolve))
  assert.equal((await reader.read()).done, true)
})

test('platform reminder refresh follows durable mutations and does not poll reads or failed writes', async () => {
  const release = deferred(), calls = [], events = []
  const reminders = { scheduleRefresh: async () => { calls.push('refresh') }, status: async () => ({ enabled: false }),
    setEnabled: async value => ({ enabled: value }), refresh: async () => ({ count: 1 }), test: async () => ({ message: 'scheduled' }) }
  const request = mobilePlatformRequests({ reminders, updateStatus: () => ({ supported: false }), call: async (path, input, options) => {
    if (input) await release.promise
    if (path.endsWith('/delete')) throw Error('rejected')
    if (path === '/api/chat') options.onEvent({ type: 'activity', activity: { id: 'tool:t', state: 'done' } })
    return 'saved'
  } })
  await request('/api/tasks'); assert.deepEqual(calls, [])
  const saving = request('/api/tasks/update', { id: 'fixture' })
  await Promise.resolve(); assert.deepEqual(calls, [])
  release.resolve(); await saving; assert.deepEqual(calls, ['refresh'])
  await assert.rejects(request('/api/tasks/delete', {})); assert.deepEqual(calls, ['refresh'])
  await request('/api/chat', {}, { onEvent: event => events.push(event) })
  assert.equal(events.length, 1); assert.equal(calls.length, 3)
  assert.deepEqual(await request('/api/desktop/reminders'), { enabled: false })
  assert.deepEqual(await request('/api/desktop/reminders/enabled', { enabled: true }), { enabled: true })
  await assert.rejects(request('/api/desktop/reminders/enabled', { enabled: 'yes' }), /开关/u)
  await assert.rejects(request('/api/desktop/reminders/test', { extra: true }))
})
