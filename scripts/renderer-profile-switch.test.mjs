import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

const root=new URL('../src/',import.meta.url).href
const hooks=registerHooks({resolve(specifier,context,next){
  return next(context.parentURL?.startsWith(root)&&specifier.startsWith('.')&&!/\.[a-z]+$/i.test(specifier)?`${specifier}.ts`:specifier,context)
}})
const { BlackHoleRenderer }=await import('../src/prototype/BlackHoleRenderer.ts')
hooks.deregister()

function engine() {
  const calls=[]
  const state={profileInitialized:true,renderProfile:'full',renderScene:'home',requestedQuality:'auto',quality:'high',targetFps:60,
    adaptiveQuality:{resetWindow:()=>calls.push('window'),reset:()=>calls.push('reset')},
    applyQuality:quality=>calls.push(quality),cancelFrame:()=>calls.push('cancel'),requestFrame:()=>calls.push('request'),publishStats:()=>calls.push('publish')}
  return {calls,state,set:(...args)=>BlackHoleRenderer.prototype.setRenderProfile.call(state,...args)}
}

test('changing pages at the same effective cadence preserves the pending frame and adaptive history',()=>{
  const e=engine()
  e.set('full','workspace','auto')
  assert.deepEqual(e.calls,['request','publish'])
  assert.equal(e.state.quality,'high','retain the actual adaptive quality')
  assert.equal(e.state.renderScene,'workspace')
  e.calls.length=0;e.set('full','workspace','auto')
  assert.deepEqual(e.calls,[])
  e.set('full','home','auto')
  assert.deepEqual(e.calls,['request','publish'])
})

test('a real frame budget or quality change still resets scheduling and applies the requested quality',()=>{
  const e=engine()
  e.set('smooth120','home','auto')
  assert.deepEqual(e.calls,['window','high','cancel','request','publish'])
  assert.equal(e.state.targetFps,120)
  e.calls.length=0;e.set('smooth120','workspace','ultra')
  assert.deepEqual(e.calls,['reset','ultra','cancel','request','publish'])
  assert.equal(e.state.targetFps,120)
})

test('initial setup applies its profile even when defaults already match',()=>{
  const e=engine();e.state.profileInitialized=false
  e.set('full','home','auto')
  assert.deepEqual(e.calls,['reset','ultra','cancel','request','publish'])
})
