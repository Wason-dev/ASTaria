/** Run against a dedicated temporary Chrome profile on 9233, never the user's browser. */
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const url = process.env.HOME_TEST_URL ?? 'http://127.0.0.1:5188/'
const production = process.env.WORKBENCH_PRODUCTION === '1'
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
  const selector = `.home-menu li:nth-child(${index}) button`
  const page = index === 1 ? 'home' : 'workbench'
  // Let the previous page finish restoring focus, and leave the hover surface
  // before opening it with the keyboard. Otherwise its pending blur can close it.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await cameraSettled()
  await evaluate('document.querySelector(".home-brand").focus({preventScroll:true})')
  if (await evaluate('document.querySelector(".home-menu").inert')) await key('Enter')
  await wait(`(async()=>{
    const menu=document.querySelector('.home-menu'),list=menu.querySelector('.home-menu-list'),button=document.querySelector(${JSON.stringify(selector)});
    if(menu.inert||menu.dataset.open!=='true'||getComputedStyle(menu).visibility!=='visible'||getComputedStyle(list).opacity!=='1'||menu.getAnimations({subtree:true}).some(a=>a.playState==='running')) return false;
    const first=button.getBoundingClientRect();
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const last=button.getBoundingClientRect(),hit=document.elementFromPoint(last.x+last.width/2,last.y+last.height/2);
    return !menu.inert&&last.width>0&&last.height>0&&Math.abs(first.x-last.x)<.1&&Math.abs(first.y-last.y)<.1&&button.contains(hit);
  })()`)
  await click(selector)
  await wait(`document.querySelector('.home-workspace').dataset.page===${JSON.stringify(page)}&&${page === 'workbench'
    ? '!document.querySelector(".workbench").inert&&document.querySelector(".workbench").dataset.active==="true"&&getComputedStyle(document.querySelector(".wb-scroll")).opacity==="1"'
    : '!document.querySelector(".home-scene-ui").inert&&getComputedStyle(document.querySelector(".home-scene-ui")).opacity==="1"&&getComputedStyle(document.querySelector(".workbench")).visibility==="hidden"'}`)
}
const focus = () => wait('document.querySelector(".workbench").dataset.active==="true"&&!document.querySelector(".workbench").inert&&!!document.querySelector(".wb-clock")&&!document.querySelector(".wb-stage").inert&&document.activeElement.matches(".wb-focus-main h2")')
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
  await check('workbench keeps the background clear with the approved zero-blur setting', 'getComputedStyle(document.querySelector(".wb-background")).backdropFilter==="blur(0px)"&&[".workbench",".wb-scroll",".home-workspace",".p0-universe"].every(s=>getComputedStyle(document.querySelector(s)).filter==="none"&&getComputedStyle(document.querySelector(s)).backdropFilter==="none")')
  await check('empty briefing stays factual and labels local advice', 'document.querySelector(".wb-brief-source").textContent==="本地建议"&&[...document.querySelectorAll(".wb-today-metrics dd")].every(e=>e.textContent==="0")&&!document.querySelector(".wb-brief [data-focus-origin]")')
  if (production) {
    await evaluate('localStorage.setItem("astaria-workbench-appearance-v2",JSON.stringify({width:1100,font:16,completed:false}));true')
    await send('Page.reload', { ignoreCache: true }); await ready(); await menu(2)
    await check('production removes visual customization and sample entry points', '!document.querySelector(".wb-toolbar button")&&!document.querySelector(".wb-customize")&&!document.querySelector(".wb-preview-label")')
    await check('production ignores previously saved development appearance', 'document.querySelector(".wb-container").getBoundingClientRect().width===1100&&getComputedStyle(document.querySelector(".workbench")).fontSize==="12px"&&!!document.querySelector(".wb-completed")')
    await click('.wb-bottom-note button')
    await setRange('input[aria-label="专注分钟"]', 40)
    await check('timer duration adjustment remains a production function', 'document.querySelector(".wb-bottom-note").textContent.includes("40 分钟专注")&&document.querySelector(".wb-duration-reveal").dataset.open==="true"')
    await check('production retains Upcoming inside workbench without a separate navigation item', 'document.querySelector(".workbench").dataset.active==="true"&&document.querySelector(".wb-deadlines").textContent.includes("暂时没有明确的截止日期")')
  } else {
  await click('.wb-toolbar .wb-tool')
  await wait('document.querySelectorAll(".wb-available .wb-task").length===5')
  await delay(550)
  await check('sample preview uses chosen geometry and glass without touching the database', '(()=>{const c=document.querySelector(".wb-container").getBoundingClientRect(),b=document.querySelector(".wb-task").getBoundingClientRect(),s=getComputedStyle(document.querySelector(".wb-task .home-glass-surface"));return c.width===1100&&b.height===96&&Number(s.getPropertyValue("--glass-tint"))===0&&Number(s.getPropertyValue("--glass-rim"))===.5&&Number(s.getPropertyValue("--glass-shadow"))===.25&&getComputedStyle(document.querySelector(".workbench")).fontSize==="12px"})()')
  await check('desktop briefing glass aligns with the first task glass', '(()=>{const a=document.querySelector(".wb-brief").getBoundingClientRect(),b=document.querySelector(".wb-task").getBoundingClientRect();return a.right<b.left&&Math.abs(a.top-b.top)<1})()')
  await check('desktop Upcoming uses two readable columns across the full workspace', '(()=>{const grid=document.querySelector(".wb-ddl-grid"),rows=grid.querySelectorAll(".wb-ddl-item"),a=rows[0].getBoundingClientRect(),b=rows[1].getBoundingClientRect(),t=document.querySelector(".wb-overview-layout").getBoundingClientRect();return getComputedStyle(grid).gridTemplateColumns.split(" ").length===2&&Math.abs(a.top-b.top)<1&&a.right<b.left&&a.width>300&&Math.abs(grid.getBoundingClientRect().left-t.left)<1})()')
  assert.equal((await rows()).length, 0)
  await check('later and completed sections stay expanded', 'document.querySelectorAll(".wb-later .wb-task").length===2&&document.querySelectorAll(".wb-completed-row").length===1&&!document.querySelector(".workbench details")')
  await check('Upcoming includes overdue, imminent and future dates with explicit timing', 'document.querySelectorAll(".wb-ddl-item").length>=5&&!!document.querySelector(".wb-ddl-item[data-urgency=overdue]")&&!!document.querySelector(".wb-ddl-item[data-urgency=upcoming]")&&document.querySelector("[data-deadline-id=preview-reading] time").textContent.includes("全天")&&/\\d{2}:\\d{2}/.test(document.querySelector("[data-deadline-id=preview-physics] time").textContent)')
  await check('urgency has progressively stronger type weight and color', '(()=>{const a=getComputedStyle(document.querySelector("[data-urgency=overdue] .wb-ddl-countdown")),b=getComputedStyle(document.querySelector("[data-urgency=urgent] .wb-ddl-countdown")),c=getComputedStyle(document.querySelector("[data-urgency=upcoming] .wb-ddl-countdown"));return parseFloat(a.fontSize)>parseFloat(b.fontSize)&&parseFloat(b.fontSize)>parseFloat(c.fontSize)&&+a.fontWeight>+b.fontWeight&&+b.fontWeight>+c.fontWeight&&a.color!==b.color&&b.color!==c.color})()')
  await shot('chooser-1440')
  await check('briefing recommendation matches the task ordering and exposes actual totals', 'document.querySelector(".wb-brief-start").dataset.focusOrigin==="brief-"+document.querySelector(".wb-task[data-recommended=true]").dataset.taskId&&document.querySelector(".wb-today-metrics dd").textContent==="5"&&document.querySelector(".wb-brief-source").textContent==="示例 · 本地建议"')
  await click('.wb-brief .wb-reason-toggle')
  await check('briefing evidence expands accessibly with an animated layout', '(()=>{const t=document.querySelector(".wb-brief .wb-reason-toggle"),r=document.getElementById(t.getAttribute("aria-controls"));return t.getAttribute("aria-expanded")==="true"&&!r.inert&&getComputedStyle(r).transitionProperty.includes("grid-template-rows")&&r.textContent.includes("原预计")&&r.textContent.includes("未计入课表")})()')
  await shot('briefing-evidence-1440')
  await key('Escape')
  await check('closing evidence makes hidden content inert while it animates out', 'document.querySelector(".wb-brief .wb-insight-reveal").inert&&document.querySelector(".wb-brief .wb-insight-reveal").getAttribute("aria-hidden")==="true"')
  await click('.wb-brief-start'); await focus()
  await check('briefing action enters the chosen task without changing its timer setting', 'document.querySelector(".wb-focus-main h2").textContent==="补交社团活动记录"&&document.querySelector(".wb-clock").textContent==="35:00"')
  await click('.wb-back'); await wait('document.activeElement.matches(".wb-brief-start")')
  await check('returning from a briefing recommendation restores its visible source', 'document.activeElement.dataset.focusOrigin==="brief-preview-overdue"&&document.activeElement.getBoundingClientRect().top>=document.querySelector(".wb-scroll").getBoundingClientRect().top')
  await click('.wb-ddl-item[data-urgency=overdue] .wb-reason-toggle')
  await check('deadline evidence separates estimates and actual effort without nested buttons', '(()=>{const r=document.querySelector(".wb-ddl-item[data-urgency=overdue]");return !r.querySelector("button button")&&r.querySelector(".wb-ddl-effort").textContent.includes("原预计 15 分钟")&&!r.querySelector(".wb-insight-reveal").inert&&r.querySelector(".wb-insight-reveal").textContent.includes("尚未记录专注")})()')
  await key('Escape')
  await check('Xixi related tasks stay visible without disclosure controls', 'document.querySelectorAll(".wb-watch-related button").length>0&&!document.querySelector(".wb-watch .wb-insight-reveal")&&!document.querySelector(".wb-watch .wb-reason-toggle")&&[...document.querySelectorAll(".wb-watch-related button")].every(b=>!b.closest("[inert]")&&getComputedStyle(b).visibility==="visible")')
  const noticeOrigin = await evaluate('document.querySelector(".wb-watch-related button").dataset.focusOrigin')
  await click('.wb-watch-related button'); await focus()
  await click('.wb-back'); await wait(`document.activeElement.dataset.focusOrigin===${JSON.stringify(noticeOrigin)}`)
  await check('return from a notice restores its original visible task button', `(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),s=document.querySelector('.wb-scroll').getBoundingClientRect();return e.dataset.focusOrigin===${JSON.stringify(noticeOrigin)}&&e.matches('.wb-watch-related button')&&!e.closest('[inert]')&&r.top>=s.top-1&&r.bottom<=s.bottom+1})()`)
  await click('.wb-customize-trigger')
  await check('customization opens a labelled dialog with live parameter controls', 'document.querySelector(".wb-customize").open&&document.querySelectorAll(".wb-adjustment input").length===12')
  await setRange('input[aria-label="背景磨砂"]', 7)
  await check('backdrop blur can be tuned independently from the glass material', 'getComputedStyle(document.querySelector(".wb-background")).backdropFilter.includes("blur(")&&getComputedStyle(document.querySelector(".workbench")).getPropertyValue("--wb-backdrop-blur")==="7px"&&JSON.parse(localStorage.getItem("astaria-workbench-appearance-v2")).blur===0')
  await setRange('.wb-adjustment input', 940)
  await check('changing appearance updates the live workspace and persists parameters', 'document.querySelector(".wb-container").getBoundingClientRect().width===940&&JSON.parse(localStorage.getItem("astaria-workbench-appearance-v2")).width===940')
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
  await click('[data-deadline-id="preview-overdue"]'); await focus()
  await check('a deadline opens the same focus flow without starting its timer', 'document.querySelector(".wb-focus-main h2").textContent==="补交社团活动记录"&&document.querySelector(".wb-clock-actions .wb-action").textContent==="开始专注"')
  await click('.wb-back'); await wait('document.activeElement.dataset.deadlineId==="preview-overdue"')
  await check('deadline focus returns to Upcoming inside workbench', '!!document.querySelector(".wb-chooser")&&document.activeElement.dataset.deadlineId==="preview-overdue"')
  await click('[data-deadline-id="preview-overdue"]'); await focus()
  await click('.wb-clock-actions .wb-secondary'); await wait('!!document.querySelector(".wb-finished")')
  await click('.wb-finished .wb-action'); await wait('!!document.querySelector(".wb-chooser")')
  await check('completed deadlines leave Upcoming and remain in the expanded history', '!document.querySelector("[data-deadline-id=preview-overdue]")&&!document.querySelector("[data-task-id=preview-overdue]")&&document.querySelector(".wb-completed-row[data-recent=true]").textContent.includes("补交社团活动记录")')
  await click('.wb-toolbar .wb-tool')
  await wait('!document.querySelector(".wb-preview-label")')
  await check('preview settings and task state never mutate real records', 'JSON.parse(localStorage.getItem("astaria-focus-v1")).durations.focusMin===35&&document.querySelector(".wb-empty").textContent.includes("暂时没有")')
  await click('.wb-empty .wb-action')
  await wait('document.activeElement.id==="home-compose"')
  await check('home capture retains black theme and expanded 680 by 460 glass', 'document.querySelector(".p0").dataset.night==="true"&&document.querySelector(".home-launch").textContent==="交给析熙"&&document.querySelector(".home-morph").getBoundingClientRect().width===680&&document.querySelector(".home-morph").getBoundingClientRect().height===460')
  await check('returning home fully hides the workbench backdrop', 'getComputedStyle(document.querySelector(".wb-background")).opacity==="0"&&getComputedStyle(document.querySelector(".workbench")).visibility==="hidden"')
  await send('Input.insertText', { text: '复核实验报告\n先把需要核对的数据列出来' })
  await click('.home-capture'); await wait('document.querySelectorAll(".home-receipt").length===1')
  await menu(2); await wait('document.querySelectorAll(".wb-task").length===1')
  await click('.wb-task'); await focus()
  await click('.wb-clock-actions .wb-action')
  await wait('document.querySelector(".wb-clock-actions .wb-action").textContent==="暂停"')
  assert.equal((await rows())[0].status, 'doing')
  await click('.wb-back'); await wait('!!document.querySelector(".wb-chooser")')
  await check('returning to task selection pauses the active timer', '(()=>{const t=JSON.parse(localStorage.getItem("astaria-focus-v1"));return t.tasks[t.selectedTaskId].phase==="paused"&&!!document.querySelector(".wb-chooser")})()')
  await click('.wb-task'); await focus(); await click('.wb-clock-actions .wb-action')
  await delay(1150)
  await menu(1)
  await check('leaving workbench pauses the real task and restores the home action', '(()=>{const t=JSON.parse(localStorage.getItem("astaria-focus-v1"));return t.tasks[t.selectedTaskId].phase==="paused"&&document.querySelector(".home-launch").textContent==="交给析熙"&&document.querySelector(".p0").dataset.night==="true"})()')
  const paused = await timer()
  await delay(500)
  await menu(2)
  await check('returning to focus preserves elapsed time without restarting', `(()=>{const t=JSON.parse(localStorage.getItem('astaria-focus-v1'));return document.querySelector('.workbench').dataset.active==='true'&&!document.querySelector('.workbench').inert&&t.tasks[t.selectedTaskId].elapsedMs===${paused.tasks[paused.selectedTaskId].elapsedMs}&&document.querySelector('.wb-clock-actions .wb-action').textContent==='继续专注'})()`)
  await wait('document.querySelector(".workbench").dataset.active==="true"&&!document.querySelector(".wb-stage").inert&&getComputedStyle(document.querySelector(".wb-scroll")).opacity==="1"')
  await click('.wb-clock-actions .wb-action')
  await wait('(()=>{const t=JSON.parse(localStorage.getItem("astaria-focus-v1"));return document.querySelector(".wb-clock-actions .wb-action").textContent==="暂停"&&t.tasks[t.selectedTaskId].phase==="running"})()')
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
  await check('completed items remain visible with completion timing', '!!document.querySelector(".wb-completed-row time")&&!document.querySelector(".workbench details")&&!document.querySelector(".wb-task")')
  await click('.wb-toolbar .wb-tool'); await wait('!!document.querySelector(".wb-task")')
  for (const [width,height] of [[900,700],[748,700],[390,844],[320,568],[844,390]]) {
    await send('Emulation.setDeviceMetricsOverride', { width,height,deviceScaleFactor:1,mobile:false }); await delay(200)
    await check(`task selection fits ${width}x${height}`, '(()=>{const c=document.querySelector(".wb-container").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth&&document.querySelector(".wb-scroll").scrollWidth<=innerWidth})()')
    await check(`Upcoming fits ${width}x${height}`, '(()=>{const c=document.querySelector(".wb-deadlines").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth})()')
    await check(`related tasks remain unfolded at ${width}x${height}`, '[...document.querySelectorAll(".wb-watch-related button")].every(b=>!b.closest("[inert]")&&getComputedStyle(b).visibility==="visible")&&!document.querySelector(".wb-watch .wb-reason-toggle")')
    if (width === 900) {
      await check('900px layout preserves aligned glass and two deadline columns', '(()=>{const a=document.querySelector(".wb-brief").getBoundingClientRect(),b=document.querySelector(".wb-task").getBoundingClientRect(),g=document.querySelector(".wb-ddl-grid"),r=g.querySelector(".wb-ddl-item").getBoundingClientRect();return a.right<b.left&&Math.abs(a.top-b.top)<1&&getComputedStyle(g).gridTemplateColumns.split(" ").length===2&&r.width>=250})()')
    }
    if (width === 390) {
      await check('390px layout stacks deadlines without compressing their text', 'getComputedStyle(document.querySelector(".wb-ddl-grid")).gridTemplateColumns.split(" ").length===1&&document.querySelector(".wb-ddl-item").getBoundingClientRect().width>=300')
    }
    await evaluate('document.querySelector(".wb-scroll").scrollTo({top:0});true'); await delay(380)
    await shot(`chooser-${width}`)
    if (width <= 760) {
      await check(`compact deadline summary is immediately visible at ${width}x${height}`, '(()=>{const e=document.querySelector(".wb-ddl-compact"),r=e.getBoundingClientRect(),s=document.querySelector(".wb-scroll").getBoundingClientRect();return getComputedStyle(e).display!=="none"&&r.top>=s.top&&r.bottom<=s.bottom&&e.textContent.includes("逾期")})()')
      await click('.wb-ddl-compact'); await wait('document.activeElement.id==="wb-ddl-heading"'); await delay(450)
      await check(`compact summary reveals the first deadline below its heading at ${width}x${height}`, '(()=>{const r=document.activeElement.getBoundingClientRect(),s=document.querySelector(".wb-scroll").getBoundingClientRect(),b=document.querySelector(".wb-ddl-item button").getBoundingClientRect();return r.top>=s.top-1&&r.bottom<=s.bottom+1&&b.top>=r.bottom&&b.bottom<=s.bottom+1})()')
      await shot(`upcoming-${width}`)
    }
    await click('.wb-task[data-task-id="preview-reading"]'); await focus(); await delay(380)
    await check(`focus and Xixi fit ${width}x${height}`, '(()=>{const c=document.querySelector(".wb-focus-main").getBoundingClientRect(),x=document.querySelector(".wb-xixi").getBoundingClientRect();return c.left>=0&&c.right<=innerWidth&&x.left>=0&&x.right<=innerWidth&&document.querySelector(".wb-scroll").scrollWidth<=innerWidth})()')
    await shot(`focus-${width}`)
    await click('.wb-back'); await wait('!!document.querySelector(".wb-chooser")')
    await click('[data-deadline-id="preview-week"]'); await focus()
    await click('.wb-back'); await wait('document.activeElement.dataset.deadlineId==="preview-week"')
    await check(`returning to a deadline keeps keyboard focus visible at ${width}x${height}`, '(()=>{const r=document.activeElement.getBoundingClientRect(),s=document.querySelector(".wb-scroll").getBoundingClientRect();return r.top>=s.top-1&&r.bottom<=s.bottom+1})()')
  }
  await send('Emulation.setDeviceMetricsOverride', { width:1440,height:900,deviceScaleFactor:1,mobile:false })
  await send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] })
  await evaluate('document.querySelector(".wb-task").focus()'); await key('Enter'); await focus()
  await check('keyboard selection honors reduced motion and lands on focus heading', 'document.activeElement.matches(".wb-focus-main h2")&&parseFloat(getComputedStyle(document.querySelector(".wb-focus-main .wb-glass-content")).animationDuration)<.001')
  }
  assert.equal(errors.length,0,'no runtime exceptions')
  checks.push({name:'no runtime exceptions',pass:true})
} catch(error) { failure=String(error); throw error }
finally {
  await fs.writeFile(new URL(production ? 'production-checks.json' : 'browser-checks.json', output),JSON.stringify({url,checks,errors,failure},null,2))
  console.log(JSON.stringify({passed:checks.filter(c=>c.pass).length,checks:checks.filter(c=>!c.pass),failure},null,2))
  ws.close()
}
