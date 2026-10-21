/**
 * Real production-mobile integration acceptance, with fictional data only.
 * Usage: node scripts/verify-mobile-shell.mjs [dist-mobile] [shell-ui/run-name]
 * Optional: --mode=functional|performance|all --widths=320,390,820
 *           --stages=matrix,details,states (default: all three)
 * Builds are never run here. A hashed copy of the supplied dist is served.
 * IME and app-activity events are simulations, not native-device evidence.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDatabase } from '../server/database.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2), positional = args.filter(a => !a.startsWith('--'))
const option = (key, fallback) => args.find(a => a.startsWith(`--${key}=`))?.split('=')[1] ?? fallback
const dist = resolve(root, positional[0] ?? 'dist-mobile')
const allowedOutput = join(root, 'artifacts/mobile-rebuild-2026-10-15/shell-ui')
const output = resolve(root, positional[1] ?? join(allowedOutput, new Date().toISOString().replaceAll(':', '-')))
assert.ok(output.startsWith(`${allowedOutput}${sep}`), 'Use a new run directory below artifacts/mobile-rebuild-2026-10-15/shell-ui')
const mode = option('mode', 'all'), widths = option('widths', '320,390,820').split(',').map(Number)
const stages = option('stages', 'matrix,details,states').split(',')
assert.ok(['all', 'functional', 'performance'].includes(mode))
assert.ok(widths.every(n => [320, 390, 820].includes(n)))
assert.ok(stages.every(s => ['matrix','details','states'].includes(s)))
const served = join(output, 'served-dist'), date = '2026-10-15', at = `${date}T08:00:00+08:00`
const ua = 'Mozilla/5.0 (Linux; Android 12; wv) AppleWebKit/537.36 Chrome/154.0.0.0 Mobile Safari/537.36'
const delay = ms => new Promise(yes => setTimeout(yes, ms))
const hash = value => createHash('sha256').update(value).digest('hex')
const safe = value => value.replace(/[^a-zA-Z0-9._-]/g, '-')
const report = {
  schema: 1, status: 'running', startedAt: new Date().toISOString(), dist, output, mode, widths, stages,
  contract: 'BlackHolePrototype + HomeWorkspace, original brand/chat/horizon; MobileCalendar inside original glass',
  scope: 'Mac headless Chrome / production mobile Worker / fictional imported backups only',
  limitations: ['IME uses overridden DOM viewport getters and real resize/scroll events; not a real keyboard',
    'Native inactive signal is simulated; no iOS/Android device verification',
    'Screenshots and geometry do not prove smooth display FPS, power consumption or recognition accuracy',
    'No model configured or external model calls; no real app/profile/database or private inputs read'],
  functional: [], geometric: [], screenshots: [], hitTests: [], animationSamples: [], visualPending: [], sessions: [],
}
const saveJSON = (name, value) => writeFile(join(output, name), JSON.stringify(value, null, 2))
const record = (section, id, status, detail, location) => {
  report[section].push({ id, status, detail, location })
  console.log(`${status.toUpperCase()} ${id}${status === 'fail' ? `: ${typeof detail === 'string' ? detail.slice(0, 350) : JSON.stringify(detail).slice(0, 350)}` : ''}`)
}
async function inventory(directory) {
  const files = []
  async function walk(path) {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.isFile()) { const bytes = await readFile(full); files.push({ path: relative(directory, full), bytes: bytes.length, sha256: hash(bytes) }) }
      else throw Error(`Refuse non-regular build entry: ${full}`)
    }
  }
  await walk(directory)
  return { hash: hash(JSON.stringify(files)), files }
}
function fixture(kind = 'baseline') {
  const db = createDatabase(':memory:')
  try {
    db.setPreference('onboarding-completed', true)
    db.setPreference('free-time-daily', { date, completedAt: at })
    const act = action => db.updatePlanner(action, db.getPlanner().revision)
    act({ type: 'import-routines', routines: [{ id: 'qa-window', title: '学习', kind: 'available', weekdays: [0,1,2,3,4,5,6], start: '08:00', end: '22:00', location: '', items: [], enabled: true }] })
    if (kind !== 'empty') {
      for (let i = 0; i < 40; i++) {
        const task = db.createTask({ title: kind === 'dense' && i === 0 ? `虚构长标题 Econ1234567890 / ${'请核对完整课程资料与截止时间'.repeat(6)}` : `隔离验收事项 ${i + 1}`, estimateMin: 25, due: '2026-10-22', inbox: false })
        if (i < 16) act({ type: 'save-block', block: { id: `qa-slot-${i}`, taskId: task.id, date: i < 8 ? date : '2026-10-16', start: `${String(9 + i % 8).padStart(2, '0')}:00`, end: `${String(9 + i % 8).padStart(2, '0')}:25`, locked: false } })
      }
      for (let i = 0; i < 60; i++) {
        const requestId = `qa-chat-${i}`
        db.appendMessage({ conversationId: 'main', requestId, role: 'user', content: `一起核对第 ${i + 1} 项资料` })
        db.appendMessage({ conversationId: 'main', requestId, role: 'assistant', content: `## 第 ${i + 1} 项安排\n\n${'这段是用于检查长对话滚动、输入与页面切换的虚构内容。'.repeat(20)}\n\n- 保留截止时间\n- 核对真实空档\n- 完成后给出回执\n\n**已有资料保持完整。**` })
      }
    } else {
      // A real empty timetable/empty chat, rather than hiding existing content.
      for (const routine of db.getPlanner().routines) act({ type: 'delete-routine', id: routine.id })
    }
    db.ensureConversation('main'); db.selectConversation('main')
    return db.exportData()
  } finally { db.close() }
}
const instrument = `{
 const NativeDate=Date;window.Date=class extends NativeDate{constructor(...a){super(...(a.length?a:[NativeDate.parse('${at}')]));}static now(){return NativeDate.parse('${at}')}};
 localStorage.setItem('astaria-sqlite-migration-v1','complete');sessionStorage.setItem('astaria-xixi-conversation-v1','main');
 const qa=window.__shellQA={longTasks:[],encodes:[],rects:0,workerNames:[],localCalls:0,viewportWrites:0,calls:[],ime:null,inputs:[]};
 document.addEventListener('pointerdown',event=>qa.inputs.push({at:performance.now(),type:event.pointerType,target:event.target.closest?.('button')?.className??event.target.tagName}),true);
 new PerformanceObserver(list=>qa.longTasks.push(...list.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});
 const encode=HTMLCanvasElement.prototype.toDataURL;HTMLCanvasElement.prototype.toDataURL=function(...a){const t=performance.now(),v=encode.apply(this,a);qa.encodes.push({width:this.width,height:this.height,ms:performance.now()-t});return v};
 const rect=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(...a){qa.rects++;return rect.apply(this,a)};
 const NativeWorker=Worker;window.Worker=class extends NativeWorker{constructor(u,o){super(u,o);qa.workerNames.push(o?.name??String(u))}};
 const post=NativeWorker.prototype.postMessage;NativeWorker.prototype.postMessage=function(m,...args){if(m?.kind==='call'){qa.localCalls++;qa.calls.push({path:m.path,hasInput:m.input!==undefined,at:performance.now()})}return post.call(this,m,...args)};
 const property=CSSStyleDeclaration.prototype.setProperty;CSSStyleDeclaration.prototype.setProperty=function(n,...a){if(n==='--mobile-viewport-height')qa.viewportWrites++;return property.call(this,n,...a)};
 const height=Object.getOwnPropertyDescriptor(window,'innerHeight');Object.defineProperty(window,'innerHeight',{configurable:true,get:()=>qa.ime?.innerHeight??(height.get?height.get.call(window):height.value)});
 for(const key of ['height','offsetTop']){const v=visualViewport;const d=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(v),key);Object.defineProperty(v,key,{configurable:true,get:()=>qa.ime?.[key]??d.get.call(v)})}
}`

class Chrome {
  constructor(name) { this.name = name; this.pending = new Map(); this.serial = 0; this.errors = []; this.network = []; this.animations = [] }
  async open(base) {
    this.base = base
    const profile = join(output, `.chrome-${this.name}`)
    await mkdir(profile, { recursive: true }); this.profile = profile
    this.child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-extensions', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', 'about:blank'], { stdio: 'ignore' })
    this.child.on('error', e => { this.spawnError = e })
    let port
    for (let i = 0; i < 180; i++) { if (this.spawnError) throw this.spawnError; try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break } catch {} await delay(100) }
    assert.ok(port, 'isolated Chrome debugging port')
    const target = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(t => t.type === 'page')
    this.socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((yes, no) => { this.socket.onopen = yes; this.socket.onerror = no })
    this.socket.onmessage = event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id)
      if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.no(Error(JSON.stringify(message.error))) : pending.yes(message.result) }
      if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails)
      if (message.method === 'Animation.animationStarted') this.animations.push(message.params.animation)
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params, allowed = request.url.startsWith(`${base}/`) || /^(data|blob):/.test(request.url)
        if (!allowed) this.network.push(request.url)
        void this.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }).catch(() => {})
      }
    }
    for (const method of ['Page.enable', 'Runtime.enable', 'Performance.enable', 'Animation.enable']) await this.send(method)
    await this.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await this.send('Network.enable'); await this.send('Network.setBypassServiceWorker', { bypass: true })
    await this.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
    await this.send('Emulation.setUserAgentOverride', { userAgent: ua })
    // Functional runs must stay a visible foreground tab. A hidden headless
    // target stops real renderer frames and cannot establish animation readiness.
    // Performance retains the baseline's focus-emulation setting (disabled).
    this.focusEmulation = this.name.startsWith('functional')
    if (this.focusEmulation) await this.send('Emulation.setFocusEmulationEnabled', { enabled: true })
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: instrument })
    this.version = await this.send('Browser.getVersion')
    return this
  }
  send(method, params = {}) {
    return new Promise((yes, no) => {
      const id = ++this.serial, timer = setTimeout(() => { this.pending.delete(id); no(Error(`CDP timeout ${method}`)) }, 30000)
      this.pending.set(id, { yes, no, timer }); this.socket.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  async wait(expression, ms = 20000) {
    const start = performance.now()
    do { if (await this.eval(expression)) return; await delay(60) } while (performance.now() - start < ms)
    throw Error(`Timeout waiting for ${expression}`)
  }
  async size(width, height = width === 820 ? 1180 : 844, rate = 1) {
    this.width = width; this.height = height
    await this.send('Emulation.setCPUThrottlingRate', { rate })
    await this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: true })
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
  }
  async load(backup, appearance) {
    await this.send('Page.bringToFront')
    await this.send('Page.navigate', { url: this.base })
    await this.wait("!!window.__ASTARIA_P0__ && !!document.querySelector('.home-brand')")
    if (backup) {
      await this.api('data/import', { backup, confirmed: true })
      // The real backup format intentionally excludes onboarding-completed.
      // Set this fixture's explicit true through the real Worker API, rather
      // than modifying its checksum/schema or relying on app-default migration.
      await this.api('onboarding', { completed: true })
      assert.equal((await this.api('onboarding')).completed, true)
    }
    if (appearance) { const expected = await this.api('preferences'); await this.api('preferences', { expected, value: { ...expected, ...appearance } }) }
    const reloadStarted = performance.now()
    await this.send('Page.reload')
    await this.wait("!!window.__ASTARIA_P0__ && !!document.querySelector('.home-brand') && !document.querySelector('.first-run')")
    this.startupReady = { nodeWallMs: performance.now() - reloadStarted, pagePerformanceMs: await this.eval('performance.now()'), predicate: 'renderer + original brand + no onboarding', pollIntervalMs: 60 }
    await delay(1000)
  }
  api(path, input, allowError = false) {
    return this.eval(`(async()=>{const r=await fetch('/api/${path}',{method:${JSON.stringify(input === undefined ? 'GET' : 'POST')},headers:{'X-ASTaria-Local':'1','Content-Type':'application/json'},${input === undefined ? '' : `body:JSON.stringify(${JSON.stringify(input)}),`}});const data=await r.json();${allowError ? 'return {status:r.status,ok:r.ok,data}' : 'if(!r.ok)throw Error(data.error);return data'}})()`)
  }
  async click(selector, text) {
    // Controls deliberately stay inert through their real exit/entry motion.
    // Wait for that contract, then keep the same actual coordinate hit test.
    await this.wait(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(text)}`});return !!e&&!e.disabled&&!e.closest('[inert],[hidden],[aria-hidden=true]')&&getComputedStyle(e).visibility==='visible'})()`)
    const found = await this.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(text)}`});e.scrollIntoView({block:'nearest',inline:'nearest'});return true})()`)
    assert.ok(found)
    await delay(70)
    const hit = await this.eval(`(()=>{const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>${text === undefined ? 'true' : `e.textContent.trim()===${JSON.stringify(text)}`}),r=e.getBoundingClientRect(),s=getComputedStyle(e);const x=Math.min(innerWidth-2,Math.max(2,r.left+r.width/2)),y=Math.min(${this.height}-2,Math.max(2,r.top+r.height/2)),top=document.elementFromPoint(x,y);return {selector:${JSON.stringify(selector)},text:${JSON.stringify(text ?? '')},x,y,rect:r.toJSON(),visibility:s.visibility,display:s.display,hit:!!top&&(top===e||e.contains(top)),top:top?.outerHTML.slice(0,350),active:document.activeElement?.outerHTML.slice(0,150)}})()`)
    report.hitTests.push({ session: this.name, ...hit })
    assert.ok(hit.hit && hit.visibility === 'visible' && hit.display !== 'none', `Hit obscured: ${JSON.stringify(hit)}`)
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: hit.x, y: hit.y }] })
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    return hit
  }
  async ready(selector, ms = 15000) {
    await this.wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled||e.closest('[inert]'))return false;const s=getComputedStyle(e),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return s.visibility==='visible'&&s.pointerEvents!=='none'&&r.width>0&&r.height>0&&!!hit&&(hit===e||e.contains(hit))})()`, ms)
  }
  async nav(label, settle = 1100) {
    const navigationStarted = performance.now()
    if (await this.eval("document.querySelector('#home-menu').inert")) { await this.click('.home-brand'); await this.wait("!document.querySelector('#home-menu').inert"); await delay(300) }
    await this.click('#home-menu button', label)
    const dispatchedAt = performance.now()
    const pages = { 首页: 'home', 工作台: 'workbench', 日程: 'schedule', 余时: 'free-time', 设置: 'settings' }
    await this.wait(`document.querySelector('.home-workspace').dataset.page===${JSON.stringify(pages[label])}`)
    const ready = {
      首页: "!!document.querySelector('.home-current') && !document.querySelector('.home-scene-ui').inert",
      工作台: "!!document.querySelector('.workbench[data-active=true] .wb-scroll') && ['ready','empty'].includes(document.querySelector('.workbench[data-active=true] .wb-scroll').dataset.guideState)",
      日程: "!!document.querySelector('.mobile-schedule-workspace[data-active=true] .m-calendar-view') && (document.querySelectorAll('.m-calendar-week-summary').length===7||!!document.querySelector('.m-calendar-day-heading')||!!document.querySelector('.m-calendar-month-grid'))",
      余时: "!!document.querySelector('.free-time-page[data-active=true] .free-time-viewport')",
      设置: "document.querySelectorAll('.xixi-settings-directory button').length===6",
    }
    await this.wait(ready[label])
    const pageSelector = { 首页: '.home-scene-ui', 工作台: '.workbench[data-active=true] .wb-scroll', 日程: '.mobile-schedule-workspace[data-active=true]', 余时: '.free-time-page[data-active=true]', 设置: '.xixi-settings' }[label]
    await this.wait(`(()=>{const p=document.querySelector(${JSON.stringify(pageSelector)});return !!p&&[...p.querySelectorAll('button:not(:disabled)')].some(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect(),x=r.left+r.width/2,y=r.top+r.height/2,hit=document.elementFromPoint(x,y);return !e.closest('[inert],[hidden],[aria-hidden=true]')&&s.visibility==='visible'&&s.pointerEvents!=='none'&&r.width>0&&r.height>0&&hit&&(hit===e||e.contains(hit))})})()`)
    const interactiveAt = performance.now(), state = await this.pageCounts()
    const timing = { label, fromNavigationStartMs: interactiveAt - navigationStarted, afterTouchDispatchMs: interactiveAt - dispatchedAt, fromPagePointerDownMs: state.performanceNow - state.lastPointerDown.at, predicate: ready[label], interactive: 'at least one enabled page button passes elementFromPoint', pollIntervalMs: 60, state }
    if (this.name === 'performance') await delay(Math.max(0, settle - (performance.now() - dispatchedAt)))
    return timing
  }
  pageCounts() {
    return this.eval(`(()=>{const q=s=>document.querySelectorAll(s).length,visible=e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[hidden],[inert],[aria-hidden=true]');return {performanceNow:performance.now(),lastPointerDown:__shellQA.inputs.at(-1)??{at:performance.now()},page:document.querySelector('.home-workspace')?.dataset.page,counts:{originalRoots:q('.p0 .home-workspace'),desktopPlanners:q('.planner'),mobileSchedules:q('.mobile-schedule-workspace'),weekSummaries:q('.m-calendar-week-summary'),dayEntries:q('.m-calendar-entry'),renderedMessages:q('#home-xixi .xixi-message'),chatCharacters:document.querySelector('#home-xixi .xixi-conversation')?.textContent.length??0,workbenchButtons:q('.workbench button'),mountedPages:q('.workbench,.mobile-schedule-workspace,.free-time-page,.xixi-settings'),visibleControls:[...document.querySelectorAll('button')].filter(visible).length},workbenchState:document.querySelector('.wb-scroll')?.dataset.guideState,render:__ASTARIA_P0__.getSnapshot()}})()`)
  }
  async input(selector, value) {
    await this.click(selector)
    await this.eval(`{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new Event('change',{bubbles:true}));true}`)
  }
  async key(key, code = key) {
    const windowsVirtualKeyCode = ({ Enter:13, Escape:27, Home:36, End:35, ArrowLeft:37, ArrowUp:38, ArrowRight:39, ArrowDown:40 })[key] ?? 0
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode })
  }
  snapshot() { return this.eval(`(()=>{const rect=s=>document.querySelector(s)?.getBoundingClientRect().toJSON(),c=document.querySelector('.p0-universe canvas'),gl=c?.getContext('webgl2'),css=getComputedStyle(document.documentElement);return {page:document.querySelector('.home-workspace')?.dataset.page,visibilityState:document.visibilityState,documentHidden:document.hidden,mobileActive:document.documentElement.dataset.mobileActive,hasFocus:document.hasFocus(),innerWidth,innerHeight,visual:{height:visualViewport.height,offsetTop:visualViewport.offsetTop},keyboard:document.documentElement.dataset.mobileKeyboard,layoutHeight:css.getPropertyValue('--m-layout-height'),visibleHeight:css.getPropertyValue('--m-visible-height'),offsetTop:css.getPropertyValue('--m-visible-offset-top'),p0:rect('.p0'),universe:rect('.p0-universe'),morph:rect('.home-morph'),compose:rect('#home-compose'),canvas:c?{width:c.width,height:c.height,drawingBufferWidth:gl?.drawingBufferWidth,drawingBufferHeight:gl?.drawingBufferHeight}:null,render:window.__ASTARIA_P0__?.getSnapshot(),active:document.activeElement?.outerHTML.slice(0,350)}})()`) }
  async shot(id, metadata = {}) {
    const file = `screenshots/${safe(id)}.png`
    const png = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, fromSurface: true })
    await writeFile(join(output, file), Buffer.from(png.data, 'base64'))
    const state = await this.snapshot()
    await saveJSON(`screenshots/${safe(id)}.json`, { ...metadata, ...state })
    report.screenshots.push({ id, file, session: this.name, width: this.width, height: this.height, ...metadata })
    report.visualPending.push({ id, file, status: 'pending', checks: ['readability over bright background', 'original visual language / font / shape', 'layer separation / crop / wrapping'] })
    return state
  }
  async close() {
    report.sessions.push({ name: this.name, version: this.version, focusEmulation: this.focusEmulation, errors: this.errors, externalRequests: this.network })
    try { await this.send('Browser.close') } catch {}
    this.socket?.close(); for (const p of this.pending.values()) clearTimeout(p.timer)
    if (this.child && this.child.exitCode === null) { this.child.kill(); await Promise.race([new Promise(r => this.child.once('exit', r)), delay(3000)]) }
    if (this.profile) await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

async function check(c, section, id, fn, location) {
  try { const result = await fn(); record(section, id, 'pass', result ?? null, location); return true }
  catch (error) {
    record(section, id, 'fail', { message: error.message, stack: error.stack }, location)
    await c?.shot(`FAIL-${id}`, { error: error.message }).catch(() => {})
    return false
  }
  finally { await saveJSON('report.json', report) }
}

async function hiddenHome(c, id) {
  return check(c, 'geometric', `${id}-home-underlay-hidden`, async () => {
    const data = await c.eval(`(()=>{const page=document.querySelector('.home-workspace')?.dataset.page;return {page,targets:['.home-current','.home-launch'].map(selector=>{const e=document.querySelector(selector);if(!e)return {selector,missing:true};const r=e.getBoundingClientRect(),style=getComputedStyle(e),x=Math.min(innerWidth-1,Math.max(1,r.left+r.width/2)),y=Math.min(innerHeight-1,Math.max(1,r.top+r.height/2)),hit=document.elementFromPoint(x,y),ancestors=[];for(let p=e;p&&ancestors.length<7;p=p.parentElement){const c=getComputedStyle(p);ancestors.push({class:p.className,visibility:c.visibility,display:c.display,opacity:c.opacity,pointerEvents:c.pointerEvents,inert:p.inert,ariaHidden:p.getAttribute('aria-hidden')})}return {selector,visibility:style.visibility,display:style.display,pointerEvents:style.pointerEvents,actualVisible:e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true}),rect:r.toJSON(),point:{x,y},receivesHit:!!hit&&(hit===e||e.contains(hit)),hit:hit?.outerHTML.slice(0,250),ancestors}})}})()`)
    await saveJSON(`geometry/${safe(id)}-home-underlay.json`, data)
    assert.notEqual(data.page, 'home', 'Underlay check requires a non-home page')
    for (const e of data.targets) {
      assert.equal(e.missing, undefined, `Original retained home target missing: ${e.selector}`)
      assert.equal(e.visibility, 'hidden', `Retained ${e.selector} computed visibility is ${e.visibility}; aria/inert does not hide glass underlay`)
      assert.equal(e.actualVisible, false, `Retained home text is visible: ${e.selector}`)
      assert.equal(e.receivesHit, false, `Retained home control receives hit through foreground: ${e.selector}`)
    }
    return data
  }, 'mobile/runtime/mobile.css non-home .home-scene-ui and descendants; actual computed style and elementFromPoint')
}
async function geometry(c, id) {
  await check(c, 'geometric', id, async () => {
    const data = await c.eval(`(()=>{const modal=[...document.querySelectorAll('dialog[open]')].find(e=>e.matches(':modal'));const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return (!modal||modal.contains(e))&&e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>0&&r.height>0&&s.display!=='none'&&s.visibility==='visible'&&!e.closest('[inert],[aria-hidden=true]')};const nodes=[...document.querySelectorAll('.home-brand,.home-menu[data-open=true],.home-morph,.m-calendar,.m-calendar-sheet[open],.xixi-settings-panel,.horizon-studio[open]')].filter(visible);const rows=nodes.map(e=>({selector:e.className,rect:e.getBoundingClientRect().toJSON(),scrollWidth:e.scrollWidth,clientWidth:e.clientWidth}));return {foregroundModal:modal?.className,width:innerWidth,scrollWidth:document.documentElement.scrollWidth,bodyWidth:document.body.scrollWidth,rows,horizontalScrollers:[...document.querySelectorAll('.m-calendar-date-picker,.m-calendar-content,.m-calendar-sheet-body')].filter(visible).map(e=>({class:e.className,scrollWidth:e.scrollWidth,clientWidth:e.clientWidth})),selects:[...document.querySelectorAll('select')].filter(visible).map(e=>({label:e.getAttribute('aria-label'),html:e.outerHTML.slice(0,180)}))}})()`)
    await saveJSON(`geometry/${safe(id)}.json`, data)
    assert.ok(data.scrollWidth <= data.width + 1 && data.bodyWidth <= data.width + 1, `Document horizontal overflow ${JSON.stringify(data)}`)
    const outside = data.rows.filter(r => r.rect.left < -1 || r.rect.right > data.width + 1)
    assert.deepEqual(outside, [], `Foreground outside viewport: ${JSON.stringify(outside)}`)
    assert.deepEqual(data.horizontalScrollers.filter(r => r.scrollWidth > r.clientWidth + 1), [], 'Calendar requires horizontal scrolling')
    return data
  }, 'mobile/runtime/mobile.css; src/home/home.css; mobile/ui/mobile-calendar.css')
}

// Cross-page visual contract: compare the actual mounted shells, including lazy CSS.
async function workspaceStyle(c, id, selector, inkSelector, contentSelector) {
  await c.wait(`(()=>{for(let e=document.querySelector(${JSON.stringify(inkSelector)});e&&!e.classList.contains('home-workspace');e=e.parentElement)if(e.getAnimations({subtree:false}).some(a=>a.playState==='running'))return false;return true})()`)
  const data = await c.eval(`(()=>{const panel=document.querySelector(${JSON.stringify(selector)}),ink=document.querySelector(${JSON.stringify(inkSelector)}),content=document.querySelector(${JSON.stringify(contentSelector)}),surface=panel.querySelector('.home-glass-surface'),back=panel.querySelector('.home-glass-backdrop'),ps=getComputedStyle(panel),cs=getComputedStyle(content),ancestors=[];for(let e=ink;e&&!e.classList.contains('home-workspace');e=e.parentElement){const s=getComputedStyle(e);ancestors.push({class:e.className,transform:s.transform,filter:s.filter,opacity:s.opacity,willChange:s.willChange})}return {panel:panel.getBoundingClientRect().toJSON(),ink:ink.getBoundingClientRect().toJSON(),radius:ps.borderRadius,fill:getComputedStyle(surface).backgroundColor,backdrop:getComputedStyle(back).backdropFilter,padding:cs.paddingLeft,inkSize:getComputedStyle(ink).fontSize,ancestors}})()`)
  c.workspaceStyles ??= []
  c.workspaceStyles.push({ id, ...data })
  await saveJSON(`geometry/${safe(id)}-material.json`, data)
  await check(c, 'geometric', `${id}-settled-ink`, () => {
    assert.deepEqual(data.ancestors.filter(s=>s.transform!=='none'||s.filter!=='none'||s.opacity!=='1'), [], 'Settled text remains under a transformed/filtered/faded ancestor')
    return data
  }, 'actual foreground ancestor/computed styles, after entry motion')
}

// Live spring/GSAP frames are sampled without seeking or freezing production state.
async function motion(c, id, action, selector, stop, timeout = 8000) {
  const before = await c.snapshot(), start = performance.now(), samples = []
  await action()
  for (const offset of [0, 120, 450]) {
    if (offset) await delay(offset === 120 ? 120 : 330)
    const state = await c.shot(`${id}-${offset}ms`, { motion: id, elapsedMs: performance.now() - start })
    samples.push({ elapsedMs: performance.now() - start, state })
  }
  await c.wait(stop, timeout); await delay(100)
  samples.push({ elapsedMs: performance.now() - start, state: await c.shot(`${id}-end`, { motion: id }) })
  report.animationSamples.push({ id, technique: 'live CDP screenshots; actual elapsed timing; no renderer/time/quality changes', selector, before, samples })
}

async function ime(c, id, selector = '#home-compose') {
  return check(c, 'functional', id, async () => {
    await c.wait('!__ASTARIA_P0__.getSnapshot().cameraTransition')
    await c.click(selector); await delay(120)
    const before = await c.snapshot(), states = []
    await saveJSON(`${safe(id)}.json`, { simulation: true, before, states })
    assert.equal(before.keyboard, 'closed')
    // Scale occlusion with the viewport height, including the taller foldable.
    // Otherwise a tall viewport may still have more room than the closed max-height.
    for (const v of [{ innerHeight: c.height - 40, height: c.height - 40, offsetTop: 0 }, { innerHeight: Math.round(c.height * 624 / 844), height: Math.round(c.height * 504 / 844), offsetTop: 36 }, { innerHeight: Math.round(c.height * 544 / 844), height: Math.round(c.height * 454 / 844), offsetTop: 62 }]) {
      await c.eval(`{window.__shellQA.ime=${JSON.stringify(v)};window.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('scroll'));true}`)
      await delay(250)
      const state = await c.snapshot(); states.push(state)
      await saveJSON(`${safe(id)}.json`, { simulation: true, before, states })
      assert.equal(state.layoutHeight, before.layoutHeight, 'IME changed layout-height CSS variable')
      assert.equal(state.p0.height, before.p0.height, 'IME resized original p0 layout')
      assert.equal(state.universe.height, before.universe.height, 'IME resized universe CSS height')
      assert.deepEqual(state.canvas, before.canvas, 'IME changed canvas/drawingBuffer')
      assert.equal(state.render.quality, before.render.quality, 'IME changed visible rendering quality')
    }
    const opened = states.at(-1)
    await c.shot(`${id}-open`, { keyboard: 'DOM viewport simulation, not native keyboard' })
    assert.equal(opened.keyboard, 'open')
    assert.equal(parseInt(opened.offsetTop), 62)
    assert.ok(parseInt(opened.visibleHeight) < parseInt(before.visibleHeight))
    if (selector === '#home-compose') {
      assert.ok(opened.morph.height < before.morph.height, 'Foreground chat did not shrink')
      assert.ok(opened.compose.top >= 62 && opened.compose.bottom <= 62 + parseInt(opened.visibleHeight) + 1, `Composer obscured by simulated keyboard: ${JSON.stringify(opened.compose)}`)
    }
    await c.eval("{window.__shellQA.ime=null;window.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('scroll'));true}")
    await delay(500)
    const restored = await c.shot(`${id}-restored`)
    await saveJSON(`${safe(id)}.json`, { simulation: true, before, states, restored })
    assert.equal(restored.keyboard, 'closed'); assert.equal(restored.layoutHeight, before.layoutHeight)
    assert.equal(restored.visibleHeight, before.visibleHeight); assert.deepEqual(restored.canvas, before.canvas)
    if (selector === '#home-compose') assert.ok(Math.abs(restored.morph.height - before.morph.height) <= 1, 'Chat height did not recover')
    await saveJSON(`${safe(id)}.json`, { simulation: true, before, states, restored })
    return { before: before.canvas, opened: opened.canvas, restored: restored.canvas, keyboard: opened.keyboard }
  }, 'mobile/runtime/viewport.ts; mobile/runtime/mobile.css; src/home/HomeWorkspace.tsx measure')
}

async function performanceRun(base, backup) {
  const c = new Chrome('performance'), samples = []
  const result = { conditions: { cpuSlowdown: 4, viewport: { width: 390, height: 844, dpr: 2 }, userAgent: ua, timezone: 'Asia/Shanghai', fixedDate: at, tasks: 40, messages: 120, renderQuality: 'unmodified auto; record actual snapshots', source: 'same fixture generator/text as verify-mobile-performance.mjs' }, samples }
  const metrics = async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.filter(m => ['TaskDuration','ScriptDuration','LayoutDuration','RecalcStyleDuration','LayoutCount','RecalcStyleCount'].includes(m.name)).map(m => [m.name, m.value]))
  async function measure(label, action, semantics) {
    await delay(350); const before = await metrics()
    await c.eval('window.__shellQA.encodes=[];window.__shellQA.longTasks=[];window.__shellQA.rects=0;window.__shellQA.localCalls=0;window.__shellQA.viewportWrites=0;window.__shellQA.calls=[];window.__shellQA.inputs=[];true')
    const start = performance.now(); let failure
    let actionReady
    try { actionReady = await action() } catch (e) { failure = e.message }
    const after = await metrics(), data = await c.eval('({longTasks:__shellQA.longTasks,encodes:__shellQA.encodes,rects:__shellQA.rects,localCalls:__shellQA.localCalls,viewportWrites:__shellQA.viewportWrites,render:__ASTARIA_P0__.getSnapshot(),workerCalls:__shellQA.calls,realInputs:__shellQA.inputs})')
    samples.push({ label, semantics, failure, wallMs: performance.now() - start, actionReady, pageState: await c.pageCounts(), metrics: Object.fromEntries(Object.keys(before).map(k => [k, after[k] - before[k]])), ...data })
    await saveJSON('performance.json', result)
    if (failure) throw Error(failure)
  }
  try {
    await c.open(base); await c.size(390, 844, 4); await c.load(backup)
    result.startup = await c.eval('({navigation:performance.getEntriesByType("navigation")[0].toJSON(),longTasks:__shellQA.longTasks,workerNames:__shellQA.workerNames,render:__ASTARIA_P0__.getSnapshot()})')
    result.startup.ready = c.startupReady; result.startup.pageState = await c.pageCounts()
    await c.wait("document.querySelectorAll('#home-xixi .xixi-message').length===120")
    await measure('open-chat', async () => {
      await c.ready('.home-launch'); await c.click('.home-launch')
      const dispatchedAt = performance.now()
      await c.wait("!document.querySelector('#home-xixi').inert")
      await c.ready('#home-compose')
      const inputReady = await c.pageCounts(), inputReadyMs = performance.now() - dispatchedAt
      await c.wait("!window.__ASTARIA_P0__.getSnapshot().cameraTransition")
      const settledMs = performance.now() - dispatchedAt
      await delay(300)
      return { inputReadyAfterDispatchMs: inputReadyMs, inputReadyFromPointerDownMs: inputReady.performanceNow - inputReady.lastPointerDown.at, cameraSettledAfterDispatchMs: settledMs, pollIntervalMs: 60, inputReady }
    }, 'Original home-launch to non-inert/hittable chat and camera stopped + 300ms; separate true ready times; coordinate hit validation adds harness overhead')
    await measure('typing-30-updates', async () => {
      for (let i = 1; i <= 30; i++) { await c.eval(`{const e=document.querySelector('#home-compose');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify('保留完整历史，检查手机输入响应'.repeat(2))}.slice(0,${i}));e.dispatchEvent(new Event('input',{bubbles:true}));true}`); await delay(16) }
      return { inputUpdates: 30, finalText: await c.eval("document.querySelector('#home-compose').value"), pageState: await c.pageCounts() }
    }, 'Exactly baseline native textarea value setter + input event, 30 prefixes, 16ms waits; not physical input latency')
    for (let i = 0; i < 2; i++) {
      await measure(`workbench-${i}`, () => c.nav('工作台'), 'Original navigation; real touch + hit test; 1100ms settle; added hit-test overhead')
      await measure(`schedule-${i}`, () => c.nav('日程'), 'Navigation to mobile Calendar; different schedule UI from baseline desktop planner; not same-behavior improvement')
      if (i === 0) {
        if (await c.eval("!!document.querySelector('.m-calendar-month-toggle')")) await c.click('.m-calendar-month-toggle')
        else throw Error('Expected integrated MobileCalendar; desktop planner is not a substitute')
        await delay(500)
      }
      await measure(`free-time-${i}`, () => c.nav('余时'), 'Original navigation; real touch + hit test; 1100ms settle; added hit-test overhead')
    }
    const tasks = await c.api('tasks'), conversation = await c.api('conversation?id=main')
    assert.equal(tasks.length, 40); assert.equal(conversation.messages.length, 120)
    result.counts = { tasks: tasks.length, messages: conversation.messages.length }
    await c.shot('performance-final')
  } catch (error) { result.error = error.message; record('functional', 'performance-run', 'fail', error.message, 'performance.json'); await c.shot('FAIL-performance').catch(() => {}) }
  finally {
    result.version = c.version
    const baselineFile = join(root, 'artifacts/mobile-rebuild-2026-10-15/baseline-performance/result.json')
    try {
      const bytes = await readFile(baselineFile), baseline = JSON.parse(bytes)
      result.baseline = { path: relative(root, baselineFile), sha256: hash(bytes), cpuSlowdown: baseline.cpuSlowdown, viewport: baseline.viewport, quality: baseline.startup.render.quality, samples: baseline.samples.map(s => ({ label: s.label, wallMs: s.wallMs, metrics: s.metrics })) }
      result.comparability = { environmentConditionsMatch: baseline.cpuSlowdown === 4 && baseline.viewport.width === 390 && baseline.viewport.height === 844 && baseline.viewport.dpr === 2, startup: 'Same imported fixture, reload + readiness + 1000ms; raw navigation/long-task samples retained', typing: 'Same scripted input operation and 16ms interval; inspect actual quality snapshots before comparison', openChat: 'Same component and ready predicate; coordinate hit validation introduces harness cost', schedule: 'MobileCalendar replaces desktop planner; changed behavior, no like-for-like speedup claim', background: 'Record actual policy/frames; no visible-quality or power benefit inferred', conclusion: 'Raw observations only; no percentage improvement claim' }
    } catch (e) { result.baselineError = e.message }
    await saveJSON('performance.json', result); report.performance = result
    await c.close()
  }
}

async function calendar(c, id) {
  const settled = () => c.wait("document.querySelector('.m-calendar-period-window')?.dataset.moving==='false'")
  const calendarClick = async (...args) => { await c.click(...args); await settled() }
  if (!await check(c, 'functional', `${id}-calendar-root`, async () => {
    await c.nav('日程')
    await hiddenHome(c, `${id}-schedule`)
    await c.wait("!!document.querySelector('.mobile-schedule-workspace[data-active=true] .m-calendar')", 5000)
    assert.equal(await c.eval("document.querySelectorAll('.planner').length"), 0, 'Desktop PlannerWorkspace mounted in mobile root')
    assert.equal(await c.eval("document.querySelector('.m-calendar-view [aria-pressed=true]').dataset.mode"), 'week', 'Default mobile calendar must be week overview')
    await calendarClick('.m-calendar-view [data-mode="week"]')
    const data = await c.eval("({week:document.querySelectorAll('.m-calendar-period-frame[data-current=true] .m-calendar-week .m-calendar-date').length,glass:!!document.querySelector('.m-calendar')?.closest('.pl-glass,.home-morph,.mobile-calendar-glass,.home-glass-panel'),ancestors:(()=>{let e=document.querySelector('.m-calendar'),a=[];for(let i=0;e&&i<5;i++,e=e.parentElement)a.push(e.className);return a})()})")
    assert.equal(data.week, 7)
    assert.equal(await c.eval("document.querySelectorAll('.m-calendar-week-summary').length"), 7, 'Week mode is not a seven-day overview')
    assert.equal(await c.eval("document.querySelectorAll('.m-calendar-timeline').length"), 0, 'Day detail leaked into week overview')
    // Shared GlassSurface may be a sibling; inspect the owning pane, not class names alone.
    const pane = await c.eval("(()=>{const e=document.querySelector('.mobile-schedule-workspace .m-calendar-body');return e?{class:e.className,glass:!!e.querySelector(':scope > .home-glass-measure > .home-glass-surface')}:null})()")
    assert.ok(pane?.glass, `MobileCalendar lacks original GlassSurface: ${JSON.stringify(data)}`)
    return { ...data, pane }
  }, 'src/home/HomeWorkspace.tsx schedule branch; mobile/ui/MobileScheduleWorkspace.tsx')) return
  await c.shot(`${id}-calendar-week`); await geometry(c, `${id}-calendar-week`)
  await check(c, 'functional', `${id}-calendar-week-arrows`, async () => {
    const read = () => c.eval("[...document.querySelectorAll('.m-calendar-period-frame[data-current=true] .m-calendar-week .m-calendar-date')].map(e=>e.getAttribute('aria-label'))")
    const before = await read(); await calendarClick('.m-calendar-period [aria-label="下一周"]')
    const next = await read(); assert.ok(next[0].includes('10月19日'), `Expected week starting Oct 19: ${next[0]}`)
    await calendarClick('.m-calendar-period [aria-label="上一周"]'); assert.deepEqual(await read(), before)
    return { before, next }
  }, 'mobile/ui/MobileCalendar.tsx week navigation')
  await check(c, 'functional', `${id}-calendar-month`, async () => {
    await calendarClick('.m-calendar-view [data-mode="month"]'); await c.wait("document.querySelector('.m-calendar-month-toggle').getAttribute('aria-expanded')==='true'")
    const count = await c.eval("document.querySelectorAll('.m-calendar-month-grid .m-calendar-date').length")
    assert.ok(count >= 28); await c.shot(`${id}-calendar-month`); await geometry(c, `${id}-calendar-month`)
    await calendarClick('.m-calendar-period [aria-label="下个月"]')
    assert.ok(await c.eval("document.querySelector('.m-calendar-month-toggle').textContent.includes('11月')"))
    await calendarClick('.m-calendar-period [aria-label="上个月"]')
    assert.ok(await c.eval("document.querySelector('.m-calendar-month-toggle').textContent.includes('10月')"))
    await calendarClick('.m-calendar-month-grid .m-calendar-date[aria-current="date"]')
    assert.equal(await c.eval("document.querySelector('.m-calendar-view [aria-pressed=true]').dataset.mode"), 'day')
    assert.ok(await c.eval("!!document.querySelector('.m-calendar-day-heading')&&!document.querySelector('.m-calendar-month-grid')"))
    await c.shot(`${id}-calendar-day`); await geometry(c, `${id}-calendar-day`)
    return { monthDates: count, selectingMonthDateOpensDay: true }
  }, 'mobile/ui/MobileCalendar.tsx')
  await check(c, 'functional', `${id}-calendar-date-and-menu`, async () => {
    await calendarClick('.m-calendar-week .m-calendar-date[aria-label*="10月16日"]')
    assert.ok(await c.eval("document.querySelector('.m-calendar-day-heading h2').textContent.includes('10月16日')"))
    await c.shot(`${id}-calendar-tomorrow`)
    await calendarClick('.m-calendar-period [aria-label="后一天"]')
    assert.ok(await c.eval("document.querySelector('.m-calendar-day-heading h2').textContent.includes('10月17日')"))
    await calendarClick('.m-calendar-period [aria-label="前一天"]')
    assert.ok(await c.eval("document.querySelector('.m-calendar-day-heading h2').textContent.includes('10月16日')"))
    await calendarClick('.m-calendar-return-week')
    assert.equal(await c.eval("document.querySelectorAll('.m-calendar-week-summary').length"), 7)
    await calendarClick('.m-calendar-view [data-mode="day"]')
    await calendarClick('.m-calendar-actions .m-calendar-button', '今天')
    await motion(c, `${id}-calendar-menu-enter`, () => c.click('[aria-label="打开日程菜单"]'), '.m-calendar-sheet', "!!document.querySelector('.m-calendar-sheet[open]')")
    assert.equal(await c.eval("getComputedStyle(document.querySelector('.m-calendar-content')).visibility"), 'hidden')
    await geometry(c, `${id}-calendar-menu`)
    await calendarClick('.m-calendar-sheet [aria-label="返回日程"]'); await c.wait("!document.querySelector('.m-calendar-sheet[open]')")
    return { selectedTomorrow: true, menuUnderlayHidden: true }
  }, 'mobile/ui/MobileCalendar.tsx date selection; CalendarSheet animation')
}

async function functionalRun(base, backup, empty, dense) {
  const c = new Chrome('functional')
  try {
    await c.open(base)
    for (const width of stages.includes('matrix') ? widths : []) for (const theme of ['dark', 'light']) for (const glass of ['clear', 'soft']) {
      const id = `${width}-${theme}-${glass}`
      console.log(`SCENARIO ${id}`)
      await check(c, 'functional', `${id}-scenario`, async () => {
        await c.size(width); await c.load(backup, { theme, glass }); c.workspaceStyles = []
        assert.ok(await c.eval("!!document.querySelector('.p0 .home-workspace') && !document.querySelector('.m-app') && !!document.querySelector('.p0-universe canvas')"))
        const names = await c.eval('__shellQA.workerNames'); assert.ok(names.includes('astaria-local-data')); assert.ok(names.includes('astaria-geodesics'))
        const status = await c.api('status'); assert.equal(status.configured, false)
        assert.ok(await c.eval("document.querySelector('.home-current').innerText.includes('当前') && document.querySelector('.home-launch').textContent==='交给析熙'"))
        await c.shot(`${id}-home`); await geometry(c, `${id}-home`)
        await c.click('.home-brand'); await delay(350)
        const brand = await c.eval("(()=>{const e=document.querySelector('.home-brand'),s=getComputedStyle(e),w=getComputedStyle(e.querySelector('.home-brand-wordmark')),b=[...document.querySelectorAll('#home-menu button')];return {font:s.fontFamily,fontSize:s.fontSize,fontWeight:s.fontWeight,letterSpacing:s.letterSpacing,wordmarkWeight:w.fontWeight,nav:b.map(e=>e.textContent.trim()),selected:b.filter(e=>e.hasAttribute('aria-current')).map(e=>({text:e.textContent,radius:getComputedStyle(e).borderRadius,rect:e.getBoundingClientRect().toJSON()}))}})()")
        await check(c, 'functional', `${id}-original-brand`, async () => {
          assert.deepEqual(brand.nav, ['首页','工作台','日程','余时','设置'])
          // Original home.css and the frozen baseline both specify 12px <=600px.
          assert.equal(brand.fontSize, width <= 600 ? '12px' : '13px'); assert.equal(brand.fontWeight, '500')
          assert.ok(brand.selected.every(b => parseFloat(b.radius) < b.rect.height / 2), 'Navigation selection became circular/pill shaped')
          return brand
        }, 'src/home/home.css @media(max-width:600px); baseline-dist/assets/index-Dsk9l-TD.css')
        await saveJSON(`geometry/${id}-brand.json`, brand); await c.shot(`${id}-brand`)
        await c.click('#home-menu button', '首页'); await delay(400)
        await check(c, 'functional', `${id}-chat-open`, () => motion(c, `${id}-chat-open`, () => c.click('.home-launch'), '.home-morph', "!document.querySelector('#home-xixi').inert && !__ASTARIA_P0__.getSnapshot().cameraTransition"), 'src/home/HomeWorkspace.tsx home-morph')
        await c.wait("document.querySelectorAll('#home-xixi .xixi-message').length===120")
        await c.shot(`${id}-chat-long`); await geometry(c, `${id}-chat-long`)
        await check(c, 'functional', `${id}-history-complete`, async () => {
          const data = await c.eval("(()=>{const e=document.querySelector('#home-xixi .xixi-message'),p=e.querySelector('p'),r=document.createRange();e.scrollIntoView({block:'start'});r.selectNodeContents(p);const s=getSelection();s.removeAllRanges();s.addRange(r);const text=s.toString();s.removeAllRanges();const log=document.querySelector('#home-xixi .xixi-conversation');log.scrollTop=log.scrollHeight;return {count:document.querySelectorAll('#home-xixi .xixi-message').length,text}})()")
          assert.equal(data.count, 120); assert.ok(data.text.includes('一起核对')); return data
        }, 'src/xixi/ConversationLog.tsx')
        await c.input('#home-compose', '虚构草稿：跨页面保留，不发送模型')
        await c.nav('工作台'); await hiddenHome(c, `${id}-workbench`); await workspaceStyle(c, `${id}-workbench`, '.wb-briefing-panel', '.wb-brief-message h3', '.wb-briefing-panel'); await c.shot(`${id}-workbench`); await geometry(c, `${id}-workbench`)
        await calendar(c, id)
        await workspaceStyle(c, `${id}-schedule`, '.m-calendar-body', '.m-calendar-heading h1', '.m-calendar-body-content')
        await c.nav('余时'); await hiddenHome(c, `${id}-free-time`); await workspaceStyle(c, `${id}-free-time`, '.free-time-layout.free-time-pane', '.free-time-goals h3', '.free-time-goals .free-time-pane-content'); await c.shot(`${id}-free-time`); await geometry(c, `${id}-free-time`)
        await c.nav('首页'); await c.wait("!__ASTARIA_P0__.getSnapshot().cameraTransition")
        if (await c.eval("document.querySelector('#home-xixi').inert")) { await c.click('.home-launch'); await c.wait("!document.querySelector('#home-xixi').inert") }
        assert.equal(await c.eval("document.querySelector('#home-compose').value"), '虚构草稿：跨页面保留，不发送模型')
        await ime(c, `${id}-IME`)
        // Always recover a simulated viewport after a failed assertion as well.
        await c.eval("{__shellQA.ime=null;window.dispatchEvent(new Event('resize'));visualViewport.dispatchEvent(new Event('resize'));true}"); await delay(300)
        await c.nav('设置'); await hiddenHome(c, `${id}-settings`); await workspaceStyle(c, `${id}-settings`, '.xixi-settings-panel', '.xixi-settings-directory-entry strong', '.xixi-settings-shell'); await c.shot(`${id}-settings`); await geometry(c, `${id}-settings`)
        await check(c, 'functional', `${id}-settings-native-select`, async () => {
          const selects = await c.eval("[...document.querySelectorAll('.xixi-settings select')].filter(e=>e.getClientRects().length&&getComputedStyle(e).visibility==='visible').map(e=>e.getAttribute('aria-label'))")
          assert.deepEqual(selects, [], `Native select can open system menu: ${selects.join(', ')}`); return selects
        }, 'src/xixi/LocalSettings.tsx')
        await check(c, 'geometric', `${id}-shared-workspace-material`, () => {
          const reference = c.workspaceStyles.find(s=>s.id.endsWith('-free-time')); assert.ok(reference)
          for (const page of c.workspaceStyles) {
            assert.equal(page.fill, reference.fill, `${page.id}: glass fill diverged from goals pane`)
            assert.equal(page.radius, reference.radius, `${page.id}: shell radius diverged from goals pane`)
            assert.equal(page.padding, reference.padding, `${page.id}: content inset diverged from goals pane`)
            assert.ok(Math.abs(page.panel.left-reference.panel.left)<=1, `${page.id}: page edge misaligned`)
          }
          return c.workspaceStyles
        }, 'cross-page computed values; goals pane is the user-selected anchor')
        await c.nav('首页')
        return { workers: names, theme, glass, width, brand }
      }, 'functional matrix; nested failure entries remain failures')
    }
    // Detailed business/actions in one fresh, fixed viewport, independent of matrix state.
    if (stages.includes('details')) {
    await c.size(390); await c.load(backup, { theme: 'dark', glass: 'clear' })
    await check(c, 'geometric', 'mobile-navigation-overlay-keeps-workspace-fixed', async () => {
      const pages = [
        ['工作台', '.wb-scroll'], ['日程', '.mobile-schedule-workspace'], ['余时', '.free-time-viewport'], ['设置', '.xixi-settings-scroll'],
      ]
      const evidence = []
      for (const [label, selector] of pages) {
        await c.nav(label); await c.wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&e.getClientRects().length>0})()`)
        await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollTop=Math.min(80,e.scrollHeight-e.clientHeight);return true})()`)
        const read = () => c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();return {top:r.top,height:r.height,scrollTop:e.scrollTop,transform:getComputedStyle(e).transform}})()`)
        const before = await read()
        await c.click('.home-brand'); await c.wait("document.querySelector('.home-menu').dataset.open==='true'"); await delay(260)
        const open = await read()
        assert.deepEqual(open, before, `${label}: navigation menu must not move or resize its workspace`)
        await c.click('.home-brand'); await c.wait("document.querySelector('.home-menu').dataset.open==='false'"); await delay(260)
        assert.deepEqual(await read(), before, `${label}: closing navigation menu must not compensate the workspace position`)
        evidence.push({ label, selector, before, open })
      }
      return evidence
    }, 'mobile/runtime/mobile.css; HomeWorkspace navigation remains an overlay')
    await calendar(c, 'details-390')
    await check(c, 'functional', 'chat-composer-and-no-key', async () => {
      await c.nav('首页'); await c.ready('.home-launch')
      await c.click('.home-launch'); await c.wait("!document.querySelector('#home-xixi').inert && !__ASTARIA_P0__.getSnapshot().cameraTransition")
      const before = (await c.api('tasks')).length
      assert.equal(await c.eval("document.querySelector('.xixi-manual')"), null)
      const status = await c.api('status'); assert.equal(status.configured, false)
      const rejected = await c.api('chat', { requestId: 'shell-no-key', conversationId: 'main', text: '虚构拒绝测试', context: { page: 'home', timezone: 'Asia/Shanghai' } }, true)
      assert.equal(rejected.ok, false); assert.match(rejected.data.error, /连接模型|配置|密钥/)
      assert.equal((await c.api('conversation?id=main')).messages.length, 120)
      await c.input('#home-compose', '虚构 UI 发送：无 Key 必须拒绝')
      await c.click('.home-capture[type="submit"]')
      await c.wait("!!document.querySelector('.xixi-send-error')")
      const uiError = await c.eval("document.querySelector('.xixi-send-error').textContent")
      assert.match(uiError, /配置|连接|密钥/)
      assert.equal((await c.api('conversation?id=main')).messages.length, 120)
      assert.equal(await c.eval("document.querySelector('#home-compose').value"), '虚构 UI 发送：无 Key 必须拒绝')
      assert.equal((await c.api('tasks')).length, before, 'an unconfigured chat never creates a task')
      await c.shot('chat-composer-no-key'); return { rejected }
    }, 'src/home/HomeWorkspace.tsx submit; server/serviceCore.mjs /chat')
    await check(c, 'functional', 'chat-reverse-and-draft', async () => {
      await c.load(backup); await c.ready('.home-launch'); await c.click('.home-launch')
      await c.wait("!document.querySelector('#home-xixi').inert")
      await c.input('#home-compose', '虚构反向动画保留草稿')
      await motion(c, 'chat-close', () => c.click('[aria-label="收起析熙"]'), '.home-morph', "document.querySelector('#home-xixi').inert&&!__ASTARIA_P0__.getSnapshot().cameraTransition")
      await c.ready('.home-launch'); await c.click('.home-launch'); await c.wait("!document.querySelector('#home-xixi').inert")
      assert.equal(await c.eval("document.querySelector('#home-compose').value"), '虚构反向动画保留草稿')
      await c.click('[aria-label="收起析熙"]')
      // Reopen when original geometry and actual hit testing allow it, not at
      // an assumed animation time or merely when disabled becomes false.
      await c.ready('.home-launch')
      const reversingAt = await c.snapshot(); await saveJSON('chat-reverse-ready.json', reversingAt)
      await c.click('.home-launch'); await c.wait("!document.querySelector('#home-xixi').inert&&!__ASTARIA_P0__.getSnapshot().cameraTransition")
      assert.equal(await c.eval("document.querySelector('#home-compose').value"), '虚构反向动画保留草稿')
      return { draftPreserved: true, reversedWhileCameraMoving: reversingAt.render.cameraTransition }
    }, 'src/home/HomeWorkspace.tsx original spring reversal')
    await check(c, 'functional', 'settings-subpages-and-manual-quality', async () => {
      await c.load(backup); await c.nav('设置')
      const tabs = await c.eval("[...document.querySelectorAll('.xixi-settings-directory button')].map(e=>e.textContent.trim())")
      assert.deepEqual(tabs, ['通用','析熙','时间安排','通知','外观与动画','数据'])
      for (const tab of tabs) {
        await c.click('.xixi-settings-directory button', tab); await delay(250)
        assert.equal(await c.eval("document.querySelector('.xixi-settings-content').dataset.section"), tab)
        assert.equal(await c.eval("document.querySelector('.xixi-settings').dataset.mobileView"), 'section')
        await c.shot(`settings-section-${tab === '通用' ? 'general' : tab === '析熙' ? 'model' : tab === '时间安排' ? 'schedule' : tab === '通知' ? 'notifications' : tab === '外观与动画' ? 'appearance' : 'data'}`)
        await geometry(c, `settings-section-${tabs.indexOf(tab)}`)
        const nativeMenus = await c.eval("[...document.querySelectorAll('.xixi-settings select')].filter(e=>e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&!e.closest('[hidden],[inert],[aria-hidden=true]')).map(e=>e.getAttribute('aria-label'))")
        assert.deepEqual(nativeMenus, [], `Native select reachable in ${tab}`)
        await c.click('[aria-label="返回设置目录"]'); await c.wait("document.querySelector('.xixi-settings').dataset.mobileView==='directory'")
        await c.wait(`document.activeElement?.textContent.trim()===${JSON.stringify(tab)}`, 2000)
        assert.equal(await c.eval("document.activeElement?.textContent.trim()"), tab, 'Settings subpage back did not restore directory focus')
      }
      await c.click('.xixi-settings-directory button', '外观与动画'); await delay(250)
      await c.click('button.adaptive-select-trigger[aria-label="黑洞画质"]')
      await c.wait("!!document.querySelector('.adaptive-select-dialog[open] [role=listbox]')")
      await c.shot('settings-custom-quality-menu')
      assert.equal(await c.eval("getComputedStyle(document.querySelector('.xixi-settings-scroll')).visibility"), 'visible', 'Chooser removed the surrounding settings page'); assert.notEqual(await c.eval("getComputedStyle(document.querySelector('.xixi-settings-scroll')).clipPath"), 'none', 'Chooser must cut out the covered region from its original underlay')
      await c.click('.adaptive-select-dialog [role="option"]', '最高')
      await c.wait("document.querySelector('select[aria-label=\"黑洞画质\"]').value==='ultra'", 3000)
      await c.wait("!document.querySelector('select[aria-label=\"黑洞画质\"]').disabled")
      const selected = await c.api('preferences'); assert.equal(selected.render.quality, 'ultra')
      await c.click('.xixi-render-options button:nth-child(1)'); await delay(250)
      const manual = await c.api('preferences'); assert.equal(manual.render.profile, 'smooth120'); assert.equal(manual.render.quality, 'ultra')
      await c.nav('首页'); await c.wait('!__ASTARIA_P0__.getSnapshot().cameraTransition')
      const home = await c.eval('__ASTARIA_P0__.getSnapshot()'); assert.equal(home.requestedQuality, 'ultra'); assert.equal(home.targetFps, 120)
      await c.nav('日程'); await c.wait('!__ASTARIA_P0__.getSnapshot().cameraTransition')
      const schedule = await c.eval('__ASTARIA_P0__.getSnapshot()'); assert.equal(schedule.requestedQuality, 'ultra'); assert.equal(schedule.targetFps, 30)
      await c.nav('首页'); await c.wait('!__ASTARIA_P0__.getSnapshot().cameraTransition')
      const returned = await c.eval('__ASTARIA_P0__.getSnapshot()'); assert.equal(returned.requestedQuality, 'ultra'); assert.equal(returned.targetFps, 120)
      const after = await c.api('preferences'); assert.equal(after.render.quality, 'ultra'); assert.equal(after.render.profile, 'smooth120')
      await saveJSON('manual-quality.json', { selected, manual, home, schedule, returned })
      return { manualQuality: manual.render, homeFps: home.targetFps, scheduleFps: schedule.targetFps, returnFps: returned.targetFps }
    }, 'src/xixi/LocalSettings.tsx; src/prototype/renderProfile.ts')
    await check(c, 'functional', 'horizon-entry-and-cancel', async () => {
      await c.load(backup, { theme: 'dark', glass: 'clear' })
      await c.wait("document.querySelector('.home-black-hole-entry')?.dataset.visible==='true'")
      const before = await c.api('planner')
      await motion(c, 'horizon-enter', () => c.click('.home-black-hole-entry'), '.horizon-studio', "document.querySelector('.horizon-studio')?.dataset.phase==='ready'", 15000)
      await geometry(c, 'horizon-ready')
      await c.click('.horizon-day-heading nav button', '明天'); await delay(300)
      assert.ok(await c.eval("[...document.querySelectorAll('.horizon-day-heading nav button')].some(e=>e.textContent==='明天'&&e.getAttribute('aria-pressed')==='true')"))
      await c.shot('horizon-tomorrow')
      await c.click('.horizon-day-heading nav button', '今天'); await delay(300)
      if (await c.eval("!!document.querySelector('.orbit-group:not(:disabled)')")) {
        await c.click('.orbit-group:not(:disabled)'); await delay(350)
        assert.ok(await c.eval("document.querySelector('.horizon-group-detail')?.dataset.open==='true'"), 'Group did not expand')
        await c.shot('horizon-group-expanded')
        await c.click('.horizon-group-detail button', '收拢这组'); await delay(400)
      } else throw Error('Fixture groups not reachable; cannot claim horizon functionality')
      await motion(c, 'horizon-exit', () => c.click('.orbit-cancel'), '.horizon-studio', "!document.querySelector('.horizon-studio')", 15000)
      assert.deepEqual(await c.api('planner'), before, 'Horizon cancel modified planner')
      assert.ok(await c.eval("document.activeElement===document.querySelector('.home-black-hole-entry')"), 'Horizon did not restore entry focus')
      return { cancelledWithoutPlannerWrites: true }
    }, 'src/home/BlackHoleEntry.tsx; src/xixi/HorizonStudio.tsx')
    await check(c, 'functional', 'calendar-save-edit-cancel', async () => {
      await c.load(backup); await c.nav('日程'); await c.wait("!!document.querySelector('.m-calendar')", 5000)
      await c.click('.m-calendar-view [data-mode="day"]')
      await c.click('[aria-label="新增单日活动"]'); await c.wait("!!document.querySelector('.m-calendar-sheet[open]')")
      await c.input('.m-calendar-form input[maxlength="160"]', '虚构活动：集成保存')
      await c.input('.m-calendar-form input[type="time"]', '18:00')
      await c.input('.m-calendar-form .m-calendar-form-pair label:last-child input', '17:30')
      await c.click('.m-calendar-form button[type="submit"]')
      await c.wait("!!document.querySelector('.m-calendar-form [role=alert]')")
      await c.shot('calendar-invalid-time-error')
      assert.ok(!(await c.api('planner')).dayEvents.some(e => e.title === '虚构活动：集成保存'), 'Invalid time was saved')
      await c.input('.m-calendar-form .m-calendar-form-pair label:last-child input', '18:30')
      await c.click('.m-calendar-form button[type="submit"]'); await c.wait("!document.querySelector('.m-calendar-sheet[open]')")
      let planner = await c.api('planner'), event = planner.dayEvents.find(e => e.title === '虚构活动：集成保存')
      assert.ok(event); assert.equal(event.start, '18:00'); assert.equal(event.end, '18:30')
      // Tag only the fixture's exact saved row; coordinates still go through hit testing.
      await c.eval("(()=>{const e=[...document.querySelectorAll('.m-calendar-entry')].find(e=>e.querySelector('strong')?.textContent==='虚构活动：集成保存');if(!e)throw Error('Saved activity missing from timeline');e.dataset.shellQaTarget='event';return true})()")
      await c.click('[data-shell-qa-target="event"]')
      await c.input('.m-calendar-form input[maxlength="160"]', '虚构活动：编辑已保存')
      await c.click('.m-calendar-form button[type="submit"]'); await c.wait("!document.querySelector('.m-calendar-sheet[open]')")
      planner = await c.api('planner'); assert.equal(planner.dayEvents.find(e => e.id === event.id).title, '虚构活动：编辑已保存')
      await c.eval("(()=>{const e=[...document.querySelectorAll('.m-calendar-entry')].find(e=>e.querySelector('strong')?.textContent==='虚构活动：编辑已保存');if(!e)throw Error('Edited activity missing from timeline');e.dataset.shellQaTarget='edited-event';return true})()")
      await c.click('[data-shell-qa-target="edited-event"]')
      await c.input('.m-calendar-form input[maxlength="160"]', '虚构活动：未保存草稿')
      await c.click('.m-calendar-sheet [aria-label="返回日程"]'); await delay(250)
      planner = await c.api('planner'); assert.equal(planner.dayEvents.find(e => e.id === event.id).title, '虚构活动：编辑已保存')
      await c.shot('calendar-saved-cancelled-edit')
      return { event, unsavedEditDiscarded: true, note: 'No generic save undo is exposed by Calendar; cancellation tested, not claimed as undo' }
    }, 'mobile/ui/MobileCalendar.tsx ArrangementEditor')
    await check(c, 'functional', 'calendar-exception-save-and-revoke', async () => {
      await c.load(backup); await c.nav('日程'); await c.wait("!!document.querySelector('.m-calendar')", 5000)
      const before = await c.api('planner')
      await c.click('[aria-label="打开日程菜单"]'); await delay(200)
      await c.click('.m-calendar-menu button', '调休 / 假期 / 停课')
      await c.wait("!!document.querySelector('.m-calendar-sheet[open]')")
      await c.click('.m-calendar-form button[type="submit"]'); await c.wait("!document.querySelector('.m-calendar-sheet[open]')")
      const saved = await c.api('planner'); assert.ok(saved.dayExceptions[date])
      await c.click('.m-calendar-view [data-mode="day"]')
      await c.click('.m-calendar-exception'); await delay(200)
      await c.click('.m-calendar-form .m-calendar-button', '撤销当天例外')
      await c.shot('calendar-exception-revoke-confirmation')
      await c.click('.m-calendar-form .m-calendar-button', '确认撤销'); await c.wait("!document.querySelector('.m-calendar-sheet[open]')")
      const revoked = await c.api('planner'); assert.equal(revoked.dayExceptions[date], before.dayExceptions[date])
      assert.deepEqual(revoked.routines, before.routines)
      assert.deepEqual(revoked.blocks, before.blocks)
      await saveJSON('calendar-exception-revoke.json', { before, saved, revoked })
      return { realPlannerSaveAndRevoke: true }
    }, 'mobile/ui/MobileCalendar.tsx ExceptionEditor; shared /api/planner')
    await check(c, 'functional', 'upload-first-step-layer-and-focus', async () => {
      await c.load(backup); await c.nav('日程'); await c.wait("!!document.querySelector('.m-calendar')", 5000)
      await c.click('[aria-label="打开日程菜单"]'); await delay(250)
      await c.click('.m-calendar-menu button', '截图导入课表')
      await c.wait("document.querySelector('.tti-dialog[open]')?.dataset.step==='upload'")
      await c.shot('upload-first-step'); await geometry(c, 'upload-first-step')
      const layer = await c.eval("(()=>{const under=document.querySelector('.m-calendar'),dialog=document.querySelector('.tti-dialog');return {covered:!!under&&getComputedStyle(under).visibility==='hidden',dialogVisible:getComputedStyle(dialog).visibility,step:dialog.dataset.step,otherSteps:document.querySelectorAll('[data-testid=timetable-codes],[data-testid=timetable-groups],[data-testid=timetable-preview]').length}})()")
      assert.equal(layer.dialogVisible, 'visible'); assert.equal(layer.otherSteps, 0)
      assert.equal(layer.covered, true, 'Underlying Calendar text remains visible below import glass')
      await c.click('[aria-label="关闭课表导入"]'); await c.wait("!document.querySelector('.tti-dialog')"); await delay(200)
      const active = await c.eval("({html:document.activeElement?.outerHTML,visible:!!document.activeElement?.getClientRects().length,inert:!!document.activeElement?.closest('[inert]')})")
      await saveJSON('upload-close-focus.json', { layer, active })
      await c.wait("document.activeElement?.getAttribute('aria-label')==='打开日程菜单'", 2000)
      assert.ok(active.visible && !active.inert && !/^<body/i.test(active.html), 'Close did not restore useful focus')
      return { layer, active: await c.eval("document.activeElement.outerHTML"), recognition: 'not attempted' }
    }, 'mobile/ui/MobileCalendar.tsx; src/planner/ImportSurface.tsx')
    await check(c, 'functional', 'native-inactive-frame-stop', async () => {
      await c.load(backup); await c.wait('!__ASTARIA_P0__.getSnapshot().cameraTransition')
      const before = await c.eval('__ASTARIA_P0__.getSnapshot()'); await delay(350)
      assert.ok((await c.eval('__ASTARIA_P0__.getSnapshot().renderedFrames')) > before.renderedFrames)
      await c.eval("{document.documentElement.dataset.mobileActive='false';document.dispatchEvent(new Event('astaria-app-activity'));true}")
      await delay(100); const stopped = await c.eval('__ASTARIA_P0__.getSnapshot()'); await delay(500)
      assert.equal(await c.eval('__ASTARIA_P0__.getSnapshot().renderedFrames'), stopped.renderedFrames)
      await c.eval("{document.documentElement.dataset.mobileActive='true';document.dispatchEvent(new Event('astaria-app-activity'));true}"); await delay(400)
      const resumed = await c.eval('__ASTARIA_P0__.getSnapshot()'); assert.ok(resumed.renderedFrames > stopped.renderedFrames)
      await saveJSON('activity.json', { simulation: true, before, stopped, resumed }); return { before: before.renderedFrames, stopped: stopped.renderedFrames, resumed: resumed.renderedFrames }
    }, 'src/prototype/BlackHoleRenderer.ts; src/stores/pageActivity.ts')
    const fresh = new Chrome('functional-fresh-onboarding')
    await check(fresh, 'functional', 'fresh-default-onboarding', async () => {
      try {
        await fresh.open(base); await fresh.size(390)
        await fresh.send('Page.navigate', { url: base })
        await fresh.wait("!!document.querySelector('.home-brand') && !!document.querySelector('.first-run') && !!window.__ASTARIA_P0__")
        const before = await fresh.api('onboarding'); assert.equal(before.completed, false, 'Writing mobile defaults skipped first-run choice')
        await fresh.shot('fresh-onboarding-before-choice')
        await fresh.api('onboarding', { completed: true }); await fresh.send('Page.reload')
        await fresh.wait("!!document.querySelector('.home-brand')&&!document.querySelector('.first-run')&&!!window.__ASTARIA_P0__")
        assert.equal((await fresh.api('onboarding')).completed, true)
        return { freshBeforeChoice: before, explicitlyCompletedSurvivesReload: true, fixtureImported: false }
      } finally { await fresh.close() }
    }, 'server/onboarding.mjs; mobile/runtime/service.mjs default initialization')
    }
    for (const [name, value] of stages.includes('states') ? [['empty', empty], ['dense', dense]] : []) {
      await check(c, 'functional', `${name}-data-state`, async () => {
        await c.size(320); await c.load(value); await c.shot(`${name}-home`); await geometry(c, `${name}-home`)
        await c.click('.home-launch'); await c.wait("!document.querySelector('#home-xixi').inert && !__ASTARIA_P0__.getSnapshot().cameraTransition")
        await c.shot(`${name}-chat`); await geometry(c, `${name}-chat`)
        assert.equal((await c.api('tasks')).length, name === 'empty' ? 0 : 40)
        await calendar(c, `${name}-320`); return { fictional: true }
      }, 'fictional backup; actual empty/dense business state')
    }
    assert.deepEqual(c.errors, [], 'Browser runtime exceptions'); assert.deepEqual(c.network, [], 'External network attempted')
  } finally { await c.close() }
}

let server, createdOutput = false
try {
  await mkdir(dirname(output), { recursive: true })
  await mkdir(output, { recursive: false })
  createdOutput = true
  const verifier = await readFile(fileURLToPath(import.meta.url))
  report.verifier = { sha256: hash(verifier), arguments: process.argv.slice(2), node: process.version }
  await writeFile(join(output, 'verifier-source.mjs'), verifier)
  for (const dir of ['screenshots', 'geometry']) await mkdir(join(output, dir))
  // Parent may be building. Never silently accept a dist older than the inputs
  // relevant to this contract. A later source drift is recorded separately.
  const buildInputs = ['src/main.tsx','src/home/HomeWorkspace.tsx','mobile/runtime/mobile.css','mobile/ui/MobileCalendar.tsx','mobile/ui/MobileScheduleWorkspace.tsx','mobile/ui/mobile-calendar.css','mobile/ui/mobile-workspaces.css','src/xixi/LocalSettings.tsx','src/ui/AdaptiveSelect.tsx','src/planner/ImportSurface.tsx','server/onboarding.mjs','mobile/runtime/service.mjs']
  const waitBuildStart = performance.now()
  while (true) {
    const newestInput = Math.max(...await Promise.all(buildInputs.map(async p => (await stat(join(root, p))).mtimeMs)))
    let builtAt = 0; try { builtAt = (await stat(join(dist, 'index.html'))).mtimeMs } catch {}
    if (builtAt >= newestInput) break
    if (performance.now() - waitBuildStart > 120000) throw Error('dist is older than current integration source; wait for parent build')
    console.log('WAIT parent mobile build'); await delay(2000)
  }
  let stable = false
  for (let attempt = 0; attempt < 10; attempt++) {
    const before = await inventory(dist); await delay(800); const after = await inventory(dist)
    if (before.hash !== after.hash) { await delay(1000); continue }
    await cp(dist, served, { recursive: true }); const copied = await inventory(served), current = await inventory(dist)
    if (copied.hash === current.hash) { report.build = { snapshotHash: copied.hash, files: copied.files, sourcePath: dist, capturedAt: new Date().toISOString() }; stable = true; break }
    await rm(served, { recursive: true, force: true })
  }
  assert.ok(stable, 'Build changed while copying; retry after build completes')
  const sources = ['src/main.tsx', 'src/home/HomeWorkspace.tsx', 'src/prototype/BlackHolePrototype.tsx', 'mobile/runtime/mobile.css', 'mobile/runtime/viewport.ts', 'mobile/ui/MobileCalendar.tsx', 'mobile/ui/MobileScheduleWorkspace.tsx', 'mobile/ui/mobile-calendar.css', 'mobile/ui/mobile-workspaces.css', 'src/xixi/LocalSettings.tsx', 'src/ui/AdaptiveSelect.tsx', 'src/planner/ImportSurface.tsx', 'server/onboarding.mjs', 'scripts/verify-mobile-performance.mjs']
  report.sourceHashes = Object.fromEntries(await Promise.all(sources.map(async p => [p, hash(await readFile(join(root, p)))])))
  await saveJSON('build-manifest.json', { build: report.build, sourceHashes: report.sourceHashes })
  const mime = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.wasm':'application/wasm', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' }
  report.serverApiRequests = []
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname)
      if (pathname.startsWith('/api/')) { report.serverApiRequests.push(pathname); response.writeHead(500, { 'Content-Type':'application/json' }); response.end('{"error":"API must use real mobile Worker, never HTTP server"}'); return }
      const file = resolve(served, `.${pathname === '/' ? '/index.html' : pathname}`)
      if (!file.startsWith(`${served}${sep}`)) { response.writeHead(403); response.end(); return }
      const bytes = await readFile(file)
      response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': "connect-src 'self' blob: data:; worker-src 'self' blob:" }); response.end(bytes)
    } catch { response.writeHead(404); response.end('Not found') }
  })
  await new Promise(yes => server.listen(0, '127.0.0.1', yes))
  const base = `http://127.0.0.1:${server.address().port}`; report.servedOrigin = base
  const backup = fixture(), empty = fixture('empty'), dense = fixture('dense')
  await saveJSON('fixture.json', backup); report.fixture = { fictional: true, sha256: hash(JSON.stringify(backup)), tasks: 40, messages: 120, onboardingCompleted: true, onboardingSetup: 'Real POST /api/onboarding {completed:true} after backup import, then read back; native backup schema excludes onboarding preference' }
  await saveJSON('fixture-setup.json', { backupFile: 'fixture.json', onboardingCompleted: true, setup: [{ path: '/api/data/import', confirmed: true }, { path: '/api/onboarding', completed: true }], note: 'Backup checksum and allowlist preserved; empty fixture has zero tasks/messages/routines, completed onboarding is explicit' })
  if (mode !== 'functional') await performanceRun(base, backup)
  if (mode !== 'performance') await functionalRun(base, backup, empty, dense)
  assert.deepEqual(report.serverApiRequests, [], 'HTTP APIs escaped mobile Worker')
} catch (error) { record('functional', 'runner-fatal', 'fail', { message: error.message, stack: error.stack }, 'scripts/verify-mobile-shell.mjs') }
finally {
  if (server) { server.closeAllConnections(); await new Promise(yes => server.close(yes)) }
  try { report.sourceDrift = Object.fromEntries(await Promise.all(Object.keys(report.sourceHashes ?? {}).map(async p => [p, hash(await readFile(join(root, p))) !== report.sourceHashes[p]]))) } catch {}
  report.finishedAt = new Date().toISOString()
  report.summary = { functional: Object.groupBy(report.functional, r => r.status), geometric: Object.groupBy(report.geometric, r => r.status), screenshots: report.screenshots.length, visualPending: report.visualPending.length }
  report.status = [...report.functional, ...report.geometric].some(r => r.status === 'fail') ? 'failed' : 'automated-checks-passed-visual-review-pending'
  if (createdOutput) await saveJSON('report.json', report)
  console.log(JSON.stringify({ output, status: report.status, functionalFailures: report.functional.filter(r => r.status === 'fail').map(r => r.id), geometricFailures: report.geometric.filter(r => r.status === 'fail').map(r => r.id), screenshots: report.screenshots.length }))
  process.exitCode = report.status === 'failed' ? 1 : 0
}
