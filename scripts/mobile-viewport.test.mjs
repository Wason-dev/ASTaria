/**
 * Regression tests for mobile/runtime/viewport.ts
 *
 * Scope (contract only, no production edits):
 *  - calculateMobileViewport(input, previous?): pure reducer, numeric assertions.
 *  - attachMobileViewport(...): attachments against a minimal EventTarget DOM/Window double.
 *
 * Run: node --test scripts/mobile-viewport.test.mjs
 */
import assert from 'node:assert/strict'
import { after, describe, test } from 'node:test'

import {
  MOBILE_VIEWPORT_EVENT,
  attachMobileViewport,
  calculateMobileViewport,
} from '../mobile/runtime/viewport.ts'

// ---------------------------------------------------------------------------
// Minimal DOM / Window double (no dependencies)
// ---------------------------------------------------------------------------

/** Compatible with the `element instanceof HTMLElement` probe in isEditing(). */
class FakeElement extends EventTarget {
  constructor(init = {}) {
    super()
    this.isContentEditable = init.isContentEditable ?? false
    this.readOnly = init.readOnly ?? false
    this.disabled = init.disabled ?? false
    this.type = init.type ?? ''
    this.focusin = 0
    this.focusout = 0
    this.addEventListener('focusin', () => { this.focusin += 1 })
    this.addEventListener('focusout', () => { this.focusout += 1 })
  }
}

class FakeTextAreaElement extends FakeElement {}
class FakeInputElement extends FakeElement {}

/** The reducer's `element instanceof HTMLInputElement` prefix runs before `element.type` is read. */
const previousHTMLElement = globalThis.HTMLElement
const previousHTMLInputElement = globalThis.HTMLInputElement
const previousHTMLTextAreaElement = globalThis.HTMLTextAreaElement
globalThis.HTMLElement = FakeElement
globalThis.HTMLInputElement = FakeInputElement
globalThis.HTMLTextAreaElement = FakeTextAreaElement

after(() => {
  globalThis.HTMLElement = previousHTMLElement
  globalThis.HTMLInputElement = previousHTMLInputElement
  globalThis.HTMLTextAreaElement = previousHTMLTextAreaElement
})

/** Records every setProperty so "no duplicate CSS write" is directly observable. */
class FakeStyle {
  constructor() {
    this.values = new Map()
    this.writes = []
  }

  getPropertyValue(name) {
    return this.values.get(name) ?? ''
  }

  setProperty(name, value) {
    this.values.set(name, value)
    this.writes.push([name, value])
  }

  writesFor(name) {
    return this.writes.filter(([property]) => property === name).map(([, value]) => value)
  }
}

class FakeDocument extends EventTarget {
  constructor({ activeElement = null } = {}) {
    super()
    this.documentElement = { style: new FakeStyle(), dataset: {} }
    this.activeElement = activeElement
    this.hidden = false
    this.dispatched = []
    this.addEventListener(MOBILE_VIEWPORT_EVENT, event => { this.dispatched.push(event.detail) })
  }

  get css() {
    return this.documentElement.style
  }

  get dataset() {
    return this.documentElement.dataset
  }
}

function createWindow(document, { innerWidth = 390, innerHeight = 800, visualViewport = null } = {}) {
  const listeners = new Map()
  const frames = new Map()
  const cancelled = []
  let nextFrame = 1

  const add = (subject, event, handler) => {
    const set = listeners.get(event) ?? new Set()
    set.add(handler)
    listeners.set(event, set)
    subject.addEventListener(event, handler)
  }
  const remove = (subject, event, handler) => {
    listeners.get(event)?.delete(handler)
    subject.removeEventListener(event, handler)
  }
  const emit = (subject, event, init = {}) => subject.dispatchEvent(new Event(event, init))

  const target = new EventTarget()
  const fakeWindow = {
    document,
    visualViewport,
    innerWidth,
    innerHeight,
    screen: { width: innerWidth, height: innerHeight, orientation: { type: 'portrait-primary' } },
    orientation: 0,
    addEventListener: (event, handler) => add(target, event, handler),
    removeEventListener: (event, handler) => remove(target, event, handler),
    dispatchEvent: event => target.dispatchEvent(event),
    requestAnimationFrame: callback => {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    },
    cancelAnimationFrame: id => {
      cancelled.push(id)
      frames.delete(id)
    },
  }

  return {
    window: fakeWindow,
    document,
    cancelled,
    pendingFrames: () => frames.size,
    count: event => listeners.get(event)?.size ?? 0,
    emit,
    /** requestAnimationFrame semantics: queued work runs only on the next real frame. */
    flush() {
      const queued = [...frames.entries()]
      frames.clear()
      for (const [, callback] of queued) callback(0)
      return queued.length
    },
  }
}

