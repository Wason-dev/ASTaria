import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'

const source = stripTypeScriptTypes(await readFile(new URL('../mobile/runtime/network.ts', import.meta.url), 'utf8'))
  .replace(/^import .+$/gm, '').replace(/^export /gm, '')
function fixture(native = true) {
  const calls = []
  const nativeRequest = compileFunction(`${source}\nreturn nativeRequest`, ['Capacitor', 'CapacitorHttp'])(
    { isNativePlatform: () => native },
    { request: async input => { calls.push(input); return { status: 200, data: '{"results":[]}', headers: {} } } })
  return { calls, nativeRequest }
}
test('mobile native transport accepts official Search and Fetch with bearer auth and no redirect', async () => {
  const { calls, nativeRequest } = fixture()
  for (const path of ['/v1/tools/search', '/v1/tools/fetch']) {
    const body = path.endsWith('/search') ? '{"query":"public","count":8,"need_content":true}' : '{"url":"https://example.com/"}'
    const response = await nativeRequest({ url: `https://api.deepseek.com${path}`, method: 'POST', headers: { Authorization: 'Bearer fixture' }, body })
    assert.equal(response.status, 200)
    assert.equal(calls.at(-1).data, body)
    assert.equal(calls.at(-1).headers.Authorization, 'Bearer fixture')
    assert.equal(calls.at(-1).disableRedirects, true)
  }
  assert.equal(calls.length, 2)
})
test('mobile transport refuses preview, unapproved origins, paths and credentialed URLs before native I/O', async () => {
  const { calls, nativeRequest } = fixture()
  for (const url of ['https://other.example/v1/tools/search', 'http://api.deepseek.com/v1/tools/search', 'https://user:pass@api.deepseek.com/v1/tools/search', 'https://api.deepseek.com/v1/tools/search?x=1', 'https://api.deepseek.com/v1/tools/search#fragment', 'https://api.deepseek.com/anthropic/v1/messages', 'https://api.deepseek.com/v1/tools/delete']) {
    await assert.rejects(nativeRequest({ url, method: 'POST' }), /只允许/u)
  }
  await assert.rejects(nativeRequest({ url: 'https://api.deepseek.com/v1/tools/search', method: 'GET' }), /只允许/u)
  assert.equal(calls.length, 0)
  const preview = fixture(false)
  await assert.rejects(preview.nativeRequest({ url: 'https://api.deepseek.com/v1/tools/search', method: 'POST' }), /原生 App/u)
  assert.equal(preview.calls.length, 0)
})
