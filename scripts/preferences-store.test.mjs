import test from 'node:test'
import assert from 'node:assert/strict'
import { createPreferencesStore } from '../src/xixi/preferencesStore.ts'

const initial = () => ({ theme: 'dark', glass: 'clear', effect: { brightness: 0.8, enabled: true } })
const flush = () => new Promise(resolve => setImmediate(resolve))

function harness({ visible = true } = {}) {
  const timers = new Map(), visibilityListeners = new Set(), publishListeners = new Set(), requests = []
  let nextTimer = 0
  const store = createPreferencesStore({
    initialValue: initial(),
    read: () => new Promise((resolve, reject) => requests.push({ resolve, reject })),
    isVisible: () => visible,
    onVisibilityChange: listener => { visibilityListeners.add(listener); return () => visibilityListeners.delete(listener) },
    onPublish: listener => { publishListeners.add(listener); return () => publishListeners.delete(listener) },
    setTimer: (listener, delay) => { const id = ++nextTimer; timers.set(id, { listener, delay }); return id },
    clearTimer: id => timers.delete(id),
  })
  return {
    store, requests, timers, visibilityListeners, publishListeners,
    setVisible: next => { visible = next; visibilityListeners.forEach(listener => listener()) },
    publishEvent: value => publishListeners.forEach(listener => listener(value)),
    firePoll: () => {
      assert.equal(timers.size, 1)
      const [id, timer] = timers.entries().next().value
      assert.equal(timer.delay, 15_000)
      timers.delete(id)
      timer.listener()
    },
  }
}

test('all consumers share one read, one poll, and one pair of listeners', async () => {
  const h = harness()
  const notifications = Array(8).fill(0)
  const unsubscribe = notifications.map((_, index) => h.store.subscribe(() => notifications[index]++))
  const pending = h.store.refresh()
  assert.equal(h.store.refresh(), pending)
  await flush()
  assert.equal(h.requests.length, 1)
  assert.equal(h.visibilityListeners.size, 1)
  assert.equal(h.publishListeners.size, 1)
  h.requests[0].resolve(initial())
  await pending
  assert.deepEqual(notifications, Array(8).fill(1))
  assert.equal(h.timers.size, 1)
  h.firePoll()
  await flush()
  assert.equal(h.requests.length, 2)
  h.requests[1].resolve(initial())
  await h.store.refresh()
  unsubscribe.slice(0, 7).forEach(stop => stop())
  assert.equal(h.timers.size, 1)
  unsubscribe[7]()
  assert.equal(h.timers.size, 0)
  assert.equal(h.visibilityListeners.size, 0)
  assert.equal(h.publishListeners.size, 0)
})

test('unchanged values retain snapshot and value references without notifying subscribers', async () => {
  const h = harness()
  let notifications = 0
  const stop = h.store.subscribe(() => notifications++)
  const first = h.store.refresh()
  await flush()
  h.requests[0].resolve(initial())
  await first
  const previous = h.store.getSnapshot()
  const second = h.store.refresh()
  await flush()
  h.requests[1].resolve({ effect: { enabled: true, brightness: 0.8 }, glass: 'clear', theme: 'dark' })
  await second
  assert.equal(h.store.getSnapshot(), previous)
  assert.equal(h.store.getSnapshot().value, previous.value)
  assert.equal(notifications, 1)
  stop()
})

test('hidden documents remove polling entirely and resume with one read when visible', async () => {
  const h = harness()
  const stop = h.store.subscribe(() => {})
  const first = h.store.refresh()
  await flush()
  h.requests[0].resolve(initial())
  await first
  assert.equal(h.timers.size, 1)
  h.setVisible(false)
  assert.equal(h.timers.size, 0)
  h.setVisible(true)
  await flush()
  assert.equal(h.requests.length, 2)
  const resumed = h.store.refresh()
  h.setVisible(false)
  h.requests[1].resolve(initial())
  await resumed
  assert.equal(h.timers.size, 0, 'a read finishing after the window hides must not restart polling')
  stop()
})

