/** Isolated timetable geometry QA: fake clock, in-memory API, no personal data or model. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
const output = process.env.TIMETABLE_QA_OUTPUT ?? '/tmp/astaria-timetable-readability'
const base = process.env.TIMETABLE_QA_URL ?? 'http://127.0.0.1:5192/'
const db = createDatabase(':memory:')
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
const routine = (id,title,kind,start,end,weekdays=[1,2,3,4,5]) => ({id,title,kind,start,end,weekdays,location:'测试教室',items:[],enabled:true})
edit({type:'import-routines',routines:[
  routine('qa-morning','晨间交流','class','08:40','08:50'),
  routine('qa-check','器材准备','class','08:50','08:55'),
  routine('qa-english','阅读练习','class','09:00','09:40'),
  routine('qa-math','逻辑练习','class','09:50','10:30'),
  routine('qa-afternoon','美术鉴赏','class','13:10','13:50'),
  routine('qa-free1','空课','available','14:20','15:00'),
  routine('qa-free2','空课','available','15:10','15:50'),
  routine('qa-biology','编程实验','class','14:20','15:50',[2]),
  routine('qa-evening','晚自习','available','18:20','20:10'),
]})
const task=db.createTask({title:'测试小事项',estimateMin:35,inbox:false})
edit({type:'save-block',block:{id:'qa-task',taskId:task.id,date:'2030-02-12',start:'18:20',end:'18:55',locked:false}})
const service=createLocalService({db,vault:{status:async()=>true},complete:async()=>{throw Error('Unexpected model call')},dataDirectory:':memory:'})
const version = await fetch('http://127.0.0.1:9233/json/version').then(result => result.json())
const ws = new WebSocket(version.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let serial = 0, session, contextId
const pending = new Map(), checks = [], errors = [], apiPaths = []
const send = (method, params = {}, sid = session) => new Promise((resolve, reject) => { const id = ++serial; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) })) })
const api = request => new Promise(resolve => {
  const parsed = new URL(request.url), origin = new URL(base)
  apiPaths.push({ method: request.method, path: parsed.pathname })
  const req = Readable.from(request.postData ? [Buffer.from(request.postData)] : [])
  req.url = parsed.pathname + parsed.search; req.method = request.method
  req.socket = { remoteAddress: '127.0.0.1', localPort: Number(origin.port) }
  req.headers = { host: origin.host, origin: origin.origin, 'x-astaria-local': '1', 'content-type': 'application/json' }
  const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }) } }
  service.middleware(req, res, () => resolve({ status: 404, body: '{}' }))
})
ws.onmessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (message.method === 'Fetch.requestPaused') api(message.params.request).then(result => send('Fetch.fulfillRequest', { requestId: message.params.requestId, responseCode: result.status,
    responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body: Buffer.from(result.body).toString('base64') }, message.sessionId)).catch(error => errors.push(error.message))
  if (message.id) { const callback = pending.get(message.id); pending.delete(message.id); message.error ? callback.reject(message.error) : callback.resolve(message.result) }
}
const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const wait = async expression => { for (let index = 0; index < 100; index++) { if (await evaluate(expression)) return; await delay(70) } throw new Error(`Timeout: ${expression}`) }
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  await delay(100)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(50)
}
const fill = async (selector, value) => { await click(selector); await evaluate(`document.querySelector(${JSON.stringify(selector)}).select();true`); await send('Input.insertText', { text: value }) }
const mode = async value => { await click(`.pl-segment button[data-mode=${value}]`); await wait(`document.querySelector('.planner').dataset.mode===${JSON.stringify(value)}`); await delay(360) }
const shot = async name => writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
const current = '[data-period-current=true]'

const visibleText = selector => `(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return [...e.children].filter(c=>getComputedStyle(c).display!=='none'&&getComputedStyle(c).visibility!=='hidden').every(c=>{const t=c.getBoundingClientRect();return t.height>0&&t.top>=r.top+1&&t.bottom<=r.bottom-1&&t.width<=r.width})})()`
try {
  await mkdir(output,{recursive:true})
  contextId=(await send('Target.createBrowserContext',{},null)).browserContextId
  const targetId=(await send('Target.createTarget',{url:'about:blank',browserContextId:contextId},null)).targetId
  session=(await send('Target.attachToTarget',{targetId,flatten:true},null)).sessionId
  await send('Page.enable');await send('Runtime.enable');await send('Network.setBypassServiceWorker',{bypass:true})
  await send('Fetch.enable',{patterns:[{urlPattern:'*/api/*',requestStage:'Request'}]})
  await send('Emulation.setTimezoneOverride',{timezoneId:'Asia/Shanghai'})
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false})
  await send('Page.addScriptToEvaluateOnNewDocument',{source:`{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2030-02-12T09:00:00+08:00']))}static now(){return new NativeDate('2030-02-12T09:00:00+08:00').getTime()}};localStorage.setItem('astaria-sqlite-migration-v1','complete')}`})
  await send('Page.navigate',{url:base});await wait('!!document.querySelector(".home-brand")')
  await click('.home-brand');await wait('document.querySelector("#home-menu").dataset.open==="true"')
  await evaluate(`document.querySelectorAll('#home-menu button').forEach(e=>{if(e.textContent.trim()==='日程')e.dataset.qaSchedule='true'});true`)
  await click('[data-qa-schedule=true]');await wait('document.querySelector(".planner[data-active=true]")?.dataset.mode==="week"');await delay(500)
  for (const width of [1440,1280,1024,390]) {
    await send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await delay(250)
    for (const value of ['week','day']) {
      await mode(value)
      const column=`${current} .pl-day-column[data-date="2030-02-12"]`
      await check(`${width} ${value}: morning title fully inside ten-minute card`,visibleText(`${column} .pl-slot[aria-label*="晨间交流"]`))
      await check(`${width} ${value}: five-minute title has one complete row`,visibleText(`${column} .pl-slot[aria-label*="器材准备"]`))
      await check(`${width} ${value}: time title and location fully fit 40-minute class`,visibleText(`${column} .pl-slot[aria-label*="阅读练习"]`))
      await check(`${width} ${value}: consecutive morning events remain separate`, `(()=>{const col=document.querySelector(${JSON.stringify(column)}),r=t=>[...col.querySelectorAll('.pl-slot')].find(e=>e.getAttribute('aria-label').includes(t)).getBoundingClientRect();return r('器材准备').top-r('晨间交流').bottom>=1.9&&r('阅读练习').top>r('器材准备').bottom&&r('逻辑练习').top>r('阅读练习').bottom})()`)
      await check(`${width} ${value}: class occupancy hides original gold frames`, `(()=>{const col=document.querySelector(${JSON.stringify(column)});return ![...col.querySelectorAll('[data-kind=available]')].some(e=>e.textContent.includes('14:20')||e.textContent.includes('15:10'))&&!!col.querySelector('[aria-label*="编程实验"]')})()`)
      await check(`${width} ${value}: task stays inset from evening gold frame`, `(()=>{const col=document.querySelector(${JSON.stringify(column)}),task=col.querySelector('[data-kind=plan]').getBoundingClientRect(),free=col.querySelector('[data-kind=available]').getBoundingClientRect();return task.left-free.left>=5&&free.right-task.right>=5&&task.top-free.top>=1.9})()`)
      await check(`${width} ${value}: nine oclock ruler line matches lesson anchor and now marker`, `(()=>{const col=document.querySelector(${JSON.stringify(column)}),grid=document.querySelector('${current} .pl-timetable-grid'),r=[...grid.querySelectorAll('.pl-timetable-ruler>span')].find(e=>e.textContent==='09:00').getBoundingClientRect(),lesson=col.querySelector('[aria-label*="阅读练习"]').getBoundingClientRect(),now=col.querySelector('.pl-now-line').getBoundingClientRect();return Math.abs((r.top+r.height/2)-now.top)<1&&Math.abs(lesson.top-now.top-2)<1})()`)
      await check(`${width} ${value}: document does not overflow horizontally`, 'document.documentElement.scrollWidth<=innerWidth')
      if(width===1440||width===390){await evaluate(`document.querySelector(${JSON.stringify(column)}+' .pl-slot[aria-label*="晨间交流"]').scrollIntoView({block:'center',inline:'center'});true`);await delay(200);await shot(`${width}-${value}-morning`)}
    }
  }
  await mode('week')
  await check('other weekdays retain original availability', `document.querySelector('${current} .pl-day-column[data-date="2030-02-11"] [data-kind=available][aria-label*="14:20"]')!==null`)
  edit({type:'delete-routine',id:'qa-biology'})
  await evaluate('window.dispatchEvent(new Event("astaria-local-data-change"));true')
  await wait(`!!document.querySelector('${current} .pl-day-column[data-date="2030-02-12"] [data-kind=available][aria-label*="14:20"]')`)
  checks.push('removing the fixed lesson restores both underlying free-time frames')
  assert.deepEqual(errors,[])
  await writeFile(`${output}/results.json`,JSON.stringify({checks,errors,apiPaths},null,2))
  console.log(`PASS ${checks.length} timetable readability checks (${output})`)
}catch(error){await shot('failure').catch(()=>{});await writeFile(`${output}/failure.json`,JSON.stringify({message:error.message,checks,errors},null,2));throw error}
finally{if(contextId)await send('Target.disposeBrowserContext',{browserContextId:contextId},null);ws.close();service.close()}
