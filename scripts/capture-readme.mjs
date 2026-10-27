/** Reproducible README screenshots: fictional data, real writes/undo, isolated temporary browser. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createCompanion } from '../server/companion.mjs'

import { randomUUID } from 'node:crypto'
import { createXixi } from '../server/xixi.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { DEFAULT_PREFERENCES } from '../server/preferences.mjs'
import { finishResponse } from './fixtures/model-receipt.mjs'

// Frozen demo clock in this process and its owned browser; never open the user's database.
process.env.TZ = 'Asia/Shanghai'
const DATE = '2026-10-08', INSTANT = `${DATE}T17:10:00+08:00`
const NativeDate = Date
globalThis.Date = class extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [INSTANT])) }
  static now() { return new NativeDate(INSTANT).getTime() }
}
const mobile = process.env.README_CAPTURE_MOBILE === '1'
const output = resolve(process.env.README_CAPTURE_OUTPUT ?? 'artifacts/readme-capture')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-readme-'))
const profile = join(temporary, 'chrome-profile')
let base, chrome, vite, ws, stopping = false
const db = createDatabase(':memory:')
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
for (const routine of db.getPlanner().routines) edit({ type: 'delete-routine', id: routine.id })
assert.deepEqual(db.getPlanner().routines, [], 'the demo timetable starts from an empty weekly schedule')
// One school week (Mon 10/5 - Sun 10/11) around the frozen Thursday. Weekday values
// follow Date.getDay() (0 = Sunday). Each teaching day keeps its own course and room so
// the 10/9 and 10/10 timetable swaps below are visible as real differences.
for (const [id, title, kind, start, end, location, items] of [
  ['weekend', '周末自由安排', 'available', '09:00', '22:00', '图书馆', []],
  ['lunch', '午餐与休息', 'break', '12:00', '13:00', '', []],
  ['dinner', '晚餐', 'break', '17:30', '18:00', '', []],
  ['study', '晚自习', 'available', '18:00', '20:00', '图书馆', []],
  ['dorm', '宿舍', 'available', '20:30', '22:30', '宿舍', []],
  ['morning-free', '上午可安排', 'available', '08:50', '10:00', '图书馆', []],
  ['afternoon-free', '下午可安排', 'available', '15:10', '17:00', '图书馆', []],
  ['mon-physics', '大学物理', 'class', '08:10', '09:40', '理科楼 2-105', ['实验记录本', '计算器']],
  ['mon-math', '高等数学', 'class', '10:00', '11:40', '理科楼 3-201', ['教材', '错题本']],
  ['tue-program', '程序设计基础', 'class', '08:10', '09:40', '信息楼 A-302', ['笔记本电脑']],
  ['tue-english', '英语研讨', 'class', '10:00', '11:40', '外语楼 5-108', ['阅读材料']],
  ['mid-data', '数据结构', 'class', '10:00', '11:40', '信息楼 A-305', ['教材', '笔记本电脑']],
  ['mid-os', '操作系统研讨', 'class', '14:00', '15:00', '信息楼 B-210', ['课程讲义']],
  ['thu-network', '计算机网络', 'class', '08:10', '09:40', '信息楼 A-401', ['课程讲义']],
  ['thu-database', '数据库实验', 'class', '10:00', '11:40', '实验楼 3-214', ['实验手册']],
  ['fri-lab', '程序设计实验', 'class', '08:10', '09:40', '实验楼 2-108', ['实验手册', '笔记本电脑']],
]) edit({ type: 'save-routine', routine: { id: `demo-${id}`, title, kind, start, end, location, items, enabled: true,
  weekdays: { 'morning-free': [1,2,3,4,5], 'afternoon-free': [1,2,3,4,5], lunch: [1,2,3,4,5], dinner: [1,2,3,4,5],
    study: [1,2,3,4,5], dorm: [1,2,3,4,5], weekend: [6,0], 'mon-physics': [1], 'mon-math': [1], 'tue-program': [2], 'tue-english': [2],
    'mid-data': [3], 'mid-os': [3], 'thu-network': [4], 'thu-database': [4], 'fri-lab': [5] }[id] } })
for (const [index, title, date, start, end, due] of [
  [0, '整理实验数据', DATE, '19:00', '19:30', DATE],
  [1, '英语演讲提纲', '2026-10-09', '19:00', '19:30', '2026-10-09'],
  [2, '复习实验误差分析', DATE, '19:30', '20:00', '2026-10-09'],
  [3, '小组项目讨论', '2026-10-10', '18:00', '18:45', '2026-10-11'],
  [4, '整理一周阅读笔记', '2026-10-11', '19:00', '19:30', '2026-10-12'],
]) {
  const task = db.createTask({ title, due, estimateMin: end.endsWith(':45') ? 45 : 30, inbox: false })
  edit({ type: 'save-block', block: { id: `demo-block-${index}`, taskId: task.id, date, start, end, locked: false } })
}
for (let index = 0; index < 6; index++) {
  const start = 20 * 60 + 30 + index * 15
  const clock = minute => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`
  const task = db.createTask({ title: ['整理课堂笔记', '补充实验图表', '检查小组资料', '复习英语词组', '准备数学错题', '规划周末阅读'][index], estimateMin: 15, inbox: false })
  edit({ type: 'save-block', block: { id: `demo-horizon-${index}`, taskId: task.id, date: '2026-10-09', start: clock(start), end: clock(start + 15), locked: false,
    horizonGroupId: `demo-group-${index}`, horizonGroupTitle: task.title } })
}
// Calendar exceptions and a real one-off event, all through the production planner actions.
edit({ type: 'set-day-exception', date: '2026-10-05', endDate: '2026-10-06', kind: 'holiday' })
edit({ type: 'set-day-exception', date: '2026-10-09', kind: 'rescheduled', sourceWeekday: 3 })
edit({ type: 'set-day-exception', date: '2026-10-10', kind: 'rescheduled', sourceWeekday: 5 })
edit({ type: 'save-day-event', event: { id: 'demo-ceremony', title: '校庆典礼', date: '2026-10-05', start: '09:30', end: '11:00', location: '礼堂', items: ['活动手册'] } })
db.createTask({ title: '整理读书分享资料', estimateMin: 30, inbox: false })
// Unscheduled work with real deadlines: these fill the planner's 待安排 column.
for (const [title, estimateMin, due] of [
  ['准备课堂演示', 20, '2026-10-09'],
  ['归还图书馆图书', 10, '2026-10-10'],
  ['整理小组分工', 30, '2026-10-11'],
]) db.createTask({ title, estimateMin, due, inbox: false })
// The populated capture exercises a fresh user's tour with demonstration data.
db.setPreference('onboarding-completed', true)
db.setPreference('app', { ...DEFAULT_PREFERENCES, glass: 'soft' })
db.createTask({ title: '选一本下月想读的书', estimateMin: 15, inbox: false })
// Reserve the demonstration slot while seeding unrelated recurring goals.
for (const title of ['阅读理解练习', '词汇填空练习', '语法整理']) db.createTask({title,collection:'英语周末作业',due:'2026-10-11',estimateMin:35,inbox:false})
const reservation = db.createTask({ title: '演示时段预留', estimateMin: 45, inbox: false })
edit({ type: 'save-block', block: { id: 'demo-reservation', taskId: reservation.id, date: DATE, start: '18:00', end: '18:45', locked: true } })
const companion = createCompanion({ db })
for (const goal of [
  { title: '编程基础练习', minPerWeek: 3, sessionMin: 30, sessionMax: 45, targetNote: '从变量和循环开始，完成一个小练习' },
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
  () => tool('create_tasks', { expectedRevision: db.getPlanner().revision, tasks: [{ title: '完成物理实验报告', due: '2026-10-09', estimateMin: 45, schedule: { date: DATE, start: '18:00', end: '18:45' } }] }),
  () => tool('read_planner', { date: DATE }),
  payload => finishResponse(payload, '记好了，明天截止，今晚 18:00–18:45 完成。实验数据整理仍在 19:00 开始，中间留了 15 分钟休息。', '报告明天要交，今晚晚自习的第一段空档有完整 45 分钟，做完也不会挤占 19:00 的实验数据整理。'),
]
const xixi = createXixi({ db, complete: async payload => { const response = responses.shift(); assert.ok(response, 'unexpected additional model call'); return response(payload) } })
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
// The demo week must really carry the holiday span, both timetable swaps and the one-off event.
const demoState = db.getPlanner()
assert.deepEqual(['2026-10-05', '2026-10-06'].map(day => demoState.dayExceptions[day]?.kind), ['holiday', 'holiday'])
assert.equal(demoState.dayExceptions['2026-10-09']?.kind, 'rescheduled')
assert.equal(demoState.dayExceptions['2026-10-09']?.sourceWeekday, 3)
assert.equal(demoState.dayExceptions['2026-10-10']?.kind, 'rescheduled')
assert.equal(demoState.dayExceptions['2026-10-10']?.sourceWeekday, 5)
assert.ok(demoState.dayExceptions['2026-10-05'].routines.every(routine => routine.kind !== 'class'), 'a holiday snapshot keeps no classes')
assert.ok(demoState.dayExceptions['2026-10-09'].routines.some(routine => routine.kind === 'class'), 'the 10/9 swap carries the source-day classes')
assert.deepEqual(demoState.dayEvents.map(event => [event.date, event.title]), [['2026-10-05', '校庆典礼']])
const fixtureChecks = ['calendar exceptions and the one-off event exist in real planner state']
const savedKeys = []
const service = createLocalService({ db, vault: { status: async () => true, save: async key => { savedKeys.push(key) }, read: async () => { throw Error('Demo must never access credentials') } }, complete: async () => { throw Error('No live model calls in README capture') }, fetcher: async () => { throw Error('No external API calls in README capture') }, dataDirectory: ':memory:' })
let serial = 0
const pending = new Map(), checks = [...fixtureChecks], errors = [], apiPaths = []
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
    // A navigation aborts in-flight requests, so the browser may have dropped this one before
    // our answer arrives. A stale interception id is not a page error and must not fail the run.
    const answer = async (method, params) => {
      try { await send(method, params) } catch (error) {
        if (!/Invalid InterceptionId/i.test(String(error?.message))) throw error
      }
    }
    const handle = async () => {
      if (url.origin !== new URL(base).origin) await answer('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' })
      else if (url.pathname.startsWith('/api/')) {
        const result = await api(request)
        await answer('Fetch.fulfillRequest', { requestId, responseCode: result.status,
          responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(result.body).toString('base64') })
      } else await answer('Fetch.continueRequest', { requestId })
    }
    void handle().catch(error => { if (!stopping) errors.push(error.message) })
  }
  if (message.id) { const callback = pending.get(message.id); if (!callback) return; pending.delete(message.id); clearTimeout(callback.timeout); message.error ? callback.reject(message.error) : callback.resolve(message.result) }
}
const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// Each retry is one CDP round trip, so a loaded machine slows both the render and this poll.
// Give page transitions up to ~30s before failing; the assertions themselves are unchanged.
const wait = async expression => { for (let index = 0; index < 300; index++) { try { if (await evaluate(expression)) return } catch (error) { if (!String(error.message).includes('Inspected target navigated or closed')) throw error } await delay(100) } throw new Error(`Timeout: ${expression}`) }
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'});true`)
  await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||e.closest('[inert]'))return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(50)
}
const shot = async name => writeFile(`${output}/${name}.png`, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
try {
  await mkdir(output, { recursive: true })
  vite = await preview({ configFile:false, root, build:{outDir:mobile?'dist-mobile':'dist'}, preview:{host:'127.0.0.1',port:0,open:false} })
  base = `http://127.0.0.1:${vite.httpServer.address().port}/`
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
  await send('Emulation.setDeviceMetricsOverride', { width: mobile ? 430 : 1600, height: mobile ? 932 : 1050, deviceScaleFactor: 1, mobile })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `{const NativeDate=Date;window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:['${INSTANT}']))}static now(){return NativeDate.now()}};localStorage.setItem('astaria-sqlite-migration-v1','complete')}` })
  await send('Page.navigate', { url: base }); await wait('!!document.querySelector(".home-brand")')

  const byText = async (selector, text) => {
    await evaluate(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.readmeClick='true';return true})()`)
    await click('[data-readme-click=true]'); await evaluate(`document.querySelectorAll('[data-readme-click]').forEach(e=>delete e.dataset.readmeClick);true`)
  }
  const nav = async text => {
    // A page transition can briefly unmount the shell; wait for it before driving the menu.
    await wait(`!!document.querySelector('.home-brand') && !!document.querySelector('#home-menu')`)
    await wait(`!window.__ASTARIA_P0__?.getCameraSnapshot().cameraTransition`)
    await evaluate(`new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))`)
    await evaluate(`document.querySelector('.home-brand').focus();true`)
    if (await evaluate(`document.querySelector('#home-menu').inert`)) await click('.home-brand')
    await wait(`!document.querySelector('#home-menu').inert && Number(getComputedStyle(document.querySelector('.home-menu-list')).opacity)>=.99`)
    // The horizontal menu scrolls a newly focused item into view. Activate by
    // keyboard after focus, so that scroll cannot move it between mouse down/up.
    await evaluate(`(()=>{const e=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing menu item');e.focus();return true})()`)
    await wait(`document.activeElement?.closest('#home-menu') && document.activeElement.textContent.trim()===${JSON.stringify(text)}`)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 })
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await delay(450)
  }

  if (mobile) {
    await wait('!!document.querySelector(".first-run")')
    await delay(1200)
    await shot('mobile-first-run')
    const imported = await evaluate(`(async()=>{const r=await fetch('/api/data/import',{method:'POST',headers:{'Content-Type':'application/json','X-ASTaria-Local':'1'},body:JSON.stringify({backup:${JSON.stringify(db.exportData())},confirmed:true})});if(!r.ok)throw Error(await r.text());const s=await fetch('/api/onboarding',{method:'POST',headers:{'Content-Type':'application/json','X-ASTaria-Local':'1'},body:JSON.stringify({completed:true})});if(!s.ok)throw Error(await s.text());return true})()`)
    assert.equal(imported, true)
    checks.push('fictional backup imported through the production mobile worker')
    await evaluate(`sessionStorage.setItem('astaria-xixi-conversation-v1', ${JSON.stringify(db.getActiveConversation().id)});true`)
    await send('Page.reload', {ignoreCache:true})
    await wait('!!document.querySelector(".home-launch") && !document.querySelector(".first-run")')
    await delay(1600)
    await check('mobile composition is active', `document.documentElement.dataset.mobile==='preview'`)
    await shot('mobile-home')
    await click('.home-launch')
    await wait('document.querySelector(".home-morph")?.dataset.progress === "1.000"')
    await delay(650)
    await wait(`document.querySelector('.xixi-conversation')?.textContent.includes('实验报告')`)
    await evaluate(`document.querySelector('.xixi-conversation').scrollTop=0;true`)
    await check('mobile chat panel fits the viewport', `(()=>{const r=document.querySelector('.home-morph').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1})()`)
    await shot('mobile-chat')
    await nav('日程')
    await delay(1400)
    await shot('mobile-planner')
    await nav('工作台')
    await wait('!!document.querySelector(".wb-available .wb-task")')
    await delay(650)
    await shot('mobile-workbench')
    await click('.wb-available .wb-task')
    await wait('!!document.querySelector(".wb-xixi textarea")')
    await delay(650)
    await shot('mobile-focus')
    await send('Emulation.setDeviceMetricsOverride',{width:1194,height:834,deviceScaleFactor:1,mobile:true})
    await nav('首页')
    if (await evaluate(`document.querySelector('.home-morph')?.dataset.progress!=='1.000'`)) await click('.home-launch')
    await wait('document.querySelector(".home-morph")?.dataset.progress === "1.000"')
    await delay(1500)
    await shot('tablet-chat')
    assert.equal(errors.length,0,JSON.stringify(errors))
    await writeFile(`${output}/mobile-results.json`,JSON.stringify({checks,errors,scenario:{fictional:true,runtime:'production mobile worker',nativeDevice:false}},null,2))
    console.log(`PASS mobile README capture (${output})`)
  } else {
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
  await check('planner includes the new task and existing assignments', `(()=>{const t=document.querySelector('.planner').textContent;return t.includes('完成物理实验报告')&&t.includes('英语演讲提纲')&&t.includes('数据结构')&&t.includes('计算机网络')&&t.includes('数据库实验')})()`)
  await check('the holiday span really removes the Monday and Tuesday classes', `(()=>{const t=document.querySelector('.planner').textContent;return !t.includes('大学物理')&&!t.includes('高等数学')&&!t.includes('程序设计基础')&&!t.includes('英语研讨')})()`)
  await check('planner shows the 10/5-10/6 holiday span and both timetable swaps', `(()=>{const label=day=>document.querySelector(\`.pl-timetable-date[data-date="\${day}"] .pl-timetable-override\`)?.textContent;return label('2026-10-05')==='假期'&&label('2026-10-06')==='假期'&&label('2026-10-09')==='临时调课 · 周三课表'&&label('2026-10-10')==='临时调课 · 周五课表'})()`)
  // A holiday removes the weekly classes and keeps the one-off event as a fixed fact;
  // the free-day window still has to be there and the marker has to be visible.
  await check('holiday columns swap the weekly classes for a free-day window', `(()=>{const f=document.querySelector('[data-period-current=true]'),c=f?.querySelector('.pl-day-column[data-date="2026-10-05"]');if(!c)return false;const slots=[...c.querySelectorAll('.pl-slot')],classes=slots.filter(s=>s.dataset.kind==='class');return classes.length===1&&classes[0].getAttribute('aria-label').startsWith('单日活动，校庆典礼')&&slots.some(s=>s.dataset.kind==='available'&&s.getAttribute('aria-label').includes('周末自由安排'))&&!classes.some(s=>/大学物理|高等数学/.test(s.textContent))&&Number(getComputedStyle(f.querySelector('.pl-timetable-override')).opacity)>=.99})()`)
  await check('10/9 runs the Wednesday timetable instead of its Friday classes', `(()=>{const c=document.querySelector('[data-period-current=true] .pl-day-column[data-date="2026-10-09"]');if(!c)return false;const t=c.textContent;return t.includes('数据结构')&&t.includes('操作系统研讨')&&!t.includes('程序设计实验')})()`)
  await check('10/10 runs the Friday timetable on a Saturday', `(()=>{const c=document.querySelector('[data-period-current=true] .pl-day-column[data-date="2026-10-10"]');if(!c)return false;const t=c.textContent;return t.includes('程序设计实验')&&!t.includes('数据结构')&&!t.includes('操作系统研讨')})()`)
  await check('planner exposes placed work and the one-off event', `(()=>{const t=document.querySelector('.planner').textContent;return t.includes('校庆典礼')&&t.includes('小组项目讨论')&&t.includes('英语演讲提纲')})()`)
  await check('pending column lists the unscheduled work with real deadlines', `(()=>{const stack=document.querySelector('.pl-overview-unscheduled .task-stack');return !!stack&&Number(stack.dataset.count)>=4&&stack.getAttribute('aria-label')==='待安排'&&!!stack.querySelector('.task-stack-card[data-active=true] strong')?.textContent})()`)
  await shot('planner')
  await nav('余时')
  await wait('document.querySelector(".free-time-page")?.dataset.active === "true" && document.querySelectorAll(".free-time-goal-list li").length >= 3')
  await delay(900)
  await check('three active goals and actual scheduled minutes', `document.querySelector('.free-time-metrics').textContent.includes('3 项')&&document.querySelector('.free-time-page').textContent.includes('编程基础练习')`)
  await shot('free-time')
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
  // Show the swapped day itself: select 10/9, then read the day view from the real UI.
  await nav('日程')
  await wait('document.querySelector(".planner")?.dataset.active === "true"')
  if (await evaluate(`document.querySelector('.planner').dataset.mode !== 'week'`)) await click('.pl-segment button[data-mode=week]')
  await click('[data-period-current=true] .pl-timetable-date[data-date="2026-10-09"]')
  await wait(`document.querySelector('.planner').dataset.selectedDate === '2026-10-09'`)
  await click('.pl-segment button[data-mode=day]')
  await wait(`document.querySelector('.planner').dataset.mode === 'day'`)
  await delay(700)
  await check('day view shows the 10/9 makeup timetable and its switch control', `(()=>{const t=document.querySelector('.planner').textContent;return document.querySelector('.planner').dataset.selectedDate==='2026-10-09'&&t.includes('临时调课 · 周三课表')&&t.includes('数据结构')&&!t.includes('计算机网络')})()`)
  await shot('planner-day')
  await click('.pl-segment button[data-mode=week]')
  await wait(`document.querySelector('.planner').dataset.mode === 'week'`)
  await nav('工作台')
  await wait('document.querySelector(".workbench")?.dataset.active === "true" && !!document.querySelector(".wb-available .wb-task")')
  await delay(600)
  await check('workbench lists only real tasks from the same seeded planner', `(()=>{const list=document.querySelector('.wb-available');if(!list)return false;const seeded=${JSON.stringify([...new Set(db.listTasks().flatMap(task => [task.title,task.collection].filter(Boolean)))])};const cards=[...list.querySelectorAll('.wb-task')].map(card=>card.querySelector('strong')?.textContent);return cards.length>=1&&cards.every(title=>seeded.includes(title))&&new Set(cards).size===cards.length})()`)
  await shot('workbench')
  await click(`.wb-task[data-task-id="${receiptTask.id}"]`)
  await wait(`!!document.querySelector('.wb-xixi textarea') && !document.querySelector('.wb-scroll').inert`)
  await delay(600)
  await check('focus chat shares the compact plus beside Send', `(()=>{const p=document.querySelector('.wb-xixi .xixi-attachment-button');return /添加/.test(p?.getAttribute('aria-label')??'')&&p.nextElementSibling?.type==='submit'&&!document.querySelector('.wb-xixi .wb-input-shell button')})()`)
  await shot('workbench-focus')
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
  }
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
  if (vite) { vite.httpServer.closeAllConnections(); await new Promise(done=>vite.httpServer.close(done)) }; service.close(); await rm(temporary, { recursive: true, force: true })
}
