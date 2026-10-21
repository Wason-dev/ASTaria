import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { portraitCameraOffset } from '../src/prototype/portraitComposition.ts'
import { sceneProjection } from '../src/spatial/scene.ts'
import { resolveStringFlightCamera, publishStringFlightProjection, getStringFlightProjection, setStringFlight } from '../src/prototype/stringFlight.ts'
const hook=registerHooks({resolve(s,c,next){return next(c.parentURL?.endsWith('/blackHoleEntryGeometry.ts')&&s==='../spatial/scene'?'../spatial/scene.ts':s,c)}})
const { blackHoleEntryGeometry }=await import('../src/home/blackHoleEntryGeometry.ts');hook.deregister()

test('portrait home and chat keep the shadow to the right while hit targets share the actual camera',()=>{
 for(const [width,height] of [[390,844],[320,740],[430,932]])for(const [zoom,centerX] of [[.7,.65],[2.05,.98]]) {
  const camera={zoom,centerX:centerX+portraitCameraOffset(width,height,zoom),centerY:.51,roll:18,inclination:83}
  const target=blackHoleEntryGeometry(camera,width,height),projection=sceneProjection(camera,width,height)
  assert.equal(target.cx,projection.cx)
  const left=(target.cx-target.shadowRadius)/width
  assert.ok(left>.42&&left<.58,`visible shadow starts near the right half: ${left}`)
 }
 assert.equal(portraitCameraOffset(1440,900,2.05),0)
 assert.equal(portraitCameraOffset(844,390,.7),0)
})
test('portrait composition moves continuously with camera zoom, then edge flight recenters without a jump on return',()=>{
 let previous=0
 for(let i=0;i<=100;i++){const current=portraitCameraOffset(390,844,.7+i*1.35/100);assert.ok(current>=previous);assert.ok(i===0||current-previous<.02);previous=current}
 const original={zoom:.7,centerX:.65+portraitCameraOffset(390,844,.7),centerY:.51,roll:18,inclination:83}
 assert.deepEqual(resolveStringFlightCamera(original,0,'edge',390/844),{...original,radius:30})
 const end=resolveStringFlightCamera(original,1,'edge',390/844)
 assert.equal(end.centerX,.5)
 setStringFlight(1,'edge');publishStringFlightProjection(end,390,844)
 assert.ok(Math.abs(getStringFlightProjection(390,844).cx-195)<1e-8)
 setStringFlight(0,'edge')
})
