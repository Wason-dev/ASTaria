import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FOCUS_MS, REST_MS, advanceFocusTimer, changeFocusDurations, createFocusTimerState, focusTimerSession,
  nextFocusRound, pauseFocusTimer, restoreFocusTimer, selectFocusTask,
  startFocusRest, startFocusTimer, taskFocusSpentMs,
} from '../src/workbench/focusTimer.ts'

const origin = 1_790_000_000_000
const selected = id => selectFocusTask(createFocusTimerState(), id, origin)
const running = id => startFocusTimer(selected(id), origin)

test('selecting a task prepares 35 minutes without starting or changing any task status', () => {
  const state = selected('a')
  assert.deepEqual(focusTimerSession(state), {
    taskId: 'a', mode: 'focus', phase: 'ready', elapsedMs: 0, remainingMs: 35 * 60_000, spentMs: 0, durationMs: FOCUS_MS,
  })
  assert.equal(advanceFocusTimer(state, origin + 600_000), state)
  assert.equal(startFocusRest(state, origin), state)
  assert.equal(nextFocusRound(state, origin), state)
  assert.equal('status' in state.tasks.a, false)
})

test('a delayed background tick catches up, caps at 35 minutes and never begins rest automatically', () => {
  const state = advanceFocusTimer(running('a'), origin + FOCUS_MS + 86_400_000)
  assert.deepEqual(focusTimerSession(state), {
    taskId: 'a', mode: 'focus', phase: 'finished', elapsedMs: FOCUS_MS, remainingMs: 0, spentMs: FOCUS_MS, durationMs: FOCUS_MS,
  })
  assert.equal(advanceFocusTimer(state, origin + 2 * 86_400_000), state)
  assert.equal(startFocusTimer(state, origin + 2 * 86_400_000), state)
})

test('repeated ticks and pause/start calls count each millisecond once', () => {
  let state = running('a')
  state = advanceFocusTimer(state, origin + 20_000)
  state = advanceFocusTimer(state, origin + 20_000)
  state = startFocusTimer(state, origin + 20_000)
  assert.equal(taskFocusSpentMs(state, 'a'), 20_000)
  state = pauseFocusTimer(state, origin + 30_000)
  state = pauseFocusTimer(state, origin + 80_000)
  assert.equal(focusTimerSession(state).elapsedMs, 30_000)
  assert.equal(advanceFocusTimer(state, origin + 90_000), state)
  state = startFocusTimer(state, origin + 100_000)
  state = advanceFocusTimer(state, origin + 110_000)
  assert.equal(taskFocusSpentMs(state, 'a'), 40_000)
  assert.equal(focusTimerSession(state).remainingMs, FOCUS_MS - 40_000)
})

test('switching tasks pauses the previous session and restores each task independently', () => {
  let state = selectFocusTask(running('a'), 'b', origin + 60_000)
  assert.equal(focusTimerSession(state).phase, 'ready')
  assert.equal(taskFocusSpentMs(state, 'a'), 60_000)
  assert.equal(state.tasks.a.phase, 'paused')
  state = startFocusTimer(state, origin + 80_000)
  state = selectFocusTask(state, 'a', origin + 110_000)
  assert.equal(taskFocusSpentMs(state, 'b'), 30_000)
  assert.equal(focusTimerSession(state).phase, 'paused')
  assert.equal(focusTimerSession(state).elapsedMs, 60_000)
  assert.equal(Object.values(state.tasks).filter(timer => timer.phase === 'running').length, 0)
  state = startFocusTimer(state, origin + 120_000)
  state = advanceFocusTimer(state, origin + 130_000)
  assert.equal(taskFocusSpentMs(state, 'a'), 70_000)
  assert.equal(taskFocusSpentMs(state, 'b'), 30_000)
})

test('rest lasts 5 minutes, adds no focus time, and the next round waits for Start', () => {
  let state = advanceFocusTimer(running('a'), origin + FOCUS_MS)
  state = startFocusRest(state, origin + FOCUS_MS + 60_000)
  assert.equal(focusTimerSession(state).mode, 'rest')
  assert.equal(focusTimerSession(state).remainingMs, 5 * 60_000)
  state = advanceFocusTimer(state, origin + FOCUS_MS + 60_000 + REST_MS + 60_000)
  assert.equal(focusTimerSession(state).phase, 'finished')
  assert.equal(focusTimerSession(state).mode, 'rest')
  assert.equal(taskFocusSpentMs(state, 'a'), FOCUS_MS)
  state = nextFocusRound(state, origin + FOCUS_MS + REST_MS + 120_000)
  assert.equal(focusTimerSession(state).phase, 'ready')
  assert.equal(focusTimerSession(state).remainingMs, FOCUS_MS)
  state = startFocusTimer(state, origin + FOCUS_MS + REST_MS + 120_000)
  state = advanceFocusTimer(state, origin + FOCUS_MS + REST_MS + 130_000)
  assert.equal(taskFocusSpentMs(state, 'a'), FOCUS_MS + 10_000)
})

