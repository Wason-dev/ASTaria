import test from 'node:test'
import assert from 'node:assert/strict'
import { createFocusTimerTicker } from '../src/workbench/focusTimerTicker.ts'
import {
  FOCUS_MS, advanceFocusTimer, createFocusTimerState, focusTimerSession,
  pauseFocusTimer, restoreFocusTimer, selectFocusTask, startFocusTimer,
} from '../src/workbench/focusTimer.ts'

const origin = 1_790_000_000_000

function harness() {
  let now = origin
  let state = selectFocusTask(createFocusTimerState(), 'task', now)
  let visible = true
  let nextId = 0
  let wakeups = 0
  let saved = null
  let ticker
  const timers = new Map()
  const mount = () => {
    ticker = createFocusTimerTicker({
      remainingMs: () => {
        const session = focusTimerSession(state)
        return session?.phase === 'running' ? session.remainingMs : null
      },
      isVisible: () => visible,
      tick: checkpoint => {
        wakeups += 1
        const before = focusTimerSession(state)
        state = advanceFocusTimer(state, now)
        if (checkpoint || (before?.phase === 'running' && focusTimerSession(state)?.phase === 'finished')) {
          saved = JSON.stringify(state)
        }
      },
      setTimeout(callback, delay) {
        const id = ++nextId
        timers.set(id, { callback, at: now + delay })
        return id
      },
      clearTimeout: id => timers.delete(id),
    })
    ticker.refresh(true)
  }
  const elapse = duration => {
    const until = now + duration
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > until) break
      now = next[1].at
      timers.delete(next[0])
      next[1].callback()
    }
    now = until
  }
  mount()
  return {
    mount, elapse,
    start() { state = startFocusTimer(state, now); ticker.refresh(true) },
    pause() { state = pauseFocusTimer(state, now); ticker.refresh(true) },
    visibility(value) { visible = value; ticker.refresh(true) },
    pagehide() { ticker.refresh(true) },
    jump(duration) { now += duration },
    unmount() {
      saved = JSON.stringify(pauseFocusTimer(state, now))
      ticker.stop()
    },
    get session() { return focusTimerSession(state) },
    get saved() { return restoreFocusTimer(saved, now).state },
    get wakeups() { return wakeups },
    get pending() { return timers.size },
    get nextDelay() { return [...timers.values()][0]?.at - now },
  }
}

test('idle and paused sessions have no recurring wakeups', () => {
  const timer = harness()
  const initial = timer.wakeups
  timer.elapse(60_000)
  assert.equal(timer.wakeups, initial)
  assert.equal(timer.pending, 0)
  timer.start()
  timer.elapse(1250)
  assert.equal(timer.session.elapsedMs, 1250)
  timer.pause()
  const paused = timer.wakeups
  timer.elapse(60_000)
  assert.equal(timer.pending, 0)
  assert.equal(timer.wakeups, paused)
  assert.equal(timer.session.elapsedMs, 1250)
})

test('visible running sessions retain 250ms updates, including the first tick after resume', () => {
  const timer = harness()
  timer.start()
  const initial = timer.wakeups
  timer.elapse(1000)
  assert.equal(timer.wakeups - initial, 4)
  assert.equal(timer.session.elapsedMs, 1000)
  timer.pause()
  timer.elapse(10_000)
  timer.start()
  assert.equal(timer.pending, 1)
  timer.elapse(250)
  assert.equal(timer.session.elapsedMs, 1250)
})

test('hiding cancels UI ticks, keeps the deadline and returning immediately catches up', () => {
  const timer = harness()
  timer.start()
  timer.elapse(1000)
  timer.visibility(false)
  const hidden = timer.wakeups
  assert.equal(timer.nextDelay, FOCUS_MS - 1000)
  timer.elapse(60_000)
  assert.equal(timer.wakeups, hidden)
  assert.equal(timer.session.elapsedMs, 1000)
  timer.visibility(true)
  assert.equal(timer.session.elapsedMs, 61_000)
  assert.equal(timer.pending, 1)
  assert.equal(timer.nextDelay, 250)
  timer.elapse(250)
  assert.equal(timer.session.elapsedMs, 61_250)
})

test('a hidden round wakes only once at expiry and persists completion without starting rest', () => {
  const timer = harness()
  timer.start()
  timer.visibility(false)
  const hidden = timer.wakeups
  timer.elapse(FOCUS_MS + 60_000)
  assert.equal(timer.wakeups - hidden, 1)
  assert.equal(timer.pending, 0)
  assert.equal(timer.session.phase, 'finished')
  assert.equal(timer.session.mode, 'focus')
  assert.equal(timer.session.spentMs, FOCUS_MS)
  assert.equal(focusTimerSession(timer.saved).phase, 'finished')
  timer.visibility(true)
  assert.equal(timer.session.spentMs, FOCUS_MS)
  assert.equal(timer.pending, 0)
})

test('resuming after OS suspension catches up even when the deadline callback was delayed', () => {
  const timer = harness()
  timer.start()
  timer.visibility(false)
  timer.jump(FOCUS_MS + 86_400_000)
  timer.visibility(true)
  assert.equal(timer.pending, 0)
  assert.equal(timer.session.phase, 'finished')
  assert.equal(timer.session.spentMs, FOCUS_MS)
  assert.equal(focusTimerSession(timer.saved).phase, 'finished')
})

test('pagehide saves a wall-clock checkpoint without pausing a hidden running timer', () => {
  const timer = harness()
  timer.start()
  timer.visibility(false)
  timer.elapse(60_000)
  timer.pagehide()
  assert.equal(timer.session.phase, 'running')
  assert.equal(timer.session.elapsedMs, 60_000)
  assert.equal(focusTimerSession(timer.saved).elapsedMs, 60_000)
  assert.equal(timer.pending, 1)
  assert.equal(timer.nextDelay, FOCUS_MS - 60_000)
})

test('cleanup removes all wakeups and saves a paused checkpoint', () => {
  const timer = harness()
  timer.start()
  timer.visibility(false)
  timer.elapse(60_000)
  timer.unmount()
  const stopped = timer.wakeups
  timer.elapse(86_400_000)
  assert.equal(timer.pending, 0)
  assert.equal(timer.wakeups, stopped)
  assert.equal(focusTimerSession(timer.saved).phase, 'paused')
  assert.equal(focusTimerSession(timer.saved).elapsedMs, 60_000)
})

test('StrictMode effect replay leaves the in-memory round running with only one ticker', () => {
  const timer = harness()
  timer.start()
  timer.elapse(1000)
  timer.unmount()
  assert.equal(focusTimerSession(timer.saved).phase, 'paused')
  timer.mount()
  assert.equal(timer.session.phase, 'running')
  assert.equal(focusTimerSession(timer.saved).phase, 'running')
  assert.equal(timer.pending, 1)
  const replayed = timer.wakeups
  timer.elapse(1000)
  assert.equal(timer.wakeups - replayed, 4)
  assert.equal(timer.session.elapsedMs, 2000)
})