test('mounting while hidden performs no background read until visibility returns', async () => {
  const h = harness({ visible: false })
  const stop = h.store.subscribe(() => {})
  await flush()
  assert.equal(h.requests.length, 0)
  assert.equal(h.timers.size, 0)
  h.setVisible(true)
  const pending = h.store.refresh()
  await flush()
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve(initial())
  await pending
  stop()
})

test('publishing a save immediately updates all consumers and supersedes a stale read', async () => {
  const h = harness()
  let notifications = 0
  const stop = h.store.subscribe(() => notifications++)
  const pending = h.store.refresh()
  await flush()
  const saved = { ...initial(), glass: 'soft' }
  h.publishEvent(saved)
  assert.equal(h.store.getSnapshot().value, saved)
  assert.equal(h.store.getSnapshot().loaded, true)
  assert.equal(notifications, 1)
  h.requests[0].resolve(initial())
  await pending
  assert.equal(h.store.getSnapshot().value, saved)
  assert.equal(notifications, 1)
  stop()
})

test('a refresh after a save waits for a fresh read without overlapping the superseded request', async () => {
  const h = harness()
  const stop = h.store.subscribe(() => {})
  const oldRead = h.store.refresh()
  await flush()
  h.store.publish({ ...initial(), glass: 'soft' })
  const refresh = h.store.refresh(), concurrentRefresh = h.store.refresh()
  let completed = false
  void refresh.then(() => { completed = true })
  await flush()
  assert.equal(h.requests.length, 1)
  h.requests[0].resolve(initial())
  await oldRead
  await flush()
  assert.equal(h.requests.length, 2)
  assert.equal(completed, false)
  assert.equal(h.store.getSnapshot().value.glass, 'soft')
  const latest = { ...initial(), glass: 'soft', theme: 'light' }
  h.requests[1].resolve(latest)
  await Promise.all([refresh, concurrentRefresh])
  assert.equal(h.store.getSnapshot().value, latest)
  assert.equal(completed, true)
  stop()
})

test('publishing even an equal value invalidates an older read and its later error', async () => {
  const h = harness()
  const stop = h.store.subscribe(() => {})
  const pending = h.store.refresh()
  await flush()
  h.store.publish(initial())
  const saved = h.store.getSnapshot()
  h.requests[0].reject(new Error('stale failure'))
  await pending
  assert.equal(h.store.getSnapshot(), saved)
  assert.equal(h.store.getSnapshot().error, '')
  stop()
})

test('read failures remain recoverable and equal successful data clears the error', async () => {
  const h = harness()
  const stop = h.store.subscribe(() => {})
  const failed = h.store.refresh()
  await flush()
  h.requests[0].reject(new Error('offline'))
  await failed
  assert.equal(h.store.getSnapshot().error, 'offline')
  assert.equal(h.store.getSnapshot().loaded, false)
  assert.equal(h.timers.size, 1)
  const value = h.store.getSnapshot().value
  h.firePoll()
  const recovered = h.store.refresh()
  await flush()
  h.requests[1].resolve(initial())
  await recovered
  assert.equal(h.store.getSnapshot().error, '')
  assert.equal(h.store.getSnapshot().loaded, true)
  assert.equal(h.store.getSnapshot().value, value)
  stop()
})

test('StrictMode unmount and remount reuse the pending request and clean up listeners', async () => {
  const h = harness()
  const firstStop = h.store.subscribe(() => {})
  firstStop()
  assert.equal(h.visibilityListeners.size, 0)
  const secondStop = h.store.subscribe(() => {})
  const pending = h.store.refresh()
  await flush()
  assert.equal(h.requests.length, 1)
  assert.equal(h.visibilityListeners.size, 1)
  secondStop()
  h.requests[0].resolve(initial())
  await pending
  assert.equal(h.timers.size, 0)
  assert.equal(h.visibilityListeners.size, 0)
  assert.equal(h.publishListeners.size, 0)
})

test('local saves while unmounted remain cached and cannot be replaced by an older read', async () => {
  const h = harness()
  const stop = h.store.subscribe(() => {})
  const pending = h.store.refresh()
  await flush()
  stop()
  const saved = { ...initial(), theme: 'light' }
  h.store.publish(saved)
  h.requests[0].resolve(initial())
  await pending
  assert.equal(h.store.getSnapshot().value, saved)
  assert.equal(h.timers.size, 0)
})
