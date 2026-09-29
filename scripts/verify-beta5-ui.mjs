/** Isolated month/week/day QA: owned temporary Chrome and Vite, intercepted in-memory API, no personal data. */
import assert from 'node:assert/strict'
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
import { createCompanion } from '../server/companion.mjs'

const resumeEvidence = []
let testNotifications = 0
let notificationState = { supported: true, enabled: true, authorization: 2, count: 3, through: null, omitted: 0, error: null, previewMode: 'never', iconAvailable: false }
const output = process.env.BETA5_QA_OUTPUT ?? '/tmp/astaria-beta5-ui'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-beta5-ui-runtime-'))
const profile = join(temporary, 'chrome-profile')
let base, chrome, vite, ws, stopping = false
const db = createDatabase(':memory:')
const task = db.createTask({ title: '完成物理实验报告', due: '2026-09-23', estimateMin: 35, inbox: false })
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

edit({ type: 'save-routine', routine: { ...db.getPlanner().routines[0], id: 'qa-odd', title: '单周创作课程', weekCycle: 'odd', weekAnchor: '2026-09-21' } })
edit({ type: 'save-routine', routine: { ...db.getPlanner().routines[0], id: 'qa-even', title: '双周讨论课程', weekCycle: 'even', weekAnchor: '2026-09-21' } })
edit({ type: 'set-first-week-monday', date: '2026-09-21' })
const removable = db.createTask({ title: '整理周末阅读笔记', estimateMin: 25, inbox: false })
edit({ type: 'save-block', block: { id: 'qa-delete-plan', taskId: removable.id, date: '2026-09-21', start: '09:00', end: '09:25', locked: false } })

const companion = createCompanion({ db, now: () => new Date('2026-09-21T10:00:00+08:00') })
const savedScenario = companion.previewDecision({ date: '2026-09-22', taskId: task.id, strategy: 'today', recurrence: 'once' })
const newerScenario = companion.previewDecision({ date: '2026-09-23', taskId: adjacent.id, strategy: 'today', recurrence: 'once' })
assert.ok(savedScenario.plans.length > 0 && newerScenario.id !== savedScenario.id)
const conversationId = db.getActiveConversation().id
const scenarioReceipt = (requestId, targetId, content) => {
  db.appendMessage({ conversationId, requestId, role: 'user', content: '先比较路线，不改日历。' })
  db.appendMessage({ conversationId, requestId, role: 'tool', toolCallId: `${requestId}-tool`, content: JSON.stringify({ ok: true, scenario: { id: targetId } }) })
  return db.appendMessage({ conversationId, requestId, role: 'assistant', content }).id
}
const savedReceiptMessageId = scenarioReceipt('qa-saved-scenario', savedScenario.id, '这份实验报告路线可以查看，尚未采用。')
const missingReceiptMessageId = scenarioReceipt('qa-missing-scenario', 'qa-no-longer-available', '此前保存的比较。')

