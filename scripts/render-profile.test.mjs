import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRenderProfile, nextRenderDeadline, renderFrameIsDue, resolveRenderProfile, RENDER_PROFILES } from '../src/prototype/renderProfile.ts'

test('render profiles keep the full visual stack while reducing the render budget', () => {
  assert.deepEqual(RENDER_PROFILES, {
    full: { quality: 'ultra', frameRate: 60 },
    smooth90: { quality: 'ultra', frameRate: 90 },
    smooth120: { quality: 'ultra', frameRate: 120 },
    balanced: { quality: 'high', frameRate: 45 },
    economy: { quality: 'low', frameRate: 30 },
  })
  assert.equal(normalizeRenderProfile('balanced'), 'balanced')
  assert.equal(normalizeRenderProfile('smooth90'), 'smooth90')
  assert.equal(normalizeRenderProfile('smooth120'), 'smooth120')
  assert.equal(normalizeRenderProfile('unknown'), 'full')
  assert.equal(normalizeRenderProfile(null), 'full')
  assert.equal(normalizeRenderProfile('rest'), 'economy')
  for (const prototypeKey of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
    assert.equal(normalizeRenderProfile(prototypeKey), 'full', prototypeKey)
  }
})

test('workspaces intentionally cap ambient rendering at 60 for power saving without raising lower profiles or reducing quality', () => {
  for (const [profile, config] of Object.entries(RENDER_PROFILES)) {
    assert.deepEqual(resolveRenderProfile(profile, 'home'), config)
    assert.deepEqual(resolveRenderProfile(profile, 'workspace'), { ...config, frameRate: Math.min(config.frameRate, 60) })
  }
  assert.equal(resolveRenderProfile('smooth120', 'home').frameRate, 120)
  assert.equal(resolveRenderProfile('smooth90', 'home').frameRate, 90)
  assert.equal(resolveRenderProfile('balanced', 'workspace').frameRate, 45)
  assert.equal(resolveRenderProfile('economy', 'workspace').frameRate, 30)
})

function simulate(displayHz, targetFps, seconds, jitter = false) {
  let deadline = 0
  const renders = []
  for (let tick = 0; tick < displayHz * seconds; tick++) {
    const t = (tick + 1) * 1000 / displayHz + (jitter ? Math.sin(tick * .37) * .1 : 0)
    if (renderFrameIsDue(deadline, t)) {
      renders.push(t)
      deadline = nextRenderDeadline(deadline, t, targetFps)
    }
  }
  return renders
}

test('all profiles retain their requested cadence on 60, 90 and 120 Hz displays', () => {
  const seconds = 10
  for (const displayHz of [60, 90, 120]) {
    for (const profile of Object.keys(RENDER_PROFILES)) {
      for (const scene of ['home', 'workspace']) {
        const targetFps = resolveRenderProfile(profile, scene).frameRate
        const expected = Math.min(targetFps, displayHz) * seconds
        const renders = simulate(displayHz, targetFps, seconds)
        const label = `${profile}, ${scene}, ${displayHz} Hz`
        assert.ok(Math.abs(renders.length - expected) <= 1, `${label}: ${renders.length} renders, expected ${expected}`)
        // A 90 FPS profile on a 120 Hz panel must alternate its vsync spacing;
        // never quantize down to 60 FPS by waiting a fresh interval each frame.
        if (targetFps === 90 && displayHz === 120) {
          const gaps = renders.slice(1).map((value, index) => value - renders[index])
          assert.ok(gaps.some(gap => gap < 9), `${label}: includes consecutive refreshes`)
          assert.ok(gaps.some(gap => gap > 16), `${label}: skips refreshes as required`)
        }
      }
    }
  }
})

test('minor RAF timestamp jitter does not systematically halve the frame rate', () => {
  for (const [displayHz, targetFps] of [[60, 60], [90, 90], [120, 120], [120, 90], [120, 45], [60, 30]]) {
    const renders = simulate(displayHz, targetFps, 10, true)
    assert.ok(Math.abs(renders.length - targetFps * 10) <= 1, `${targetFps} FPS at ${displayHz} Hz: ${renders.length}`)
  }
})

test('native refresh timestamp variation keeps the selected cadence without extra average frames', () => {
  for (const displayHz of [60,90,120,144,160,165]) for (const target of [30,45,60,90,120]) {
    let deadline=0
    const frames=[]
    for(let tick=0;tick<displayHz*10;tick++) {
      const time=(tick+1)*1000/displayHz+Math.sin(tick*.37)*.85
      if(renderFrameIsDue(deadline,time)) {
        frames.push(time);deadline=nextRenderDeadline(deadline,time,target)
      }
    }
    assert.ok(Math.abs(frames.length-Math.min(target,displayHz)*10)<=1,`${target} FPS/${displayHz} Hz: ${frames.length}`)
    if(target===displayHz) {
      const largest=Math.max(...frames.slice(1).map((time,index)=>time-frames[index]))
      assert.ok(largest<1000/displayHz+2,'timestamp variation must not create a skipped refresh')
    }
  }
})

test('a long interruption skips expired deadlines without a burst of catch-up renders', () => {
  for (const targetFps of [120, 90, 60, 45, 30]) {
    const interval = 1000 / targetFps
    let deadline = nextRenderDeadline(0, 10, targetFps)
    const resumedAt = 60_013.7
    assert.equal(renderFrameIsDue(deadline, resumedAt), true)
    deadline = nextRenderDeadline(deadline, resumedAt, targetFps)
    assert.ok(deadline > resumedAt && deadline <= resumedAt + interval + .001)
    assert.equal(renderFrameIsDue(deadline, resumedAt), false, `${targetFps} FPS must not replay expired frames`)
    const next = nextRenderDeadline(deadline, deadline, targetFps)
    assert.ok(Math.abs(next - deadline - interval) < .001)
  }
})
