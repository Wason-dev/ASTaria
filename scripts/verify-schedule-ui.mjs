/** Isolated month/week/day QA: owned temporary Chrome and Vite, intercepted in-memory API, no personal data. */
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'

const output = process.env.SCHEDULE_QA_OUTPUT ?? '/tmp/astaria-schedule-ui'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-schedule-ui-runtime-'))
const profile = join(temporary, 'chrome-profile')
let base, chrome, vite, ws, stopping = false
// Match the browser fixture day; keep real timers for Chrome/Vite lifecycle.
mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-21T10:00:00+08:00').getTime() })
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
edit({ type: 'save-routine', routine: { id: 'qa-retired', title: '已移除的历史课', kind: 'class', weekdays: [4], start: '07:00', end: '07:20', location: '', items: [], enabled: true } })
edit({ type: 'set-day-template', date: '2026-09-13', sourceWeekday: 4 })
edit({ type: 'delete-routine', id: 'qa-retired' })
edit({ type: 'set-day-template', date: '2026-09-27', sourceWeekday: 4 })
const service = createLocalService({ db, vault: { status: async () => true, read: async () => { throw Error('QA must never access credentials') } }, complete: async () => ({ choices: [{ message: { content: '这一天有清楚的空课和计划' } }] }), dataDirectory: ':memory:' })
let serial = 0
const pending = new Map(), checks = [], errors = [], apiPaths = []
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 15000); pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params })) })
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
const onMessage = event => {
  const message = JSON.parse(event.data)
  if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
  if (message.method === 'Fetch.requestPaused') {
    const { requestId, request } = message.params, url = new URL(request.url)
    const handle = async () => {
      if (url.origin !== new URL(base).origin) await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      else if (url.pathname.startsWith('/api/')) {
        const result = await api(request)
        await send('Fetch.fulfillRequest', { requestId, responseCode: result.status,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(result.body).toString('base64') })
      } else await send('Fetch.continueRequest', { requestId })
    }
    void handle().catch(error => { if (!stopping) errors.push(error.message) })
  }
  if (message.id) { const callback = pending.get(message.id); if (!callback) return; pending.delete(message.id); clearTimeout(callback.timeout); message.error ? callback.reject(message.error) : callback.resolve(message.result) }
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
const setNative = async (selector, value, type) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(${type}.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
const setPlanField = async (selector, value) => evaluate(`(()=>{const input=document.querySelector('.pl-plan-form '+${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
const savePlan = async () => { await click('.pl-plan-form button[type=submit]'); await wait('!document.querySelector(".pl-dialog-header button").disabled'); await delay(80) }
const closePlan = async () => { await click('button[aria-label="关闭事项与安排"]'); await wait('!document.querySelector(".pl-dialog[open]")') }
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
  const marks=[...document.querySelectorAll('${current} .pl-timetable-ruler span')];
  const nine=marks.find(e=>e.textContent==='09:00'),ten=marks.find(e=>e.textContent==='10:00');
  const expected=ruler.top+nine.offsetTop+(ten.offsetTop-nine.offsetTop)/3;
  return next.top-first.bottom>=3.5&&short.top-next.bottom>=2.5&&short.height>2&&
    first.left-frame.left>=5&&frame.right-first.right>=5&&Math.abs(first.top-expected-2)<1&&
    slots[0].getAttribute('aria-label').includes('09:20–09:55');
})()`)
try {
  await mkdir(output, { recursive: true })
  vite = await createServer({ configFile: false, root, cacheDir: join(temporary, 'vite-cache'), plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false } })
  vite.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next()
    res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'QA API escaped interception' }))
  })
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}/`
  chrome = spawn(process.env.SCHEDULE_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' })
  let chromeError, debugPort
  chrome.on('error', error => { chromeError = error })
  for (let i = 0; i < 150; i++) {
    if (chromeError) throw chromeError
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break } catch {}
    if (chrome.exitCode !== null) throw Error(`Temporary Chrome exited: ${chrome.exitCode}`)
    await delay(100)
  }
  assert.ok(debugPort, 'owned browser debugging port is available')
  const target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(result => result.json())).find(item => item.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = onMessage
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.setBypassServiceWorker', { bypass: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
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
    return entries.length===2&&entries.every(e=>e.left-frame.left>=9&&frame.right-e.right>=9)&&entries[1].top-entries[0].bottom>=4.5;
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
  await check('existing plan opens editable with its exact time and no pencil step', `document.querySelector('.pl-plan-form input[type=date]').value==='2026-09-23'&&document.querySelector('.pl-plan-form input[type=time]').value==='09:20'&&!document.querySelector('.pl-plan-form fieldset').disabled&&document.querySelector('.pl-plan-form button[type=submit]').textContent==='更新时段'&&!document.querySelector('.pl-dialog button[title="编辑时段"]')`)
  await setPlanField('input[type=time]', '09:25'); await savePlan()
  await setPlanField('.pl-form-pair label:last-child input', '09:50'); await savePlan()
  assert.equal(db.getPlanner().blocks.filter(block => block.taskId === task.id).length, 1)
  assert.deepEqual(db.getPlanner().blocks.find(block => block.id === 'qa-plan'), { id: 'qa-plan', taskId: task.id, date: '2026-09-23', start: '09:25', end: '09:50', locked: false })
  await check('repeated updates retain the existing id and update mode', `document.querySelector('.pl-plan-form button[type=submit]').textContent==='更新时段'&&document.querySelector('.pl-plan-row[data-selected=true]').textContent.includes('09:25–09:50')`)
  await setPlanField('.pl-form-pair label:last-child input', '10:05'); await savePlan()
  await check('conflicting edits stay in the editor with a visible error', `!!document.querySelector('.pl-dialog .pl-error')&&document.querySelector('.pl-plan-form button[type=submit]').textContent==='更新时段'`)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'qa-plan').end, '09:50')
  await setPlanField('.pl-form-pair label:last-child input', '09:50')
  await click('.pl-plan-form input[type=checkbox]'); await savePlan()
  await check('locking the current plan requires a separate unlock before further edits', `document.querySelector('.pl-plan-form fieldset').disabled&&document.querySelector('.pl-plan-row[data-selected=true]').textContent.includes('解锁')`)
  assert.equal(db.getPlanner().blocks.find(block => block.id === 'qa-plan').locked, true)
  await click('.pl-plan-row[data-selected=true] .pl-plan-actions button'); await wait('!document.querySelector(".pl-plan-form fieldset").disabled')
  await check('unlock retains the current time and immediately restores editable fields', `document.querySelector('.pl-plan-form input[type=time]').value==='09:25'&&!document.querySelector('.pl-plan-form input[type=checkbox]').checked&&document.querySelector('.pl-plan-form button[type=submit]').textContent==='更新时段'`)
  for (const [start, end] of [['18:30', '19:00'], ['19:10', '19:35']]) {
    await click('.pl-plans-heading button')
    await check(`explicit add ${start} enters new-plan mode`, `document.querySelector('.pl-plan-form button[type=submit]').textContent==='添加时段'&&!document.querySelector('.pl-plan-form input[type=checkbox]').checked`)
    await setPlanField('input[type=date]', '2026-09-22'); await setPlanField('input[type=time]', start); await setPlanField('.pl-form-pair label:last-child input', end); await savePlan()
    await check(`new ${start} plan stays selected for subsequent updates`, `document.querySelector('.pl-plan-form button[type=submit]').textContent==='更新时段'&&document.querySelector('.pl-plan-row[data-selected=true]').textContent.includes(${JSON.stringify(start)})`)
  }
  const addedPlans = db.getPlanner().blocks.filter(block => block.taskId === task.id && block.id !== 'qa-plan')
  assert.equal(addedPlans.length, 2)
  await click('.pl-plan-select[aria-label="选择 2026-09-23 09:25–09:50 时段"]')
  await check('multiple plan rows directly switch the selected editable time', `document.querySelector('.pl-plan-form input[type=date]').value==='2026-09-23'&&document.querySelector('.pl-plan-form input[type=time]').value==='09:25'&&document.querySelector('.pl-plan-select[aria-pressed=true]').textContent.includes('当前时段')`)
  await closePlan(); await mode('week')
  await click(`${current} .pl-day-column[data-date="2026-09-22"] .pl-slot[data-kind=plan][aria-label*="19:10–19:35"]`); await wait('!!document.querySelector(".pl-dialog[open]")')
  await check('clicking the second plan on an unselected day opens exactly that plan', `document.querySelector('.planner').dataset.selectedDate==='2026-09-23'&&document.querySelector('.pl-plan-form input[type=date]').value==='2026-09-22'&&document.querySelector('.pl-plan-form input[type=time]').value==='19:10'&&document.querySelector('.pl-plan-select[aria-pressed=true]').textContent.includes('19:10–19:35')`)
  const selectedPlan = addedPlans.find(block => block.start === '19:10')
  await setPlanField('input[type=time]', '19:15')
  edit({ type: 'save-block', block: { ...selectedPlan, end: '19:40' } })
  await evaluate('window.dispatchEvent(new Event("focus"));true'); await wait('!!document.querySelector(".pl-dialog .pl-stale")')
  await check('external changes preserve the draft and disable saving until reload', `document.querySelector('.pl-plan-form fieldset').disabled&&document.querySelector('.pl-plan-form input[type=time]').value==='19:15'`)
  await click('.pl-dialog .pl-stale button')
  await check('reload restores the same selected plan from the latest revision', `!document.querySelector('.pl-plan-form fieldset').disabled&&document.querySelector('.pl-plan-form input[type=time]').value==='19:10'&&document.querySelector('.pl-plan-form .pl-form-pair label:last-child input').value==='19:40'`)
  await shot('direct-plan-editor')
  for (const expectedStart of ['18:30', '09:25']) {
    await click('.pl-plan-row[data-selected=true] .pl-plan-actions button'); await click('.pl-plan-row[data-selected=true] .pl-plan-actions button')
    await wait(`document.querySelector('.pl-plan-form input[type=time]').value===${JSON.stringify(expectedStart)}`)
    await check(`deleting selected plan selects remaining ${expectedStart} without turning it into a new copy`, `document.querySelector('.pl-plan-form button[type=submit]').textContent==='更新时段'&&document.querySelector('.pl-plan-row[data-selected=true]').textContent.includes(${JSON.stringify(expectedStart)})`)
  }
  assert.deepEqual(db.getPlanner().blocks.filter(block => block.taskId === task.id).map(block => block.id), ['qa-plan'])
  await click('.pl-plan-row[data-selected=true] .pl-plan-actions button'); await click('.pl-plan-row[data-selected=true] .pl-plan-actions button')
  await wait('document.querySelector(".pl-plan-form button[type=submit]").textContent==="添加时段"')
  await check('deleting the final plan leaves a fresh unlocked draft', `!document.querySelector('.pl-plan-row')&&!document.querySelector('.pl-plan-form input[type=checkbox]').checked&&document.querySelector('.pl-plan-form input[type=time]').value==='18:00'`)
  assert.equal(db.getPlanner().blocks.filter(block => block.taskId === task.id).length, 0)
  await closePlan(); await mode('day')
  await click(`${current} .pl-slot[data-kind=class]`); await wait('!!document.querySelector(".pl-dialog[open]")')
  await fill('.pl-dialog input[maxlength="100"]', '已修改物理课')
  await click('.pl-dialog button[type=submit]'); await wait('!document.querySelector(".pl-dialog[open]")')
  assert.equal(db.getPlanner().routines.find(item => item.id === 'qa-class').title, '已修改物理课'); checks.push('daily routine editing persists to the same planner database')
  await mode('week')
  await check('week date header visibly marks the one-day Thursday template', `document.querySelector('${current} .pl-timetable-date[data-date="2026-09-27"] .pl-timetable-override')?.textContent==='临时按周四课表'`)
  assert.equal(db.getPlanner().dayOverrides['2026-09-27'].routines.find(item => item.id === 'qa-class').title, '已修改物理课')
  checks.push('ordinary weekly edit synchronizes future one-day templates')
  await click(`${current} .pl-timetable-date[data-date="2026-09-27"]`)
  await click(`${current} .pl-day-column[data-date="2026-09-27"] .pl-slot[data-kind=class]`)
  await wait('!!document.querySelector(".pl-dialog[open]")')
  await check('temporary class opens current source weekly routine with explicit scope', `document.querySelector('.pl-dialog').getAttribute('aria-label')==='编辑每周安排'&&document.querySelector('.pl-dialog input[maxlength="100"]').value==='已修改物理课'&&document.querySelector('.pl-dialog').textContent.includes('周四')&&document.querySelector('.pl-dialog').textContent.includes('调课')`)
  await shot('temporary-lesson-editor')
  await fill('.pl-dialog input[maxlength="100"]', '调课来源修正物理课')
  await click('.pl-dialog button[type=submit]'); await wait('!document.querySelector(".pl-dialog[open]")')
  assert.equal(db.getPlanner().routines.find(item => item.id === 'qa-class').title, '调课来源修正物理课')
  assert.equal(db.getPlanner().dayOverrides['2026-09-27'].routines.find(item => item.id === 'qa-class').title, '调课来源修正物理课')
  assert.equal(db.getPlanner().dayOverrides['2026-09-13'].routines.find(item => item.id === 'qa-class').title, '测试物理课')
  checks.push('editing a temporary class persists its source and future override while retaining historical snapshots')
  await check('saved source changes appear immediately on the temporary lesson card', `document.querySelector('${current} .pl-day-column[data-date="2026-09-27"] .pl-slot[data-kind=class]').textContent.includes('调课来源修正物理课')`)
  const originalWeekly = JSON.stringify(db.getPlanner().routines)
  for (const kind of ['break', 'available']) {
    const before = JSON.stringify(db.getPlanner())
    await click(`${current} .pl-day-column[data-date="2026-09-27"] .pl-slot[data-kind=${kind}]`)
    await wait('!!document.querySelector(".pl-dialog[open]")')
    await check(`temporary ${kind} opens an enabled weekly editor`, `document.querySelector('.pl-dialog').getAttribute('aria-label')==='编辑每周安排'&&document.querySelector('.pl-dialog select').value===${JSON.stringify(kind)}&&!document.querySelector('.pl-dialog fieldset').disabled`)
    await fill('.pl-dialog input[maxlength="100"]', '取消的草稿')
    await click('button[aria-label="关闭编辑每周安排"]'); await wait('!document.querySelector(".pl-dialog[open]")')
    assert.equal(JSON.stringify(db.getPlanner()), before); checks.push(`cancelling temporary ${kind} leaves the complete planner unchanged`)
  }
  await mode('day')
  await check('single day exposes both override marker and restore action', `document.querySelector('${current} .pl-timetable-override')?.textContent==='临时按周四课表'&&!!document.querySelector('.pl-day-template button[aria-label="撤销这一天的日历例外"]')`)
  await mode('month')
  await check('month selection retains readable temporary timetable summary', `document.querySelector('.planner').dataset.selectedDate==='2026-09-27'&&document.querySelector('.pl-day-template').textContent.includes('临时按周四课表')`)
  await shot('single-day-template-month')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await check('narrow month summary keeps restore control within its panel', `(()=>{const e=document.querySelector('.pl-day-template button'),r=e.getBoundingClientRect(),p=document.querySelector('.pl-overview').getBoundingClientRect();return r.left>=p.left&&r.right<=p.right&&r.bottom<=p.bottom})()`)
  await shot('single-day-template-mobile')
  await click('.pl-day-template button[aria-label="撤销这一天的日历例外"]'); await wait('!document.querySelector(".pl-day-template")')
  assert.equal(db.getPlanner().dayOverrides?.['2026-09-27'], undefined); assert.equal(JSON.stringify(db.getPlanner().routines), originalWeekly); checks.push('restore removes only the selected one-day override')
  await mode('day')
  await check('restored Sunday removes temporary classes and date marker', `!document.querySelector('${current} .pl-slot[data-kind=class]')&&!document.querySelector('${current} .pl-timetable-override')`)
  await click('.pl-exception-controls summary')
  await wait('document.querySelector(".pl-exception-controls").open')
  await setNative('.pl-exception-controls input[type=date]', '2026-09-29', 'HTMLInputElement')
  await click('.pl-exception-controls button[type=submit]')
  await wait('document.querySelector(".pl-day-template")?.textContent.includes("假期")')
  assert.deepEqual(['2026-09-27', '2026-09-28', '2026-09-29'].map(date => db.getPlanner().dayExceptions[date]?.kind), ['holiday', 'holiday', 'holiday'])
  await check('consecutive holiday keeps a visible free-day window without classes', `document.querySelector('.pl-day-template').textContent.includes('假期')&&!document.querySelector('${current} .pl-slot[data-kind=class]')&&!!document.querySelector('${current} .pl-slot[data-kind=available]')&&document.querySelector('.pl-capacity-hero strong').textContent.includes('小时')`)
  await shot('holiday-day-mobile')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await shot('holiday-day-desktop')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await setNative('.pl-exception-controls select', 'restored', 'HTMLSelectElement')
  await click('.pl-exception-controls button[type=submit]')
  await wait('document.querySelector(".pl-day-template")?.textContent.includes("已恢复原安排")')
  assert.deepEqual(['2026-09-27', '2026-09-28', '2026-09-29'].map(date => db.getPlanner().dayExceptions[date]?.kind), ['restored', 'restored', 'restored'])
  checks.push('restoring a holiday span replaces every date exception without changing weekly routines')
  await setNative('.pl-exception-controls input[type=date]', '2026-09-27', 'HTMLInputElement')
  await setNative('.pl-exception-controls select', 'cancelled', 'HTMLSelectElement')
  await click('.pl-exception-controls button[type=submit]')
  await wait('document.querySelector(".pl-day-template")?.textContent.includes("临时停课")')
  assert.equal(db.getPlanner().dayExceptions['2026-09-27'].kind, 'cancelled')
  checks.push('cancelled date can be saved without choosing a source weekday')
  await setNative('.pl-exception-controls select', 'rescheduled', 'HTMLSelectElement')
  await wait('!!document.querySelector(".pl-exception-controls label:last-of-type select")')
  await setNative('.pl-exception-controls label:last-of-type select', '4', 'HTMLSelectElement')
  await click('.pl-exception-controls button[type=submit]')
  await wait('document.querySelector(".pl-day-template")?.textContent.includes("临时调课 · 周四课表")')
  assert.equal(db.getPlanner().dayExceptions['2026-09-27'].sourceWeekday, 4)
  await check('rescheduled date shows its copied Thursday class', `!!document.querySelector('${current} .pl-slot[data-kind=class]')`)
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await check('date exception form and feedback fit narrow glass panel', `(()=>{const p=document.querySelector('.pl-overview').getBoundingClientRect();return [...document.querySelectorAll('.pl-exception-controls,.pl-exception-controls button,.pl-day-template')].every(e=>{const r=e.getBoundingClientRect();return r.left>=p.left-1&&r.right<=p.right+1})})()`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await click('.pl-day-template button[aria-label="撤销这一天的日历例外"]')
  await wait('!document.querySelector(".pl-day-template")')
  assert.equal(db.getPlanner().dayExceptions['2026-09-27'], undefined)
  checks.push('undo removes the rescheduled date while retaining other restored dates')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }); await delay(300)
  await mode('month')
  await click(`${current} .pl-calendar-day[data-date="2026-09-13"]`); await mode('day')
  const historicalBefore = JSON.stringify(db.getPlanner())
  await click(`${current} .pl-slot[data-kind=class]`); await wait('!!document.querySelector(".pl-dialog[open]")')
  await check('historical routine whose source was removed offers no enabled save action', `document.querySelector('.pl-dialog input[maxlength="100"]').value==='已移除的历史课'&&![...document.querySelectorAll('.pl-dialog button[type=submit]')].some(button=>!button.disabled&&!button.closest('fieldset[disabled]'))`)
  await check('orphaned historical routine offers an explicit route to weekly schedules', `[...document.querySelectorAll('.pl-dialog button')].some(button=>button.textContent.includes('查看每周安排'))`)
  await shot('historical-missing-source')
  await evaluate(`(()=>{const button=[...document.querySelectorAll('.pl-dialog button')].find(button=>button.textContent.includes('查看每周安排'));button.dataset.qaWeekly='true';return true})()`)
  await click('[data-qa-weekly=true]'); await wait('!!document.querySelector(".pl-dialog[open][aria-label=每周安排]")')
  await click('button[aria-label="关闭每周安排"]'); await wait('!document.querySelector(".pl-dialog[open]")')
  assert.equal(JSON.stringify(db.getPlanner()), historicalBefore); checks.push('viewing an orphaned historical snapshot never recreates the deleted weekly routine')
  await mode('month'); await click(`${current} .pl-calendar-day[data-date="2026-09-27"]`); await mode('day')
  for (const value of ['month', 'week', 'day']) {
    await mode(value)
    await click('button[aria-label="每周安排"]'); await wait('!!document.querySelector(".pl-dialog[open]")')
    // The selected date is Sunday while the edited source routine belongs to Thursday.
    // Select its source weekday before asserting the routine browser contents.
    await click('.pl-routine-days button[aria-label^="星期四"]')
    await check(`${value} exposes weekly routines and add-time action`, `document.querySelector('.pl-dialog').textContent.includes('添加时段')&&document.querySelector('.pl-dialog').textContent.includes('调课来源修正物理课')`)
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
  stopping = true
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM'); await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)])
    if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await delay(150) }
  }
  await vite?.close(); service.close(); await rm(temporary, { recursive: true, force: true })
  mock.timers.reset()
}