const service = createLocalService({ db, vault: { status: async () => true, read: async () => { throw Error('QA must never access credentials') } }, complete: async () => ({ choices: [{ message: { content: '这一天有清楚的空课和计划' } }] }), dataDirectory: ':memory:' })
let serial = 0
const pending = new Map(), checks = [], errors = [], apiPaths = []
const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 15000); pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params })) })
const api = request => new Promise(resolve => {
  const parsed = new URL(request.url), origin = new URL(base)
  apiPaths.push({ method: request.method, path: parsed.pathname })
  if (parsed.pathname === '/api/desktop/reminders/test') { testNotifications++; return resolve({ status: 200, body: JSON.stringify({ message: '测试提醒将在5秒后出现，请检查正文与图标。' }) }) }
  if (parsed.pathname.startsWith('/api/desktop/reminders')) return resolve({ status: 200, body: JSON.stringify(notificationState) })
  if (parsed.pathname.startsWith('/api/desktop/updates')) return resolve({ status: 200, body: JSON.stringify({ supported: true, current: { version: '0.1.0-beta.5', builtAt: null, commit: null }, automatic: false, status: 'idle', error: null, latest: null, download: null, canInstall: false, releasesUrl: 'https://github.com/Wason-dev/ASTaria/releases', lastInstall: { status: 'installed', message: 'ASTaria 已更新，原有数据已保留。' } }) })
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
  chrome = spawn(process.env.BETA5_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
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
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__commits=0;window.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,renderers:new Map(),inject(r){this.renderers.set(1,r);return 1},onCommitFiberRoot(){window.__commits++},onCommitFiberUnmount(){},checkDCE(){}};` })
  await send('Page.navigate', { url: base }); await wait('!!document.querySelector(".home-brand")')

  const byText = async (selector, text) => {
    await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.beta5Click='true';return true})()`)
    await click('[data-beta5-click=true]'); await evaluate(`document.querySelectorAll('[data-beta5-click]').forEach(e=>delete e.dataset.beta5Click);true`)
  }
  const nav = async text => {
    await evaluate(`document.querySelector('.home-brand').focus();true`)
    if (await evaluate(`document.querySelector('#home-menu').inert`)) await click('.home-brand')
    await byText('#home-menu button', text); await delay(450)
  }
  await wait('!!window.__ASTARIA_P0__ && !document.querySelector(".home-current-title").disabled')
  await delay(900)
  await shot('home')
  await evaluate('window.__commits=0;true')
  await click('.home-launch')
  await wait('!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition && document.querySelector(".home-morph").dataset.progress === "1.000"')
  const motionCommits = await evaluate('window.__commits')
  assert.ok(motionCommits < 30, `camera animation needs bounded UI commits: ${motionCommits}`)
  await check('camera opens chat fully and releases input only at arrival', `!document.querySelector('#home-xixi').inert && document.querySelector('.home-deck').style.visibility === 'visible'`)
  const receiptSnapshot = { planner: db.getPlanner(), tasks: db.listTasks(), scenarios: db.getCompanionState().scenarios }
  const receiptApiStart = apiPaths.length
  const savedReceiptSelector = `.xixi-message[data-message-id="${savedReceiptMessageId}"] .xixi-receipt button`
  await click(savedReceiptSelector)
  await wait(`document.querySelector('.scenario-receipt-dialog[open] select[aria-label="选择已保存推演"]')?.value === ${JSON.stringify(savedScenario.id)}`)
  await check('actual chat receipt opens its saved scenario ID instead of the newest scenario', `document.querySelector('.scenario-receipt-dialog select[aria-label="选择推演事项"]').value === ${JSON.stringify(task.id)} && document.querySelector('.scenario-receipt-dialog input[aria-label="推演起始日期"]').value === ${JSON.stringify(savedScenario.date)} && document.querySelector('.scenario-receipt-dialog .route-section-heading h3').textContent === ${JSON.stringify(task.title)}`)
  await shot('saved-scenario-receipt')
  await click('button[aria-label="关闭路线比较"]')
  await wait('!document.querySelector(".scenario-receipt-dialog")')
  assert.deepEqual({ planner: db.getPlanner(), tasks: db.listTasks(), scenarios: db.getCompanionState().scenarios }, receiptSnapshot)
  checks.push('opening and closing a saved scenario preserves the full calendar, tasks and previews')
  await click(`.xixi-message[data-message-id="${missingReceiptMessageId}"] .xixi-receipt button`)
  await wait('document.querySelector(".scenario-receipt-dialog .scenario-receipt-message h3")?.textContent === "这份推演已不可用"')
  await check('missing scenario receipt shows a clear unavailable state without another scenario or apply action', `document.querySelector('.scenario-receipt-dialog').textContent.includes('日历没有因此改变') && !document.querySelector('.scenario-receipt-dialog .route-studio') && !!document.querySelector('.scenario-receipt-message[role="status"]')`)
  await shot('missing-scenario-receipt')
  await click('button[aria-label="关闭路线比较"]')
  await wait('!document.querySelector(".scenario-receipt-dialog")')
  assert.deepEqual({ planner: db.getPlanner(), tasks: db.listTasks(), scenarios: db.getCompanionState().scenarios }, receiptSnapshot)
  assert.deepEqual(apiPaths.slice(receiptApiStart).filter(({ method, path }) => method !== 'GET' && /^\/api\/companion\/(route|scenario)(\/|$)/.test(path)), [])
  checks.push('receipt navigation never applies, regenerates or discards a scenario, including unavailable IDs')
  await click('.home-collapse')
  await wait('!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition && document.querySelector(".home-morph").dataset.progress === "0.000"')
  await check('camera returns to exact pill and black hole entry', `Math.abs(document.querySelector('.home-morph').getBoundingClientRect().height-38)<1&&document.querySelector('.home-black-hole-entry').dataset.visible==='true'`)
  checks.push(`camera round-trip: opening commits=${motionCommits}, no per-frame whole-page render`)
  for (let index = 0; index < 3; index++) {
    const before = await evaluate('window.__ASTARIA_P0__.getSnapshot()')
    await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));true`)
    await delay(150)
    await evaluate(`Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus'));true`)
    await wait('window.__ASTARIA_P0__.getSnapshot().foregroundFirstFrameMs !== null')
    const after = await evaluate('window.__ASTARIA_P0__.getSnapshot()')
    assert.equal(after.quality,before.quality)
    assert.equal(after.width,before.width)
    assert.equal(after.height,before.height)
    assert.ok(after.foregroundFirstFrameMs < 2000)
    resumeEvidence.push({ firstFrameMs: after.foregroundFirstFrameMs, quality: after.quality, width: after.width, height: after.height })
  }
  checks.push('3 foreground simulations draw within 2 seconds at unchanged quality/resolution')
  await nav('日程')
  await wait('document.querySelector(".planner")?.dataset.active === "true"')
  await wait('!!document.querySelector(".pl-overview-task-pages .pl-icon-button")')
  await check('day-item paging controls are circular 26px buttons', `(()=>{const buttons=[...document.querySelectorAll('.pl-overview-task-pages .pl-icon-button')];return buttons.length===2&&buttons.every(button=>{const r=button.getBoundingClientRect();return Math.abs(r.width-26)<1&&Math.abs(r.height-r.width)<1&&getComputedStyle(button).borderRadius==='50%'})})()`)
  await shot('planner')
  await click('button[aria-label="每周安排"]')
  await wait('!!document.querySelector(".pl-routine-browser[open]")')
  await byText('.pl-routine-week-controls .pl-segment button','单周')
  await check('odd filter includes weekly/odd and excludes even', `document.querySelector('.pl-routine-day-content').textContent.includes('单周创作课程')&&!document.querySelector('.pl-routine-day-content').textContent.includes('双周讨论课程')&&document.querySelector('.pl-routine-day-content').textContent.includes('测试物理课')`)
  await byText('.pl-routine-week-controls .pl-segment button','双周')
  await check('even filter includes weekly/even and excludes odd', `document.querySelector('.pl-routine-day-content').textContent.includes('双周讨论课程')&&!document.querySelector('.pl-routine-day-content').textContent.includes('单周创作课程')&&document.querySelector('.pl-routine-day-content').textContent.includes('测试物理课')`)
  await click('.pl-routine-browser-toolbar .pl-primary')
  await wait('!!document.querySelector(".pl-dialog[aria-label=添加每周安排]")')
  await check('adding from even overview inherits even cycle and shared first week', `document.querySelector('select[aria-label="重复周次"]').value==='even'&&document.querySelector('input[aria-label="第1周的周一"]').value==='2026-09-21'`)
  await click('button[aria-label="关闭添加每周安排"]'); await delay(250)
  await nav('工作台')
  await click(`.wb-task[data-task-id="${removable.id}"]`)
  await wait('!!document.querySelector(".wb-focus")')
  await byText('.wb-focus-title-row button','删除事项')
  await check('focus deletion first opens confirmation without deleting', `!!document.querySelector('.wb-delete-confirm')`)
  assert.equal(db.listTasks().some(t=>t.id===removable.id),true)
  await byText('.wb-delete-confirm button','保留事项')
  assert.equal(db.listTasks().some(t=>t.id===removable.id),true)
  await byText('.wb-focus-title-row button','删除事项')
  await byText('.wb-delete-confirm button','确认删除事项')
  await wait('!!document.querySelector(".wb-chooser")')
  assert.equal(db.listTasks().some(t=>t.id===removable.id),false)
  assert.equal(db.getPlanner().blocks.some(b=>b.taskId===removable.id),false)
  checks.push('confirmed focus deletion removes ordinary task and linked plan; cancel preserves both')
  await nav('余时')
  await wait('!!document.querySelector(".free-time-wish-entry")')
  await shot('free-time')
  const wishApiStart = apiPaths.length
  const wishBefore = { wishes: db.getCompanionState().wishes, planner: db.getPlanner() }
  const wishTrigger = '.free-time-wish-heading button'
  const wishGaps = name => check(name, `(()=>{const panes=['.string-invitation','.free-time-wish-entry','.free-time-goals','.free-time-plan'].map(selector=>document.querySelector(selector).getBoundingClientRect());return panes.slice(1).every((pane,index)=>Math.abs(pane.top-panes[index].bottom-16)<1)})()`)
  const wishLayout = name => check(name, `(()=>{
    const rect=selector=>document.querySelector(selector).getBoundingClientRect();
    const copy=rect('.free-time-wish-copy'),trigger=rect('${wishTrigger}'),form=rect('.free-time-wish-start'),input=rect('.free-time-wish-start textarea'),aside=rect('.free-time-wish-aside');
    return copy.right<trigger.left&&Math.min(copy.bottom,trigger.bottom)>Math.max(copy.top,trigger.top)&&input.width/form.width>.65&&input.height>=140&&aside.left>input.right&&Math.abs(aside.bottom-input.bottom)<2;
  })()`)
  const wishMotion = []
  const animateWish = async direction => {
    const samples = await evaluate(`new Promise(resolve=>{const pane=document.querySelector('.free-time-wish-entry'),samples=[pane.getBoundingClientRect().height],start=performance.now();document.querySelector('${wishTrigger}').click();const frame=()=>{samples.push(pane.getBoundingClientRect().height);if(performance.now()-start>520)resolve(samples);else requestAnimationFrame(frame)};requestAnimationFrame(frame)})`)
    const first=samples[0],last=samples.at(-1),low=Math.min(first,last),high=Math.max(first,last)
    assert.ok(direction==='open'?last-first>140:first-last>140, `${direction}: panel reaches the expected height`)
    assert.ok(samples.some(height=>height>low+2&&height<high-2), `${direction}: real intermediate heights are rendered`)
    wishMotion.push({ direction, first, last, intermediateFrames:samples.filter(height=>height>low+2&&height<high-2).length })
  }
  await evaluate(`window.__wishNodes={pane:document.querySelector('.free-time-wish-entry'),glass:document.querySelector('.free-time-wish-entry .home-glass-surface')};true`)
  await wishGaps('closed free-time glass panels have equal 16px gaps')
  await check('collapsed wish form is inert and matches its accessible trigger', `(()=>{const trigger=document.querySelector('${wishTrigger}'),reveal=document.querySelector('.free-time-wish-reveal');return trigger.getAttribute('aria-expanded')==='false'&&trigger.getAttribute('aria-controls')===reveal.id&&reveal.inert&&reveal.getBoundingClientRect().height<1})()`)
  await animateWish('open')
  await wishGaps('expanded free-time glass panels retain equal 16px gaps')
  await wishLayout('desktop wish composer uses a wide input and aligned side actions')
  await check('clear wish glass is retained and opening focuses its input', `document.activeElement===document.querySelector('.free-time-wish-start textarea')&&document.querySelector('.free-time-wish-entry feGaussianBlur').getAttribute('stdDeviation')==='0'`)
  await shot('free-time-wish-expanded')
  await fill('.free-time-wish-start textarea','保留这份尚未保存的心愿')
  await animateWish('close')
  await check('closing returns focus, disables hidden input and preserves its draft', `document.activeElement===document.querySelector('${wishTrigger}')&&document.querySelector('.free-time-wish-reveal').inert&&document.querySelector('.free-time-wish-start textarea').disabled&&document.querySelector('.free-time-wish-start textarea').value==='保留这份尚未保存的心愿'`)
  await click(wishTrigger); await delay(400)
  await check('reopening retains the same glass and unsaved draft', `window.__wishNodes.pane===document.querySelector('.free-time-wish-entry')&&window.__wishNodes.glass===document.querySelector('.free-time-wish-entry .home-glass-surface')&&document.querySelector('.free-time-wish-start textarea').value==='保留这份尚未保存的心愿'`)
  await send('Emulation.setDeviceMetricsOverride', { width:1024, height:768, deviceScaleFactor:1, mobile:false }); await delay(160)
  await wishLayout('1024px wish composer remains horizontal and spacious')
  await send('Emulation.setDeviceMetricsOverride', { width:390, height:844, deviceScaleFactor:1, mobile:false }); await delay(160)
  await check('narrow wish composer stacks without clipping or horizontal overflow', `(()=>{const viewport=document.querySelector('.free-time-viewport'),pane=document.querySelector('.free-time-wish-entry').getBoundingClientRect(),input=document.querySelector('.free-time-wish-start textarea').getBoundingClientRect(),aside=document.querySelector('.free-time-wish-aside').getBoundingClientRect();return viewport.scrollWidth<=viewport.clientWidth+1&&aside.top>=input.bottom&&[input,...[...document.querySelectorAll('.free-time-wish-actions button')].map(e=>e.getBoundingClientRect())].every(r=>r.left>=pane.left&&r.right<=pane.right)})()`)
  await send('Emulation.setDeviceMetricsOverride', { width:1440, height:1000, deviceScaleFactor:1, mobile:false }); await delay(160)
  await byText('.free-time-wish-actions button','取消'); await delay(400)
  await check('cancel clears the unsaved wish and collapses the editor', `document.querySelector('.free-time-wish-start textarea').value===''&&document.querySelector('.free-time-wish-reveal').inert&&document.querySelector('.free-time-wish-reveal').getBoundingClientRect().height<1`)
  assert.deepEqual({ wishes:db.getCompanionState().wishes, planner:db.getPlanner() },wishBefore)
  assert.deepEqual(apiPaths.slice(wishApiStart).filter(({method,path})=>method!=='GET'&&path.startsWith('/api/companion/')),[])
  checks.push('opening, toggling and canceling a wish never write or schedule anything')
  await send('Emulation.setEmulatedMedia', { features:[{name:'prefers-reduced-motion',value:'reduce'}] })
  await click(wishTrigger)
  await check('reduced motion opens directly to the full composer geometry', `(()=>{const reveal=document.querySelector('.free-time-wish-reveal');return !reveal.inert&&reveal.getBoundingClientRect().height>180&&getComputedStyle(reveal).transitionDuration.split(',').every(value=>parseFloat(value)<=.001)})()`)
  await click(wishTrigger)
  await check('reduced motion closes without a retained empty area', `document.querySelector('.free-time-wish-reveal').getBoundingClientRect().height<1`)
  await send('Emulation.setEmulatedMedia', { features:[] })
  await nav('设置'); await byText('.xixi-settings-tabs button','外观与动画')
  await wait('!!document.querySelector("select[aria-label=玻璃质感]")&&!document.querySelector("select[aria-label=玻璃质感]").disabled')
  await evaluate(`(()=>{const select=document.querySelector('select[aria-label="玻璃质感"]');select.value='soft';select.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await wait('document.querySelector("select[aria-label=玻璃质感]").value==="soft"&&!document.querySelector("select[aria-label=玻璃质感]").disabled')
  await nav('余时'); await click(wishTrigger); await delay(400)
  await check('frosted mode applies the same 6px glass to invitation, wish and goal panels', `['.string-invitation','.free-time-wish-entry','.free-time-goals'].every(selector=>document.querySelector(selector+' feGaussianBlur').getAttribute('stdDeviation')==='6')`)
  await wishGaps('frosted expanded panels retain equal spacing')
  await shot('free-time-wish-expanded-soft')
  checks.push(...wishMotion.map(({direction,intermediateFrames})=>`wish ${direction} renders ${intermediateFrames} intermediate heights`))
  const plansBefore = db.getPlanner().blocks.length
  await fill('.free-time-wish-start textarea','想学会拍星空照片')
  await click('.free-time-wish-start button[type=submit]')
  await wait('!!document.querySelector(".home-clarifying-wish")')
  assert.equal(db.getPlanner().blocks.length, plansBefore)
  await check('wish creation opens clarification and retains content without scheduling', `document.querySelector('.home-clarifying-wish').textContent.includes('想学会拍星空照片')`)
  await nav('设置')
  await byText('.xixi-settings-tabs button','通知')
  await wait('document.querySelector(".xixi-notification-preferences")?.textContent.includes("系统提醒") || !![...document.querySelectorAll(".xixi-notification-preferences")].find(e=>e.textContent.includes("系统提醒"))')
  await check('notification privacy/icon diagnostics are shown only when needed', `document.querySelector('.xixi-settings').textContent.includes('macOS 已关闭通知预览')&&document.querySelector('.xixi-settings').textContent.includes('系统提醒图标未能读取')`)
  assert.equal(testNotifications,0)
  await byText('.xixi-settings-actions button','发送测试提醒')
  await wait('document.querySelector(".xixi-settings").textContent.includes("测试提醒将在5秒后出现")')
  assert.equal(testNotifications,1)
  notificationState={...notificationState,authorization:0,previewMode:'always',iconAvailable:true}
  await byText('.xixi-settings-actions button','重新同步提醒')
  await check('unauthorized test is disabled and obsolete diagnostics disappear', `[...document.querySelectorAll('.xixi-settings-actions button')].find(e=>e.textContent==='发送测试提醒').disabled&&!document.querySelector('.xixi-settings').textContent.includes('macOS 已关闭通知预览')&&!document.querySelector('.xixi-settings').textContent.includes('系统提醒图标未能读取')`)
  await byText('.xixi-settings-tabs button','通用')
  await wait('document.querySelector(".xixi-app-update-last-install")?.textContent.includes("原有数据已保留")')
  checks.push('lastInstall result is shown after restart')
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await writeFile(`${output}/results.json`, JSON.stringify({ checks, resumeEvidence, motionCommits, limitations: ['Foreground visibility is simulated; this does not prove macOS native GPU recovery timing.'], errors, apiPaths }, null, 2))
  console.log(`PASS ${checks.length} beta5 checks (${output})`)
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
}
