/** Isolated browser + SQLite service: no user database, credentials, or provider calls. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { localDay, shiftDay } from '../src/home/agenda.ts'

const base = process.env.STACK_QA_URL ?? 'http://127.0.0.1:5190/'
const endpoint = process.env.STACK_QA_CDP ?? 'http://127.0.0.1:9233'
const output = process.env.STACK_QA_OUTPUT ?? '/tmp/astaria-card-stack-ui'
const db = createDatabase(':memory:')
const today = localDay(new Date())
for(let i=0;i<6;i++)db.createTask({title:`待安排测试 ${i+1}：准备资料与实验记录`, estimateMin:30,inbox:false})
for(let i=0;i<5;i++)db.createTask({title:`当天事项 ${i+1}`,due:today,estimateMin:30,inbox:false})
const service = createLocalService({ db, vault: { status: async () => true }, complete: async () => { throw Error('UI verification must not invoke the model') }, dataDirectory: '/isolated-companion-qa' })
const version = await fetch(`${endpoint}/json/version`).then(response => response.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0, session, contextId
const pending = new Map(), checks = [], errors = [], requests = []
const send = (method, params = {}, sid = session) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })) })
const api = request => new Promise(resolve => {
  requests.push({ path: new URL(request.url).pathname, method: request.method })
  const req = Readable.from(request.postData ? [Buffer.from(request.postData)] : [])
  req.url = new URL(request.url).pathname + new URL(request.url).search; req.method = request.method
  req.socket = { remoteAddress: '127.0.0.1', localPort: Number(new URL(base).port) }
  req.headers = { host: new URL(base).host, origin: new URL(base).origin, 'x-astaria-local': '1', 'content-type': 'application/json' }
  const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }) } }
  service.middleware(req, res, () => resolve({ status: 404, body: '{}' }))
})
ws.onmessage = event => {
  const value = JSON.parse(event.data)
  if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
  if (value.method === 'Fetch.requestPaused') api(value.params.request).then(response => send('Fetch.fulfillRequest', { requestId: value.params.requestId, responseCode: response.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(response.body).toString('base64') }, value.sessionId)).catch(reason => errors.push(String(reason)))
  if (!value.id) return
  const callback = pending.get(value.id); pending.delete(value.id)
  value.error ? callback.reject(value.error) : callback.resolve(value.result)
}
const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(75) } throw Error(`Timeout: ${expression}`) }
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`); await delay(150)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await delay(90)
}
const byText = async (selector, text) => {
  await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.qaClick='target';return true})()`)
  await click('[data-qa-click=target]'); await evaluate('document.querySelectorAll("[data-qa-click]").forEach(e=>delete e.dataset.qaClick);true')
}
const fill = async (selector, value) => { await click(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select();true`); await send('Input.insertText', { text: value }) }
const key = async value => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: value === 'Escape' ? 27 : value === 'Enter' ? 13 : 9 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value }) }
const shot = async name => writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))

try {
  await mkdir(output,{recursive:true})
  contextId=(await send('Target.createBrowserContext',{},null)).browserContextId
  const target=await send('Target.createTarget',{url:'about:blank',browserContextId:contextId},null)
  session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true},null)).sessionId
  await send('Page.enable');await send('Runtime.enable');await send('Network.setBypassServiceWorker',{bypass:true});await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*'}]})
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('astaria-sqlite-migration-v1','complete')`})
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await send('Page.navigate',{url:base});await wait('!!document.querySelector(".home-brand")')
  await click('.home-brand');await byText('#home-menu button','日程');await wait('!!document.querySelector(".pl-overview-unscheduled .task-stack-card")')
  const stack='.pl-overview-unscheduled .task-stack',active=stack+' .task-stack-card[data-active=true]'
  const activeText=()=>evaluate(`document.querySelector(${JSON.stringify(active)}).textContent`)
  const first=await activeText()
  await check('pending queue uses stacked cards without disclosure or vertical list','!document.querySelector(".pl-disclosure")&&document.querySelectorAll(".pl-overview-unscheduled .task-stack-card").length===1')
  await check('only the front card can be reached or announced',`[...document.querySelectorAll('${stack} .task-stack-card')].filter(e=>!e.inert&&e.tabIndex===0&&e.getAttribute('aria-hidden')==='false').length===1`)
  await check('pending stack keeps a bounded height',`document.querySelector('${stack}').getBoundingClientRect().height<140`)
  await evaluate(`document.querySelector('${stack}').scrollIntoView({block:'nearest'});true`);await delay(100)
  const point=await evaluate(`(()=>{const r=document.querySelector('${active}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  const outer=await evaluate('document.querySelector(".pl-scroll").scrollTop')
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY:90});await delay(60)
  await check('wheel starts card transition',`document.querySelector('${stack}').dataset.moving==='true'&&!!document.querySelector('${stack} .task-stack-exit')`)
  assert.notEqual(await activeText(),first);checks.push('wheel advances to the next card')
  const second=await activeText()
  await send('Input.dispatchMouseEvent',{type:'mouseWheel',x:point.x,y:point.y,deltaX:0,deltaY:50});await delay(50)
  assert.equal(await activeText(),second);assert.equal(await evaluate('document.querySelector(".pl-scroll").scrollTop'),outer);checks.push('trackpad momentum advances one card without scrolling the page')
  await delay(400);await check('old animation card is cleaned up',`!document.querySelector('${stack} .task-stack-exit')`)
  await evaluate(`document.querySelector('${active}').focus();true`)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown'});await delay(70)
  assert.notEqual(await activeText(),second);await check('keyboard moves focus with the active card',`document.activeElement.matches('${active}')`)
  await click(stack+' button[aria-label="待安排：上一项"]');assert.equal(await activeText(),second);checks.push('visible previous control reverses the queue')
  await click(active);await wait('!!document.querySelector(".pl-dialog[open]")');checks.push('front card opens task details');await click('.pl-dialog header button');await wait('!document.querySelector(".pl-dialog")')
  await check('current card is transparent with no rear content',`document.querySelectorAll('${stack} .task-stack-card').length===1&&getComputedStyle(document.querySelector('${active}')).backgroundColor==='rgba(0, 0, 0, 0)'&&!document.querySelector('${stack} .task-stack-hint')`)
  await check('pending stack does not create its own vertical scrollbar',`(()=>{const s=document.querySelector('${stack}');return s.scrollHeight<=s.clientHeight+1})()`)
  await shot('stack-desktop')
  await click('button[aria-label="切换浅色"]');await delay(250)
  await check('light theme keeps clear cards and readable ink',`getComputedStyle(document.querySelector('${active}')).backgroundColor==='rgba(0, 0, 0, 0)'&&getComputedStyle(document.querySelector('${active}')).color==='rgb(48, 52, 58)'`)
  await shot('stack-light');await click('button[aria-label="切换深色"]')
  await byText('.pl-segment button','月');await wait('!!document.querySelector(".pl-calendar-grid")')
  await check('day and month summaries preserve their flat lists','!document.querySelector(".pl-overview-tasks .task-stack,.pl-overview-notes .task-stack")&&document.querySelectorAll(".pl-overview-task-grid button").length===5&&document.querySelectorAll(".pl-month-deadline").length===5')
  await shot('stack-month')
  await byText('.pl-segment button','周');await wait('!!document.querySelector(".pl-overview-unscheduled .task-stack")')
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});await delay(300)
  await check('compact queue stays within its column without horizontal overflow',`(()=>{const e=document.querySelector('${stack}'),r=e.getBoundingClientRect(),p=e.closest('.pl-overview-notes').getBoundingClientRect();return r.left>=p.left&&r.right<=p.right+1&&document.documentElement.scrollWidth<=innerWidth})()`)
  await evaluate(`document.querySelector('${stack}').scrollIntoView({block:'nearest'});true`)
  const touchBefore=await activeText()
  const touchPoint=await evaluate(`(()=>{const r=document.querySelector('${active}').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Emulation.setTouchEmulationEnabled',{enabled:true})
  await send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:touchPoint.x,y:touchPoint.y+15}]})
  await send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:touchPoint.x,y:touchPoint.y-18}]})
  await send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await delay(400)
  assert.notEqual(await activeText(),touchBefore);checks.push('vertical touch gesture advances the pending card')
  await send('Emulation.setTouchEmulationEnabled',{enabled:false})
  await shot('stack-compact')
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  await click(stack+' button[aria-label="待安排：下一项"]')
  await check('reduced motion removes card flight while preserving selection',`!document.querySelector('${stack} .task-stack-exit')||getComputedStyle(document.querySelector('${stack} .task-stack-exit')).display==='none'`)
  await send('Emulation.setEmulatedMedia',{features:[]});await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await click('.home-brand');await byText('#home-menu button','首页');await click('.home-launch');await wait('!!document.querySelector(".home-agenda-undated .task-stack-card")')
  await check('home undated queue uses the same stack rather than an expandable list','document.querySelector(".home-agenda-undated").tagName==="SECTION"&&document.querySelectorAll(".home-agenda-undated .task-stack-card").length===1')
  await shot('stack-home')
  await click('.home-agenda-undated .task-stack button[aria-label="未定日期：下一项"]');await delay(400)
  checks.push('home pending controls advance the same queue')
  await evaluate(`document.querySelector('.home-agenda-undated .task-stack-card[data-active=true]').focus();true`)
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',windowsVirtualKeyCode:35});await send('Input.dispatchKeyEvent',{type:'keyUp',key:'End',code:'End'});await delay(400)
  await check('last card disables the next button',`document.querySelector('.home-agenda-undated .task-stack button[aria-label="未定日期：下一项"]').disabled`)
  await check('a fresh wheel gesture at the boundary can scroll the parent',`(()=>{const e=document.querySelector('.home-agenda-undated .task-stack'),event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:90});e.dispatchEvent(event);return !event.defaultPrevented})()`)
  assert.deepEqual(errors,[])
  await writeFile(`${output}/results.json`,JSON.stringify({checks,errors},null,2));console.log(`PASS ${checks.length} card-stack UI checks (${output})`)
} catch(error) {await shot('failure').catch(()=>{});await writeFile(`${output}/failure.json`,JSON.stringify({message:error.message,checks,errors},null,2));throw error}
finally {if(contextId)await send('Target.disposeBrowserContext',{browserContextId:contextId},null);ws.close();service.close()}