test('choosing another focus round or ending rest early both produce an idle 35 minute round', () => {
  const complete = advanceFocusTimer(running('a'), origin + FOCUS_MS)
  const continued = nextFocusRound(complete, origin + FOCUS_MS)
  assert.equal(focusTimerSession(continued).phase, 'ready')
  const resting = startFocusRest(complete, origin + FOCUS_MS)
  const skipped = nextFocusRound(resting, origin + FOCUS_MS + 30_000)
  assert.equal(focusTimerSession(skipped).phase, 'ready')
  assert.equal(taskFocusSpentMs(skipped, 'a'), FOCUS_MS)
})

test('reload reconstructs a running deadline and does not count already checkpointed time twice', () => {
  const checkpoint = advanceFocusTimer(running('a'), origin + 20_000)
  const restored = restoreFocusTimer(JSON.stringify(checkpoint), origin + 80_000)
  assert.equal(restored.error, null)
  assert.equal(focusTimerSession(restored.state).elapsedMs, 80_000)
  const again = restoreFocusTimer(JSON.stringify(restored.state), origin + 80_000)
  assert.equal(taskFocusSpentMs(again.state, 'a'), 80_000)
  const expired = restoreFocusTimer(JSON.stringify(checkpoint), origin + FOCUS_MS + 1)
  assert.equal(focusTimerSession(expired.state).phase, 'finished')
  assert.equal(taskFocusSpentMs(expired.state, 'a'), FOCUS_MS)
})

test('paused session reload does not count time while the workspace was closed', () => {
  const checkpoint = pauseFocusTimer(running('a'), origin + 20_000)
  const restored = restoreFocusTimer(JSON.stringify(checkpoint), origin + 86_400_000)
  assert.equal(restored.error, null)
  assert.equal(focusTimerSession(restored.state).phase, 'paused')
  assert.equal(taskFocusSpentMs(restored.state, 'a'), 20_000)
})

test('a backward wall-clock jump never removes progress or counts the same time twice', () => {
  const checkpoint = advanceFocusTimer(running('a'), origin + 20_000)
  assert.equal(advanceFocusTimer(checkpoint, origin + 10_000), checkpoint)
  const caughtUp = advanceFocusTimer(checkpoint, origin + 30_000)
  assert.equal(taskFocusSpentMs(caughtUp, 'a'), 30_000)
})

test('corrupt storage resets safely; malformed or simultaneous running records cannot resume', () => {
  const fixtures = ['{', '{}', 'null', '[]', JSON.stringify({ ...running('a'), version: 2 })]
  const mutate = edit => {
    const state = running('a')
    edit(state)
    fixtures.push(JSON.stringify(state))
  }
  mutate(state => { state.selectedTaskId = 'missing' })
  mutate(state => { state.tasks.a.elapsedMs = -1 })
  mutate(state => { state.tasks.a.elapsedMs = FOCUS_MS + 1 })
  mutate(state => { state.tasks.a.spentMs = '100' })
  mutate(state => { state.tasks.a.runningSince = null })
  mutate(state => { state.tasks.a.phase = 'finished' })
  mutate(state => { state.tasks.a.phase = ['running'] })
  mutate(state => { state.tasks.b = { ...state.tasks.a } })
  mutate(state => { state.tasks.a.elapsedMs = 1000; state.tasks.a.spentMs = 0 })
  mutate(state => { state.durations.focusMin = 7 })
  mutate(state => { state.tasks.a.durationMs = 36 * 60_000 })
  for (const raw of fixtures) {
    const result = restoreFocusTimer(raw, origin)
    assert.equal(focusTimerSession(result.state), null)
    assert.ok(result.error, raw)
  }
  assert.equal(restoreFocusTimer(null, origin).error, null)
})

