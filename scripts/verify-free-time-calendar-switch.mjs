/** Production-page navigation with owned Chrome and temporary data; no user profile or model calls. */
import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createCompanion } from '../server/companion.mjs'
import { createFreeTime } from '../server/freeTime.mjs'
import { createLocalService } from '../server/index.mjs'
import { DEFAULT_PREFERENCES } from '../server/preferences.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'

const root = resolve(process.env.CALENDAR_SWITCH_QA_DIST ?? 'dist')
const output = resolve(process.env.CALENDAR_SWITCH_QA_OUTPUT ?? 'artifacts/v1-readiness/calendar-stutter/current')
const variants = (process.env.CALENDAR_SWITCH_QA_THEMES ?? 'dark-clear,dark-soft,light-clear,light-soft').split(',')
const rounds = Number(process.env.CALENDAR_SWITCH_QA_ROUNDS ?? 3)
const captureTrace = process.env.CALENDAR_SWITCH_QA_TRACE === '1'
const regression = process.env.CALENDAR_SWITCH_QA_REGRESSION === '1'
const checkedAt = new Date().toISOString()
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10)
const temporary = await mkdtemp(join(tmpdir(), 'astaria-calendar-switch-'))
const fixedDate = '2026-10-12T10:00:00+08:00', today = '2026-10-12'
mock.timers.enable({ apis: ['Date'], now: new Date(fixedDate).getTime() })
const db = createDatabase(':memory:')
const edit = action => db.updatePlanner(action, db.getPlanner().revision)
const companion = createCompanion({ db })
edit({ type: 'import-routines', routines: [
  { id: 'qa-available', title: '测试可用时间', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '07:00', end: '22:00', location: '', items: [], enabled: true },
  ...Array.from({ length: 5 }, (_, i) => ({ id: `qa-class-${i}`, title: `测试课程 ${i + 1}`, kind: 'class', weekdays: [1,2,3,4,5], start: `${String(8 + i * 2).padStart(2, '0')}:00`, end: `${String(8 + i * 2).padStart(2, '0')}:45`, location: '测试教室', items: ['测试讲义'], enabled: true })),
] })
for (let index = 0; index < 120; index++) {
  const date = new Date(2026, 8, 10 + index % 42, 12)
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const task = db.createTask({ title: `测试事项 ${index + 1}`, due: day, estimateMin: 25, inbox: false })
  const start = 9 + Math.floor(index / 42) * 2
  edit({ type: 'save-block', block: { id: `qa-block-${index}`, taskId: task.id, date: day, start: `${String(start).padStart(2, '0')}:00`, end: `${String(start).padStart(2, '0')}:25`, locked: false } })
  if (day < today) db.updateTask(task.id, { status: 'done' })
}
for (let index = 0; index < 4; index++) companion.saveFreeTimeGoal({ title: `测试持续目标 ${index + 1}`, minPerWeek: 0, sessionMin: 20, sessionMax: 30 })
db.setPreference('free-time-daily', { date: today, completedAt: fixedDate })
db.setPreference('onboarding-completed', true)
const preferences = { ...DEFAULT_PREFERENCES, render: { profile: 'full', quality: 'ultra', glass: 'auto' } }
db.setPreference('app', preferences)
const plannerBefore = db.getPlanner()
const apiRequests = [], errors = [], samples = [], checks = [], blockedRequests = []
const service = createLocalService({ db, dataDirectory: temporary,
  vault: { status: async () => false, read: async () => { throw Error('QA cannot read credentials') } },
  fetcher: async () => { throw Error('QA cannot contact external services') },
  complete: async () => { throw Error('QA cannot call a model') },
})
const token = 'isolated-calendar-navigation-test-capability'
const handler = createDesktopHandler({ root, service, token })
const server = createServer((req, res) => {
  req.headers['x-astaria-desktop'] = token
  if (req.url.startsWith('/api/')) apiRequests.push({ path: req.url, method: req.method })
  void handler(req, res)
})
let chrome, ws, stopping = false, serial = 0, base, traceComplete
const pending = new Map()
const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))
const send = (method, params = {}) => new Promise((yes, no) => {
  const id = ++serial, timeout = setTimeout(() => { pending.delete(id); no(Error(`CDP timeout ${method}`)) }, 20_000)
  pending.set(id, { yes, no, timeout }); ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = async expression => {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(50) }
  throw Error(`Timeout ${expression}`)
}
const check = async (name, expression) => { assert.ok(await evaluate(expression), name); checks.push(name) }
const menu = async () => {
  await evaluate('document.querySelector(".home-brand").click();true')
  await wait('document.querySelector("#home-menu")?.dataset.open==="true"')
  await delay(250)
}
const nav = async (label, measured = false) => {
  await menu()
  const requestOffset = apiRequests.length
  const result = await evaluate(`(async()=>{
    const button=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(label)});
    if(!button)throw Error('Missing destination');
    if(${measured})window.__calendarQa.begin();
    button.click();
    if(!${measured})return null;
    await new Promise(r=>setTimeout(r,1200));
    return window.__calendarQa.finish();
  })()`)
  await wait(`document.querySelector('.home-workspace').dataset.page===${JSON.stringify(label === '余时' ? 'free-time' : 'schedule')}`)
  return result && { ...result, apiRequests: apiRequests.slice(requestOffset) }
}
const instrumentation = `{
  let current=null;
  const NativeDate=Date;let fixedTime=NativeDate.parse(${JSON.stringify(fixedDate)});window.Date=class extends NativeDate{constructor(...args){super(...(args.length?args:[fixedTime]));if(current)current.dateConstructions++}static now(){return fixedTime}};
  localStorage.setItem('astaria-sqlite-migration-v1','complete');
  const encode=HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL=function(...args){const start=performance.now();const result=encode.apply(this,args);if(current)current.encodes.push({width:this.width,height:this.height,ms:performance.now()-start});return result};
  window.__calendarQa={setTime(value){fixedTime=NativeDate.parse(value);window.dispatchEvent(new Event('focus'))},begin(){const start=performance.now();current={start,frames:[],encodes:[],longTasks:[],budgets:[],glass:[],mutations:[],dateConstructions:0};let last=null;
    current.observer=new PerformanceObserver(list=>{if(current)current.longTasks.push(...list.getEntries().filter(e=>e.startTime>=start).map(e=>({start:e.startTime-start,ms:e.duration}))) });current.observer.observe({type:'longtask'});
    current.mutationObserver=new MutationObserver(records=>{if(current)current.mutations.push(...records.filter(r=>r.target.closest('.planner')&&(r.target.matches('.home-glass-surface,feImage,filter')||r.type==='childList'&&r.target.matches('.planner,.pl-container'))).map(r=>({ms:performance.now()-start,tag:r.target.tagName,attribute:r.attributeName}))) });current.mutationObserver.observe(document.querySelector('.planner'),{subtree:true,attributes:true,childList:true,attributeFilter:['style','href','width','height']});
    const tick=time=>{if(!current)return;if(last!==null)current.frames.push(time-last);last=time;const s=window.__ASTARIA_P0__.getSnapshot();current.budgets.push({fps:s.targetFps,quality:s.quality,moving:s.cameraTransition});
      current.glass.push({ms:performance.now()-start,surfaces:[...document.querySelectorAll('.planner .home-glass-surface')].map(e=>({filter:e.style.backdropFilter,geometry:[...e.previousElementSibling?.querySelectorAll('feImage')??[]].map(m=>({width:m.getAttribute('width'),height:m.getAttribute('height')}))}))});
      current.frame=requestAnimationFrame(tick)};current.frame=requestAnimationFrame(tick);
  },finish(){current.observer.disconnect();current.mutationObserver.disconnect();cancelAnimationFrame(current.frame);const {observer,mutationObserver,frame,...result}=current;current=null;result.duration=performance.now()-result.start;
    const sorted=result.frames.slice().sort((a,b)=>a-b);result.rafP95Ms=sorted[Math.ceil(sorted.length*.95)-1];result.rafMaxMs=sorted.at(-1);delete result.start;return result;}}
}`
const regressionChecks = async () => {
  const current = '[data-period-current=true]'
  const cell = `${current} .pl-calendar-day[data-date="2026-10-30"]`
  const entry = `${cell} .pl-calendar-entry`
  const changed = () => evaluate("window.dispatchEvent(new Event('astaria-local-data-change'));true")
  await nav('日程')
  await evaluate('document.querySelector(".pl-segment [data-mode=month]").click();true')
  await wait(`!!document.querySelector(${JSON.stringify(cell)})`)
  const task = db.createTask({ title: '验收事项初始标题', due: '2026-10-30', estimateMin: 20, inbox: false })
  const block = { id: 'qa-live-block', taskId: task.id, date: '2026-10-30', start: '18:00', end: '18:20', locked: false }
  edit({ type: 'save-block', block }); await changed()
  await wait(`document.querySelector(${JSON.stringify(entry)})?.title.includes('18:00–18:20')`)
  db.updateTask(task.id, { title: '验收事项已改标题' }); await changed()
  await wait(`document.querySelector(${JSON.stringify(entry)})?.title.includes('验收事项已改标题')`)
  edit({ type: 'save-block', block: { ...block, start: '19:00', end: '19:20' } }); await changed()
  await wait(`document.querySelector(${JSON.stringify(entry)})?.title.includes('19:00–19:20')`)
  await check('live month task and time update', `!document.querySelector(${JSON.stringify(entry)})?.title.includes('18:00–18:20')`)
  db.updateTask(task.id, { status: 'done' }); await changed()
  await wait(`document.querySelector(${JSON.stringify(entry)})?.dataset.done==='true'`)
  db.updateTask(task.id, { status: 'todo' }); await changed()
  await wait(`document.querySelector(${JSON.stringify(entry)})?.dataset.done==='false'`)
  await check('live month completion and reopening', `document.querySelector(${JSON.stringify(entry)})?.dataset.done==='false'`)
  edit({ type: 'set-day-exception', date: '2026-10-30', kind: 'rescheduled', sourceWeekday: 3 }); await changed()
  await wait(`document.querySelector(${JSON.stringify(cell)})?.textContent.includes('临时调课 · 周三课表')`)
  await check('live exception label', `document.querySelector(${JSON.stringify(cell)})?.getAttribute('aria-label').includes('临时调课 · 周三课表')`)
  await evaluate(`document.querySelector(${JSON.stringify(cell)}).focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));true`)
  await wait("document.activeElement?.dataset.date==='2026-10-31'")
  await check('calendar keyboard selection retains focus', "document.querySelector('.planner').dataset.selectedDate==='2026-10-31'&&document.activeElement.dataset.date==='2026-10-31'")
  await evaluate(`document.querySelector(${JSON.stringify(cell)}).click();document.querySelector('.pl-segment [data-mode=week]').click();true`)
  const slot = `${current} .pl-day-column[data-date="2026-10-30"] .pl-slot[data-kind=plan]`
  await wait(`document.querySelector(${JSON.stringify(slot)})?.textContent.includes('19:00–19:20')`)
  edit({ type: 'save-block', block: { ...block, start: '20:00', end: '20:20' } }); await changed()
  await wait(`document.querySelector(${JSON.stringify(slot)})?.textContent.includes('20:00–20:20')`)
  await check('live week time update', `document.querySelector(${JSON.stringify(slot)})?.textContent.includes('验收事项已改标题')`)

  // This history projection deliberately changes without a planner revision.
  const goal = companion.saveFreeTimeGoal({ title: '验收持续目标', minPerWeek: 0, sessionMin: 20, sessionMax: 30 })
  const sessionTask = db.createTask({ title: goal.title, source: 'recurring', freeTimeGoalId: goal.id, estimateMin: 20, inbox: false })
  const companionState = db.getCompanionState()
  companionState.freeTimeGoals.find(item => item.id === goal.id).taskId = sessionTask.id
  db.saveCompanionState(companionState)
  edit({ type: 'delete-block', id: block.id })
  edit({ type: 'save-block', block: { ...block, taskId: sessionTask.id } }); await changed()
  await wait(`document.querySelector(${JSON.stringify(slot)})?.textContent.includes('验收持续目标')`)
  const freeTime = createFreeTime({ db }), revision = db.getPlanner().revision
  const completed = freeTime.completeSession({ sessionId: block.id }); await changed()
  await wait(`document.querySelector(${JSON.stringify(slot)})?.dataset.done==='true'`)
  assert.equal(db.getPlanner().revision, revision)
  freeTime.reopenSession({ sessionId: block.id, expectedCompletedAt: completed.completedAt }); await changed()
  await wait(`document.querySelector(${JSON.stringify(slot)})?.dataset.done==='false'`)
  await check('same-revision session completion and reopening', `document.querySelector(${JSON.stringify(slot)})?.dataset.done==='false'`)

  await evaluate('document.querySelector(".pl-period [aria-label=下一周]").click();true')
  await delay(40)
  await evaluate('document.querySelector(".pl-period [aria-label=上一周]").click();true')
  await delay(400)
  await check('rapid period reversal settles to requested week', "document.querySelector('.planner').dataset.selectedDate==='2026-10-30'&&document.querySelectorAll('[data-period-current=true]').length===1&&document.querySelectorAll('[data-period-current=false]').length===0")
  await nav('余时')
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false })
  await delay(250)
  await check('hidden resized calendar does not sample glass', "document.querySelector('.planner').inert&&document.querySelectorAll('.planner feImage').length===0&&[...document.querySelectorAll('.planner .home-glass-surface')].every(e=>getComputedStyle(e).backdropFilter==='none')")
  const returned = await nav('日程', true)
  const actual = await evaluate("[...document.querySelectorAll('.planner .home-glass-measure')].map(e=>[e.clientWidth,e.clientHeight])")
  const svg = await evaluate("document.querySelectorAll('.planner feImage').length>0")
  if (svg) {
    assert.deepEqual(returned.glass[0].surfaces.map(s => s.geometry.map(g => [Number(g.width),Number(g.height)])).flat(), actual, 'first visible glass has current window geometry')
    assert.ok(returned.glass[0].surfaces.every(s => s.filter.startsWith('url(')))
  } else assert.ok(returned.glass[0].surfaces.every(s => s.geometry.length === 0), 'CSS glass does not allocate SVG maps')
  checks.push('return after hidden window resize restores correct first-paint glass')
  // A real layout transition still settles once, instead of encoding every frame.
  const resized = await evaluate(`(async()=>{window.__calendarQa.begin();const host=document.querySelector('.planner .pl-board .home-glass-measure');host.style.transition='height 300ms linear';host.style.height=(host.clientHeight-100)+'px';await new Promise(r=>setTimeout(r,600));const result=window.__calendarQa.finish();result.size=[host.clientWidth,host.clientHeight];return result})()`)
  if (svg) {
    assert.ok(resized.encodes.length <= 1, 'animated resize encodes at most one final map')
    const last = resized.glass.at(-1).surfaces.at(-1)
    assert.deepEqual(last.geometry.map(g => [Number(g.width),Number(g.height)]), [resized.size])
    assert.ok(last.filter.startsWith('url('))
  } else assert.equal(resized.encodes.length, 0)
  checks.push('animated resize keeps debounce and final accurate geometry')
  await evaluate("const host=document.querySelector('.planner .pl-board .home-glass-measure');host.style.transition='';host.style.height='';true")
  await delay(200)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate('(async()=>{await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);document.querySelector(".pl-period [aria-label=下一周]").click();await new Promise(requestAnimationFrame);return true})()')
  await check('reduced motion switches period without a departing frame', "document.querySelectorAll('[data-period-current=false]').length===0")
  await send('Emulation.setEmulatedMedia', { features: [] })

  await evaluate("document.querySelector('.pl-segment [data-mode=month]').click();true")
  await evaluate("[...document.querySelectorAll('.pl-board-toolbar button')].find(e=>e.textContent==='今天').click();true")
  await wait("!!document.querySelector('[data-period-current=true] .pl-calendar-day[data-date=\"2026-10-12\"]')")
  const capacity = "document.querySelector('[data-period-current=true] .pl-calendar-day[data-date=\"2026-10-12\"] .pl-calendar-capacity').title"
  const initialTime = await evaluate(capacity)
  await evaluate("window.__calendarQa.setTime('2026-10-12T21:00:00+08:00');true")
  await wait(`${capacity}!==${JSON.stringify(initialTime)}`)
  await check('focus updates remaining time to the current clock', `${capacity}.includes('1 小时')`)
  const beforeTime = await evaluate(capacity)
  await evaluate("window.__calendarQa.setTime('2026-10-12T21:01:00+08:00');true")
  await wait(`${capacity}!==${JSON.stringify(beforeTime)}`)
  await check('clock minute invalidates cached remaining time', `${capacity}!==${JSON.stringify(beforeTime)}`)
  await evaluate("window.__calendarQa.setTime('2026-10-13T00:00:00+08:00');true")
  await wait("document.querySelector('[data-period-current=true] .pl-calendar-day[aria-current=date]')?.dataset.date==='2026-10-13'")
  await check('midnight updates today without losing selected date', "document.querySelector('.planner').dataset.selectedDate==='2026-10-12'")
}
try {
  await mkdir(output, { recursive: true })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen)); base = `http://127.0.0.1:${server.address().port}/`
  const profile = join(temporary, 'chrome-profile')
  chrome = spawn(process.env.CALENDAR_SWITCH_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' })
  let debugPort, startupError
  chrome.on('error', error => { startupError = error })
  for (let i = 0; i < 150; i++) {
    if (startupError) throw startupError
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break } catch {}
    if (chrome.exitCode !== null) throw Error(`Owned Chrome exited ${chrome.exitCode}`)
    await delay(100)
  }
  assert.ok(debugPort)
  const target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(r => r.json())).find(e => e.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
  ws.onmessage = event => {
    const value = JSON.parse(event.data)
    if (value.method === 'Tracing.tracingComplete') traceComplete?.(value.params)
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
    if (value.method === 'Fetch.requestPaused') {
      const { requestId, request } = value.params
      if (!request.url.startsWith(base)) {
        blockedRequests.push(request.url)
        void send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {})
      } else void send('Fetch.continueRequest', { requestId }).catch(error => { if (!stopping) errors.push(String(error)) })
    }
    const callback = pending.get(value.id)
    if (callback) { pending.delete(value.id); clearTimeout(callback.timeout); value.error ? callback.no(value.error) : callback.yes(value.result) }
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Profiler.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await send('Emulation.setDeviceMetricsOverride', { width: 1473, height: 944, deviceScaleFactor: 2, mobile: false })
  if (process.env.CALENDAR_SWITCH_QA_UA) await send('Emulation.setUserAgentOverride', { userAgent: process.env.CALENDAR_SWITCH_QA_UA })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation })
  for (const variant of variants) {
    const [theme, glass] = variant.split('-')
    assert.ok(['dark','light'].includes(theme) && ['clear','soft'].includes(glass))
    db.setPreference('app', { ...preferences, theme, glass })
    await send('Page.navigate', { url: base }); await wait('!!window.__ASTARIA_P0__ && !!document.querySelector(".home-brand")')
    await nav('余时'); await wait('document.querySelectorAll(".free-time-goal-list li").length===4 && !window.__ASTARIA_P0__.getSnapshot().cameraTransition')
    await delay(600)
    for (const mode of ['week','month']) {
      for (let round = 0; round < rounds; round++) {
        if (round === 0) {
          await send('Profiler.start')
          if (captureTrace) await send('Tracing.start', { categories: 'devtools.timeline,blink,cc,gpu,disabled-by-default-devtools.timeline.frame', transferMode: 'ReturnAsStream' })
        }
        const sample = await nav('日程', true)
        if (round === 0) {
          await writeFile(join(output, `${variant}-${mode}-switch.cpuprofile`), JSON.stringify((await send('Profiler.stop')).profile))
          if (captureTrace) {
            const complete = new Promise(yes => { traceComplete = yes })
            await send('Tracing.end')
            const { stream } = await complete
            let contents = ''
            for (;;) { const chunk = await send('IO.read', { handle: stream }); contents += chunk.data; if (chunk.eof) break }
            await send('IO.close', { handle: stream }); traceComplete = null
            await writeFile(join(output, `${variant}-${mode}-switch.trace.json`), contents)
          }
        }
        await wait('!!document.querySelector(".planner[data-active=true] .pl-board")')
        const actualMode = await evaluate('document.querySelector(".planner").dataset.mode')
        samples.push({ variant, mode: actualMode, round, ...sample })
        console.log(JSON.stringify({ variant, mode: actualMode, round, rafMaxMs: sample.rafMaxMs, dateConstructions: sample.dateConstructions, longTasks: sample.longTasks, encodes: sample.encodes }))
        await check(`${variant}/${mode}/${round}: full-quality workspace budget`, `window.__ASTARIA_P0__.getSnapshot().quality==='ultra'&&window.__ASTARIA_P0__.getSnapshot().targetFps===30`)
        await check(`${variant}/${mode}/${round}: departing free time cannot sample or receive input`, `document.querySelector('.free-time-page').inert&&[...document.querySelectorAll('.free-time-page .home-glass-surface')].every(e=>getComputedStyle(e).backdropFilter==='none')`)
        await writeFile(join(output, `${variant}-${actualMode}-${round}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
        if (mode === 'week' && round === rounds - 1) {
          await evaluate('document.querySelector(".pl-segment [data-mode=month]").click();true')
          await wait('document.querySelectorAll("[data-period-current=true] .pl-calendar-day").length===42')
        }
        await evaluate('window.__calendarPlannerNode=document.querySelector(".planner .pl-period-track");true')
        await nav('余时'); await delay(400)
      }
    }
    await evaluate('document.querySelector(".free-time-viewport").scrollTop=160;window.__calendarFreeNode=document.querySelector(".free-time-page");window.__calendarFreeScroll=document.querySelector(".free-time-viewport").scrollTop;true')
    await nav('日程'); await delay(400)
    await check(`${variant}: retained calendar node`, 'document.querySelector(".planner .pl-period-track")===window.__calendarPlannerNode')
    await nav('余时'); await delay(400)
    await check(`${variant}: retained free-time node and scroll`, 'document.querySelector(".free-time-page")===window.__calendarFreeNode&&Math.abs(document.querySelector(".free-time-viewport").scrollTop-window.__calendarFreeScroll)<1')
  }
  assert.deepEqual(errors, []); assert.deepEqual(db.getPlanner(), plannerBefore, 'navigation leaves saved arrangements untouched')
  if (regression) { await regressionChecks(); assert.deepEqual(errors, []) }
  const buildAssets = []
  for (const name of ['index.html', ...(await readdir(join(root, 'assets'))).filter(n => /\.(js|css)$/.test(n)).map(n => `assets/${n}`)]) {
    const bytes = await readFile(join(root, name)); buildAssets.push({ name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
  }
  const gpu = await evaluate(`(()=>{const gl=document.createElement('canvas').getContext('webgl2'),d=gl?.getExtension('WEBGL_debug_renderer_info');return{userAgent:navigator.userAgent,renderer:d?gl.getParameter(d.UNMASKED_RENDERER_WEBGL):null,width:innerWidth,height:innerHeight,dpr:devicePixelRatio}})()`)
  const report = { ok: true, checkedAt, root, regression, fixture: { tasks: 124, blocks: 120, goals: 4, date: today }, gpu, checks, samples, errors, blockedRequests, buildAssets,
    limitations: ['Browser RAF and CPU diagnostics do not measure final screen presentation or power.', 'User-agent override is a glass-path simulation, not Windows hardware validation.'] }
  await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2)+'\n')
  console.log(JSON.stringify({ ok: true, output, samples: samples.length, checks: checks.length, gpu }))
} finally {
  stopping = true; ws?.close(); chrome?.kill('SIGTERM'); server.closeAllConnections()
  await new Promise(resolveClose => server.close(resolveClose)); await service.close(); mock.timers.reset()
  if (chrome) await new Promise(resolveExit => { if (chrome.exitCode !== null) resolveExit(); else { chrome.once('exit', resolveExit); setTimeout(resolveExit, 3000) } })
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
