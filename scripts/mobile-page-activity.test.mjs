import test from 'node:test'
import assert from 'node:assert/strict'
import { pageIsHidden, pageIsVisible, observePageActivity, PAGE_ACTIVITY_EVENT } from '../src/stores/pageActivity.ts'
import { startVisiblePolling } from '../src/stores/visiblePolling.ts'

test('native inactivity stops polling before WebView visibility changes and resumes once without treating blur as hidden', async t => {
  const globals=['document','window','setInterval','clearInterval'],previous=new Map(globals.map(k=>[k,Object.getOwnPropertyDescriptor(globalThis,k)]))
  t.after(()=>{for(const[k,v]of previous){if(v)Object.defineProperty(globalThis,k,v);else delete globalThis[k]}})
  const document=Object.assign(new EventTarget(),{hidden:false,visibilityState:'visible',documentElement:{dataset:{}}}),window=new EventTarget(),timers=new Map();let serial=0,calls=0,events=0
  globalThis.document=document;globalThis.window=window
  globalThis.setInterval=window.setInterval=callback=>{timers.set(++serial,callback);return serial}
  globalThis.clearInterval=id=>timers.delete(id)
  const unobserve=observePageActivity(()=>events++),stop=startVisiblePolling(()=>calls++,5000)
  assert.equal(calls,1);assert.equal(timers.size,1);assert.equal(pageIsVisible(),true)
  window.dispatchEvent(new Event('blur'));assert.equal(pageIsHidden(),false);assert.equal(timers.size,1)
  document.documentElement.dataset.mobileActive='false';document.dispatchEvent(new Event(PAGE_ACTIVITY_EVENT))
  assert.equal(pageIsHidden(),true);assert.equal(pageIsVisible(),false);assert.equal(timers.size,0);assert.equal(calls,1)
  document.documentElement.dataset.mobileActive='true';document.dispatchEvent(new Event(PAGE_ACTIVITY_EVENT))
  assert.equal(timers.size,1);assert.equal(calls,2)
  document.hidden=true;document.visibilityState='hidden';document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(timers.size,0)
  document.hidden=false;document.visibilityState='visible';document.dispatchEvent(new Event('visibilitychange'))
  assert.equal(timers.size,1);assert.equal(calls,3)
  stop();unobserve();assert.equal(timers.size,0)
  document.dispatchEvent(new Event(PAGE_ACTIVITY_EVENT));assert.equal(events,4);assert.equal(calls,3)
})
