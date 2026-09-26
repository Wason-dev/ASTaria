import test from 'node:test'
import assert from 'node:assert/strict'
import { createCompletion } from '../server/provider.mjs'

test('caller cancellation reaches the provider fetch without losing its timeout', async () => {
  const controller = new AbortController()
  let entered
  const started = new Promise(resolve => { entered = resolve })
  let fetchSignal
  const complete = createCompletion({ read: async () => 'test-only-key' }, async (_url, { signal }) => {
    fetchSignal = signal
    entered()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  })
  const request = complete({ messages: [{ role: 'user', content: 'test' }] }, { signal: controller.signal })
  await started
  assert.notEqual(fetchSignal, controller.signal)
  assert.equal(fetchSignal.aborted, false)
  controller.abort()
  await assert.rejects(request)
  assert.equal(fetchSignal.aborted, true)
})
