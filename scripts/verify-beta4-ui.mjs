/** Beta.4 UI acceptance with temporary SQLite/Chrome, mock model and mock native
 * notifications. Run after build:desktop. No real model or OS permission requests. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'
import { getPreferences } from '../server/preferences.mjs'

import { createCompanion } from '../server/companion.mjs'
import { weekStart } from '../src/planner/weekCycle.ts'
import { localDay } from '../src/home/agenda.ts'
const directory = await mkdtemp(join(tmpdir(), 'astaria-beta4-ui-'))
const artifacts = resolve('artifacts/verification/beta4-ui'); await mkdir(artifacts,{recursive:true})
const db = createDatabase(join(directory,'test.sqlite')), calls = [], timers = new Set()
const today=localDay(new Date()), anchor=weekStart(today), weekday=new Date().getDay()
const routine={id:'cycle-qa',title:'隔周物理验收',weekdays:[weekday],kind:'class',start:'10:00',end:'10:40',location:'',items:[],enabled:true}
db.updatePlanner({type:'import-routines',routines:[routine]},db.getPlanner().revision)
const wish=createCompanion({db}).saveWish({content:'学摄影验收',evidence:'想学摄影',clarification:{motivation:'拍好日常',firstStep:'拍一张窗边照片'}})
let state={supported:true,enabled:false,authorization:0,count:0,through:null,omitted:0,error:null},deny=true
const reminders={status:async()=>state,setEnabled:async enabled=>{if(enabled&&deny)throw Error('请先在系统设置 → 通知中允许 ASTaria 提醒');state={...state,enabled,authorization:2,count:enabled?4:0};calls.push(enabled);return state},flush:async()=>state}
const service=createLocalService({db,dataDirectory:directory,vault:{status:async()=>true,read:async()=> 'test-only'},complete:async request=>{calls.push('mock-model');return {choices:[{message:{role:'assistant',content:'想先试拍什么？'}}]}}})
const token='isolated-beta4-own-ui-capability-00000000'
const handler=createDesktopHandler({root:resolve('dist'),service,token,reminders})
const server=createServer((req,res)=>{req.headers['x-astaria-desktop']=token;void handler(req,res)})
await new Promise(yes=>server.listen(0,'127.0.0.1',yes))
const browser = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })
const delay = ms => new Promise(yes => setTimeout(yes, ms))
let ws
try {
  let devtools
  for (let i = 0; i < 100; i++) {
    try { devtools = (await readFile(join(directory, 'chrome', 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break } catch { await delay(100) }
  }
  assert.ok(devtools, 'isolated Chrome starts')
  ws = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
  await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
  let serial = 0, session
  const pending = new Map(), errors = [], network = []
  const send = (method, params = {}) => new Promise((yes, no) => {
    const id = ++serial
    pending.set(id, { yes, no })
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  ws.onmessage = event => {
    const value = JSON.parse(event.data)
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
    if (value.method === 'Network.requestWillBeSent') network.push(value.params.request.url)
    const callback = pending.get(value.id)
    if (callback) { pending.delete(value.id); value.error ? callback.no(value.error) : callback.yes(value.result) }
  }
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100) }
    throw Error(`Timeout: ${expression}`)
  }
  const click = async selector => {
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`)
    await delay(250)
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Control is occluded: '+${JSON.stringify(selector)});return {x,y}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const tab = async label => {
    await evaluate(`[...document.querySelectorAll('.xixi-settings-tabs button')].forEach(e=>e.removeAttribute('data-qa-tab'));[...document.querySelectorAll('.xixi-settings-tabs button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).dataset.qaTab='1';true`)
    await click('[data-qa-tab]')
  }
  const screenshot = async name => {
    await writeFile(join(artifacts, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }
  const clickText=async(selector,label)=>{
    await wait(`[...document.querySelectorAll(${JSON.stringify(selector)})].some(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.closest('[inert]'))`)
    await evaluate(`document.querySelectorAll('[data-qac]').forEach(e=>e.removeAttribute('data-qac'));[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(label)}&&!e.closest('[inert]')).dataset.qac='1';true`)
    await click('[data-qac]')
  }
  const nav=async name=>{await click('.home-brand');await clickText('#home-menu button',name);await delay(700)}
  const input=async(selector,value)=>{await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='SELECT'?HTMLSelectElement.prototype:e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event(e.tagName==='SELECT'?'change':'input',{bubbles:true}));return true})()`)}
  const target = await send('Target.createTarget',{url:'about:blank'})
  session=(await send('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId
  await send('Page.enable');await send('Runtime.enable');await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false})
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
  const origin=`http://127.0.0.1:${server.address().port}`
  await send('Page.navigate',{url:origin});await wait('!!document.querySelector(".home-brand")')
  await evaluate(`sessionStorage.setItem('astaria-home-draft','保留原草稿');true`)
  await send('Page.reload');await wait('!!document.querySelector(".home-brand")')
  await nav('余时');await click('.free-time-tabs button:nth-child(2)')
  await clickText('.free-time-goal-actions button','聊清楚')
  await wait('!!document.querySelector(".home-clarifying-wish")')
  assert.ok((await evaluate('document.querySelector("#home-compose").value')).includes('学摄影验收'))
  assert.ok(!(await evaluate('document.querySelector("#home-compose").value')).includes('保留原草稿'))
  await delay(800);await screenshot('wish-dark-1440.png')
  await click('.home-compose-actions .home-capture')
  await wait(`document.querySelector('.home-xixi')?.textContent.includes('想先试拍什么')`)
  assert.equal(calls.filter(x=>x==='mock-model').length,1)
  const turns=db.exportData().tables.turns.map(x=>JSON.parse(x.document))
  assert.equal(turns.at(-1).context.wishId,wish.id)
  assert.equal(db.getPlanner().blocks.length,0)
  await clickText('.home-clarifying-wish button','结束澄清')
  assert.equal(await evaluate('document.querySelector("#home-compose").value'),'保留原草稿')
  assert.equal(db.listTasks().length,0)
  await nav('日程');await click('[aria-label="每周安排"]')
  await click('[aria-label*="编辑隔周物理验收"]')
  await wait('!!document.querySelector("select[aria-label=重复周次]")')
  await input('select[aria-label="重复周次"]','odd')
  await input('input[aria-label="第1周的周一"]',anchor)
  await screenshot('cycle-dark-1440.png')
  await clickText('.pl-dialog button','保存安排')
  await wait('!document.querySelector(".pl-dialog[open]")')
  assert.equal(db.getPlanner().routines.find(r=>r.id==='cycle-qa').weekCycle,'odd')
  const slot='[data-period-current="true"] .pl-slot[data-kind="class"][aria-label*="隔周物理验收"]'
  await wait(`!!document.querySelector(${JSON.stringify(slot)})`)
  await click('[aria-label="下一周"]');await delay(700)
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(slot)})`),false)
  await click('[aria-label="上一周"]');await delay(700)
  await click('[aria-label="每周安排"]');await click('[aria-label*="编辑隔周物理验收"]')
  await wait('!!document.querySelector("select[aria-label=重复周次]")')
  await input('select[aria-label="重复周次"]','even')
  await input('input[aria-label="第1周的周一"]',today===anchor?localDay(new Date(Date.now()+86400000)):today)
  const beforeRevision=db.getPlanner().revision
  await clickText('.pl-dialog button','保存安排')
  await wait(`document.querySelector('.pl-dialog .pl-error')?.textContent.includes('周一')`)
  assert.equal(db.getPlanner().revision,beforeRevision)
  await input('input[aria-label="第1周的周一"]',anchor)
  await clickText('.pl-dialog button','保存安排');await wait('!document.querySelector(".pl-dialog[open]")')
  assert.equal(db.getPlanner().routines.find(r=>r.id==='cycle-qa').weekCycle,'even')
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(slot)})`),false)
  await click('[aria-label="下一周"]');await wait(`!!document.querySelector(${JSON.stringify(slot)})`)
  await nav('设置');await tab('通知')
  await click('[role=switch][aria-label="关闭 App 后仍提醒"]')
  await wait(`document.querySelector('.xixi-settings-content').textContent.includes('请先在系统设置')`)
  assert.equal(state.enabled,false)
  deny=false;await click('[role=switch][aria-label="关闭 App 后仍提醒"]')
  await wait(`document.querySelector('[role=switch][aria-label="关闭 App 后仍提醒"]').getAttribute('aria-checked')==='true'`)
  await screenshot('notifications-dark-1440.png')
  await click('[role=switch][aria-label="关闭 App 后仍提醒"]')
  await wait(`document.querySelector('[role=switch][aria-label="关闭 App 后仍提醒"]').getAttribute('aria-checked')==='false'`)
  assert.equal(state.count,0)
  db.setPreference('app',{...getPreferences(db),theme:'light',glass:'soft'})
  await send('Page.reload');await wait('!!document.querySelector(".home-brand")');await nav('设置');await tab('通知')
  await send('Emulation.setDeviceMetricsOverride',{width:1024,height:1000,deviceScaleFactor:1,mobile:false})
  await delay(700);await screenshot('notifications-light-soft-1024.png')
  const layout=await evaluate(`['html','.xixi-settings-scroll','.xixi-settings-content','.xixi-notification-options'].map(s=>{const e=document.querySelector(s);return {selector:s,width:e.clientWidth,scroll:e.scrollWidth}})`)
  for(const l of layout)assert.ok(l.scroll<=l.width+1,JSON.stringify(l))
  assert.deepEqual(errors,[])
  assert.deepEqual(network.filter(url=>!url.startsWith(origin)&&!url.startsWith('data:')&&!url.startsWith('blob:')),[])
  const result={passed:true,checks:['wish draft isolation, send context and restore','odd/even editor, invalid anchor, current/next-week display','notification permission denial/enable/disable','light frosted layout1024/dark1440'],layout,realModelCalls:0,mockModelCalls:calls.filter(x=>x==='mock-model').length,nativeNotifications:0,errors}
  await writeFile(join(artifacts,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result))
} finally {
  for (const timer of timers) clearTimeout(timer)
  ws?.close()
  const stopped = new Promise(yes => browser.once('exit', yes))
  browser.kill('SIGTERM')
  await Promise.race([stopped, delay(5000)])
  if (browser.exitCode === null) browser.kill('SIGKILL')
  server.closeAllConnections()
  await new Promise(yes => server.close(yes))
  await service.close()
  await rm(directory, { recursive: true, force: true })
}
