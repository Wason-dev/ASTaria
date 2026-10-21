import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { orbitTransitionFrame } from '../src/xixi/orbitTransition.ts'

const root=new URL('../src/',import.meta.url).href
const hooks=registerHooks({resolve(specifier,context,next){
  return next(context.parentURL?.startsWith(root)&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)?`${specifier}.ts`:specifier,context)
}})
const { BlackHoleRenderer }=await import('../src/prototype/BlackHoleRenderer.ts')
hooks.deregister()

function engine() {
  const calls=[]
  const state={cameraIsRunning:()=>false,presentationIsRunning:BlackHoleRenderer.prototype.presentationIsRunning,stringFlightProgress:0,
    profileInitialized:true,renderProfile:'full',renderScene:'home',requestedQuality:'auto',quality:'high',targetFps:60,
    adaptiveQuality:{resetWindow:()=>calls.push('window'),reset:()=>calls.push('reset')},
    applyQuality:quality=>calls.push(quality),cancelFrame:()=>calls.push('cancel'),requestFrame:()=>calls.push('request'),publishStats:()=>calls.push('publish')}
  return {calls,state,set:(...args)=>BlackHoleRenderer.prototype.setRenderProfile.call(state,...args)}
}

test('changing pages at the same effective cadence preserves the pending frame and adaptive history',()=>{
  const e=engine()
  e.set('economy','home','auto');e.calls.length=0
  e.set('economy','workspace','auto')
  assert.deepEqual(e.calls,['request','publish'])
  assert.equal(e.state.quality,'high','retain the actual adaptive quality')
  assert.equal(e.state.renderScene,'workspace')
  e.calls.length=0;e.set('economy','workspace','auto')
  assert.deepEqual(e.calls,[])
  e.set('economy','home','auto')
  assert.deepEqual(e.calls,['request','publish'])
})

test('a real frame budget or quality change still resets scheduling and applies the requested quality',()=>{
  const e=engine()
  e.set('smooth120','home','auto')
  assert.deepEqual(e.calls,['window','high','cancel','request','publish'])
  assert.equal(e.state.targetFps,120)
  e.calls.length=0;e.set('smooth120','workspace','ultra')
  assert.deepEqual(e.calls,['reset','ultra','cancel','request','publish'])
  assert.equal(e.state.targetFps,30)
})

test('initial setup applies its profile even when defaults already match',()=>{
  const e=engine();e.state.profileInitialized=false
  e.set('full','home','auto')
  assert.deepEqual(e.calls,['reset','ultra','cancel','request','publish'])
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document')
  try {
    Object.defineProperty(globalThis, 'document', { configurable:true, value:{ documentElement:{ dataset:{ mobile:'android' } } } })
    const mobile = engine(); mobile.state.profileInitialized = false
    mobile.set('full','home','auto')
    assert.deepEqual(mobile.calls,['reset','high','cancel','request','publish'])
    mobile.calls.length = 0
    mobile.set('full','home','ultra')
    assert.deepEqual(mobile.calls,['reset','ultra','cancel','request','publish'], 'manual Ultra keeps its selected quality')
    assert.equal(mobile.state.targetFps,60)
  } finally {
    if (before) Object.defineProperty(globalThis,'document',before)
    else delete globalThis.document
  }
})

test('round trips preserve the chosen FPS tier and manual quality while applying the workspace power cap',()=>{
  for (const [profile,fps] of [['economy',30],['balanced',45],['full',60],['smooth90',90],['smooth120',120]]) {
    const e=engine()
    e.set(profile,'home','ultra')
    assert.equal(e.state.targetFps,fps)
    e.set(profile,'workspace','ultra')
    assert.equal(e.state.targetFps,Math.min(fps,30))
    assert.equal(e.state.renderProfile,profile)
    assert.equal(e.state.requestedQuality,'ultra')
    e.set(profile,'home','ultra')
    assert.equal(e.state.targetFps,fps)
    assert.equal(e.state.renderProfile,profile)
    assert.equal(e.state.requestedQuality,'ultra')
  }
})

// Exercise the renderer methods, including the camera's real spring settlement,
// so the power cap cannot return at an earlier UI interactivity threshold.
test('moving cameras retain each chosen home budget until their spring tail settles', () => {
  for (const [profile, fps] of [['economy',30],['balanced',45],['full',60],['smooth90',90],['smooth120',120]]) {
    const e = engine(), spring = {value:2.05,target:.7,velocity:0,tolerance:.0001}
    Object.assign(e.state, {cameraSprings:[spring], cameraIsRunning:BlackHoleRenderer.prototype.cameraIsRunning,
      syncCameraUniforms:()=>{}, previousFrame:123, simulationTime:4.5, nextFrameAt:321})
    e.set(profile, 'home', 'ultra')
    e.set(profile, 'workspace', 'ultra')
    assert.equal(e.state.targetFps,fps)
    let frames=0
    while (e.state.cameraIsRunning()) {
      assert.equal(e.state.targetFps,fps)
      BlackHoleRenderer.prototype.advanceCamera.call(e.state,1/fps)
      BlackHoleRenderer.prototype.syncFrameBudget.call(e.state)
      assert.ok(++frames<1000)
    }
    assert.equal(e.state.targetFps,30)
    assert.equal(e.state.requestedQuality,'ultra')
    assert.equal(e.state.previousFrame,123,'do not reset the simulation delta')
    assert.equal(e.state.simulationTime,4.5)
    spring.target=2.05
    BlackHoleRenderer.prototype.syncFrameBudget.call(e.state)
    assert.equal(e.state.targetFps,fps,'reversals immediately restore the selected budget')
    e.set(profile,'home','ultra')
    assert.equal(e.state.targetFps,fps)
  }
})

