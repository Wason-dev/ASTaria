import test from 'node:test'
import assert from 'node:assert/strict'
import { settleKeyboardAxis, attachKeyboardReturn } from '../src/home/keyboardReturn.ts'

test('return decelerates into the target without bouncing, across 60 and 120Hz', () => {
  for (const hz of [60, 120]) {
    let axis = { value: 280, velocity: 0 }, previous = axis.value
    const steps = []
    for (let i = 0; i < hz / 2; i++) {
      axis = settleKeyboardAxis(axis, 680, 1 / hz)
      assert.ok(axis.value >= previous && axis.value <= 680)
      steps.push(axis.value - previous); previous = axis.value
    }
    assert.ok(680 - axis.value < .1)
    assert.ok(steps.at(-1) < steps[Math.floor(hz / 10)] / 20)
  }
})

for (const platform of ['native-ios', 'native-android']) test(`${platform}: return yields immediately to rising keyboard, reduced motion, navigation and dispose`, () => {
  const values = new Map([['--m-visible-height','400px'],['--safe-area-inset-top','24px'],['--m-layout-height','834px']])
  const doc = new EventTarget(), raf = new Map(), surfaceValues = new Map([['--home-chat-progress','1'],['--home-chat-end-top','84'],['--home-chat-end-height','680']])
  const style = map => ({ getPropertyValue: key => map.get(key) ?? '', setProperty: (key, value) => map.set(key,value), removeProperty: key => map.delete(key) })
  let time = 0, next = 0, mutation
  const before = globalThis.MutationObserver
  globalThis.MutationObserver = class { constructor(fn){ mutation = fn } observe(){} disconnect(){} }
  doc.documentElement = { dataset: { mobileViewport: platform }, style: style(values) }; doc.hidden = false
  const workspace = { get clientWidth(){throw Error('IME must not flush clientWidth')}, dataset: { page:'home', chatOpen:'true', motion:'full' } }
  const win = { getComputedStyle: () => {throw Error('IME must not flush computed style')},
    matchMedia: () => ({matches:false}), performance: {now:()=>time}, requestAnimationFrame: fn => {raf.set(++next,fn);return next}, cancelAnimationFrame: id=>raf.delete(id) }
  doc.defaultView = win
  const surface = {ownerDocument:doc,dataset:{progress:'1.000'},style:{...style(surfaceValues),width:'396px',borderRadius:'15px'}}
  const emit = height => { values.set('--m-visible-height',`${height}px`);doc.dispatchEvent(new Event('astaria-mobile-viewport-change')) }
  const frame = () => {time+=16;const queue=[...raf.values()];raf.clear();queue.forEach(fn=>fn(time))}
  try {
    const geometry=[]
    const stop=attachKeyboardReturn(surface,workspace,(...values)=>geometry.push(values))
    const initial=parseFloat(surfaceValues.get('--home-keyboard-height'))
    emit(834);frame()
    const moved=parseFloat(surfaceValues.get('--home-keyboard-height'))
    assert.ok(moved>initial && moved<680)
    emit(380)
    assert.equal(raf.size,0)
    assert.ok(parseFloat(surfaceValues.get('--home-keyboard-height'))+parseFloat(surfaceValues.get('--home-keyboard-top'))<=380-24-12)
    emit(834);frame();workspace.dataset.motion='reduced';mutation()
    assert.equal(raf.size,0);assert.equal(surfaceValues.get('--home-keyboard-height'),'680px')
    values.set('--m-layout-height','500px');emit(500)
    surfaceValues.set('--home-chat-end-height','330');mutation()
    assert.equal(surfaceValues.get('--home-keyboard-height'),'330px')
    values.set('--m-layout-height','834px');emit(834)
    surfaceValues.set('--home-chat-end-height','680');mutation()
    assert.equal(surfaceValues.get('--home-keyboard-height'),'680px','returning from a small window discards the old height after React changes endpoints')
    workspace.dataset.chatOpen='false';mutation()
    assert.equal(surfaceValues.has('--home-keyboard-height'),false)
    workspace.dataset.chatOpen='true';mutation();emit(400);emit(834);frame()
    stop();assert.equal(raf.size,0);assert.equal(surfaceValues.has('--home-keyboard-height'),false)
    emit(300);assert.equal(surfaceValues.has('--home-keyboard-height'),false)
    assert.ok(geometry.every(([width,height,radius])=>width===396&&Number.isFinite(height)&&radius===15),'exact dimensions are delivered without DOM measurement')
  } finally {globalThis.MutationObserver=before}
})

test('Android follows each system IME curve sample through open, reverse and final close without a second spring', () => {
  const rootValues = new Map([['--m-visible-height','844px'],['--safe-area-inset-top','24px'],['--m-layout-height','844px']])
  const surfaceValues = new Map([['--home-chat-progress','1'],['--home-chat-end-top','52'],['--home-chat-end-height','736']])
  const style = map => ({ getPropertyValue: key => map.get(key) ?? '', setProperty: (key,value) => map.set(key,value), removeProperty: key => map.delete(key) })
  const document = new EventTarget(), frames = new Map()
  const before = globalThis.MutationObserver
  globalThis.MutationObserver = class { observe(){} disconnect(){} }
  document.documentElement = { dataset:{mobileViewport:'native-android',mobileKeyboardAnimation:'idle'},style:style(rootValues) }
  document.hidden = false
  document.defaultView = { matchMedia:()=>({matches:false}),performance:{now:()=>0},requestAnimationFrame:fn=>{frames.set(1,fn);return 1},cancelAnimationFrame:id=>frames.delete(id) }
  const surface = { ownerDocument:document,style:{...style(surfaceValues),width:'346px',borderRadius:'15px'},dataset:{progress:'1.000'} }
  const workspace = { dataset:{page:'home',chatOpen:'true',motion:'full'} }
  try {
    const stop = attachKeyboardReturn(surface,workspace)
    for (const [i,inset] of [4,60,180,300,360,300,180,60,200,360,160,0].entries()) {
      document.documentElement.dataset.mobileKeyboardAnimation=i===11?'idle':'running'
      rootValues.set('--m-visible-height',`${844-inset}px`)
      document.dispatchEvent(new Event('astaria-mobile-viewport-change'))
      assert.equal(Number.parseFloat(surfaceValues.get('--home-keyboard-height')),Math.min(736,844-inset-24-52-12))
      assert.equal(frames.size,0,'native curve must not queue an additional recovery spring')
    }
    stop()
  } finally { globalThis.MutationObserver=before }
})
