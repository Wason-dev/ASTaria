import test from 'node:test'
import assert from 'node:assert/strict'
import { glassOverlayExit } from '../src/ui/glassOverlayExit.ts'
let frames, media, animations
class Element {
  constructor(name, children=[]) { this.name=name;this.children=children;this.dataset={};this.style={values:new Map(),getPropertyValue(name){return this.values.get(name)?.value??''},getPropertyPriority(name){return this.values.get(name)?.priority??''},setProperty(name,value,priority=''){this.values.set(name,{value,priority})},removeProperty(name){this.values.delete(name)}} }
  matches(selector) { return selector.split(',').includes(this.name) }
  querySelectorAll(selector) { return this.children.flatMap(child=>[...(child.matches(selector)?[child]:[]),...child.querySelectorAll(selector)]) }
  animate(keyframes,options) {
    let resolve
    const animation={keyframes,options,target:this,progress:0,cancelled:false,finished:new Promise(done=>{resolve=done}),effect:{getComputedTiming:()=>({progress:animation.progress})},finish:()=>resolve(),cancel(){this.cancelled=true}}
    animations.push(animation); return animation
  }
}
globalThis.HTMLElement=Element
globalThis.matchMedia=()=>media
globalThis.getComputedStyle=element=>({borderColor:'rgb(100, 100, 100)',boxShadow:'rgb(0, 0, 0) 0px 8px 28px',opacity:'1',transform:'none',backgroundColor:'transparent',...element.computed})
globalThis.requestAnimationFrame=callback=>{const id=Math.random();frames.set(id,callback);return id}
globalThis.cancelAnimationFrame=id=>frames.delete(id)
function fixture(reduced=false){
 frames=new Map();animations=[];media={matches:reduced,listeners:new Set(),addEventListener(_type,cb){this.listeners.add(cb)},removeEventListener(_type,cb){this.listeners.delete(cb)}}
 const sample=new Element('.home-glass-backdrop'),tint=new Element('.home-glass-surface'),outline=new Element('.floating-glass-outline'),content=new Element('.home-task-content')
 const dialog=new Element('dialog',[new Element('.home-glass-measure',[sample,tint]),outline,content])
 return {dialog,sample,tint,outline,content}
}
test('popup layers leave without changing any original-page sampling or starting a frame loop', async()=>{
 const f=fixture();let done=0
 const cancel=glassOverlayExit(f.dialog,()=>done++)
 const clock=animations[0]
 assert.equal(clock.options.duration,200)
 assert.ok(clock.keyframes.every(frame=>!('opacity' in frame)&&!('transform' in frame)))
 assert.equal(f.sample.style.getPropertyValue('visibility'),'','the popup sampler fades naturally without being hidden')
 assert.equal(f.tint.style.getPropertyValue('visibility'),'','material remains present for the fade')
 clock.progress=.5
 for(const [id,callback]of [...frames]){frames.delete(id);callback()}
 assert.equal(frames.size,0,'no underlay mask needs to be redrawn')
 assert.equal(done,0,'animation completion, not an independent timer, controls removal')
 clock.finish();await Promise.resolve()
 assert.equal(done,1);assert.equal(frames.size,0)
 cancel();assert.equal(media.listeners.size,0);assert.ok(animations.every(a=>a.cancelled))
})
test('unmount cancels animation and frame work without later removal callbacks', async()=>{
 const f=fixture();let done=0
 const cancel=glassOverlayExit(f.dialog,()=>done++,140)
 assert.equal(animations[0].options.duration,140)
 cancel();animations[0].finish();await Promise.resolve()
 assert.equal(done,0);assert.equal(frames.size,0);assert.equal(media.listeners.size,0)
})
test('reduced motion restores the original paint and closes without frames or animation',()=>{
 const f=fixture(true);let done=0
 glassOverlayExit(f.dialog,()=>done++)
 assert.equal(done,1);assert.equal(animations.length,0);assert.equal(frames.size,0)
})
test('reversing an entry begins at its current paint and content rather than flashing to full opacity',()=>{
 const f=fixture()
 f.content.computed={opacity:'0.35',transform:'matrix(1, 0, 0, 1, 0, 6)'}
 f.tint.computed={opacity:'1',backgroundColor:'rgba(8, 10, 14, 0.08)'}
 const cancel=glassOverlayExit(f.dialog,()=>{})
 const content=animations.find(animation=>animation.target===f.content)
 assert.deepEqual(content.keyframes[0],{opacity:'0.35',transform:'matrix(1, 0, 0, 1, 0, 6)'})
 const paint=animations.find(animation=>animation.target===f.tint)
 assert.equal(paint.keyframes[0].backgroundColor,'rgba(8, 10, 14, 0.08)')
 assert.equal(paint.keyframes[1].backgroundColor,paint.keyframes[0].backgroundColor,'unfinished entry tint is held during the fade')
 cancel()
})
test('the saved reduced-motion preference also skips exit animations',()=>{
 const f=fixture();f.dialog.dataset.reducedMotion='true';let done=0
 glassOverlayExit(f.dialog,()=>done++)
 assert.equal(done,1);assert.equal(animations.length,0);assert.equal(frames.size,0)
})
