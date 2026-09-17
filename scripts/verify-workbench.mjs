/** Run against a dedicated temporary Chrome profile on 9233, never the user's browser. */
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const url = process.env.HOME_TEST_URL ?? 'http://127.0.0.1:5188/'
const output = new URL('../artifacts/workbench/', import.meta.url)
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
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  const point = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(50)
}
const key = async (key, code = key, modifiers = 0) => {
  const windowsVirtualKeyCode = { Escape: 27, Enter: 13, Tab: 9 }[key] ?? 0
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers, windowsVirtualKeyCode, ...(key === 'Enter' ? { text: '\r', unmodifiedText: '\r' } : {}) })
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers, windowsVirtualKeyCode })
  await delay(40)
}
const shot = async (name, keepPointer = false) => {
  if (!keepPointer) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await delay(180)
  await fs.writeFile(new URL(`screenshots/${name}.png`, output), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
const rows = () => evaluate(`(async()=>{const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('astaria-local');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});try{return await new Promise((resolve,reject)=>{const r=db.transaction('tasks').objectStore('tasks').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)})}finally{db.close()}})()`)
const cameraSettled = () => wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
const ready = () => wait('!!window.__ASTARIA_P0__ && !!document.querySelector(".home-current-title:not(:disabled)")')
const menu = async index => {
  await evaluate('document.querySelector(".home-brand").focus()')
  if (await evaluate('document.querySelector(".home-menu").inert')) await key('Enter')
  await delay(290)
  await click(`.home-menu li:nth-child(${index}) button`)
}
const focus = () => wait('!!document.querySelector(".wb-clock")&&!document.querySelector(".wb-stage").inert')
const timer = () => evaluate('JSON.parse(localStorage.getItem("astaria-focus-v1"))')
const setRange = async (selector, value) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
let failure
try {
  await fs.mkdir(new URL('screenshots/', output), { recursive: true })
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'about:blank' }); await wait('location.href==="about:blank"')
  await send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb,local_storage' })
  await send('Page.navigate', { url }); await ready()
  await menu(2)
  await check('workbench changes theme, hides home focus targets, and focuses its heading', 'document.querySelector(".p0").dataset.night==="false"&&document.querySelector(".home-scene-ui").inert&&document.activeElement.matches(".wb-heading h2")')
  await check('real empty state has no preview tasks or checkboxes', '!document.querySelector(".wb-task")&&!document.querySelector(".workbench input[type=checkbox]")&&document.querySelector(".wb-empty").textContent.includes("暂时没有")')
  await click('.wb-toolbar .wb-tool')
  await wait('document.querySelectorAll(".wb-chooser > .wb-task-grid .wb-task").length===4')
  await delay(550)
  await check('sample preview uses chosen geometry and glass without touching the database', '(()=>{const c=document.querySelector(".wb-container").getBoundingClientRect(),b=document.querySelector(".wb-task").getBoundingClientRect(),s=getComputedStyle(document.querySelector(".wb-task .home-glass-surface"));return c.width===900&&b.height===96&&Math.abs(Number(s.getPropertyValue("--glass-tint"))-.2)<1e-6&&Number(s.getPropertyValue("--glass-rim"))===0&&Number(s.getPropertyValue("--glass-shadow"))===.11&&getComputedStyle(document.querySelector(".workbench")).fontSize==="12px"})()')
  assert.equal((await rows()).length, 0)
  await shot('chooser-1440')
  await click('.wb-customize-trigger')
  await check('customization opens a labelled dialog with live parameter controls', 'document.querySelector(".wb-customize").open&&document.querySelectorAll(".wb-adjustment input").length===11')
  await setRange('.wb-adjustment input', 940)
  await check('changing appearance updates the live workspace and persists parameters', 'document.querySelector(".wb-container").getBoundingClientRect().width===940&&JSON.parse(localStorage.getItem("astaria-workbench-appearance-v1")).width===940')
  await shot('customize-1440')
  await click('.wb-customize footer button')
  await key('Escape')
  await wait('!document.querySelector(".wb-customize")')
  await check('closing controls restores keyboard focus to their trigger', '!document.querySelector(".wb-customize")&&document.activeElement.matches(".wb-customize-trigger")')
  await click('.wb-task[data-task-id="preview-physics"]')
  await focus(); await delay(400)
  await check('one task click enters focus with an idle 35 minute clock and a permanent Xixi area', 'document.querySelector(".wb-clock").textContent==="35:00"&&document.querySelector(".wb-clock-actions .wb-action").textContent==="开始专注"&&!!document.querySelector(".wb-xixi textarea")')
  await shot('focus-1440')
  await click('.wb-focus-bottom button')
  await check('duration settings expand with an animated layout and accessible controls', '(()=>{const r=document.querySelector(".wb-duration-reveal");return r.dataset.open==="true"&&!r.inert&&getComputedStyle(r).transitionProperty.includes("grid-template-rows")})()')
  await setRange('input[aria-label="专注分钟"]', 40)
  await setRange('input[aria-label="休息分钟"]', 7)
  await check('duration controls update an unstarted round', 'document.querySelector(".wb-clock").textContent==="40:00"&&document.querySelector("input[aria-label=休息分钟]").value==="7"')
  await click('.wb-clock-actions .wb-action')
  await wait('document.querySelector(".wb-clock").textContent!=="40:00"')
  await setRange('input[aria-label="专注分钟"]', 45)
  await check('changing duration while running leaves this round intact', 'JSON.parse(localStorage.getItem("astaria-focus-preview-v1")).tasks["preview-physics"].durationMs===2400000&&JSON.parse(localStorage.getItem("astaria-focus-preview-v1")).durations.focusMin===45')
  await click('.wb-back')
  await wait('!!document.querySelector(".wb-chooser")')
  await check('back pauses progress and restores the selected task focus', 'JSON.parse(localStorage.getItem("astaria-focus-preview-v1")).tasks["preview-physics"].phase==="paused"&&document.activeElement.dataset.taskId==="preview-physics"')
  await click('.wb-toolbar .wb-tool')
  await wait('!document.querySelector(".wb-preview-label")')
  await check('preview settings and task state never mutate real records', 'JSON.parse(localStorage.getItem("astaria-focus-v1")).durations.focusMin===35&&document.querySelector(".wb-empty").textContent.includes("暂时没有")')
  await click('.wb-empty .wb-action')
  await wait('document.activeElement.id==="home-compose"')
  await check('home capture retains black theme and expanded 680 by 460 glass', 'document.querySelector(".p0").dataset.night==="true"&&document.querySelector(".home-launch").textContent==="交给析熙"&&document.querySelector(".home-morph").getBoundingClientRect().width===680&&document.querySelector(".home-morph").getBoundingClientRect().height===460')
  await send('Input.insertText', { text: '复核实验报告\n先把需要核对的数据列出来' })
  await click('.home-capture'); await wait('document.querySelectorAll(".home-receipt").length===1')
  await menu(2); await wait('document.querySelectorAll(".wb-task").length===1')
  await click('.wb-task'); await focus()
  await click('.wb-clock-actions .wb-action')
  await wait('document.querySelector(".wb-clock-actions .wb-action").textContent==="暂停"')
  assert.equal((await rows())[0].status, 'doing')
  await delay(1150)
  await menu(1)
  await check('leaving workbench pauses the real task and restores the home action', '(()=>{const t=JSON.parse(localStorage.getItem("astaria-focus-v1"));return t.tasks[t.selectedTaskId].phase==="paused"&&document.querySelector(".home-launch").textContent==="交给析熙"&&document.querySelector(".p0").dataset.night==="true"})()')
  const paused = await timer()
  await delay(500)
  await menu(2)
  await check('returning to focus preserves elapsed time without restarting', `(()=>{const t=JSON.parse(localStorage.getItem('astaria-focus-v1'));return t.tasks[t.selectedTaskId].elapsedMs===${paused.tasks[paused.selectedTaskId].elapsedMs}&&document.querySelector('.wb-clock-actions .wb-action').textContent==='继续专注'})()`)
  await click('.wb-clock-actions .wb-action')
  // Advance wall time only in the isolated browser, then restore it before rest.
  await evaluate('window.__focusRealNow=Date.now;Date.now=()=>window.__focusRealNow()+2100000;document.dispatchEvent(new Event("visibilitychange"));true')
  await wait('document.querySelector(".wb-clock").textContent==="00:00"')
  await evaluate('Date.now=window.__focusRealNow;delete window.__focusRealNow;true')
  await check('round completion notifies and waits for a manual choice', 'document.querySelector(".wb-clock-actions .wb-action").textContent==="休息 5 分钟"&&document.querySelector(".home-notification").textContent.includes("专注结束")')
  assert.equal((await rows())[0].status,'doing','finishing a timer cannot complete a task')
  await click('.wb-clock-actions .wb-action')
  await check('rest begins only when requested', '(()=>{const t=JSON.parse(localStorage.getItem("astaria-focus-v1")),r=t.tasks[t.selectedTaskId];return r.mode==="rest"&&r.phase==="running"&&r.durationMs===300000})()')
  await click('.wb-xixi textarea'); await send('Input.insertText', { text: '误差分析如何开始' })
  await click('.wb-clock-actions .wb-secondary')
  await wait('!!document.querySelector(".wb-finished")')
  assert.equal((await rows())[0].status, 'done')
  await check('manual completion stays in the completed focus state with task context', 'document.querySelector(".wb-finished").textContent.includes("选择下一项")&&document.activeElement.matches(".wb-focus-main h2")&&document.querySelector(".wb-xixi textarea").value==="误差分析如何开始"')
  await click('.wb-finished .wb-action'); await wait('!!document.querySelector(".wb-chooser")')
  await check('completed items are retained in a collapsed section', '!!document.querySelector(".wb-completed")&&!document.querySelector(".wb-completed").open&&!document.querySelector(".wb-task")')
  await click('.wb-toolbar .wb-tool'); await wait('!!document.querySelector(".wb-task")')
  for (const [width,height] of [[900,700],[748,700],[390,844],[320,568],[844,390]]) {
    await send('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false }); await delay(200)
    await check(`task selection fits ${width}x${height}`, '(()=>{const c=document.querySelector(".wb-container").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth&&document.querySelector(".wb-scroll").scrollWidth<=innerWidth})()')
    await click('.wb-task[data-task-id="preview-reading"]'); await focus(); await delay(380)
    await check(`focus and Xixi fit ${width}x${height}`, '(()=>{const c=document.querySelector(".wb-focus-main").getBoundingClientRect(),x=document.querySelector(".wb-xixi").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth&&x.left>=0&&x.right<=innerWidth&&document.querySelector(".wb-scroll").scrollWidth<=innerWidth})()')
    await shot(`focus-${width}`)
    await click('.wb-back'); await wait('!!document.querySelector(".wb-chooser")')
  }
  await send('Emulation.setDeviceMetricsOverride', { width:1440,height:900,deviceScaleFactor:1,mobile:false })
  await send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] })
  await evaluate('document.querySelector(".wb-task").focus()'); await key('Enter'); await focus()
  await check('keyboard selection honors reduced motion and lands on focus heading', 'document.activeElement.matches(".wb-focus-main h2")&&parseFloat(getComputedStyle(document.querySelector(".wb-focus-main .wb-glass-content")).animationDuration)<.001')
  assert.equal(errors.length,0,'no runtime exceptions')
  checks.push({name:'no runtime exceptions',pass:true})
} catch(error) { failure=String(error); throw error }
finally {
  await fs.writeFile(new URL('browser-checks.json', output),JSON.stringify({url,checks,errors,failure},null,2))
  console.log(JSON.stringify({passed:checks.filter(c=>c.pass).length,checks:checks.filter(c=>!c.pass),failure},null,2))
  ws.close()
}