/** Mirrors the publish shape so detail can be compared with toEqual. */
const metrics = state => ({
  layoutWidth: state.layoutWidth,
  layoutHeight: state.layoutHeight,
  visibleHeight: state.visibleHeight,
  offsetTop: state.offsetTop,
  keyboardInset: state.keyboardInset,
  keyboard: state.keyboard,
})

const viewportPayload = (width, height, overrides = {}) => ({
  layoutWidth: width,
  layoutHeight: height,
  visibleHeight: height,
  keyboardInset: 0,
  keyboardVisible: false,
  ...overrides,
})

const flushMicrotasks = () => new Promise(resolve => { setImmediate(resolve) })

// ---------------------------------------------------------------------------
// 1. Pure reducer
// ---------------------------------------------------------------------------

describe('calculateMobileViewport', () => {
  test('fractional native window height covers the last physical pixel without changing the IME extent', () => {
    const native = { layoutWidth: 390, layoutHeight: 844.4, visibleHeight: 544.4, keyboardInset: 300, keyboardVisible: true,
      safeArea: { top: 24, right: 0, bottom: 12, left: 0 } }
    const result = calculateMobileViewport({ innerWidth: 390, innerHeight: 844, native })
    assert.equal(result.layoutHeight, 845)
    assert.equal(result.visibleHeight, 544)
    assert.equal(result.keyboardInset, 300)
  })
  test('initial 390x800 layout', () => {
    const state = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 })
    assert.equal(state.layoutWidth, 390)
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 800)
    assert.equal(state.offsetTop, 0)
    assert.equal(state.keyboardInset, 0)
    assert.equal(state.keyboard, 'closed')
    assert.equal(state.keyboardSession, false)
    assert.equal(state.geometry, '390::0:0')
  })

  test('iOS visual viewport alone (inner 800, visual 500) keeps the 800 layout', () => {
    const state = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 800,
      focused: true,
      visualViewport: { height: 500 },
    })
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 500)
    assert.equal(state.offsetTop, 0)
    assert.equal(state.keyboardInset, 300)
    assert.equal(state.keyboard, 'open')
    assert.equal(state.keyboardSession, true)
  })

  test('Android inner and visual viewport dropping to 500 together keeps the 800 layout', () => {
    const initial = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 })
    assert.equal(initial.layoutHeight, 800)

    const state = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 500,
      focused: true,
      visualViewport: { height: 500 },
    }, initial)
    assert.equal(state.layoutHeight, 800, 'the 800 baseline is latched, not replaced by the shrunk 500')
    assert.equal(state.visibleHeight, 500)
    assert.equal(state.offsetTop, 0)
    assert.equal(state.keyboard, 'open')
    assert.equal(state.keyboardInset, 300)

    // Without a previous baseline the first observed frame cannot know 500 is a loss.
    const coldStart = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 500,
      focused: true,
      visualViewport: { height: 500 },
    })
    assert.equal(coldStart.layoutHeight, 500)
    assert.equal(coldStart.visibleHeight, 500)
    assert.equal(coldStart.keyboard, 'closed')
  })

  test('early 780 -> 500 stays latched while editing, close 790 -> 800 restores layout 800', () => {
    let state = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 })
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.keyboardSession, false)

    // Early, sub-threshold frame while editing: no IME yet, but the 800 baseline
    // is latched so the animation frames cannot shrink the layout.
    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 780, focused: true }, state)
    assert.equal(state.keyboard, 'closed')
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 780)
    assert.equal(state.keyboardInset, 0)
    assert.equal(state.keyboardSession, true)

    // Full open: the 800 baseline and the latch both hold.
    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 500, focused: true }, state)
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 500)
    assert.equal(state.keyboardInset, 300)
    assert.equal(state.keyboard, 'open')
    assert.equal(state.keyboardSession, true)

    // Close, first frame: the latch survives the lost focus and keeps layout at 800.
    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 790 }, state)
    assert.equal(state.keyboard, 'closed')
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 790)
    assert.equal(state.keyboardInset, 0)
    assert.equal(state.keyboardSession, true)

    // Fully recovered: the latch finally clears.
    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 }, state)
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 800)
    assert.equal(state.keyboard, 'closed')
    assert.equal(state.keyboardSession, false)
  })

  test('offsetTop 70 with visual 430 reports visible 430 and an IME inset of 300', () => {
    const state = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 800,
      focused: true,
      visualViewport: { height: 430, offsetTop: 70 },
    })
    assert.equal(state.offsetTop, 70)
    assert.equal(state.visibleHeight, 430)
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.keyboardInset, 300)
    assert.equal(state.keyboard, 'open')
  })

  test('landscape 800x390 does not inherit the portrait 800 layout', () => {
    const portrait = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 })
    const landscape = calculateMobileViewport({
      innerWidth: 800,
      innerHeight: 390,
      screenWidth: 800,
      screenHeight: 390,
      orientation: 'landscape-primary',
      visualViewport: { height: 390 },
    }, portrait)
    assert.equal(landscape.geometry, '800:landscape-primary:800:390')
    assert.equal(landscape.layoutWidth, 800)
    assert.equal(landscape.layoutHeight, 390)
    assert.equal(landscape.visibleHeight, 390)
    assert.equal(landscape.keyboard, 'closed')
  })

  test('full native layout (800/500/inset 300) is authoritative while inner is 500', () => {
    const state = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 500,
      focused: true,
      native: {
        layoutWidth: 390,
        layoutHeight: 800,
        visibleHeight: 500,
        keyboardInset: 300,
        keyboardVisible: true,
      },
    })
    assert.equal(state.layoutWidth, 390)
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 500)
    assert.equal(state.offsetTop, 0)
    assert.equal(state.keyboardInset, 300)
    assert.equal(state.keyboard, 'open')
  })

  test('native landscape frame carrying the stale portrait width is rejected', () => {
    const state = calculateMobileViewport({
      innerWidth: 800,
      innerHeight: 390,
      screenWidth: 800,
      screenHeight: 390,
      orientation: 'landscape-primary',
      native: {
        layoutWidth: 390,
        layoutHeight: 800,
        visibleHeight: 500,
        keyboardInset: 300,
        keyboardVisible: true,
      },
    })
    assert.equal(state.layoutWidth, 800)
    assert.equal(state.layoutHeight, 390)
    assert.equal(state.visibleHeight, 390)
    assert.equal(state.keyboardInset, 0)
    assert.equal(state.keyboard, 'closed')
  })

  test('edge-to-edge IME frames override a WebView that already reports the keyboard end size', () => {
    let state
    for (const inset of [0, 12, 48, 110, 230, 300, 220, 100, 24, 0]) {
      state = calculateMobileViewport({ innerWidth: 390, innerHeight: 500, focused: true,
        visualViewport: { height: 480, offsetTop: 20 },
        native: viewportPayload(390, 800, { visibleHeight: 800 - inset, keyboardInset: inset,
          keyboardVisible: inset > 0, safeArea: { top: 28, right: 0, bottom: 24, left: 0 } }),
      }, state)
      assert.equal(state.layoutHeight, 800, 'scene baseline remains fixed')
      assert.equal(state.visibleHeight, 800 - inset, 'follow the actual system animation frame, including sub-threshold frames')
      assert.equal(state.offsetTop, 0, 'do not mix WebView panning from another frame')
      assert.equal(state.keyboardInset, inset)
    }
  })

  test('native close restores the full layout', () => {
    let state = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 800,
      native: viewportPayload(390, 800, {
        visibleHeight: 500,
        keyboardInset: 300,
        keyboardVisible: true,
      }),
    })
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 500)
    assert.equal(state.keyboard, 'open')
    assert.equal(state.keyboardInset, 300)

    state = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 800,
      native: viewportPayload(390, 800),
    }, state)
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 800)
    assert.equal(state.keyboard, 'closed')
    assert.equal(state.keyboardInset, 0)
    assert.equal(state.keyboardSession, false)
  })

  test('without visualViewport a focused element plus a shrunken inner height infers the keyboard', () => {
    let state = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 })
    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 800, focused: true }, state)
    assert.equal(state.keyboard, 'closed')

    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 400, focused: true }, state)
    assert.equal(state.keyboard, 'open')
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 400)
    assert.equal(state.keyboardInset, 400)
  })

  test('scale 2 pinch zoom does not fabricate an IME', () => {
    const state = calculateMobileViewport({
      innerWidth: 390,
      innerHeight: 800,
      visualViewport: { height: 400, offsetTop: 200, scale: 2 },
    })
    assert.equal(state.offsetTop, 200)
    assert.equal(state.visibleHeight, 400, 'zoom still reports the actual visible region')
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.keyboardInset, 0)
    assert.equal(state.keyboard, 'closed')
    assert.equal(state.keyboardSession, false)
  })

  test('an unfocused, sub-threshold shrink recovers the layout', () => {
    let state = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 })
    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 700 }, state)
    assert.equal(state.keyboard, 'closed')
    assert.equal(state.layoutHeight, 700)
    assert.equal(state.visibleHeight, 700)

    state = calculateMobileViewport({ innerWidth: 390, innerHeight: 800 }, state)
    assert.equal(state.layoutHeight, 800)
    assert.equal(state.visibleHeight, 800)
    assert.equal(state.keyboard, 'closed')
  })

  test('NaN, Infinity and zero inputs still yield finite positive extents', () => {
    const degenerate = [
      { innerWidth: Number.NaN, innerHeight: Number.NaN },
      { innerWidth: Number.POSITIVE_INFINITY, innerHeight: Number.POSITIVE_INFINITY },
      { innerWidth: 0, innerHeight: 0 },
      { innerWidth: -390, innerHeight: -800 },
      { innerWidth: 0.1, innerHeight: 0.1 },
    ]
    for (const input of degenerate) {
      const state = calculateMobileViewport(input)
      for (const key of ['layoutWidth', 'layoutHeight', 'visibleHeight', 'offsetTop', 'keyboardInset']) {
        assert.ok(Number.isFinite(state[key]), `${key} must stay finite for ${JSON.stringify(input)}`)
      }
      assert.ok(state.layoutWidth > 0, 'layoutWidth must stay positive')
      assert.ok(state.layoutHeight > 0, 'layoutHeight must stay positive')
      assert.ok(state.visibleHeight > 0, 'visibleHeight must stay positive')
      assert.ok(state.offsetTop >= 0, 'offsetTop must stay non-negative')

      // A degenerate frame must not poison the next one either.
      const next = calculateMobileViewport({ innerWidth: Number.NaN, innerHeight: Number.NaN }, state)
      assert.ok(Number.isFinite(next.layoutHeight) && next.layoutHeight > 0)
      assert.ok(Number.isFinite(next.visibleHeight) && next.visibleHeight > 0)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Attachments against the minimal DOM double
// ---------------------------------------------------------------------------

describe('attachMobileViewport', () => {
  test('a native bootstrap seed prevents an IME-resized first layout', () => {
    const document = new FakeDocument()
    const env = createWindow(document, { innerHeight: 500 })
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: null,
      initialNative: viewportPayload(390, 800, { visibleHeight: 500, keyboardInset: 300, keyboardVisible: true }),
    })
    assert.equal(document.dispatched.length, 1)
    assert.equal(document.dispatched[0].layoutHeight, 800)
    assert.equal(document.dispatched[0].visibleHeight, 500)
    assert.equal(document.dispatched[0].keyboard, 'open')
    assert.deepEqual(document.css.writesFor('--m-layout-height'), ['800px'])
    detach()
  })

  test('coalesces events into a single frame and never republishes identical metrics', () => {
    const document = new FakeDocument()
    const env = createWindow(document)
    const seen = []
    document.addEventListener(MOBILE_VIEWPORT_EVENT, event => seen.push(event.bubbles))
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: null })
    assert.equal(document.dispatched.length, 1, 'initial synchronous publish')
    assert.deepEqual(document.dispatched[0], {
      layoutWidth: 390,
      layoutHeight: 800,
      visibleHeight: 800,
      offsetTop: 0,
      keyboardInset: 0,
      keyboard: 'closed',
    })
    assert.equal(document.dataset.mobileKeyboard, 'closed')

    // Three events in one frame -> one rAF, one update, one unique publish.
    env.window.innerHeight = 780
    env.emit(env.window, 'resize')
    env.emit(env.window, 'focus')
    env.emit(document, 'focusin')
    assert.equal(env.pendingFrames(), 1)
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 2)
    assert.equal(document.dispatched[1].visibleHeight, 780)
    assert.equal(document.css.writesFor('--m-visible-height').length, 2)
    // No offsetTop change, so that variable is not rewritten.
    assert.equal(document.css.writesFor('--m-visible-offset-top').length, 1)

    // Same numbers again -> no CSS write, no event, but still one update.
    env.emit(env.window, 'resize')
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 2)
    assert.equal(document.css.writesFor('--m-visible-height').length, 2)
    assert.equal(document.css.writesFor('--m-layout-height').length, 2)
    assert.deepEqual(seen, [true, true], 'the event is dispatched with bubbles: true')

    detach()
  })

  test('a focused input keeps the layout latched while the keyboard shrinks the page', () => {
    const document = new FakeDocument()
    const visualViewport = new EventTarget()
    visualViewport.height = 800
    visualViewport.offsetTop = 0
    visualViewport.scale = 1
    const env = createWindow(document, { visualViewport })
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: null })
    assert.equal(document.dispatched[0].keyboard, 'closed')

    // Focus an editable control: the focusin listener alone must not shrink the layout.
    document.activeElement = new FakeInputElement({ type: 'text' })
    env.emit(document, 'focusin')
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 1, 'focus alone changes no metric')
    assert.equal(document.dispatched[0].layoutHeight, 800)

    // Keyboard animates in: inner/viewport shrink while the field stays focused.
    env.window.innerHeight = 500
    visualViewport.height = 500
    env.emit(env.window, 'resize')
    env.emit(visualViewport, 'resize')
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 2)
    assert.equal(document.dispatched[1].layoutHeight, 800, 'layout stays at 800 while editing')
    assert.equal(document.dispatched[1].visibleHeight, 500)
    assert.equal(document.dispatched[1].keyboardInset, 300)
    assert.equal(document.dispatched[1].keyboard, 'open')
    assert.equal(document.dataset.mobileKeyboard, 'open')

    // Blur with the viewport still shrunk: metrics are unchanged, so nothing republishes.
    document.activeElement = null
    env.emit(document, 'focusout')
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 2, 'no duplicate publish on blur')
    assert.equal(document.dispatched[1].layoutHeight, 800)

    // Recovery: the page grows back and the latch releases.
    env.window.innerHeight = 800
    visualViewport.height = 800
    env.emit(env.window, 'resize')
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 3)
    assert.equal(document.dispatched[2].layoutHeight, 800)
    assert.equal(document.dispatched[2].visibleHeight, 800)
    assert.equal(document.dispatched[2].keyboardInset, 0)
    assert.equal(document.dispatched[2].keyboard, 'closed')
    assert.equal(document.dataset.mobileKeyboard, 'closed')

    detach()
  })

  test('visualViewport scroll republishes the offsetTop CSS variable and detail', () => {
    const document = new FakeDocument()
    const visualViewport = new EventTarget()
    visualViewport.height = 800
    visualViewport.offsetTop = 0
    visualViewport.scale = 1
    const env = createWindow(document, { visualViewport })
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: null })
    assert.equal(document.css.getPropertyValue('--m-visible-offset-top'), '0px')

    visualViewport.offsetTop = 70
    visualViewport.height = 430
    env.emit(visualViewport, 'scroll')
    assert.equal(env.flush(), 1)
    assert.equal(document.css.getPropertyValue('--m-visible-offset-top'), '70px')
    assert.equal(document.css.getPropertyValue('--m-visible-height'), '430px')
    assert.equal(document.css.getPropertyValue('--m-layout-height'), '800px')
    assert.equal(document.css.getPropertyValue('--m-keyboard-inset'), '300px')
    assert.equal(document.css.getPropertyValue('--mobile-viewport-height'), '430px')
    assert.equal(document.dataset.mobileKeyboard, 'open')
    assert.equal(document.dispatched.length, 2)
    assert.deepEqual(document.dispatched[1], {
      layoutWidth: 390,
      layoutHeight: 800,
      visibleHeight: 430,
      offsetTop: 70,
      keyboardInset: 300,
      keyboard: 'open',
    })

    detach()
  })

  test('detach cancels the pending frame, removes DOM listeners and skips the native listener', async () => {
    const document = new FakeDocument()
    const visualViewport = new EventTarget()
    visualViewport.height = 800
    visualViewport.offsetTop = 0
    visualViewport.scale = 1
    const env = createWindow(document, { visualViewport })
    const calls = { getViewport: 0, addListener: 0, removed: 0 }
    const bridge = {
      async getViewport() {
        calls.getViewport += 1
        throw new Error('detached attachment must not query native')
      },
      async addListener() {
        calls.addListener += 1
        return { async remove() { calls.removed += 1 } }
      },
    }
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: bridge })
    assert.equal(document.dispatched.length, 1)

    env.window.innerHeight = 700
    env.emit(env.window, 'resize')
    assert.equal(env.pendingFrames(), 1)

    detach()
    assert.equal(env.cancelled.length, 1, 'the queued frame is cancelled')
    assert.equal(env.pendingFrames(), 0)
    assert.deepEqual(env.flush(), 0, 'cancelled frame never runs')

    env.emit(env.window, 'resize')
    env.emit(env.window, 'orientationchange')
    env.emit(visualViewport, 'scroll')
    env.emit(document, 'focusin')
    env.emit(document, 'focusout')
    env.emit(document, 'visibilitychange')
    assert.equal(env.count('resize'), 0)
    assert.equal(env.count('orientationchange'), 0)
    assert.equal(env.count('focus'), 0)
    assert.equal(env.pendingFrames(), 0)
    assert.equal(document.dispatched.length, 1)

    await flushMicrotasks()
    assert.equal(calls.addListener, 1)
    assert.equal(calls.removed, 1, 'the late native handle is removed')
    assert.equal(calls.getViewport, 0, 'no native refresh after dispose')

    // Idempotent disposer.
    detach()
    await flushMicrotasks()
    assert.equal(calls.removed, 1)
  })

  test('native addListener rejecting falls back to getViewport, which still drives the DOM', async () => {
    const document = new FakeDocument()
    const env = createWindow(document)
    const calls = { getViewport: 0, addListener: 0 }
    const bridge = {
      async getViewport() {
        calls.getViewport += 1
        return viewportPayload(390, 800, {
          visibleHeight: 500,
          keyboardInset: 300,
          keyboardVisible: true,
        })
      },
      async addListener() {
        calls.addListener += 1
        throw new Error('no native listener available')
      },
    }
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: bridge })
    assert.deepEqual(document.dispatched[0], {
      layoutWidth: 390,
      layoutHeight: 800,
      visibleHeight: 800,
      offsetTop: 0,
      keyboardInset: 0,
      keyboard: 'closed',
    })

    await flushMicrotasks()
    assert.equal(calls.addListener, 1)
    assert.equal(calls.getViewport, 1)
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 2)
    assert.deepEqual(document.dispatched[1], {
      layoutWidth: 390,
      layoutHeight: 800,
      visibleHeight: 500,
      offsetTop: 0,
      keyboardInset: 300,
      keyboard: 'open',
    })
    assert.equal(document.dataset.mobileKeyboard, 'open')
    assert.equal(document.css.getPropertyValue('--m-layout-height'), '800px')
    assert.equal(document.css.getPropertyValue('--m-keyboard-inset'), '300px')

    detach()
  })

  test('a native push arriving before the getViewport reply wins the race', async () => {
    const document = new FakeDocument()
    const env = createWindow(document)
    let push = null
    let releaseQuery = null
    const calls = { getViewport: 0 }
    const bridge = {
      async getViewport() {
        calls.getViewport += 1
        await new Promise(resolve => { releaseQuery = resolve })
        return viewportPayload(390, 800) // stale reply: no keyboard
      },
      async addListener(_event, listener) {
        push = listener
        return { async remove() {} }
      },
    }
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: bridge })
    assert.equal(document.dispatched.length, 1)
    await flushMicrotasks()
    assert.equal(calls.getViewport, 1, 'query runs once the subscription settles')
    assert.equal(typeof push, 'function')

    // Older query, newer push: the push must win even though the reply lands afterwards.
    push(viewportPayload(390, 800, {
      visibleHeight: 500,
      keyboardInset: 300,
      keyboardVisible: true,
    }))
    assert.equal(env.pendingFrames(), 1, 'teleporting an event does not self-schedule')
    releaseQuery()
    await flushMicrotasks()
    assert.equal(env.flush(), 1, 'only one frame is queued for the burst')

    assert.equal(document.dispatched.length, 2)
    assert.deepEqual(document.dispatched[1], {
      layoutWidth: 390,
      layoutHeight: 800,
      visibleHeight: 500,
      offsetTop: 0,
      keyboardInset: 300,
      keyboard: 'open',
    })

    // A later real push is still applied.
    push(viewportPayload(390, 800))
    assert.equal(env.flush(), 1)
    assert.equal(document.dispatched.length, 3)
    assert.equal(document.dispatched[2].visibleHeight, 800)
    assert.equal(document.dispatched[2].keyboard, 'closed')

    detach()
  })

  test('native animation pushes update once immediately and publish safe areas before foreground layout', async () => {
    const document = new FakeDocument(), env = createWindow(document)
    let push
    const bridge = { async getViewport() { return viewportPayload(390, 800) },
      async addListener(_event, listener) { push = listener; return { async remove() {} } } }
    const detach = attachMobileViewport({ window: env.window, document, nativeBridge: bridge })
    await flushMicrotasks(); env.flush()
    const frame = viewportPayload(390, 800, { visibleHeight: 788, keyboardInset: 12, keyboardVisible: true,
      safeArea: { top: 28, right: 0, bottom: 24, left: 0 } })
    push(frame)
    assert.equal(document.css.getPropertyValue('--m-visible-height'), '788px')
    assert.equal(document.css.getPropertyValue('--safe-area-inset-top'), '28px')
    assert.equal(document.css.getPropertyValue('--safe-area-inset-bottom'), '24px')
    assert.equal(env.pendingFrames(), 0, 'no extra RAF behind the native frame')
    const writes = document.css.writes.length
    push(frame)
    assert.equal(document.css.writes.length, writes, 'identical native frame is deduplicated')
    detach()
  })
})
