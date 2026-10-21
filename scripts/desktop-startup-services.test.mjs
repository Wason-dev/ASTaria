import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const { createStartupServices } = createRequire(import.meta.url)('../desktop/startupServices.cjs')

test('integrations do not run before paint and repeated readiness never starts duplicate work', async () => {
  const calls = [], startup = createStartupServices({ startSync: () => calls.push('sync'), initializeReminders: async () => calls.push('reminders') })
  assert.deepEqual(calls, [])
  startup.start(); startup.start(); await Promise.resolve()
  assert.deepEqual(calls, ['sync', 'reminders'])
})
test('closing before readiness does not launch scans or notification helpers', () => {
  const startup = createStartupServices({ startSync: () => assert.fail('closed startup'), initializeReminders: () => assert.fail('closed startup') })
  startup.close(); startup.start()
})
test('failed integration does not prevent another from initializing or become an unhandled rejection', async () => {
  const expected = new Error('fixture failure'), errors = [], calls = []
  const startup = createStartupServices({ startSync: () => { throw expected }, initializeReminders: async () => { calls.push('reminders'); throw expected }, onError: error => errors.push(error) })
  startup.start(); await Promise.resolve(); await Promise.resolve()
  assert.deepEqual(calls, ['reminders']); assert.deepEqual(errors, [expected, expected])
})
