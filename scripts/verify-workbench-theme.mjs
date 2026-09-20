/** Use only the dedicated temporary Chrome profile on 9233, never the user's browser. */
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'

const url = process.env.HOME_TEST_URL ?? 'http://127.0.0.1:5188/'
const production = process.env.WORKBENCH_PRODUCTION === '1'
assert.ok(['127.0.0.1', 'localhost'].includes(new URL(url).hostname), 'Theme checks require a local preview')
const targets = await fetch('http://127.0.0.1:9233/json').then(response => response.json())
const target = targets.find(entry => entry.type === 'page')
assert.ok(target, 'Start dedicated test Chrome on port 9233')
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
const pending = new Map(), checks = [], errors = []
let serial = 0
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
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await evaluate(expression)) return
    await delay(80)
  }
  throw new Error(`Timed out: ${expression}`)
}
const check = async (name, expression) => {
  const pass = await evaluate(expression)
  checks.push({ name, pass })
  assert.equal(pass, true, name)
}
const click = async selector => {
  const encoded = JSON.stringify(selector)
  await evaluate(`document.querySelector(${encoded}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  await wait(`(async()=>{const e=document.querySelector(${encoded});if(!e||e.disabled||e.closest('[inert]')||getComputedStyle(e).visibility==='hidden')return false;const before=e.getBoundingClientRect();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&Math.abs(before.x-r.x)<.1&&Math.abs(before.y-r.y)<.1&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
  const point = await evaluate(`(()=>{const r=document.querySelector(${encoded}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(50)
}
const ready = () => wait('!!window.__ASTARIA_P0__&&!!document.querySelector(".home-current-title:not(:disabled)")')
const settled = selector => wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return !!e&&!e.getAnimations({subtree:true}).some(a=>a.playState==='running'&&Number.isFinite(a.effect.getComputedTiming().endTime))})()`)
const camera = () => evaluate(`(()=>{const s=window.__ASTARIA_P0__.getSnapshot();return Object.fromEntries(['zoom','roll','inclination','centerX','centerY','view'].map(key=>[key,s[key]]))})()`)
const appearance = 'JSON.parse(localStorage.getItem("astaria-workbench-appearance-v5"))'
const previewTimer = 'JSON.parse(localStorage.getItem("astaria-focus-preview-v1"))'
const openCustomization = async () => { await click('.wb-customize-trigger'); await wait('document.querySelector(".wb-customize")?.open'); await settled('.wb-customize') }
const closeCustomization = async () => { await click('.wb-customize [aria-label="关闭自定义"]'); await wait('!document.querySelector(".wb-customize")') }
// The running timer continually transitions its progress transform; only wait for palette changes.
const paletteSettled = () => wait(`!document.querySelector('.workbench').getAnimations({subtree:true}).some(a=>a.playState==='running'&&['color','background-color','border-color','box-shadow'].includes(a.transitionProperty))`)
const theme = async value => {
  await click(`.wb-theme-control button:${value === 'dark' ? 'last' : 'first'}-child`)
  await wait(`document.querySelector('.workbench').dataset.theme===${JSON.stringify(value)}&&document.querySelector('.p0').dataset.night===${JSON.stringify(String(value === 'dark'))}`)
  await paletteSettled()
}
const menu = async page => {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
  await evaluate('document.querySelector(".home-brand").focus({preventScroll:true});true')
  if (await evaluate('document.querySelector(".home-menu").inert')) {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  }
  await wait('document.querySelector(".home-menu").dataset.open==="true"&&!document.querySelector(".home-menu").inert')
  await settled('.home-menu')
  await click(`.home-menu li:nth-child(${page === 'home' ? 1 : 2}) button`)
  await wait(`document.querySelector('.home-workspace').dataset.page===${JSON.stringify(page)}`)
  await wait(page === 'workbench'
    ? '!document.querySelector(".workbench").inert&&getComputedStyle(document.querySelector(".wb-scroll")).opacity==="1"'
    : '!document.querySelector(".home-scene-ui").inert&&getComputedStyle(document.querySelector(".workbench")).visibility==="hidden"')
  await wait('!window.__ASTARIA_P0__.getSnapshot().cameraTransition')
}
const shot = async (name, keepPointer = false) => {
  if (!keepPointer) await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2 })
  await delay(220)
  await fs.writeFile(`/tmp/astaria-theme-${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
}
const setRange = (label, value) => evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(`input[aria-label="${label}"]`)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${value});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
const hover = async selector => {
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await wait(`getComputedStyle(document.querySelector(${JSON.stringify(`${selector} .wb-tooltip`)})).opacity==='1'`)
}

let failure
try {
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Page.bringToFront')
  await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Emulation.setEmulatedMedia', { features: [] })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: 'about:blank' }); await wait('location.href==="about:blank"')
  // The fixed CDP port belongs to the disposable QA profile. This never reaches the user browser.
  await send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb,local_storage' })
  await send('Page.navigate', { url }); await ready()
  await evaluate('sessionStorage.clear();true')
  await check('home always opens with the black-hole night theme', 'document.querySelector(".p0").dataset.night==="true"&&document.querySelector(".home-workspace").dataset.page==="home"')
  if (production) {
    await evaluate('localStorage.setItem("astaria-workbench-appearance-v5",JSON.stringify({theme:"light",font:16,blur:15,backgroundBlur:7}));true')
    await send('Page.reload', { ignoreCache: true }); await ready()
    await check('production home remains night despite a saved light workbench experiment', 'document.querySelector(".p0").dataset.night==="true"')
    await menu('workbench')
    await check('production ignores saved appearance and uses the approved dark workbench and black hole', 'document.querySelector(".workbench").dataset.theme==="dark"&&document.querySelector(".p0").dataset.night==="true"')
    await check('production exposes no customization controls', '!document.querySelector(".wb-customize-trigger,.wb-customize,.wb-theme-control")')
    await check('production ignores saved experimental background blur', 'getComputedStyle(document.querySelector(".wb-background")).backdropFilter==="blur(0px)"')
    await shot('production-dark')
  } else {
    await menu('workbench')
    await check('initial workbench uses the approved dark preset', 'document.querySelector(".workbench").dataset.theme==="dark"&&document.querySelector(".p0").dataset.night==="true"')
    await click('.wb-toolbar .wb-tool:not(.wb-customize-trigger)')
    await wait('document.querySelectorAll(".wb-task").length>0')
    await settled('.wb-chooser')
    await shot('dark-default-overview')
    const baselineCamera = await camera()
    await evaluate('window.__themeSceneCanvas=document.querySelector(".p0-universe canvas");true')
    await openCustomization()
    await check('customization exposes labelled light and dark pressed-state buttons', '(()=>{const b=[...document.querySelectorAll(".wb-theme-control button")];return b.length===2&&b[0].textContent==="浅色"&&b[1].textContent==="深色"&&b[0].getAttribute("aria-pressed")==="false"&&b[1].getAttribute("aria-pressed")==="true"})()')
    await theme('light')
    await shot('light-customize')
    await theme('dark')
    await check('dark overview and customization use legible light foregrounds', `['.wb-task-top strong','.wb-task-meta','.wb-brief-message h3','.wb-brief-message p','.wb-ddl-copy strong','.wb-ddl-node-date','.wb-customize'].every(selector=>{const e=document.querySelector(selector),channels=e&&getComputedStyle(e).color.match(/[0-9.]+/g);return channels&&channels.slice(0,3).every(channel=>Number(channel)>=140)})`)
    await check('dark mode changes only theme, preserving panel and background blur', `${appearance}.theme==='dark'&&${appearance}.blur===0&&${appearance}.backgroundBlur===0&&getComputedStyle(document.querySelector('.wb-background')).backdropFilter==='blur(0px)'`)
    await check('dark theme keeps the existing scene canvas', 'document.querySelector(".p0-universe canvas")===window.__themeSceneCanvas')
    assert.deepEqual(await camera(), baselineCamera, 'theme switch must preserve camera framing')
    checks.push({ name: 'theme switch preserves renderer camera framing', pass: true })
    await shot('dark-customize')
    await setRange('背景磨砂', 7)
    await wait("getComputedStyle(document.querySelector('.wb-background')).backdropFilter==='blur(7px)'")
    await check('background blur can change independently of the zero-blur glass material', `${appearance}.backgroundBlur===7&&${appearance}.blur===0&&+document.querySelector('.wb-briefing-panel feGaussianBlur').getAttribute('stdDeviation')===0`)
    await theme('light')
    await check('returning to light preserves independent blur choices', `${appearance}.theme==='light'&&${appearance}.backgroundBlur===7&&${appearance}.blur===0&&getComputedStyle(document.querySelector('.wb-background')).backdropFilter==='blur(7px)'`)
    await theme('dark')
    await setRange('背景磨砂', 0)
    await wait("getComputedStyle(document.querySelector('.wb-background')).backdropFilter==='blur(0px)'")
    await closeCustomization()
    await shot('dark-overview')
    await menu('home')
    await check('returning home stays black while retaining the dark workbench preference', `document.querySelector('.p0').dataset.night==='true'&&${appearance}.theme==='dark'`)
    await menu('workbench')
    await check('reentering workbench restores the selected dark theme', 'document.querySelector(".workbench").dataset.theme==="dark"&&document.querySelector(".p0").dataset.night==="true"')
    await send('Page.reload', { ignoreCache: true }); await ready()
    await check('refresh returns to black home without losing saved v5 dark preference', `document.querySelector('.home-workspace').dataset.page==='home'&&document.querySelector('.p0').dataset.night==='true'&&${appearance}.theme==='dark'`)
    await menu('workbench')
    await check('saved v5 dark preference and blur settings survive refresh', `document.querySelector('.workbench').dataset.theme==='dark'&&document.querySelector('.p0').dataset.night==='true'&&${appearance}.blur===0&&${appearance}.backgroundBlur===0`)
    await click('.wb-toolbar .wb-tool:not(.wb-customize-trigger)')
    await wait('!!document.querySelector(".wb-task[data-task-id=preview-reading]")')
    await click('.wb-task[data-task-id=preview-reading]')
    await wait('!!document.querySelector(".wb-clock")&&!document.querySelector(".wb-stage").inert&&document.activeElement.matches(".wb-focus-main h2")')
    await settled('.wb-focus')
    await click('.wb-input-textarea')
    await send('Input.insertText', { text: '保留这段上下文，先梳理论点' })
    await click('.wb-clock-actions .wb-action')
    await wait('document.querySelector(".wb-clock-actions .wb-action").textContent==="暂停"')
    await evaluate(`window.__themeFocus={heading:document.querySelector('.wb-focus-main h2'),input:document.querySelector('.wb-input-textarea'),clock:document.querySelector('.wb-clock'),draft:document.querySelector('.wb-input-textarea').value,state:${previewTimer},seconds:Number(document.querySelector('.wb-clock').getAttribute('aria-label').match(/[0-9]+/)[0])};true`)
    await openCustomization()
    for (const value of ['light', 'dark']) {
      await theme(value)
      await check(`${value} switch preserves selected task, draft, DOM nodes, and running session`, `(()=>{const before=window.__themeFocus,state=${previewTimer},id=before.state.selectedTaskId;return before.heading===document.querySelector('.wb-focus-main h2')&&before.input===document.querySelector('.wb-input-textarea')&&before.clock===document.querySelector('.wb-clock')&&before.input.value===before.draft&&state.selectedTaskId===id&&state.tasks[id].phase==='running'&&state.tasks[id].mode===before.state.tasks[id].mode&&state.tasks[id].durationMs===before.state.tasks[id].durationMs&&state.tasks[id].runningSince===before.state.tasks[id].runningSince&&document.querySelector('.wb-clock-actions .wb-action').textContent==='暂停'})()`)
    }
    await closeCustomization()
    await wait("Number(document.querySelector('.wb-clock').getAttribute('aria-label').match(/\\d+/)[0])<window.__themeFocus.seconds")
    await check('focus countdown continues after theme changes', "Number(document.querySelector('.wb-clock').getAttribute('aria-label').match(/\\d+/)[0])<window.__themeFocus.seconds&&document.querySelector('.wb-clock-actions .wb-action').textContent==='暂停'")
    assert.deepEqual(await camera(), baselineCamera, 'focus theme toggles must preserve camera framing')
    checks.push({ name: 'focus theme switches preserve renderer camera framing', pass: true })
    await shot('dark-focus')
    await click('.wb-clock-actions .wb-action')
    await check('pause still works after theme changes', `${previewTimer}.tasks['preview-reading'].phase==='paused'&&document.querySelector('.wb-clock-actions .wb-action').textContent==='继续专注'`)
    await check('dark focus and draft use legible light foregrounds', `['.wb-focus-main h2','.wb-xixi-body','.wb-input-textarea'].every(selector=>getComputedStyle(document.querySelector(selector)).color.match(/[0-9.]+/g).slice(0,3).every(channel=>Number(channel)>=140))`)
    await openCustomization()
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await theme('light'); await theme('dark')
    await check('reduced motion removes theme transitions', `matchMedia('(prefers-reduced-motion: reduce)').matches&&['.workbench','.workbench .home-glass-surface','.wb-customize','.wb-segment button','.wb-xixi-body'].every(selector=>getComputedStyle(document.querySelector(selector)).transitionDuration.split(',').every(value=>parseFloat(value)<.001))`)
    await closeCustomization()
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'forced-colors', value: 'active' }] })
    await wait("matchMedia('(forced-colors: active)').matches")
    await paletteSettled()
    await check('forced colors retains system Canvas and CanvasText in the Xixi input', `(()=>{const input=document.querySelector('.wb-input-textarea'),probe=document.createElement('span');probe.style.cssText='position:absolute;visibility:hidden;color:CanvasText;background:Canvas;forced-color-adjust:none';input.parentElement.append(probe);try{const expected=getComputedStyle(probe),actual=getComputedStyle(input),shell=getComputedStyle(input.parentElement);return actual.color===expected.color&&actual.backgroundColor===expected.backgroundColor&&shell.backgroundColor===expected.backgroundColor}finally{probe.remove()}})()`)
    await send('Emulation.setEmulatedMedia', { features: [] })
    await paletteSettled()
    for (const width of [900, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false })
      await wait("document.querySelector('.wb-container').getBoundingClientRect().right<=innerWidth")
      await settled('.wb-focus')
      await check(`dark focus fits the ${width}px viewport`, `['.wb-container','.wb-focus-main','.wb-xixi'].every(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})&&document.querySelector('.wb-scroll').scrollWidth<=innerWidth`)
      await evaluate("document.querySelector('.wb-scroll').scrollTo({top:0});true")
      await shot(`dark-focus-${width}`)
      await click('.wb-back')
      await wait('!!document.querySelector(".wb-chooser")')
      await settled('.wb-chooser')
      await wait('document.querySelector(".wb-deadlines").dataset.measured==="true"')
      await check(`dark overview fits the ${width}px viewport`, `['.wb-container','.wb-briefing-panel','.wb-deadlines','.wb-task-grid'].every(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1})&&document.querySelector('.wb-scroll').scrollWidth<=innerWidth&&[...document.querySelectorAll('.wb-ddl-copy')].every(e=>e.scrollWidth<=e.clientWidth+1)`)
      await evaluate("document.querySelector('.wb-scroll').scrollTo({top:0});true")
      await shot(`dark-overview-${width}`)
      await click('.wb-task[data-task-id=preview-reading]')
      await wait('!!document.querySelector(".wb-clock")&&!document.querySelector(".wb-stage").inert&&document.activeElement.matches(".wb-focus-main h2")')
    }
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
    await click('.wb-back')
    await wait('!!document.querySelector(".wb-chooser")')
    await settled('.wb-chooser')
    await openCustomization()
    for (const [label, value] of [
      ['内容宽度', 1320], ['字号', 13], ['事项高度', 96], ['间距', 8], ['位置', 88],
      ['通透度', 70], ['磨砂', 0], ['圆角', 24], ['边缘亮度', 40], ['阴影', 30],
      ['背景', 40], ['背景磨砂', 0],
    ]) await setRange(label, value)
    await closeCustomization()
    await settled('.wb-chooser')
    await wait('document.querySelector(".wb-deadlines").dataset.measured==="true"')
    for (const value of ['light', 'dark']) {
      await openCustomization(); await theme(value); await closeCustomization()
      const visibleReasonRows = await evaluate('[...document.querySelectorAll(".wb-ddl-item")].flatMap((row,index)=>row.inert?[]:[index+1])')
      const reasonHoverChecks = []
      for (const index of visibleReasonRows) {
        const selector = `.wb-ddl-item:nth-child(${index}) .wb-ddl-reason-toggle`
        const before = await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {width:r.width,height:r.height}})()`)
        await hover(selector)
        reasonHoverChecks.push(await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),svg=e.querySelector('svg').getBoundingClientRect(),tip=e.querySelector('.wb-tooltip'),t=tip.getBoundingClientRect(),card=e.closest('.wb-ddl-item').querySelector('.wb-ddl-select').getBoundingClientRect(),side=matchMedia('(pointer: coarse)').matches?44:26;return getComputedStyle(tip).position==='absolute'&&Math.abs(t.left-r.right-8)<1&&Math.abs(t.y+t.height/2-r.y-r.height/2)<1&&(t.right<=card.left||t.left>=card.right||t.bottom<=card.top||t.top>=card.bottom)&&r.width>=side&&r.width<=side+2&&r.height>=side&&r.height<=side+2&&Math.abs(r.width-${before.width})<.1&&Math.abs(r.height-${before.height})<.1&&Math.abs(svg.x+svg.width/2-r.x-r.width/2)<1&&Math.abs(svg.y+svg.height/2-r.y-r.height/2)<1})()`))
      }
      await check(`every visible ${value} DDL reason tooltip opens right without covering its card or stretching its centered button`, JSON.stringify(reasonHoverChecks.length > 0 && reasonHoverChecks.every(Boolean)))
      await hover(`.wb-ddl-item:nth-child(${visibleReasonRows[0]}) .wb-ddl-reason-toggle`)
      await shot(`${value}-ddl-reason-hover`, true)
    }
    await hover('.wb-ddl-page-next')
    await check('dark pager keeps circular centered buttons and a tight control group when its tooltip opens', `(()=>{const controls=document.querySelector('.wb-ddl-page-controls'),r=controls.getBoundingClientRect(),children=[...controls.children],gap=parseFloat(getComputedStyle(controls).columnGap),side=matchMedia('(pointer: coarse)').matches?44:40;return children.length===3&&Math.abs(r.width-children.reduce((sum,e)=>sum+e.getBoundingClientRect().width,0)-gap*2)<1&&Math.abs(children[0].getBoundingClientRect().left-r.left)<1&&Math.abs(children[2].getBoundingClientRect().right-r.right)<1&&[...controls.querySelectorAll('button')].every(e=>{const b=e.getBoundingClientRect(),svg=e.querySelector('svg').getBoundingClientRect();return Math.abs(b.width-side)<.1&&Math.abs(b.height-side)<.1&&getComputedStyle(e).borderRadius==='50%'&&Math.abs(svg.width-20)<.1&&Math.abs(svg.height-20)<.1&&Math.abs(svg.x+svg.width/2-b.x-b.width/2)<1&&Math.abs(svg.y+svg.height/2-b.y-b.height/2)<1&&getComputedStyle(e.querySelector('.wb-tooltip')).position==='absolute'})})()`)
    await shot('dark-ddl-pager-hover', true)
  }
  assert.equal(errors.length, 0, 'no runtime exceptions')
  checks.push({ name: 'no runtime exceptions', pass: true })
} catch (error) {
  failure = String(error)
  throw error
} finally {
  await fs.writeFile('/tmp/astaria-theme-checks.json', JSON.stringify({ url, production, checks, errors, failure }, null, 2))
  console.log(JSON.stringify({ production, passed: checks.filter(item => item.pass).length, failure }, null, 2))
  ws.close()
}
