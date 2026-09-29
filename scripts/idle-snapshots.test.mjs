/**
 * Behavior contract for the idle-work guards.
 *
 * `sameSnapshot` decides whether a polled JSON snapshot is worth a new React
 * snapshot; `mergeConversation` leans on it so an unchanged poll keeps the
 * current object; `startVisiblePolling` owns the foreground-only cadence and
 * must leave no timer (and no listener) behind while hidden or after cleanup.
 * These specs assert the observable behavior, never the source text.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { sameSnapshot } from '../src/stores/sameSnapshot.ts'
import { startVisiblePolling } from '../src/stores/visiblePolling.ts'
import { conversationTimeline, mergeConversation, mergeOperationReceipt } from '../src/xixi/conversationTimeline.ts'

const at = '2026-09-20T12:00:00.000Z'
const message = (requestId, role, seq, extra = {}) => ({ id: `${requestId}:${role}:${seq}`, requestId, role, seq, content: requestId, createdAt: at, ...extra })
const operation = (requestId, extra = {}) => ({ id: `op:${requestId}`, requestId, summary: requestId, createdAt: at, readAt: null, undoneAt: null, ...extra })
// Mirrors the /conversation payload, which always carries a companionActions array (server/index.mjs).
const state = (messages, operations = [], extra = {}) => ({ conversationId: 'main', messages, operations, companionActions: [], oldestSeq: messages[0]?.seq ?? null, hasOlder: false, ...extra })
const oldAction = { id: 'action:old', requestId: 'old', kind: 'scenario', label: '旧草案', createdAt: at }

/** Rebuild every object with its keys inserted in reverse order, like a differently serialized API payload. */
const reorderKeys = value => Array.isArray(value)
  ? value.map(reorderKeys)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorderKeys(value[key])]))
    : value

/* -------------------------------------------------------------------------- *
 * Snapshot equality
 * -------------------------------------------------------------------------- */

test('sameSnapshot treats reordered JSON keys as the same snapshot', () => {
  assert.equal(sameSnapshot({ id: 'main', hasOlder: false, oldestSeq: 1 }, { oldestSeq: 1, hasOlder: false, id: 'main' }), true)
  assert.equal(sameSnapshot(
    { messages: [{ id: 'a', seq: 1, retractedAt: null }], hasOlder: true },
    { hasOlder: true, messages: [{ seq: 1, retractedAt: null, id: 'a' }] },
  ), true)
  const snapshot = { conversationId: 'main', messages: [{ id: 'a', seq: 1 }], operations: [{ id: 'op:a', undoneAt: null }], hasOlder: false }
  assert.equal(sameSnapshot(snapshot, reorderKeys(snapshot)), true)
})

test('sameSnapshot reports nested values, deletions and ordering changes', () => {
  assert.equal(sameSnapshot({ a: { b: [1, 2, { c: 3 }] } }, { a: { b: [1, 2, { c: 4 }] } }), false, 'nested value')
  assert.equal(sameSnapshot({ a: 1, b: 2 }, { a: 1 }), false, 'removed key')
  assert.equal(sameSnapshot({ a: 1 }, { a: 1, b: 2 }), false, 'added key')
  assert.equal(sameSnapshot({ list: [1, 2] }, { list: [2, 1] }), false, 'array order')
  assert.equal(sameSnapshot({ list: [1, 2] }, { list: [1, 2, 3] }), false, 'array length')
  assert.equal(sameSnapshot({ list: [1] }, { list: { 0: 1, length: 1 } }), false, 'array versus object')
  assert.equal(sameSnapshot({ value: '1' }, { value: 1 }), false, 'value type')
})

test('sameSnapshot keeps identity, primitive equality and null boundaries', () => {
  const snapshot = { a: 1 }
  assert.equal(sameSnapshot(snapshot, snapshot), true)
  assert.equal(sameSnapshot('same', 'same'), true)
  assert.equal(sameSnapshot(NaN, NaN), true)
  assert.equal(sameSnapshot(null, null), true)
  assert.equal(sameSnapshot(null, {}), false)
  assert.equal(sameSnapshot({ a: 1 }, null), false)
})

