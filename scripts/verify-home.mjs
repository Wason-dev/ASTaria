/** Run against a dedicated temporary Chrome profile on 9233, never the user's browser. */
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const url = process.env.HOME_TEST_URL ?? 'http://127.0.0.1:5188/'
const output = new URL('../artifacts/homepage/', import.meta.url)
const targets = await fetch('http://127.0.0.1:9233/json').then(r => r.json())
const target = targets.find(t => t.type === 'page')
assert.ok(target, 'Start dedicated test Chrome on port 9233')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0
const pending = new Map(), errors = [], checks = []
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (!message.id) return
  const callback = pending.get(message.id)
  pending.delete(message.id)
  if (message.error) callback.reject(message.error)
  else callback.resolve(message.result)
}
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  pending.set(id, { resolve, reject })
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => {
  for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(80) }
  throw new Error(`Timed out: ${expression}`)
}
const check = async (name, expression) => {
  const pass = await evaluate(expression)
  checks.push({ name, pass })
  assert.equal(pass, true, name)
}
const click = async selector => {
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(50)
}
const key = async (key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode = { Escape: 27, Enter: 13, Tab: 9 }[key] ?? 0
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode })
  await delay(40)
}
const shot = async name => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await delay(180)
  await fs.writeFile(new URL(`screenshots/${name}.png`, output), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
const rows = () => evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('astaria-local');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const r=db.transaction('tasks').objectStore('tasks').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}})()`)
const cameraSettled = () => wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
const ready = () => wait('!!window.__ASTARIA_P0__ && !!document.querySelector(".home-current-title:not(:disabled)")')
let failure
try {
  await fs.mkdir(new URL('screenshots/', output), { recursive: true })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb,local_storage' })
  await send('Page.navigate', { url }); await ready()
  await evaluate('sessionStorage.clear()')
  await send('Page.reload', { ignoreCache: true }); await ready()
  await check('minimal home removes observatory, sun and task-orbit UI', '!document.querySelector(".p0-observatory,.p0-actions,.p0-views,.spatial-ui") && document.querySelector(".p0-whisper").textContent === "把今天交给我"')
  await check('pill stays small and exactly 12px below two-line current task', '(()=>{const p=document.querySelector(".home-morph").getBoundingClientRect(),t=document.querySelector(".home-current").getBoundingClientRect();return p.width===128&&p.height===38&&Math.abs(p.top-t.bottom-12)<.1})()')
  await check('real empty state, no example tasks', 'document.querySelector(".home-current-title").textContent === "今天还没有事项"')
  await shot('home-1440')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 52, y: 43 })
  await wait('document.querySelector(".home-brand").getAttribute("aria-expanded")==="true"')
  await check('hover navigation contains planned pages without fake destinations', 'document.querySelectorAll(".home-menu button:disabled").length===4 && document.querySelector(".home-menu").textContent.includes("DDL")')
  await evaluate('document.querySelector(".home-menu button").focus()')
  await key('Escape')
  await check('Escape closes nav and restores brand focus', 'document.querySelector(".home-menu").hidden && document.activeElement.matches(".home-brand")')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await evaluate('window.__morph=document.querySelector(".home-morph");true')
  await click('.home-launch')
  await delay(350)
  const widthBeforeReverse = await evaluate('document.querySelector(".home-morph").getBoundingClientRect().width')
  await key('Escape')
  const widthAfterReverse = await evaluate('document.querySelector(".home-morph").getBoundingClientRect().width')
  assert.ok(Math.abs(widthBeforeReverse - widthAfterReverse) < 25, 'interrupted morph does not jump')
  await cameraSettled(); await wait('document.activeElement.matches(".home-launch")')
  await check('same pill survives interrupted expansion', 'window.__morph===document.querySelector(".home-morph")')
  await click('.home-launch'); await cameraSettled(); await wait('document.activeElement.id==="home-compose"')
  await check('exact interstellar preset and black theme', '(()=>{const s=window.__ASTARIA_P0__.getSnapshot();return s.zoom===2.05&&s.roll===7&&s.inclination===84&&s.centerX===.98&&document.querySelector(".p0").dataset.night==="true"})()')
  await check('SVG refraction map has a nonzero viewport and live backdrop', 'document.querySelector("feImage").getAttribute("width")==="300" && document.querySelector("feImage").getAttribute("href").startsWith("data:image/png") && getComputedStyle(document.querySelector(".home-glass-surface")).backdropFilter.includes("url(")')
  await check('material matches chosen transparency and low rim with no reflection', '(()=>{const s=getComputedStyle(document.querySelector(".home-glass-surface"));return Math.abs(Number(s.getPropertyValue("--glass-tint"))-.2)<1e-6&&Number(s.getPropertyValue("--glass-rim"))===.15&&Number(s.getPropertyValue("--glass-reflection"))===0&&Number(s.getPropertyValue("--glass-shadow"))===.6})()')
  await shot('chat-1440')
  await send('Input.insertText', { text: '完成物理实验报告\n复核数据并整理结论' })
  await evaluate('document.querySelector("#home-compose").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true}))')
  assert.equal((await rows()).length, 0, 'IME confirmation does not create a task')
  await click('.home-capture')
  await wait('document.querySelectorAll(".home-receipt").length===1')
  const stored = await rows()
  assert.equal(stored.length, 1); assert.equal(stored[0].title, '完成物理实验报告'); assert.equal(stored[0].notes, '复核数据并整理结论')
  checks.push({ name: 'capture persists one task and notes to existing local store, no AI reply', pass: true })
  await click('.home-receipt button')
  await wait('!!document.querySelector("dialog[open]")')
  await key('Escape')
  await wait('!document.querySelector("dialog")')
  await check('receipt detail restores its actual opener', 'document.activeElement.matches(".home-receipt button")')
  await click('#home-compose'); await send('Input.insertText', { text: '还没写完的事项' })
  await click('.home-collapse'); await cameraSettled()
  await check('home reflects saved task and exact panorama preset', '(()=>{const s=window.__ASTARIA_P0__.getSnapshot();return document.querySelector(".home-current-title").textContent==="完成物理实验报告"&&s.zoom===.7&&s.roll===18&&s.inclination===83&&s.centerX===.65})()')
  await shot('home-with-task-1440')
  await click('.home-current-title'); await click('.home-task-status button:nth-child(2)')
  await wait('document.querySelector(".home-task-status button:nth-child(2)").getAttribute("aria-pressed")==="true"')
  await key('Escape'); await wait('!document.querySelector("dialog")')
  await check('task status persists and returns focus', 'document.activeElement.matches(".home-current-title")')
  assert.equal((await rows())[0].status, 'doing')
  await send('Page.reload', { ignoreCache: true }); await ready()
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await click('.home-launch'); await wait('document.activeElement.id==="home-compose"')
  await check('draft survives closing and reloading', 'document.querySelector("#home-compose").value==="还没写完的事项"')
  await check('reduced motion reaches chat without animated camera', 'window.__ASTARIA_P0__.getSnapshot().cameraTransition===false && document.querySelector(".home-morph").dataset.progress==="1.000"')
  for (const [width, height] of [[390, 844], [320, 568], [844, 390]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await delay(150)
    await check(`chat and composer fit ${width}x${height}`, '(()=>{const r=document.querySelector(".home-morph").getBoundingClientRect(),f=document.querySelector(".home-xixi form").getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&f.bottom<=r.bottom&&f.top>=r.top})()')
    await shot(`chat-${width}`)
  }
  await click('.home-collapse'); await wait('document.querySelector(".home-morph").dataset.progress==="0.000"')
  await check('hidden chat is inert and keyboard returns to pill', 'document.querySelector(".home-xixi").inert && document.activeElement.matches(".home-launch")')
  // Force context loss only in this isolated browser and confirm local input stays usable.
  await evaluate('document.querySelector(".p0-universe canvas").dispatchEvent(new Event("webglcontextlost",{cancelable:true}))')
  await click('.home-launch')
  await wait('document.activeElement.id==="home-compose"')
  await check('WebGL interruption cannot lock local capture', 'document.querySelector(".home-morph").dataset.progress==="1.000"&&!document.querySelector(".home-xixi").inert')
  await send('Page.navigate', { url: new URL('#/app', url).href })
  await wait('location.hash==="#/app"')
  await send('Page.reload', { ignoreCache: true })
  await wait('!!document.querySelector(".app-shell")')
  await check('original app remains accessible', '!!document.querySelector(".app-shell")')
  assert.equal(errors.length, 0, 'no browser runtime exceptions')
  checks.push({ name: 'no runtime exceptions', pass: true })
} catch (error) { failure = String(error); throw error }
finally {
  await fs.writeFile(new URL('browser-checks.json', output), JSON.stringify({ url, checks, errors, failure }, null, 2))
  console.log(JSON.stringify({ checks, failure }, null, 2))
  ws.close()
}
