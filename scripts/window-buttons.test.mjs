import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { watchWindowButtons } from '../desktop/window-buttons.cjs'

function fixture({ visible = true, fullscreen = false } = {}) {
  const window = new EventEmitter(), intervals = new Map(), timeouts = new Map(), writes = []
  let id = 0, reads = 0, minimized = false, destroyed = false, pointer = { x: 200, y: 200 }
  Object.assign(window, {
    isFullScreen: () => fullscreen, isVisible: () => visible, isMinimized: () => minimized,
    isDestroyed: () => destroyed, getBounds: () => ({ x: 0, y: 0 }),
    setWindowButtonVisibility: value => writes.push(value),
  })
  const controller = watchWindowButtons(window, { getCursorScreenPoint: () => { reads++; return pointer } }, {
    setInterval: (fn, ms) => { intervals.set(++id, { fn, ms }); return id },
    clearInterval: id => intervals.delete(id),
    setTimeout: (fn, ms) => { timeouts.set(++id, { fn, ms }); return id },
    clearTimeout: id => timeouts.delete(id),
  })
  return {
    controller, intervals, timeouts, writes, reads: () => reads,
    hover: value => { pointer = value ? { x: 45, y: 15 } : { x: 200, y: 200 } },
    poll: () => { for (const { fn } of [...intervals.values()]) fn() },
    hideDeadline: () => { for (const [id, { fn }] of [...timeouts]) { timeouts.delete(id); fn() } },
    emit: (event, update = true) => {
      if (update) {
        if (event === 'show') visible = true
        if (event === 'hide') visible = false
        if (event === 'minimize') minimized = true
        if (event === 'restore') minimized = false
        if (event === 'enter-full-screen') fullscreen = true
        if (event === 'leave-full-screen') fullscreen = false
        if (event === 'closed') destroyed = true
      }
      window.emit(event)
    },
    window,
  }
}

test('windowed hover keeps the existing response and native hit region', () => {
  const f = fixture()
  assert.deepEqual(f.writes, [false], 'actually hides controls at startup')
  assert.equal([...f.intervals.values()][0].ms, 50)
  f.hover(true); f.poll()
  assert.equal(f.controller.isVisible(), true)
  f.poll()
  assert.equal(f.writes.length, 2, 'stationary pointer does not repeat native calls')
  f.hover(false); f.poll()
  assert.equal([...f.timeouts.values()][0].ms, 220)
  f.hideDeadline()
  assert.equal(f.controller.isVisible(), false)
  f.controller.dispose()
})

test('leaving, reentering and leaving again cancels and rearms hide correctly', () => {
  const f = fixture()
  f.hover(true); f.poll()
  f.hover(false); f.poll()
  f.hover(true); f.poll()
  assert.equal(f.timeouts.size, 0)
  f.hover(false); f.poll()
  assert.equal(f.timeouts.size, 1)
  f.hideDeadline()
  assert.equal(f.controller.isVisible(), false)
  f.controller.dispose()
})

test('hidden and minimized windows have no polling or pointer queries', () => {
  for (const [suspend, resume] of [['hide', 'show'], ['minimize', 'restore']]) {
    const f = fixture()
    f.poll()
    const before = f.reads()
    f.emit(suspend)
    assert.equal(f.intervals.size, 0)
    assert.equal(f.timeouts.size, 0)
    f.poll()
    assert.equal(f.reads(), before)
    f.emit(resume); f.emit(resume)
    assert.equal(f.intervals.size, 1, 'no duplicate loop')
    f.hover(true); f.poll()
    assert.equal(f.controller.isVisible(), true)
    f.controller.dispose()
  }
})

test('fullscreen cancels pending hide and never hides traffic lights on hover', () => {
  for (const [enter, leave] of [['enter-full-screen', 'leave-full-screen'], ['enter-html-full-screen', 'leave-html-full-screen']]) {
    const f = fixture()
    f.hover(true); f.poll()
    f.hover(false); f.poll()
    assert.equal(f.timeouts.size, 1)
    f.emit(enter)
    assert.equal(f.intervals.size, 0)
    assert.equal(f.timeouts.size, 0)
    const before = f.reads()
    f.hover(true); f.poll(); f.hideDeadline()
    f.hover(false); f.poll()
    assert.equal(f.controller.isVisible(), true)
    assert.equal(f.reads(), before)
    f.emit(leave)
    assert.equal(f.controller.isVisible(), false)
    assert.equal(f.intervals.size, 1)
    f.controller.dispose()
  }
})

test('overlapping HTML and native fullscreen modes stay visible until both leave', () => {
  const f = fixture()
  f.emit('enter-full-screen'); f.emit('enter-html-full-screen')
  f.emit('leave-html-full-screen')
  assert.equal(f.controller.isVisible(), true)
  assert.equal(f.intervals.size, 0)
  f.emit('leave-full-screen')
  assert.equal(f.controller.isVisible(), false)
  assert.equal(f.intervals.size, 1)
  f.controller.dispose()
})

test('a hidden window starts with no timer and closes without retained listeners', () => {
  const f = fixture({ visible: false })
  assert.equal(f.intervals.size, 0)
  f.emit('show')
  assert.equal(f.intervals.size, 1)
  f.hover(true); f.poll(); f.hover(false); f.poll()
  f.emit('closed')
  assert.equal(f.intervals.size, 0)
  assert.equal(f.timeouts.size, 0)
  assert.equal(f.window.eventNames().length, 0)
  f.emit('show'); f.emit('restore')
  assert.equal(f.intervals.size, 0)
})
