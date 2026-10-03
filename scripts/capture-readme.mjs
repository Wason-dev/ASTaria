/** Reproducible README screenshots: fictional data, real writes/undo, isolated temporary browser. */
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

import { randomUUID } from 'node:crypto'
import { createXixi } from '../server/xixi.mjs'
import { createFreeTime } from '../server/freeTime.mjs'

// Frozen demo clock in this process and its owned browser; never open the user's database.
process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-09-29', INSTANT = `${DATE}T17:10:00+08:00`
const NativeDate = Date
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [INSTANT])) }
  static now() { return new NativeDate(INSTANT).getTime() }
}
const output = resolve(process.env.README_CAPTURE_OUTPUT ?? 'artifacts/readme-capture')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-readme-'))
const profile = join(temporary, 'chrome-profile')
let base, chrome, vite, ws, stopping = false
const db = createDatabase(':memory:')
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
for (const routine of db.getPlanner().routines) edit({ type: 'delete-routine', id: routine.id })
for (const [id, title, kind, start, end, location, items] of [
  ['physics', '物理实验', 'class', '09:00', '10:30', '实验室', ['实验记录本', '计算器']],
  ['math', '数学', 'class', '10:45', '11:30', '教室', []],
  ['lunch', '午餐与休息', 'break', '12:00', '13:00', '', []],
  ['english', '英语研讨', 'class', '14:00', '15:00', '教室', []],
  ['afternoon', '下午自习', 'available', '16:00', '17:30', '图书馆', []],
  ['dinner', '晚餐', 'break', '17:30', '18:00', '', []],
  ['study', '晚自习', 'available', '18:00', '20:00', '图书馆', []],
  ['dorm', '宿舍', 'available', '20:30', '22:30', '宿舍', []],
]) edit({ type: 'save-routine', routine: { id: `demo-${id}`, title, kind, weekdays: [1,2,3,4,5], start, end, location, items, enabled: true } })
for (const [index, title, date, start, end, due] of [
  [0, '整理实验数据', DATE, '17:00', '17:30', DATE],
  [1, '英语演讲提纲', DATE, '19:00', '19:30', '2026-09-30'],
  [2, '数学练习 · 函数', '2026-09-28', '18:00', '18:45', '2026-09-30'],
  [3, '复习实验误差分析', '2026-09-30', '18:00', '18:30', '2026-10-02'],
  [4, '小组项目讨论', '2026-10-01', '18:00', '18:45', '2026-10-02'],
  [5, '整理一周阅读笔记', '2026-10-02', '19:00', '19:30', '2026-10-03'],
]) {
  const task = db.createTask({ title, due, estimateMin: start.endsWith(':00') && end.endsWith(':45') ? 45 : 30, inbox: false })
  edit({ type: 'save-block', block: { id: `demo-block-${index}`, taskId: task.id, date, start, end, locked: false } })
}
for (let index = 0; index < 6; index++) {
  const start = 20 * 60 + 30 + index * 15
  const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  const task = db.createTask({ title: ['整理课堂笔记', '补充实验图表', '检查小组资料', '复习英语词组', '准备数学错题', '规划周末阅读'][index], estimateMin: 15, inbox: false })
  edit({ type: 'save-block', block: { id: `demo-horizon-${index}`, taskId: task.id, date: '2026-09-30', start: clock(start), end: clock(start + 15), locked: false,
    horizonGroupId: `demo-group-${index}`, horizonGroupTitle: task.title } })
}
db.createTask({ title: '整理机器人项目资料', estimateMin: 30, inbox: false })
// The populated capture exercises a fresh user's tour with demonstration data.
db.setPreference('onboarding-completed', false)
db.createTask({ title: '选一本下月想读的书', estimateMin: 15, inbox: false })
// Reserve the demonstration slot while seeding unrelated recurring goals.
const reservation = db.createTask({ title: '演示时段预留', estimateMin: 45, inbox: false })
edit({ type: 'save-block', block: { id: 'demo-reservation', taskId: reservation.id, date: DATE, start: '18:00', end: '18:45', locked: true } })
const companion = createCompanion({ db })
for (const goal of [
  { title: 'Java 与机器人编程', minPerWeek: 3, sessionMin: 30, sessionMax: 45, targetNote: '从变量和循环开始，完成一个小练习' },
  { title: '英语阅读', minPerWeek: 4, sessionMin: 20, sessionMax: 30, targetNote: '读完一篇短文，整理三个有用的表达' },
  { title: '速写练习', minPerWeek: 2, sessionMin: 20, sessionMax: 30, targetNote: '给观察与创作留一点时间' },
]) companion.saveFreeTimeGoal(goal)
const freeTime = createFreeTime({ db })
const scheduled = freeTime.schedule({ date: DATE })
assert.ok(scheduled.addedSessions.length >= 6)
db.deleteTask(reservation.id)
const tool = (name, args) => ({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })
const requestId = randomUUID()
// Script only the model response; production tool execution, SQLite writes and receipts stay real.
const responses = [
  () => tool('read_planner', { date: DATE }),
  () => tool('create_tasks', { expectedRevision: db.getPlanner().revision, tasks: [{ title: '完成物理实验报告', due: '2026-09-30', estimateMin: 45, schedule: { date: DATE, start: '18:00', end: '18:45' } }] }),
  () => ({ choices: [{ message: { role: 'assistant', content: '记好了，明天截止，今晚 18:00–18:45 做。留出完整 45 分钟，和英语提纲不冲突。' } }] }),
]
const xixi = createXixi({ db, complete: async () => { const response = responses.shift(); assert.ok(response, 'unexpected additional model call'); return response() } })
const turn = await xixi.chat({ requestId, conversationId: db.getActiveConversation().id, text: '物理实验报告明天交，预计 45 分钟，帮我记下来并安排到今晚的空档。', context: { timezone: 'Asia/Shanghai', page: 'home', date: DATE } })
assert.equal(turn.status, 'completed')
assert.equal(turn.execution.status, 'verified', JSON.stringify(turn.execution))
const receiptTask = db.listTasks().find(task => task.title === '完成物理实验报告')
assert.ok(receiptTask)
const receiptBlock = db.getPlanner().blocks.find(block => block.taskId === receiptTask.id)
assert.equal(receiptBlock.start, '18:00')
assert.equal(receiptBlock.end, '18:45')
const receipt = db.listOperations().find(operation => operation.requestId === requestId && !operation.parentOperationId)
assert.ok(receipt)
const savedKeys = []
const service = createLocalService({ db, vault: { status: async () => true, save: async key => { savedKeys.push(key) }, read: async () => { throw Error('Demo must never access credentials') } }, complete: async () => { throw Error('No live model calls in README capture') }, fetcher: async () => { throw Error('No external API calls in README capture') }, dataDirectory: ':memory:' })
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
const wait = async expression => { for (let index = 0; index < 100; index++) { try { if (await evaluate(expression)) return } catch (error) { if (!String(error.message).includes('Inspected target navigated or closed')) throw error } await delay(70) } throw new Error(`Timeout: ${expression}`) }
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  await delay(100)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(50)
}
const shot = async name => writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
try {
  await mkdir(output, { recursive: true })
  vite = await createServer({ configFile: false, root, cacheDir: join(temporary, 'vite-cache'), plugins: [react(), tailwindcss()], logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false } })
  vite.middlewares.use((req, res, next) => {
    if (!req.url?.startsWith('/api/')) return next()
    res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: 'QA API escaped interception' }))
  })
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}/`
  chrome = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
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
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['2026-09-29T17:10:00+08:00']))}static now(){return NativeDate.now()}};localStorage.setItem('astaria-sqlite-migration-v1','complete')}` })
  await send('Page.navigate', { url: base }); await wait('!!document.querySelector(".home-brand")')

  const byText = async (selector, text) => {
    await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.readmeClick='true';return true})()`)
    await click('[data-readme-click=true]'); await evaluate(`document.querySelectorAll('[data-readme-click]').forEach(e=>delete e.dataset.readmeClick);true`)
  }
  const nav = async text => {
    await evaluate(`document.querySelector('.home-brand').focus();true`)
    if (await evaluate(`document.querySelector('#home-menu').inert`)) await click('.home-brand')
    await byText('#home-menu button', text); await delay(450)
  }

  await wait('document.querySelector(".first-run")?.open === true')
  const introLayers = await evaluate(`(()=>{const w=document.querySelector('.home-workspace');return{contains:w.contains(document.querySelector('.first-run')),matches:w.matches(':has(.first-run)'),nav:getComputedStyle(document.querySelector('.home-nav')).display,scene:getComputedStyle(document.querySelector('.home-scene-ui')).display}})()`)
  assert.equal(introLayers.scene, 'none', JSON.stringify(introLayers))
  await check('first launch defaults to medium personality and dark glass', `(()=>{const d=document.querySelector('.first-run');return d.querySelector('button[aria-pressed=true]').textContent==='中'&&d.textContent.includes('黑色玻璃')})()`)
  await check('guide uses one sampled glass panel', `(()=>{const d=document.querySelector('.first-run');return d.querySelectorAll('.home-glass-measure').length===1&&d.querySelector('.home-glass-surface')?.getAttribute('style')?.includes('backdrop-filter')})()`)
  await delay(500)
  await shot('first-run')
  await byText('.first-run-options button', '磨砂玻璃')
  await check('soft preview changes real glass blur', `document.querySelector('.first-run feGaussianBlur')?.getAttribute('stdDeviation')==='6'`)
  await shot('first-run-soft-dark')
  await byText('.first-run-options button', '黑色玻璃')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await delay(400)
  await shot('first-run-mobile-dark')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false })
  await byText('.first-run-options button', '浅色')
  await byText('.first-run-options button', '磨砂玻璃')
  await delay(350)
  await check('light preview changes the home scene and sampled glass', `(()=>{const d=document.querySelector('.first-run'),w=document.querySelector('.home-workspace');return w.dataset.theme==='light'&&getComputedStyle(w,'::before').backgroundColor.includes('252, 253, 255')&&getComputedStyle(d.querySelector('.home-glass-surface')).backgroundColor.includes('250, 251, 252')})()`)
  await shot('first-run-light')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await delay(400)
  await shot('first-run-mobile')
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false })
  await byText('.first-run-options button', '深色')
  await byText('.first-run-options button', '黑色玻璃')
  await click('.first-run-next')
  await check('key can be configured later', `document.querySelector('.first-run').dataset.step==='1'&&document.querySelector('.first-run-next').textContent==='稍后配置'`)
  const demoKey = `demo-${randomUUID()}`
  await click('#first-run-key')
  await send('Input.insertText', { text: demoKey })
  await click('.first-run-next')
  assert.ok(savedKeys.length === 1 && savedKeys[0] === demoKey, 'guide saves an entered key through the isolated vault')
  checks.push('guide saves an entered key through the isolated vault')
  await wait(`document.querySelector('.first-run')?.dataset.step==='2'`)
  await click('.first-run footer button:first-child')
  await check('key step can be revisited without exposing saved value', `document.querySelector('.first-run').dataset.step==='1'&&document.querySelector('#first-run-key').value===''`)
  await click('.first-run-next')
  assert.equal(savedKeys.length, 1, 'skipping key on revisit does not write again')
  checks.push('key step can be skipped without a second vault write')
  for (const [step, page, name] of [
    [2, 'home', 'home'], [3, 'free-time', 'free-time'], [4, 'schedule', 'planner'], [5, 'workbench', 'workbench'], [6, 'home', 'horizon-entry'],
  ]) {
    await wait(`document.querySelector('.first-run').dataset.step===${JSON.stringify(String(step))}&&document.querySelector('.home-workspace').dataset.page===${JSON.stringify(page)}`)
    await delay(400)
    await check(`tour ${name} shows its real page`, `(()=>{const d=document.querySelector('.first-run');return d.dataset.tour==='true'&&d.getBoundingClientRect().right<innerWidth&&d.getBoundingClientRect().bottom<innerHeight})()`)
    await shot(`tour-${name}`)
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
    const mobileTarget = { 2: '.home-launch', 3: '.free-time-tabs[aria-label="余时目标分类"]', 4: '.pl-segment[aria-label="日程视图"]', 5: '.wb-available .wb-task:first-child' }[step]
    if (mobileTarget) await evaluate(`document.querySelector(${JSON.stringify(mobileTarget)})?.scrollIntoView({block:'center',inline:'nearest'});true`)
    await delay(300)
    await check(`mobile tour ${name} fits and leaves its page visible`, `(()=>{const d=document.querySelector('.first-run'),r=d.getBoundingClientRect(),s=document.querySelector('.home-workspace'),page=s.dataset.page,content=page==='free-time'?document.querySelector('.free-time-viewport'):page==='schedule'?document.querySelector('.pl-scroll'):page==='workbench'?document.querySelector('.wb-scroll'):null;return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&(!content||content.getBoundingClientRect().bottom<=r.top)})()`)
    if (mobileTarget) await check(`mobile tour ${name} keeps its target reachable`, `(()=>{const e=document.querySelector(${JSON.stringify(mobileTarget)}),r=e.getBoundingClientRect(),d=document.querySelector('.first-run').getBoundingClientRect(),x=Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),y=Math.max(0,Math.min(innerHeight-1,r.top+r.height/2));return r.top>=0&&r.bottom<=d.top&&e.contains(document.elementFromPoint(x,y))})()`)
    await shot(`tour-${name}-mobile`)
    await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false })
    await delay(150)
    if (step === 2) {
      await click('.home-launch')
      await wait('!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition && document.querySelector(".home-morph")?.dataset.progress === "1.000" && !document.querySelector("#home-xixi").inert')
      await click('.home-collapse')
      await wait('!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition && document.querySelector(".home-morph")?.dataset.progress === "0.000"')
    }
    if (step === 3) {
      await click('.free-time-tabs[aria-label="余时目标分类"] button:nth-child(2)')
      await check('guide switches to considering', `document.querySelector('.free-time-tabs[aria-label="余时目标分类"] button:nth-child(2)').getAttribute('aria-pressed')==='true'`)
      await click('.free-time-tabs[aria-label="余时目标分类"] button:first-child')
      await check('horizon invitation is disabled during tour', `document.querySelector('.string-invitation').disabled===true`)
    }
    if (step === 4) {
      await click('.pl-segment[aria-label="日程视图"] button[data-mode=day]')
      await check('guide changes planner mode', `document.querySelector('.planner').dataset.mode==='day'`)
    }
    if (step === 5) {
      await click('.wb-available .wb-task')
      await wait('!!document.querySelector(".wb-back")')
      await click('.wb-back')
      await wait('!!document.querySelector(".wb-available .wb-task")')
    }
    if (step >= 2 && step <= 5) {
      await wait(`document.querySelector('.first-run-feedback')?.textContent==='已完成这一步'`)
      await check(`tour ${name} confirms real interaction`, `document.querySelector('.first-run-feedback')?.textContent==='已完成这一步'`)
    }
    if (step < 6) await click('.first-run-next')
  }
  await check('horizon preview has an explicit entry', `document.querySelector('.horizon-studio')===null&&document.querySelector('.home-black-hole-entry').dataset.visible==='false'`)
  const plannerRevisionBeforePreview = db.getPlanner().revision
  await click('.first-run-preview')
  await wait(`document.querySelector('.horizon-studio')?.dataset.phase==='ready'`)
  await check('preview opens the real horizon without edit or save controls', `(()=>{const d=document.querySelector('.horizon-studio');return Boolean(d.open&&!document.querySelector('.first-run').open&&!d.querySelector('.horizon-group-controls')&&!d.querySelector('.orbit-select')&&d.querySelector('.orbit-group[disabled]'))})()`)
  assert.equal(apiPaths.filter(item => item.path === '/api/companion/horizon-groups').length, 0, 'horizon preview never requests model grouping')
  assert.equal(apiPaths.filter(item => item.path === '/api/companion/horizon-order' && item.method !== 'GET').length, 0, 'horizon preview never saves an order')
  checks.push('horizon preview uses only local reads')
  await shot('tour-horizon-preview')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await delay(250)
  await check('mobile horizon preview keeps date controls and return reachable', `(()=>{const d=document.querySelector('.horizon-studio'),date=d.querySelector('.horizon-day-heading nav'),back=d.querySelector('.orbit-cancel'),a=date.getBoundingClientRect(),b=back.getBoundingClientRect();return d.open&&a.left>=0&&a.right<=innerWidth&&b.left>=0&&b.right<=innerWidth&&b.bottom<=innerHeight&&date.contains(document.elementFromPoint(a.left+a.width/2,a.top+a.height/2))&&back.contains(document.elementFromPoint(b.left+b.width/2,b.top+b.height/2))})()`)
  await shot('tour-horizon-preview-mobile')
  await click('.horizon-day-heading nav button:nth-child(2)')
  await check('preview switches date', `document.querySelector('.horizon-day-heading nav button:nth-child(2)').getAttribute('aria-pressed')==='true'`)
  await click('.orbit-cancel')
  await wait(`document.querySelector('.first-run')?.open===true&&!document.querySelector('.horizon-studio')`)
  await check('horizon tour confirms a real date switch and return', `document.querySelector('.first-run-feedback')?.textContent==='已完成这一步'`)
  await send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1050, deviceScaleFactor: 1, mobile: false })
  assert.equal(db.getPlanner().revision, plannerRevisionBeforePreview, 'horizon preview leaves planner data unchanged')
  checks.push('horizon preview leaves planner data unchanged')
  await click('.first-run footer button:first-child')
  await check('back navigates to prior real page', `document.querySelector('.first-run').dataset.step==='5'&&document.querySelector('.home-workspace').dataset.page==='workbench'`)
  await click('.first-run-next')
  await click('.first-run-next')
  await wait('!document.querySelector(".first-run")')
  assert.equal(db.getPreference('onboarding-completed'), true)
  checks.push('first-run tour marks completion in the isolated database')
  await send('Page.reload', { ignoreCache: true }).catch(error => {
    if (!String(error.message).includes('Inspected target navigated or closed')) throw error
  })
  await wait('!!document.querySelector(".home-brand") && !!window.__ASTARIA_P0__')
  await delay(400)
  await check('completed tour does not reopen after reload', `!document.querySelector('.first-run')`)
  await wait('!!window.__ASTARIA_P0__ && !document.querySelector(".home-current-title").disabled')
  await delay(1200)
  await shot('home')
  await click('.home-launch')
  await wait('!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition && document.querySelector(".home-morph").dataset.progress === "1.000"')
  const receiptSelector = `.xixi-receipt[data-operation-id="${receipt.id}"]`
  await wait(`!!document.querySelector('${receiptSelector} .xixi-undo')`)
  await check('receipt lists saved date, duration and a working undo action', `(()=>{const r=document.querySelector('${receiptSelector}');return r.textContent.includes('45')&&r.textContent.includes('18:00')&&r.textContent.includes('18:45')&&!r.querySelector('.xixi-undo').disabled})()`)
  await evaluate(`document.querySelector('.xixi-conversation').scrollTop=0;true`)
  await delay(450)
  await shot('home-receipt')
  await click('.home-collapse')
  await wait('!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition && document.querySelector(".home-morph").dataset.progress === "0.000"')
  await nav('日程')
  await wait('document.querySelector(".planner")?.dataset.active === "true"')
  await click('.pl-segment button[data-mode=week]')
  await wait('document.querySelector(".planner").dataset.mode === "week"')
  await delay(900)
  await check('planner includes the new task and existing assignments', `document.querySelector('.planner').textContent.includes('完成物理实验报告')&&document.querySelector('.planner').textContent.includes('英语演讲提纲')`)
  await shot('planner')
  await nav('余时')
  await wait('document.querySelector(".free-time-page")?.dataset.active === "true" && document.querySelectorAll(".free-time-goal-list li").length >= 3')
  await delay(900)
  await check('three active goals and actual scheduled minutes', `document.querySelector('.free-time-metrics').textContent.includes('3 项')&&document.querySelector('.free-time-page').textContent.includes('Java 与机器人编程')`)
  await shot('free-time')
  await evaluate(`(()=>{const original=HTMLCanvasElement.prototype.toDataURL;window.__glassEncodes=0;HTMLCanvasElement.prototype.toDataURL=function(...args){window.__glassEncodes++;return original.apply(this,args)};return true})()`)
  await click('.free-time-wish-heading button')
  await check('wish glass samples with blur during expansion', `getComputedStyle(document.querySelector('.free-time-wish-entry .home-glass-surface')).backdropFilter.includes('blur(')`)
  await delay(650)
  await check('wish expansion settles to one final refraction map', `(()=>{const pane=document.querySelector('.free-time-wish-entry'),surface=pane.querySelector('.home-glass-surface'),edge=pane.querySelector('feImage');return window.__glassEncodes<=3&&getComputedStyle(surface).backdropFilter.includes('url(')&&Number(edge.getAttribute('height'))===pane.clientHeight})()`)
  await shot('free-time-wish-open')
  await click('.free-time-wish-heading button')
  await delay(650)
  await check('wish collapse avoids per-frame refraction encoding', `window.__glassEncodes<=6`)
  await click('button.string-invitation')
  await wait('document.querySelector(".horizon-studio")?.dataset.phase === "ready" && document.querySelector(".horizon-studio")?.dataset.busy === "false"')
  await click('.horizon-day-heading nav button:nth-child(2)')
  await wait('!!document.querySelector(".horizon-browse")')
  await wait(`(()=>{const group=document.querySelector('.horizon-studio .orbit-group'),label=group?.querySelector('.orbit-group-caption');return group&&!group.disabled&&Number(getComputedStyle(group).opacity)>=.99&&label&&Number(getComputedStyle(label).opacity)>=.99})()`)
  await wait(`(()=>{const copy=document.querySelector('.horizon-day-copy');return copy&&Number(getComputedStyle(copy).opacity)>=.99&&copy.getAnimations().every(animation=>animation.playState==='finished')})()`)
  const horizonVisual = await evaluate(`(()=>{const d=document.querySelector('.horizon-studio');return{phase:d.dataset.phase,editing:d.dataset.editing,inert:d.firstElementChild.hasAttribute('inert'),reveal:d.style.getPropertyValue('--orbit-reveal'),uiReveal:d.style.getPropertyValue('--horizon-ui-reveal'),canvasOpacity:getComputedStyle(d.querySelector('.orbit-canvas')).opacity,headingOpacity:getComputedStyle(d.querySelector('.orbit-heading')).opacity,browseOpacity:getComputedStyle(d.querySelector('.horizon-browse')).opacity}})()`)
  assert.equal(horizonVisual.headingOpacity, '1', JSON.stringify(horizonVisual))
  await check('overflow arrows remain on the visible central axis', `(()=>{const d=document.querySelector('.horizon-studio'),n=d.querySelector('.horizon-browse'),r=n.getBoundingClientRect();return r.top>d.getBoundingClientRect().top+100&&r.bottom<d.getBoundingClientRect().bottom-100})()`)
  await shot('horizon')
  await click('.orbit-cancel')
  await wait('!document.querySelector(".horizon-studio")')
  const unaffectedTasks = db.listTasks().filter(task => task.id !== receiptTask.id)
  const unaffectedBlocks = db.getPlanner().blocks.filter(block => block.taskId !== receiptTask.id)
  await nav('首页')
  await click('.home-launch')
  await wait('!window.__ASTARIA_P0__.getCameraSnapshot().cameraTransition && document.querySelector(".home-morph").dataset.progress === "1.000"')
  await click(`${receiptSelector} .xixi-undo`)
  await wait(`document.querySelector('${receiptSelector}').textContent.includes('已撤销')`)
  assert.equal(db.getTask(receiptTask.id), null)
  assert.deepEqual(db.listTasks(), unaffectedTasks)
  assert.deepEqual(db.getPlanner().blocks, unaffectedBlocks)
  assert.ok(db.listOperations().filter(operation => operation.requestId === requestId).every(operation => operation.undoneAt))
  checks.push('actual UI undo removes the created task and its slot, preserving all unrelated data')
  await nav('设置')
  await byText('.xixi-settings-tabs button', '通用')
  await wait('!!document.querySelector(".xixi-app-updates")')
  await delay(500)
  await shot('settings-updates')
  assert.equal(errors.length, 0, JSON.stringify(errors))
  await writeFile(`${output}/results.json`, JSON.stringify({ checks, scenario: { date: DATE, fictional: true, model: 'scripted', storage: ':memory:', goals: 3, scheduledSessions: scheduled.addedSessions.length }, errors, apiPaths }, null, 2))
  console.log(`PASS README capture and real undo (${output})`)
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