/* -------------------------------------------------------------------------- *
 * Merge stability
 * -------------------------------------------------------------------------- */

test('merging an identical conversation keeps the current object reference', () => {
  const user = message('current', 'user', 201), reply = message('current', 'assistant', 203)
  const current = state([user, reply], [operation('current')])
  assert.equal(mergeConversation(current, current), current)
  assert.equal(mergeConversation(current, reorderKeys(current)), current, 'key order is not a change')
  assert.equal(mergeConversation(current, JSON.parse(JSON.stringify(current))), current, 'a fresh poll payload is not a change')
})

test('polling after older history was loaded keeps the merged reference', () => {
  const operations = [operation('old'), operation('current')]
  const older = state([message('old', 'user', 1), message('old', 'assistant', 3)], operations, { companionActions: [oldAction], oldestSeq: 1, hasOlder: false })
  const current = state([message('current', 'user', 201), message('current', 'assistant', 203)], operations, { oldestSeq: 201, hasOlder: true })

  const loaded = mergeConversation(older, current)
  assert.notEqual(loaded, older)
  assert.deepEqual(loaded.messages.map(item => item.seq), [1, 3, 201, 203])
  assert.equal(loaded.oldestSeq, 1)
  assert.equal(loaded.hasOlder, false)

  assert.equal(mergeConversation(loaded, current), loaded, 'the same poll must not replace loaded history')
  assert.equal(mergeConversation(loaded, reorderKeys(current)), loaded)
  assert.deepEqual(conversationTimeline(loaded).map(row => row.operations.map(item => item.id)), [[], ['op:old'], [], ['op:current']])
  assert.equal(conversationTimeline(loaded)[1].companionActions[0].id, oldAction.id)
})

test('withdrawals, undo receipts, companion actions and paging metadata are never judged identical', () => {
  const user = message('current', 'user', 201), reply = message('current', 'assistant', 203)
  const current = state([user, reply], [operation('current')], { oldestSeq: 201, hasOlder: false })

  const withdrawn = mergeConversation(current, state([user, { ...reply, retractedAt: at }], current.operations, { oldestSeq: 201, hasOlder: false }))
  assert.notEqual(withdrawn, current)
  assert.deepEqual(withdrawn.messages.map(item => item.id), [user.id])

  const undone = mergeConversation(current, state([user, reply], [{ ...operation('current'), undoneAt: at }], { oldestSeq: 201, hasOlder: false }))
  assert.notEqual(undone, current)
  assert.equal(undone.operations[0].undoneAt, at)
  assert.equal(mergeOperationReceipt(current, { ...operation('current'), undoneAt: at }).operations[0].undoneAt, at)

  const linked = mergeConversation(current, state([user, reply], current.operations, { companionActions: [oldAction], oldestSeq: 201, hasOlder: false }))
  assert.notEqual(linked, current)
  assert.equal(linked.companionActions[0].id, oldAction.id)

  const paged = mergeConversation(current, state([user, reply], current.operations, { oldestSeq: 201, hasOlder: true }))
  assert.notEqual(paged, current)
  assert.equal(paged.hasOlder, true)

  const deeper = mergeConversation(current, state([user, reply], current.operations, { oldestSeq: 1, hasOlder: true }))
  assert.notEqual(deeper, current)
  assert.equal(deeper.oldestSeq, 1)

  const other = state([user, reply], current.operations)
  other.conversationId = 'another'
  assert.equal(mergeConversation(current, other), other, 'another conversation replaces the snapshot')
})

/* -------------------------------------------------------------------------- *
 * Foreground-only polling
 * -------------------------------------------------------------------------- */

