/** Unified month/week/day QA with an intercepted in-memory API and fake AI. */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

const output = process.env.SCHEDULE_QA_OUTPUT ?? '/tmp/astaria-schedule-ui'
const base = process.env.SCHEDULE_QA_URL ?? 'http://127.0.0.1:5188/'
const db = createDatabase(':memory:')
const task = db.createTask({ title: '日程测试报告', due: '2026-09-23', estimateMin: 35, inbox: false })
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
edit({ type: 'import-routines', routines: [
  { id: 'qa-class', title: '测试物理课', kind: 'class', weekdays: [1,2,3,4,5], start: '08:00', end: '08:40', location: '实验室', items: ['计算器'], enabled: true },
  { id: 'qa-free', title: '测试空课', kind: 'available', weekdays: [1,2,3,4,5], start: '09:00', end: '12:00', location: '', items: [], enabled: true },
  { id: 'qa-break', title: '测试休息', kind: 'break', weekdays: [1,2,3,4,5], start: '10:30', end: '11:00', location: '', items: [], enabled: true },
] })
edit({ type: 'save-block', block: { id: 'qa-plan', taskId: task.id, date: '2026-09-23', start: '09:20', end: '09:55', locked: false } })
const adjacent = db.createTask({ title: '紧邻的小事项', due: '2026-09-23', estimateMin: 30, inbox: false })
edit({ type: 'save-block', block: { id: 'qa-adjacent', taskId: adjacent.id, date: '2026-09-23', start: '09:55', end: '10:25', locked: false } })
const short = db.createTask({ title: '五分钟检查', due: '2026-09-23', estimateMin: 5, inbox: false })
edit({ type: 'save-block', block: { id: 'qa-short', taskId: short.id, date: '2026-09-23', start: '10:25', end: '10:30', locked: false } })
edit({ type: 'set-day-template', date: '2026-09-27', sourceWeekday: 4 })
const service = createLocalService({ db, vault: { status: async () => true }, complete: async () => ({ choices: [{ message: { content: '这一天有清楚的空课和计划' } }] }), dataDirectory: ':memory:' })
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
const slotSpacing = async name => check(name, `(()=>{
  const column=document.querySelector('${current} .pl-day-column[data-date="2026-09-23"]');
  const slots=[...column.querySelectorAll('[data-kind=plan]')];
  const first=slots.find(e=>e.textContent.includes('日程测试报告')).getBoundingClientRect();
  const next=slots.find(e=>e.textContent.includes('紧邻的小事项')).getBoundingClientRect();
  const short=slots.find(e=>e.textContent.includes('五分钟检查')).getBoundingClientRect();
  const frame=column.querySelector('[data-kind=available]').getBoundingClientRect();
  const ruler=column.getBoundingClientRect();
  const expected=ruler.top+(140/900)*ruler.height;
  return next.top-first.bottom>=3.5&&short.top-next.bottom>=2.5&&short.height>2&&
    first.left-frame.left>=5&&frame.right-first.right>=5&&Math.abs(first.top-expected-2)<1&&
    slots[0].getAttribute('aria-label').includes('09:20–09:55');
})()`)
try {
  await mkdir(output, { recursive: true })
  contextId = (await send('Target.createBrowserContext', {}, null)).browserContextId
  const targetId = (await send('Target.createTarget', { url: 'about:blank', browserContextId: contextId }, null)).targetId
  session = (await send('Target.attachToTarget', { targetId, flatten: true }, null)).sessionId
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/*', requestStage: 'Request' }] })
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-21T10:00:00+08:00']))}static now(){return new NativeDate('2026-09-21T10:00:00+08:00').getTime()}};localStorage.setItem('astaria-sqlite-migration-v1','complete')}` })
  await send('Page.navigate', { url: base }); await wait('!!document.querySelector(".home-brand")')
  await click('.home-brand'); await wait('document.querySelector("#home-menu").dataset.open==="true"')
  await evaluate(`(()=>{const e=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()==='日程');if(!e)throw Error('Missing 日程 destination');e.dataset.qaSchedule='true';return true})()`)
  await click('[data-qa-schedule=true]'); await wait('document.querySelector(".planner[data-active=true]")?.dataset.mode==="week"'); await delay(500)
  await check('one unified schedule destination replaces separate calendar/timetable', `document.querySelector('.planner h2').textContent==='日程'&&![...document.querySelectorAll('#home-menu button')].some(e=>['日历','时间表'].includes(e.textContent.trim()))`)
  await check('week remains a seven-day timetable', `document.querySelectorAll('${current} .pl-day-column').length===7`)
  await click(`${current} .pl-timetable-date[data-date="2026-09-23"]`)
  await slotSpacing('weekly tasks have gaps between adjacent cards and the availability frame without shifting their time anchors')
  await evaluate(`document.querySelector('${current} .pl-day-column[data-date="2026-09-23"] [data-kind=plan]').scrollIntoView({block:'center'});true`)
  await shot('weekly-card-spacing')
  await mode('month')
  await check('month preserves selected date and renders full calendar', `document.querySelector('.planner').dataset.selectedDate==='2026-09-23'&&document.querySelectorAll('${current} .pl-calendar-day').length===42&&document.querySelector('${current} .pl-calendar-day[data-date="2026-09-23"]').getAttribute('aria-pressed')==='true'`)
  await check('month task chips stay inset from the selected gold frame and separated from one another', `(()=>{
    const cell=document.querySelector('${current} .pl-calendar-day[data-date="2026-09-23"]');
    const frame=cell.getBoundingClientRect(),entries=[...cell.querySelectorAll('.pl-calendar-entry')].map(e=>e.getBoundingClientRect());
    return entries.length===2&&entries.every(e=>e.left-frame.left>=9&&frame.right-e.right>=9)&&entries[1].top-entries[0].bottom>=5.5;
  })()`)
  await evaluate(`document.querySelector('${current} .pl-calendar-day[data-date="2026-09-23"]').scrollIntoView({block:'center'});true`)
  await shot('month-card-spacing')
  await mode('day')
  await check('day preserves selected date with one full-width column and all slot kinds', `document.querySelector('.planner').dataset.selectedDate==='2026-09-23'&&document.querySelectorAll('${current} .pl-day-column').length===1&&['class','available','break','plan'].every(k=>document.querySelector('${current} .pl-slot[data-kind='+k+']'))`)
  await slotSpacing('daily task cards retain frame insets and short-slot spacing')
  await evaluate(`document.querySelector('${current} .pl-slot[data-kind=plan]').scrollIntoView({block:'center'});true`)
  await shot('daily-card-spacing')
  await click('.pl-period button[aria-label="后一天"]')
  await check('day navigation animates a complete outgoing and incoming day', `document.querySelector('.planner').dataset.selectedDate==='2026-09-24'&&document.querySelector('.pl-period-window').dataset.moving==='true'&&document.querySelectorAll('.pl-period-frame').length===2`)
  await delay(340); await click('.pl-period button[aria-label="前一天"]'); await delay(340)
  await mode('week'); await check('returning to week retains the same selected date', `document.querySelector('.planner').dataset.selectedDate==='2026-09-23'`)
  await click('.pl-period button[aria-label="下一周"]'); await delay(340)
  await check('week navigation advances seven days', `document.querySelector('.planner').dataset.selectedDate==='2026-09-30'`)
  await mode('month'); await click('.pl-period button[aria-label="下个月"]'); await delay(340)
  await check('month navigation preserves day-of-month when valid', `document.querySelector('.planner').dataset.selectedDate==='2026-10-30'`)
  await click('.pl-period button[aria-label="上个月"]'); await delay(340)
  await click(`${current} .pl-calendar-day[data-date="2026-09-23"]`); await mode('day')
  await click(`${current} .pl-slot[data-kind=plan]`); await wait('!!document.querySelector(".pl-dialog[open]")')
  await check('task details remain reachable from daily plan', `document.querySelector('.pl-dialog-task-title').textContent==='日程测试报告'`)
  await click('button[aria-label="关闭事项与安排"]'); await wait('!document.querySelector(".pl-dialog[open]")')
  await click(`${current} .pl-slot[data-kind=class]`); await wait('!!document.querySelector(".pl-dialog[open]")')
  await fill('.pl-dialog input[maxlength="100"]', '已修改物理课')
  await click('.pl-dialog button[type=submit]'); await wait('!document.querySelector(".pl-dialog[open]")')
  assert.equal(db.getPlanner().routines.find(item => item.id === 'qa-class').title, '已修改物理课'); checks.push('daily routine editing persists to the same planner database')
  await mode('week')
  await check('week date header visibly marks the one-day Thursday template', `document.querySelector('${current} .pl-timetable-date[data-date="2026-09-27"] .pl-timetable-override')?.textContent==='调课 · 周四'`)
  const originalWeekly = JSON.stringify(db.getPlanner().routines)
  await click(`${current} .pl-day-column[data-date="2026-09-27"] .pl-slot[data-kind=class]`)
  await check('temporary lesson selects its date and opens summary rather than weekly template editor', `!document.querySelector('.pl-dialog[open]')&&document.querySelector('.planner').dataset.selectedDate==='2026-09-27'&&document.activeElement.matches('.pl-day-template')&&document.querySelector('.pl-day-template').textContent.includes('临时按周四课表')`)
  await check('temporary lesson keeps its captured details after weekly template edits', `document.querySelector('${current} .pl-day-column[data-date="2026-09-27"] .pl-slot[data-kind=class]').getAttribute('aria-label').includes('测试物理课，08:00–08:40，实验室，临时按周四课表')`)
  await click(`${current} .pl-day-column[data-date="2026-09-27"] .pl-slot[data-kind=available]`)
  await check('temporary availability is also read-only and routes to the summary', `!document.querySelector('.pl-dialog[open]')&&document.activeElement.matches('.pl-day-template')`)
  assert.equal(JSON.stringify(db.getPlanner().routines), originalWeekly); checks.push('viewing temporary routines leaves permanent weekly template intact')
  await mode('day')
  await check('single day exposes both override marker and restore action', `document.querySelector('${current} .pl-timetable-override')?.textContent==='调课 · 周四'&&!!document.querySelector('.pl-day-template button[aria-label="恢复这一天原来的课表"]')`)
  await mode('month')
  await check('month selection retains readable temporary timetable summary', `document.querySelector('.planner').dataset.selectedDate==='2026-09-27'&&document.querySelector('.pl-day-template').textContent.includes('临时按周四课表')`)
  await shot('single-day-template-month')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await check('narrow month summary keeps restore control within its panel', `(()=>{const e=document.querySelector('.pl-day-template button'),r=e.getBoundingClientRect(),p=document.querySelector('.pl-overview').getBoundingClientRect();return r.left>=p.left&&r.right<=p.right&&r.bottom<=p.bottom})()`)
  await shot('single-day-template-mobile')
  await click('.pl-day-template button[aria-label="恢复这一天原来的课表"]'); await wait('!document.querySelector(".pl-day-template")')
  assert.equal(db.getPlanner().dayOverrides?.['2026-09-27'], undefined); assert.equal(JSON.stringify(db.getPlanner().routines), originalWeekly); checks.push('restore removes only the selected one-day override')
  await mode('day')
  await check('restored Sunday removes temporary classes and date marker', `!document.querySelector('${current} .pl-slot[data-kind=class]')&&!document.querySelector('${current} .pl-timetable-override')`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(300)
  for (const value of ['month', 'week', 'day']) {
    await mode(value)
    await click('button[aria-label="每周安排"]'); await wait('!!document.querySelector(".pl-dialog[open]")')
    await check(`${value} exposes weekly routines and add-time action`, `document.querySelector('.pl-dialog').textContent.includes('添加时段')&&document.querySelector('.pl-dialog').textContent.includes('已修改物理课')`)
    await click('button[aria-label="关闭每周安排"]'); await wait('!document.querySelector(".pl-dialog[open]")')
    await click('button[aria-label="记录事项"]'); await wait('!!document.querySelector(".pl-dialog[open]")')
    await check(`${value} exposes task creation`, `document.querySelector('.pl-dialog').getAttribute('aria-label')==='记录一件事'`)
    await click('.pl-dialog-header button'); await wait('!document.querySelector(".pl-dialog[open]")')
  }
  for (const width of [1440, 768, 390, 320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 900, deviceScaleFactor: 1, mobile: false }); await delay(450)
    for (const value of ['month', 'week', 'day']) {
      await mode(value)
      await check(`${width}px ${value}: page header and board do not overflow viewport`, `(()=>{const root=document.querySelector('.pl-scroll'),r=document.querySelector('.pl-page-header').getBoundingClientRect();return document.documentElement.scrollWidth<=innerWidth+1&&root.scrollWidth<=root.clientWidth+1&&r.right<=innerWidth+1&&r.left>=-1})()`)
      await check(`${width}px ${value}: board has no nested vertical scrollbar`, `(()=>{const e=document.querySelector('.pl-board-scroll');return getComputedStyle(e).overflowY==='visible'&&e.scrollHeight<=e.clientHeight+2})()`)
      if (value === 'day') {
        await check(`${width}px day: single column fits available glass width`, `document.querySelector('.pl-timetable-scroll').scrollWidth<=document.querySelector('.pl-timetable-scroll').clientWidth+1`)
        await evaluate(`document.querySelector('.pl-scroll').scrollTop=99999;true`); await delay(200)
        await check(`${width}px day: final hour accessible by outer page scrolling`, `(()=>{const e=document.querySelector('${current} .pl-timetable-ruler span:last-child').getBoundingClientRect(),p=document.querySelector('.pl-scroll').getBoundingClientRect();return e.bottom<=p.bottom+1&&e.top>=p.top})()`)
        await shot(`day-${width}-bottom`)
      }
    }
  }
  await click('.pl-board-toolbar .pl-secondary'); await delay(300)
  await check('today returns exact current day and current-time indicator', `document.querySelector('.planner').dataset.selectedDate==='2026-09-21'&&!!document.querySelector('${current} .pl-now-line')`)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await mode('month')
  await check('reduced motion disables mode enter animation', `getComputedStyle(document.querySelector('.pl-mode-frame')).animationName==='none'`)
  assert.equal(errors.length, 0)
  await writeFile(`${output}/results.json`, JSON.stringify({ checks, errors, apiPaths }, null, 2))
  console.log(`PASS ${checks.length} unified schedule checks (${output})`)
} catch (error) {
  await shot('failure').catch(() => {})
  await writeFile(`${output}/failure.json`, JSON.stringify({ message: error.message, checks, errors, apiPaths }, null, 2))
  throw error
} finally {
  if (contextId) await send('Target.disposeBrowserContext', { browserContextId: contextId }, null)
  ws.close(); service.close()
}
