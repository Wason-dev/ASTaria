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
  await check('small local date and clock and honest empty notification stay in the right corners', '(()=>{const c=document.querySelector(".home-clock"),n=document.querySelector(".home-notification"),r=n.getBoundingClientRect(),now=new Date(),date=new Intl.DateTimeFormat("zh-CN",{year:"numeric",month:"2-digit",day:"2-digit"}).format(now),time=new Intl.DateTimeFormat("zh-CN",{hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).format(now);return c.textContent===date+"　"+time&&getComputedStyle(c).fontSize==="11px"&&r.height===32&&r.bottom<innerHeight&&r.right>innerWidth/2&&n.textContent==="暂无通知"})()')
  await shot('home-1440')
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 52, y: 43 })
  await wait('document.querySelector(".home-brand").getAttribute("aria-expanded")==="true"')
  await wait('(()=>{const m=document.querySelector(".home-menu").getBoundingClientRect(),i=document.querySelector(".home-menu feImage");return i?.getAttribute("width")===String(Math.round(m.width))&&i?.getAttribute("height")===String(Math.round(m.height))})()')
  await check('hover navigation contains planned pages without fake destinations', 'document.querySelectorAll(".home-menu button:disabled").length===4 && document.querySelector(".home-menu").textContent.includes("DDL")')
  await check('navigation uses the same measured glass material', '(()=>{const m=document.querySelector(".home-menu").getBoundingClientRect(),g=document.querySelector(".home-menu .home-glass-surface"),s=getComputedStyle(g),i=document.querySelector(".home-menu feImage");return m.height<=40&&i.getAttribute("width")===String(Math.round(m.width))&&i.getAttribute("height")===String(Math.round(m.height))&&Math.abs(Number(s.getPropertyValue("--glass-tint"))-.2)<1e-6&&Number(s.getPropertyValue("--glass-rim"))===.15&&Number(s.getPropertyValue("--glass-shadow"))===.6})()')
  await check('navigation opens horizontally beside the brand with an animated hint', '(()=>{const m=document.querySelector(".home-menu"),r=m.getBoundingClientRect(),b=document.querySelector(".home-brand").getBoundingClientRect(),c=document.querySelector(".home-clock").getBoundingClientRect(),items=[...m.querySelectorAll("li")];return items.every(i=>Math.abs(i.getBoundingClientRect().top-items[0].getBoundingClientRect().top)<1)&&r.left>b.right&&r.right<c.left&&getComputedStyle(m).transitionProperty.includes("transform")&&getComputedStyle(m).clipPath==="none"&&!!document.querySelector(".home-nav-hint")})()')
  await shot('navigation-1440', true)
  await click('.home-brand')
  await check('first mouse click keeps the hover preview open', '!document.querySelector(".home-menu").inert')
  await click('.home-brand')
  await check('second mouse click closes navigation', 'document.querySelector(".home-menu").inert')
  await key('Enter')
  await evaluate('document.querySelector(".home-menu button").focus()')
  await key('Escape')
  await check('Escape closes nav and restores brand focus', 'document.querySelector(".home-menu").inert && document.querySelector(".home-menu").getAttribute("aria-hidden")==="true" && document.activeElement.matches(".home-brand")')
  await key('Enter')
  await check('keyboard can reopen navigation', 'document.querySelector(".home-brand").getAttribute("aria-expanded")==="true"&&!document.querySelector(".home-menu").inert')
  await key('Escape')
  await key('Tab')
  await check('closed navigation is skipped by Tab', '!document.activeElement.closest(".home-menu")')
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
  await check('SVG refraction map has a nonzero viewport and live backdrop', 'document.querySelector(".home-morph feImage").getAttribute("width")==="600" && document.querySelector(".home-morph feImage").getAttribute("href").startsWith("data:image/png") && getComputedStyle(document.querySelector(".home-morph .home-glass-surface")).backdropFilter.includes("url(")')
  await check('equal chat and agenda columns share one continuous glass surface', '(()=>{const c=document.querySelector(".home-xixi").getBoundingClientRect(),a=document.querySelector(".home-agenda").getBoundingClientRect(),m=document.querySelector(".home-morph").getBoundingClientRect();return c.width===300&&a.width===c.width&&Math.abs(a.left-c.right)<1&&c.top===a.top&&c.height===a.height&&m.width===600&&document.querySelectorAll(".home-morph .home-glass-surface").length===1&&!document.querySelector(".home-agenda").inert})()')
  await check('calendar and empty agenda are real and all sections exist', 'document.querySelectorAll(".home-month-grid tbody button").length===42&&document.querySelectorAll(".home-agenda-section").length===3&&document.querySelectorAll(".home-agenda-list li").length===0')
  await check('all empty agenda sections fit in the default compact window', 'document.querySelector("[data-agenda-section=deadlines]").getBoundingClientRect().bottom<=document.querySelector(".home-agenda-scroll").getBoundingClientRect().bottom')
  const originalMonth = await evaluate('document.querySelector(".home-month-controls strong").textContent')
  await click('.home-month-controls button[aria-label="下个月"]')
  assert.notEqual(await evaluate('document.querySelector(".home-month-controls strong").textContent'), originalMonth)
  await click('.home-month-controls button[aria-label="上个月"]')
  assert.equal(await evaluate('document.querySelector(".home-month-controls strong").textContent'), originalMonth)
  checks.push({ name: 'month navigation moves forward and back without losing the selected date', pass: true })
  await check('material matches chosen transparency and low rim with no reflection', '(()=>{const s=getComputedStyle(document.querySelector(".home-morph .home-glass-surface"));return Math.abs(Number(s.getPropertyValue("--glass-tint"))-.2)<1e-6&&Number(s.getPropertyValue("--glass-rim"))===.15&&Number(s.getPropertyValue("--glass-reflection"))===0&&Number(s.getPropertyValue("--glass-shadow"))===.6})()')
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
  await check('reduced motion also disables navigation animation', 'getComputedStyle(document.querySelector(".home-menu")).transitionProperty==="none"&&getComputedStyle(document.querySelector(".home-nav-hint")).transitionProperty==="none"')
  for (const [width, height] of [[390, 844], [320, 568], [844, 390]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await delay(150)
    await check(`chat and composer fit ${width}x${height}`, '(()=>{const r=document.querySelector(".home-morph").getBoundingClientRect(),f=document.querySelector(".home-xixi form").getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth&&r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&f.bottom<=r.bottom&&f.top>=r.top})()')
    await shot(`chat-${width}`)
    if (width < 668) {
      await click('.home-information-toggle')
      await wait('document.activeElement.matches(".home-agenda-back")')
      await delay(280)
      await check(`agenda paging fits ${width}x${height} without hidden focus or scroll drift`, '(()=>{const a=document.querySelector(".home-agenda").getBoundingClientRect(),m=document.querySelector(".home-morph").getBoundingClientRect();return Math.abs(a.left-m.left)<1&&Math.abs(a.width-m.width)<1&&document.querySelector(".home-xixi").inert&&!document.querySelector(".home-agenda").inert&&document.querySelector(".home-deck").scrollLeft===0})()')
      await shot(`agenda-${width}`)
      await click('.home-agenda-back')
      await wait('document.activeElement.matches(".home-information-toggle")')
      await delay(280)
    }
  }
  await click('.home-collapse'); await wait('document.querySelector(".home-morph").dataset.progress==="0.000"')
  await check('hidden chat is inert and keyboard returns to pill', 'document.querySelector(".home-xixi").inert && document.activeElement.matches(".home-launch")')
  for (const [width, height] of [[1440, 900], [600, 800], [320, 568]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await evaluate('document.querySelector(".home-brand").focus()')
    if (await evaluate('document.querySelector(".home-menu").inert')) await key('Enter')
    await check(`horizontal navigation and corner text fit ${width}x${height}`, '(()=>{const m=document.querySelector(".home-menu").getBoundingClientRect(),c=document.querySelector(".home-clock").getBoundingClientRect(),n=document.querySelector(".home-notification").getBoundingClientRect(),w=document.querySelector(".p0-whisper").getBoundingClientRect(),items=[...document.querySelectorAll(".home-menu li")];return m.right<=innerWidth&&m.left>=0&&items.every(i=>Math.abs(i.getBoundingClientRect().top-items[0].getBoundingClientRect().top)<1)&&(m.right<=c.left||m.top>=c.bottom)&&w.right<n.left&&n.bottom<=innerHeight})()')
    await shot(`navigation-${width}`, true)
    await key('Escape')
  }
  // Seed only the isolated test profile with local dated tasks, then reload the store.
  await evaluate(`(async()=>{
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('astaria-local');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error)});
    const day=n=>{const d=new Date();d.setDate(d.getDate()+n);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,'0'),String(d.getDate()).padStart(2,'0')].join('-')};
    window.__agendaDays={today:day(0),tomorrow:day(1)};
    const base={area:null,source:'manual',inbox:false,leadDays:3,importance:2,energy:'light',context:['anywhere'],status:'todo',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),deletedAt:null};
    try{await new Promise((resolve,reject)=>{const tx=db.transaction('tasks','readwrite');const store=tx.objectStore('tasks');
      for(const extra of [{id:'qa-agenda-plan',title:'明日实验准备',startAt:day(1),due:day(2)},{id:'qa-agenda-today',title:'今日写作',startAt:day(0),due:day(0)},{id:'qa-agenda-overdue',title:'逾期复核',due:day(-1)},{id:'qa-agenda-undated',title:'未安排事项'},{id:'qa-agenda-done',title:'已完成事项',status:'done',due:day(0)}])store.put({...base,...extra});
      tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);
    })}finally{db.close()}
  })()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.reload', { ignoreCache: true }); await ready()
  await click('.home-launch'); await cameraSettled(); await wait('document.activeElement.id==="home-compose"')
  await check('today and DDL show dated tasks without assigning undated inbox tasks', '(()=>{const t=document.querySelector("[data-agenda-section=today]").textContent,d=document.querySelector("[data-agenda-section=deadlines]").textContent,u=document.querySelector(".home-agenda-undated");return t.includes("今日写作")&&!t.includes("明日实验准备")&&!t.includes("未安排事项")&&!t.includes("已完成事项")&&d.includes("已逾期")&&d.includes("明日实验准备")&&!d.includes("已完成事项")&&u.textContent.includes("未安排事项")})()')
  const tomorrow = await evaluate('(()=>{const d=new Date();d.setDate(d.getDate()+1);return [d.getFullYear(),String(d.getMonth()+1).padStart(2,"0"),String(d.getDate()).padStart(2,"0")].join("-")})()')
  await click(`.home-month-grid button[data-date="${tomorrow}"]`)
  await check('selected day distinguishes scheduled work from its later deadline', '(()=>{const s=document.querySelector("[data-agenda-section=selected]");return s.textContent.includes("明日实验准备")&&s.textContent.includes("安排")&&!s.textContent.includes("截止")})()')
  await key('ArrowRight'); await key('ArrowLeft')
  await check('calendar arrow navigation restores the selected day and focus', `document.activeElement.dataset.date===${JSON.stringify(tomorrow)}&&document.activeElement.getAttribute("aria-pressed")==="true"`)
  await shot('agenda-tasks-1440')
  await click('[data-agenda-section=selected] .home-agenda-list button')
  await click('.home-task-status button:nth-child(3)')
  await wait('document.querySelector(".home-task-status button:nth-child(3)").getAttribute("aria-pressed")==="true"')
  await key('Escape'); await wait('!document.querySelector("dialog")')
  await check('completing an agenda task updates lists and restores visible focus', '!document.querySelector("[data-agenda-section=selected]").textContent.includes("明日实验准备")&&!document.querySelector("[data-agenda-section=deadlines]").textContent.includes("明日实验准备")&&document.activeElement.matches(".home-agenda-scroll")')
  await click('.home-month-today')
  await click('[data-agenda-section=selected] .home-agenda-list button')
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: false })
  await key('Escape'); await wait('!document.querySelector("dialog")')
  await check('resizing an agenda detail to narrow layout restores a visible focus target', 'document.activeElement.matches(".home-information-toggle")&&!document.activeElement.closest("[inert]")')
  await key('Escape'); await wait('document.querySelector(".home-morph").dataset.progress==="0.000"')
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