function installGlobals(values) {
  const previous = new Map()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, { owned: Object.prototype.hasOwnProperty.call(globalThis, key), value: globalThis[key] })
    globalThis[key] = value
  }
  return () => {
    for (const [key, entry] of previous) {
      if (entry.owned) globalThis[key] = entry.value
      else delete globalThis[key]
    }
  }
}

/** A DOM-shaped host with manual interval callbacks; nothing here waits on real time. */
function fakeVisibilityHost(initial) {
  const document = new EventTarget()
  let visibility = initial
  Object.defineProperty(document, 'visibilityState', { get: () => visibility, configurable: true })
  const intervals = new Map()
  let nextId = 0
  const restore = installGlobals({
    document,
    window: {
      setInterval(callback, milliseconds) {
        const id = ++nextId
        intervals.set(id, { callback, milliseconds })
        return id
      },
    },
    clearInterval(id) { intervals.delete(id) },
  })
  return {
    intervals,
    restore,
    delays: () => [...intervals.values()].map(timer => timer.milliseconds),
    fire: () => { for (const timer of [...intervals.values()]) timer.callback() },
    dispatch(next) { visibility = next; document.dispatchEvent(new Event('visibilitychange')) },
  }
}

test('visible polling refreshes immediately and arms exactly one interval', t => {
  const host = fakeVisibilityHost('visible')
  t.after(host.restore)
  let refreshes = 0
  startVisiblePolling(() => { refreshes += 1 }, 5000)

  assert.equal(refreshes, 1, 'the first read happens without waiting for a period')
  assert.deepEqual(host.delays(), [5000])
  assert.equal(host.intervals.size, 1)

  host.fire()
  assert.equal(refreshes, 2, 'the armed interval callback is the refresh')
  assert.equal(host.intervals.size, 1)
})

test('hiding clears the timer and performs no periodic refresh', t => {
  const host = fakeVisibilityHost('visible')
  t.after(host.restore)
  let refreshes = 0
  startVisiblePolling(() => { refreshes += 1 }, 1000)
  assert.equal(refreshes, 1)

  host.dispatch('hidden')
  assert.equal(refreshes, 1, 'hiding itself does not refresh')
  assert.equal(host.intervals.size, 0, 'the timer is gone, not merely skipped')
  host.fire()
  assert.equal(refreshes, 1)

  host.dispatch('hidden')
  assert.equal(refreshes, 1)
  assert.equal(host.intervals.size, 0)
})

test('initial hidden starts nothing, and resuming refreshes once with one timer', t => {
  const host = fakeVisibilityHost('hidden')
  t.after(host.restore)
  let refreshes = 0
  startVisiblePolling(() => { refreshes += 1 }, 2000)
  assert.equal(refreshes, 0, 'a hidden start performs no read')
  assert.equal(host.intervals.size, 0, 'a hidden start arms no timer')

  host.dispatch('visible')
  assert.equal(refreshes, 1, 'resuming refreshes immediately')
  assert.equal(host.intervals.size, 1, 'and arms exactly one timer')

  host.dispatch('visible')
  assert.equal(refreshes, 2, 'a redundant visibility event still refreshes immediately')
  assert.equal(host.intervals.size, 1, 'without stacking timers')

  host.fire()
  assert.equal(refreshes, 3)
  assert.equal(host.intervals.size, 1)
})

test('cleanup stops the timer and detaches the visibility listener', t => {
  const host = fakeVisibilityHost('visible')
  t.after(host.restore)
  let refreshes = 0
  const stop = startVisiblePolling(() => { refreshes += 1 }, 1000)
  assert.equal(refreshes, 1)

  stop()
  assert.equal(host.intervals.size, 0)
  host.dispatch('hidden')
  host.dispatch('visible')
  assert.equal(refreshes, 1, 'later visibility events must not refresh after cleanup')
  assert.equal(host.intervals.size, 0, 'nor arm a timer again')

  stop()
  assert.equal(host.intervals.size, 0)
  assert.equal(refreshes, 1)
})
