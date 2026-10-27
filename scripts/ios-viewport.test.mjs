import assert from 'node:assert/strict'
import { test } from 'node:test'
import { attachIOSViewport, normalizeIOSViewport } from '../mobile/runtime/iosViewport.ts'

const sample = (revision, inset = 0, extra = {}) => ({
  revision, layoutWidth: 440, layoutHeight: 956, visibleHeight: 956 - inset,
  keyboardInset: inset, keyboardVisible: inset > 0,
  safeArea: { top: 62, right: 0, bottom: 34, left: 0 }, ...extra,
})
const tick = () => new Promise(resolve => setImmediate(resolve))
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function fixture({ query = async () => sample(0), listenerReady } = {}) {
  const document = new EventTarget(), window = new EventTarget()
  const values = new Map(), events = [], writes = []
  document.documentElement = { dataset: {}, style: {
    getPropertyValue: name => values.get(name) ?? '',
    setProperty: (name, value) => { values.set(name, value); writes.push([name, value]) },
  } }
  document.hidden = false
  window.document = document
  // A focus pan and a zoom must have no authority over native window geometry.
  window.visualViewport = new EventTarget()
  document.addEventListener('astaria-mobile-viewport-change', event => events.push(event.detail))
  let listener, removed = 0, queries = 0
  const bridge = {
    getViewport: () => { queries++; return query() },
    addListener: async (name, callback) => {
      assert.equal(name, 'viewportChanged'); listener = callback
      if (listenerReady) await listenerReady
      return { remove: async () => { removed++ } }
    },
  }
  return { document, window, values, events, writes, bridge,
    push: value => listener(value), removed: () => removed, queries: () => queries }
}

test('native keyboard frames keep the full scene size through open, language switch and close', async () => {
  const f = fixture()
  const dispose = attachIOSViewport(f.bridge, sample(0), f.window)
  await tick()
  for (const [i, inset] of [8, 80, 200, 416, 456, 416, 200, 8, 0].entries()) {
    f.push(sample(i + 1, inset))
    assert.equal(f.values.get('--m-layout-height'), '956px')
    assert.equal(f.values.get('--m-visible-height'), `${956 - inset}px`)
    assert.equal(f.values.get('--m-visible-offset-top'), '0px')
  }
  assert.equal(f.document.documentElement.dataset.mobileKeyboard, 'closed')
  assert.equal(f.events.length, 10)
  dispose()
})

test('late initial and resume queries cannot replace a newer native keyboard frame', async () => {
  const pending = deferred(), f = fixture({ query: () => pending.promise })
  const dispose = attachIOSViewport(f.bridge, sample(1), f.window)
  await tick()
  f.push(sample(8, 416))
  pending.resolve(sample(2)); await tick()
  assert.equal(f.values.get('--m-visible-height'), '540px')
  assert.equal(f.events.length, 2)
  f.push(sample(NaN)); f.push(sample(Infinity)); f.push(sample(-1))
  assert.equal(f.events.length, 2)
  dispose()
})

test('WebKit resize, pan, zoom and focus notifications cannot resize the native scene', async () => {
  const f = fixture()
  const dispose = attachIOSViewport(f.bridge, sample(0), f.window)
  await tick()
  f.push(sample(1, 416))
  const count = f.writes.length
  for (const type of ['scroll', 'resize']) f.window.visualViewport.dispatchEvent(new Event(type))
  for (const type of ['focusin', 'focusout', 'scroll', 'resize']) f.window.dispatchEvent(new Event(type))
  f.push(sample(2, 416))
  assert.equal(f.writes.length, count)
  assert.equal(f.events.length, 2)
  assert.equal(f.queries(), 1)
  dispose()
})

test('window resize publishes new native size and safe areas without old orientation constraints', async () => {
  const f = fixture(), dispose = attachIOSViewport(f.bridge, sample(0), f.window)
  await tick()
  f.push(sample(1, 300, { layoutWidth: 1194, layoutHeight: 834,
    safeArea: { top: 24, right: 0, bottom: 20, left: 0 } }))
  assert.equal(f.values.get('--m-layout-height'), '834px')
  assert.equal(f.values.get('--m-visible-height'), '534px')
  assert.equal(f.values.get('--safe-area-inset-top'), '24px')
  f.push(sample(2, 0, { layoutWidth: 600, layoutHeight: 700.5 }))
  assert.equal(f.values.get('--m-layout-height'), '701px')
  assert.equal(f.document.documentElement.dataset.mobileKeyboard, 'closed')
  dispose()
})

test('invalid bridge data is ignored and a nondocked keyboard does not shrink the page', () => {
  for (const bad of [{ layoutWidth: 0 }, { layoutHeight: NaN }, { keyboardInset: -3 },
    { safeArea: undefined }, { safeArea: { top: -1, right: 0, bottom: 0, left: 0 } }]) {
    assert.equal(normalizeIOSViewport(sample(1, 0, bad)), null)
  }
  const floating = normalizeIOSViewport(sample(1, 0))
  assert.equal(floating.keyboard, 'closed')
  assert.equal(floating.visibleHeight, 956)
  assert.equal(normalizeIOSViewport(sample(1, 2000)).visibleHeight, 1)
})

test('dispose releases a late listener and ignores pending results and resume events', async () => {
  const ready = deferred(), query = deferred()
  const f = fixture({ listenerReady: ready.promise, query: () => query.promise })
  const dispose = attachIOSViewport(f.bridge, sample(0), f.window)
  dispose(); ready.resolve(); query.resolve(sample(2, 416)); await tick()
  f.push(sample(3, 416))
  f.window.dispatchEvent(new Event('pageshow'))
  f.document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(f.removed(), 1)
  assert.equal(f.queries(), 0)
  assert.equal(f.events.length, 1)
})