test('finishing a camera immediately (reduced motion) caps only settled workspaces',()=>{
  const e=engine(), spring={value:1.1,target:.7,velocity:-.5,tolerance:.0001}
  Object.assign(e.state,{cameraSprings:[spring],cameraIsRunning:BlackHoleRenderer.prototype.cameraIsRunning,syncCameraUniforms:()=>{}})
  e.set('smooth120','workspace','ultra')
  assert.equal(e.state.targetFps,120)
  BlackHoleRenderer.prototype.finishCameraTransition.call(e.state)
  BlackHoleRenderer.prototype.syncFrameBudget.call(e.state)
  assert.equal(e.state.targetFps,30)
  e.set('smooth120','home','ultra')
  assert.equal(e.state.targetFps,120)
})

for (const [profile, fps] of [['economy',30],['balanced',45],['full',60],['smooth90',90],['smooth120',120]]) {
  test(`${fps} FPS horizon entry, retreat and interruption retain the chosen budget with stationary home springs`, () => {
    const e = engine()
    Object.assign(e.state, { previousFrame: 123, simulationTime: 4.5, nextFrameAt: 321 })
    e.set(profile, 'workspace', 'ultra')
    assert.equal(e.state.targetFps, 30)
    e.calls.length = 0
    const scrub = progress => {
      e.state.stringFlightProgress = progress
      BlackHoleRenderer.prototype.syncFrameBudget.call(e.state)
      assert.equal(e.state.targetFps, progress > 0 && progress < 1 ? fps : 30)
      assert.equal(e.state.cameraIsRunning(), false, 'external flight never changes the home springs')
      assert.equal(e.state.previousFrame, 123)
      assert.equal(e.state.simulationTime, 4.5)
      assert.equal(e.state.requestedQuality, 'ultra')
    }
    for (let step = 0; step <= 120; step++) scrub(orbitTransitionFrame(step / 120, 0, false).flight)
    assert.equal(e.state.targetFps, 30, 'settled horizon edge retains the power cap')
    for (let step = 0; step <= 120; step++) scrub(orbitTransitionFrame(step / 120, 1, true).flight)
    const interrupted = orbitTransitionFrame(.45, 0, false).flight
    scrub(interrupted)
    e.set(profile, 'workspace', 'ultra')
    assert.equal(e.state.targetFps, fps)
    for (let step = 0; step <= 120; step++) scrub(orbitTransitionFrame(step / 120, interrupted, true).flight)
    assert.equal(e.state.targetFps, 30, 'return to free time does not leave a high-rate loop')
    assert.ok(!e.calls.includes('reset'), 'transient cadence does not reset adaptive recovery history')
  })
}

test('initializing or changing the selected profile during a flight uses its active presentation budget', () => {
  const e = engine()
  e.state.profileInitialized = false
  e.state.stringFlightProgress = .4
  e.set('full', 'workspace', 'ultra')
  assert.equal(e.state.targetFps, 60)
  e.set('smooth120', 'workspace', 'ultra')
  assert.equal(e.state.targetFps, 120)
  e.state.stringFlightProgress = 1
  BlackHoleRenderer.prototype.syncFrameBudget.call(e.state)
  assert.equal(e.state.targetFps, 30)
  e.state.stringFlightProgress = .9
  e.set('balanced', 'workspace', 'ultra')
  assert.equal(e.state.targetFps, 45)
})

test('a horizon transition is excluded from sustained-load quality sampling; steady edge motion is not', () => {
  const e = engine(), samples = []
  e.state.adaptiveQuality.sample = (...args) => { samples.push(args); return null }
  e.state.springIsRunning = () => false
  e.state.renderScene = 'workspace'
  for (const progress of [0, .2, 1, .8, 0]) {
    e.state.stringFlightProgress = progress
    BlackHoleRenderer.prototype.syncFrameBudget.call(e.state)
    BlackHoleRenderer.prototype.adaptQuality.call(e.state, 17)
  }
  assert.deepEqual(samples.map(sample => sample[2]), [false, true, false, true, false])
  assert.deepEqual(samples.map(sample => sample[3]), [30, 60, 30, 60, 30])
})