test('duration settings change idle rounds immediately and preserve running or paused rounds', () => {
  let state = changeFocusDurations(selected('a'), { focusMin: 50, restMin: 10 })
  assert.equal(focusTimerSession(state).durationMs, 50 * 60_000)
  state = startFocusTimer(state, origin)
  state = advanceFocusTimer(state, origin + 60_000)
  state = changeFocusDurations(state, { focusMin: 25, restMin: 3 })
  assert.equal(focusTimerSession(state).durationMs, 50 * 60_000)
  assert.equal(focusTimerSession(state).elapsedMs, 60_000)
  const runningReload = restoreFocusTimer(JSON.stringify(state), origin + 90_000)
  assert.equal(runningReload.error, null)
  assert.equal(focusTimerSession(runningReload.state).durationMs, 50 * 60_000)
  assert.equal(focusTimerSession(runningReload.state).elapsedMs, 90_000)
  state = pauseFocusTimer(state, origin + 120_000)
  state = changeFocusDurations(state, { focusMin: 40, restMin: 8 })
  assert.equal(focusTimerSession(state).durationMs, 50 * 60_000)
  assert.equal(focusTimerSession(state).phase, 'paused')
  state = startFocusTimer(state, origin + 120_000)
  state = advanceFocusTimer(state, origin + 50 * 60_000)
  state = startFocusRest(state, origin + 50 * 60_000)
  assert.equal(focusTimerSession(state).durationMs, 8 * 60_000)
  state = changeFocusDurations(state, { focusMin: 60, restMin: 2 })
  assert.equal(focusTimerSession(state).durationMs, 8 * 60_000)
  state = nextFocusRound(state, origin + 50 * 60_000 + 60_000)
  assert.equal(focusTimerSession(state).durationMs, 60 * 60_000)
  assert.equal(focusTimerSession(state).phase, 'ready')
  const restored = restoreFocusTimer(JSON.stringify(state), origin + 99999999)
  assert.equal(restored.error, null)
  assert.deepEqual(restored.state.durations, { focusMin: 60, restMin: 2 })
  assert.equal(focusTimerSession(restored.state).durationMs, 60 * 60_000)
})

test('rest can pause, switch tasks and resume without adding focus time or losing its remainder', () => {
  let state = advanceFocusTimer(running('a'), origin + FOCUS_MS)
  state = startFocusRest(state, origin + FOCUS_MS)
  state = selectFocusTask(state, 'b', origin + FOCUS_MS + 60_000)
  state = selectFocusTask(state, 'a', origin + FOCUS_MS + 600_000)
  assert.equal(focusTimerSession(state).mode, 'rest')
  assert.equal(focusTimerSession(state).phase, 'paused')
  assert.equal(focusTimerSession(state).remainingMs, REST_MS - 60_000)
  assert.equal(taskFocusSpentMs(state, 'a'), FOCUS_MS)
  state = startFocusTimer(state, origin + FOCUS_MS + 600_000)
  state = advanceFocusTimer(state, origin + FOCUS_MS + 840_000)
  assert.equal(focusTimerSession(state).phase, 'finished')
  assert.equal(taskFocusSpentMs(state, 'a'), FOCUS_MS)
})

test('new tasks use selected durations and invalid settings never change the active state', () => {
  const state = changeFocusDurations(selected('a'), { focusMin: 5, restMin: 1 })
  assert.equal(focusTimerSession(selectFocusTask(state, 'b', origin)).durationMs, 5 * 60_000)
  for (const setting of [{ focusMin: 0, restMin: 5 }, { focusMin: 121, restMin: 5 }, { focusMin: 36, restMin: 5 }, { focusMin: 35, restMin: 0 }, { focusMin: 35, restMin: 31 }, { focusMin: 35, restMin: 1.5 }]) {
    assert.equal(changeFocusDurations(state, setting), state)
  }
})

test('model actions do not mutate input state and arbitrary string task IDs are safe', () => {
  const state = running('__proto__')
  const original = structuredClone(state)
  const paused = pauseFocusTimer(state, origin + 1000)
  assert.deepEqual(state, original)
  assert.equal(taskFocusSpentMs(paused, '__proto__'), 1000)
  const restored = restoreFocusTimer(JSON.stringify(paused), origin + 2000)
  assert.equal(restored.error, null)
  assert.equal(taskFocusSpentMs(restored.state, '__proto__'), 1000)
  assert.equal(taskFocusSpentMs(restored.state, 'constructor'), 0)
})
