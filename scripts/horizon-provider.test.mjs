import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompletion } from '../server/provider.mjs'

const payload = { messages: [{ role: 'user', content: '只核对初排' }], max_tokens: 1024 }
const result = { choices: [{ message: { content: '{"changes":[]}' }, finish_reason: 'stop' }] }

for (const purpose of ['horizon-order', 'horizon-grouping']) for (const effort of ['off', 'low', 'high', 'max']) test(`${purpose} caps ${effort} without changing subsequent chat settings`, async () => {
  const requests = [], settings = { provider: 'deepseek', reasoningEffort: effort, streamResponses: false }
  const complete = createCompletion({ read: async () => 'test-only-key' }, async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return Response.json(result)
  }, () => 'deepseek-flash', () => settings)
  await complete(payload, { purpose })
  await complete(payload)
  assert.equal(requests[0].reasoning_effort, 'low')
  assert.equal(requests[0].thinking.type, 'enabled')
  assert.equal(requests[1].reasoning_effort, effort === 'off' ? 'none' : effort)
  assert.equal(settings.reasoningEffort, effort)
  assert.equal(requests[0].model, requests[1].model)
  assert.equal(requests[0].purpose, undefined)
  assert.equal(requests[0].stream, false)
})

test('local horizon review uses the selected local provider without cloud-specific controls or key access', async () => {
  let request
  const complete = createCompletion({ read: () => { throw new Error('local must not read a key') } }, async (url, options) => {
    request = { url, body: JSON.parse(options.body), headers: options.headers }
    return Response.json(result)
  }, () => 'deepseek-flash', () => ({ provider: 'local', reasoningEffort: 'max', local: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'test-local' } }))
  await complete(payload, { purpose: 'horizon-order' })
  assert.equal(request.url, 'http://127.0.0.1:11434/v1/chat/completions')
  assert.equal(request.body.model, 'test-local')
  assert.equal(request.body.reasoning_effort, undefined)
  assert.equal(request.body.thinking, undefined)
  assert.equal(request.body.max_tokens, 1024)
  assert.equal(request.headers.Authorization, undefined)
})
