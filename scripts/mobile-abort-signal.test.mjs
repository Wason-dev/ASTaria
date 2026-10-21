import assert from 'node:assert/strict'
import test from 'node:test'
import { abortSignalAny, abortSignalTimeout } from '../server/abortSignal.mjs'
import initSqlJs from 'sql.js'
import { readFile } from 'node:fs/promises'
import { createMobileSession } from '../mobile/runtime/session.mjs'
import { mobileTransport } from '../mobile/runtime/transport.mjs'

test('mobile abort helpers work when modern AbortSignal combinators are unavailable', async () => {
  const originalAny = AbortSignal.any
  const originalTimeout = AbortSignal.timeout
  try {
    AbortSignal.any = undefined
    AbortSignal.timeout = undefined
    const first = new AbortController()
    const second = new AbortController()
    const combined = abortSignalAny([first.signal, second.signal])
    assert.equal(combined.aborted, false)
    second.abort(new Error('cancelled'))
    assert.equal(combined.aborted, true)
    assert.equal(combined.reason.message, 'cancelled')

    const timeout = abortSignalTimeout(5)
    await new Promise(resolve => setTimeout(resolve, 15))
    assert.equal(timeout.aborted, true)
  } finally {
    AbortSignal.any = originalAny
    AbortSignal.timeout = originalTimeout
  }
})

test('legacy WebView can read onboarding, settings and planner and save tasks through the real mobile session', async () => {
  const originalAny = AbortSignal.any, originalTimeout = AbortSignal.timeout, originalJson = Response.json
  const SQL = await initSqlJs()
  const [persona, working] = await Promise.all(['persona', 'working'].map(name => readFile(new URL(`../server/prompts/${name}.md`, import.meta.url), 'utf8')))
  let bytes, session
  const storage = { load: async () => bytes?.slice(), save: async value => { bytes = value.slice() } }
  try {
    AbortSignal.any = undefined; AbortSignal.timeout = undefined; Response.json = undefined
    session = await createMobileSession({ SQL, storage, serviceOptions: {
      persona, working, vault: { status: async () => false, read: async () => { throw Error('No key in test') } },
    } })
    const fetch = mobileTransport({ origin: 'https://localhost', fallback: () => { throw Error('Unexpected network') },
      request: (path, body, options) => session.call(path, body, options) })
    const get = async path => {
      const r = await fetch('/api/' + path, { headers: { 'X-ASTaria-Local': '1' }, signal: new AbortController().signal })
      assert.equal(r.status, 200); return r.json()
    }
    assert.deepEqual(await get('onboarding'), { completed: false })
    assert.equal((await get('status')).provider, 'deepseek')
    assert.equal((await get('preferences')).render.quality, 'auto')
    assert.equal(typeof (await get('planner')).revision, 'number')
    const created = await fetch('/api/tasks/create', { method: 'POST', headers: { 'X-ASTaria-Local': '1', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '离线测试事项', inbox: false }), signal: new AbortController().signal })
    assert.equal(created.status, 200)
    assert.equal((await get('tasks')).at(-1).title, '离线测试事项')
    assert.deepEqual(await get('onboarding'), { completed: false }, 'recording while setup is incomplete must not skip it')
    const canceled = new AbortController(); canceled.abort(new Error('already canceled'))
    assert.equal(abortSignalAny([new AbortController().signal, canceled.signal]).reason.message, 'already canceled')
  } finally {
    await session?.close()
    AbortSignal.any = originalAny; AbortSignal.timeout = originalTimeout; Response.json = originalJson
  }
})
