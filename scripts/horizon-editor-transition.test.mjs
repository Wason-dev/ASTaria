import assert from 'node:assert/strict'
import test from 'node:test'
import { createHorizonEditorTransition } from '../src/xixi/horizonEditorTransition.ts'

function animator({ rejectOnCancel = false } = {}) {
  const calls = []
  const animate = (frames, options) => {
    let resolve, reject
    const animation = {
      finished: new Promise((yes, no) => { resolve = yes; reject = no }),
      cancelCount: 0,
      cancel() { this.cancelCount++; if (rejectOnCancel) reject(new Error('Animation canceled')) },
    }
    calls.push({ frames, options, animation, finish: () => resolve(animation), fail: () => reject(new Error('Interrupted')) })
    return animation
  }
  return { animate, calls }
}
const settle = async () => { await Promise.resolve(); await Promise.resolve() }

test('opening and selecting the current date do not create a content transition', async () => {
  for (const day of [0, 1, 2]) {
    const transition = createHorizonEditorTransition(day), driver = animator()
    transition.update(day, false, driver.animate)
    assert.equal(driver.calls.length, 0)
    const nextDay = day === 2 ? 1 : day + 1
    transition.update(nextDay, false, driver.animate)
    const running = driver.calls[0].animation
    transition.update(nextDay, false, driver.animate)
    assert.equal(driver.calls.length, 1)
    assert.equal(running.cancelCount, 0)
    driver.calls[0].finish(); await settle()
    assert.equal(running.cancelCount, 1)
  }
})

test('every date direction uses a short local transition with readable endpoints', async () => {
  for (const from of [0, 1, 2]) for (const to of [0, 1, 2]) {
    if (from === to) continue
    const transition = createHorizonEditorTransition(from), driver = animator()
    transition.update(to, false, driver.animate)
    const { frames, options, animation, finish } = driver.calls[0]
    assert.equal(options.duration, 300)
    assert.equal(options.fill, 'none', 'no retained style can hide the committed day')
    assert.ok(frames.every(frame => frame.opacity >= .7 && frame.opacity <= 1))
    assert.equal(Math.sign(Number(/translateX\((-?\d+)px\)/u.exec(frames[0].transform)[1])), Math.sign(to - from))
    assert.equal(frames.at(-1).opacity, 1)
    assert.equal(frames.at(-1).transform, 'translateX(0px)')
    finish(); await settle()
    assert.equal(animation.cancelCount, 1)
    transition.cancel()
    assert.equal(animation.cancelCount, 1, 'finished effects have already been released')
  }
})

test('rapid reversals cancel each old animation and ignore its late completion', async () => {
  const transition = createHorizonEditorTransition(0), driver = animator()
  for (const day of [2, 1, 0]) transition.update(day, false, driver.animate)
  assert.deepEqual(driver.calls.map(call => call.animation.cancelCount), [1, 1, 0])
  driver.calls[0].finish(); driver.calls[1].finish(); await settle()
  assert.deepEqual(driver.calls.map(call => call.animation.cancelCount), [1, 1, 0], 'old completions cannot release the newest effect')
  driver.calls[2].finish(); await settle()
  assert.deepEqual(driver.calls.map(call => call.animation.cancelCount), [1, 1, 1])
})

test('WAAPI cancellation rejections and interrupted completion are handled', async () => {
  const transition = createHorizonEditorTransition(0), driver = animator({ rejectOnCancel: true })
  transition.update(1, false, driver.animate)
  transition.update(2, false, driver.animate)
  await settle()
  assert.deepEqual(driver.calls.map(call => call.animation.cancelCount), [1, 0])
  driver.calls[1].fail(); await settle()
  assert.deepEqual(driver.calls.map(call => call.animation.cancelCount), [1, 1])
  transition.update(0, false, driver.animate)
  driver.calls[2].finish(); await settle()
  assert.deepEqual(driver.calls.map(call => call.animation.cancelCount), [1, 1, 1])
})

test('reduced motion cancels in flight and commits new dates without replay on restoration', async () => {
  const transition = createHorizonEditorTransition(0), driver = animator({ rejectOnCancel: true })
  transition.update(1, false, driver.animate)
  transition.update(1, true, driver.animate)
  transition.update(2, true, driver.animate)
  transition.update(2, false, driver.animate)
  assert.equal(driver.calls.length, 1)
  assert.equal(driver.calls[0].animation.cancelCount, 1)
  transition.update(1, false, driver.animate)
  assert.match(driver.calls[1].frames[0].transform, /translateX\(-/u, 'direction comes from the last committed date, even without motion')
  transition.cancel(); await settle()
})

test('missing or throwing WAAPI falls back to the committed date and the next switch still works', async () => {
  const transition = createHorizonEditorTransition(0), driver = animator()
  transition.update(1, false)
  assert.doesNotThrow(() => transition.update(2, false, () => { throw new Error('WAAPI unavailable') }))
  transition.update(1, false, driver.animate)
  assert.equal(driver.calls.length, 1)
  assert.match(driver.calls[0].frames[0].transform, /translateX\(-/u)
  driver.calls[0].finish(); await settle()
})

test('cleanup is idempotent and late settlement cannot affect a subsequent lifecycle', async () => {
  const transition = createHorizonEditorTransition(0), driver = animator()
  transition.update(1, false, driver.animate)
  transition.cancel(); transition.cancel()
  assert.equal(driver.calls[0].animation.cancelCount, 1)
  transition.update(1, false, driver.animate)
  assert.equal(driver.calls.length, 1, 'StrictMode/resume must not replay the same date')
  transition.update(2, false, driver.animate)
  driver.calls[0].finish(); await settle()
  assert.equal(driver.calls[1].animation.cancelCount, 0)
  transition.cancel(); driver.calls[1].finish(); await settle()
  assert.equal(driver.calls[1].animation.cancelCount, 1)
})
