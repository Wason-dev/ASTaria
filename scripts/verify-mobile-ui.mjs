/** Production mobile worker + fresh browser storage. No API server or native mocks. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { preview } from 'vite'

const project = fileURLToPath(new URL('../', import.meta.url))
const output = process.env.MOBILE_QA_OUTPUT ?? join(project, 'artifacts/v1-mobile-ui')
const legacyWebView = process.env.MOBILE_QA_LEGACY_WEBVIEW === '1'
const disableModernApis = `AbortSignal.any=undefined;AbortSignal.timeout=undefined;Response.json=undefined;`
const delay = ms => new Promise(done => setTimeout(done, ms))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const quote = JSON.stringify
const node = selector => `document.querySelector(${quote(selector)})`
const button = (selector, text) => `[...document.querySelectorAll(${quote(selector)})].find(e=>e.textContent.trim()===${quote(text)})`
const scenarios = [320, 390].flatMap(width => ['dark', 'light'].flatMap(theme => ['clear', 'soft'].map(glass => ({
  id: `${width}-${theme}-${glass}`, width, height: width === 320 ? 740 : 844, theme, glass,
}))))
const requestedScenario = process.argv[2]
if (requestedScenario !== undefined && !scenarios.some(item => item.id === requestedScenario)) throw Error('Expected one scenario ID, e.g. 320-dark-clear; omit it for the full matrix')
const selectedScenarios = requestedScenario ? scenarios.filter(item => item.id === requestedScenario) : scenarios
const report = { schemaVersion: 2, startedAt: new Date().toISOString(), status: 'running',
  scope: 'Local Chrome, real dist-mobile production worker, fresh isolated IndexedDB; no desktop API server.',
  limits: [
    'No iOS/Android native bridge is installed or mocked. Native share sheets, notification delivery, safe-area hardware and device GPU/FPS are not certified.',
    'Keyboard coverage uses Chrome device-metrics resizing and visualViewport measurements. It does not open a native software keyboard or prove an iOS visual-viewport-only resize.',
    'Touch uses CDP touch events and elementFromPoint; screenshots use a headless desktop GPU implementation.',
  ], matrix: selectedScenarios, fullMatrix: !requestedScenario, checks: [], screenshots: [], measurements: [], errors: [], consoleErrors: [],
  network: [], blockedNetwork: [], workers: [], localCalls: [], build: {} }
let context = { scenario: 'setup', page: 'build' }, socket, chrome, server, temporary, base, serial = 0
const pending = new Map(), attached = new Map(), downloads = [], eventObservers = new Set()
const recordedScreenshots = () => report.screenshots.filter(item => item.scenario === context.scenario && item.page === context.page).map(item => item.file)
function check(name, passed, actual, expected, evidence = recordedScreenshots()) {
  const result = { ...context, name, passed: passed === true, ...(expected === undefined ? {} : { expected }),
    ...(actual === undefined ? {} : { actual }), evidence }
  report.checks.push(result)
  if (!result.passed) console.error(`FAIL ${context.scenario}/${context.page}: ${name}`)
  return result.passed
}
function send(method, params = {}, sessionId) {
  return new Promise((done, reject) => {
    const id = ++serial, timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 20000)
    pending.set(id, { done, reject, timeout })
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
  })
}
async function evaluate(expression) {
  const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text)
  return reply.result.value
}
async function wait(expression, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return }
    catch (error) {
      // A real navigation can replace the CDP execution context between polls.
      if (!/Execution context was destroyed|Cannot find context with specified id/u.test(error.message)) throw error
    }
    await delay(100)
  }
  throw Error(`Not ready: ${expression}`)
}
async function capture(name) {
  const file = `${context.scenario}-${name}.png`
  const reply = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  await writeFile(join(output, file), Buffer.from(reply.data, 'base64'))
  report.screenshots.push({ ...context, file })
  return file
}
const api = (path, body) => evaluate(`(async()=>{
  const r=await fetch('/api/'+${quote(path)},{headers:{'X-ASTaria-Local':'1',${body === undefined ? '' : "'Content-Type':'application/json'"}},
    method:${quote(body === undefined ? 'GET' : 'POST')},${body === undefined ? '' : `body:JSON.stringify(${quote(body)})`}});
  const value=await r.json();if(!r.ok)throw Error(value.error);return value;
})()`)

// Observation only: requests still go through the application's real mobile transport.
async function observe() {
  await evaluate(`(()=>{
    if(window.__mobileQA)return;
    const qa=window.__mobileQA={calls:[],touches:[]}, original=window.fetch;
    window.fetch=async function(input,init){
      const url=new URL(input instanceof Request?input.url:input,location.href);
      const item={path:url.pathname,method:init?.method??(input instanceof Request?input.method:'GET')};
      try{const result=await original.call(this,input,init);if(url.pathname.startsWith('/api/'))qa.calls.push({...item,status:result.status});return result}
      catch(error){if(url.pathname.startsWith('/api/'))qa.calls.push({...item,status:0});throw error}
    };
    document.addEventListener('touchstart',event=>qa.touches.push({id:event.target.id,className:event.target.closest('button')?.className??event.target.className}),{capture:true,passive:true});
  })()`)
}
async function collectLocalCalls() {
  const calls = await evaluate('window.__mobileQA?.calls??[]')
  report.localCalls.push(...calls.map(item => ({ ...context, ...item })))
  await evaluate('if(window.__mobileQA)window.__mobileQA.calls=[]')
}

// Bounds are relative to the visual viewport; a center must hit the actual control.
async function control(locator, scroll = false) {
  if (scroll) await evaluate(`(()=>{
    const e=${locator};if(!e)return;
    // Reveal in real scroll containers only. Never pan the fixed application shell.
    for(let p=e.parentElement;p&&p!==document.body;p=p.parentElement){
      const s=getComputedStyle(p),r=e.getBoundingClientRect(),pr=p.getBoundingClientRect();
      const left=pr.left+p.clientLeft,top=pr.top+p.clientTop,right=left+p.clientWidth,bottom=top+p.clientHeight;
      if(['auto','scroll'].includes(s.overflowX)&&p.scrollWidth>p.clientWidth+1)
        p.scrollLeft+=r.left<left?r.left-left:r.right>right?r.right-right:0;
      if(['auto','scroll'].includes(s.overflowY)&&p.scrollHeight>p.clientHeight+1)
        p.scrollTop+=r.top<top?r.top-top:r.bottom>bottom?r.bottom-bottom:0;
    }
  })()`)
  await delay(80)
  return evaluate(`(()=>{
    const e=${locator};if(!e)return {found:false};
    const r=e.getBoundingClientRect(),s=getComputedStyle(e),v=visualViewport;
    const box={x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};
    const viewport={x:v?.offsetLeft??0,y:v?.offsetTop??0,width:v?.width??innerWidth,height:v?.height??innerHeight};
    const x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    let visible=!!e.getClientRects().length;
    for(let p=e;p;p=p.parentElement){const cs=getComputedStyle(p);if(p.inert||p.getAttribute('aria-hidden')==='true'||cs.visibility==='hidden'||cs.display==='none'||Number(cs.opacity)<.02)visible=false;}
    const clippedBy=[];
    for(let p=e.parentElement;p;p=p.parentElement){const cs=getComputedStyle(p),pr=p.getBoundingClientRect();
      const left=pr.left+p.clientLeft,top=pr.top+p.clientTop,right=left+p.clientWidth,bottom=top+p.clientHeight;
      const clipX=['hidden','clip','auto','scroll'].includes(cs.overflowX)&&(r.left<left-1||r.right>right+1);
      const clipY=['hidden','clip','auto','scroll'].includes(cs.overflowY)&&(r.top<top-1||r.bottom>bottom+1);
      if(clipX||clipY)clippedBy.push({className:p.className,x:clipX,y:clipY,left,top,right,bottom});
    }
    return {found:true,label:e.getAttribute('aria-label')??e.textContent.trim().slice(0,100),box,viewport,
      visible,disabled:!!e.disabled,center:{x,y},hit:hit===e||e.contains(hit),hitElement:hit?.outerHTML.slice(0,220),
      clippedBy,unclipped:clippedBy.length===0,
      inViewport:r.left>=viewport.x-1&&r.top>=viewport.y-1&&r.right<=viewport.x+viewport.width+1&&r.bottom<=viewport.y+viewport.height+1,
      radius:s.borderTopLeftRadius,touchAction:s.touchAction,coarse:matchMedia('(pointer:coarse)').matches};
  })()`)
}
async function probe(name, locator, { scroll = false, focus = true, touchSize = false } = {}) {
  const geometry = await control(locator, scroll)
  report.measurements.push({ ...context, kind: 'control', name, ...geometry })
  check(`${name}: visible in visual viewport and center unobstructed`, geometry.found && geometry.visible && geometry.inViewport && geometry.unclipped && geometry.hit,
    geometry, 'Visible control, fully inside the visual viewport, elementFromPoint hits it')
  if (touchSize) check(`${name}: at least 44px touch target`, geometry.box?.width >= 44 && geometry.box?.height >= 44, geometry.box, '44 × 44 CSS px')
  if (focus && geometry.found && !geometry.disabled) {
    const focused = await evaluate(`(()=>{const e=${locator};e.focus({preventScroll:true});return {focused:document.activeElement===e,label:document.activeElement?.getAttribute('aria-label')??document.activeElement?.id}})()`)
    check(`${name}: accepts focus`, focused.focused, focused, 'Control owns document.activeElement')
  }
  return geometry
}
async function tap(name, locator, { scroll = false, recoverNavigation = false } = {}) {
  const before = await control(locator, scroll)
  const touchCount = await evaluate('window.__mobileQA?.touches.length??0')
  const ready = before.found && before.visible && before.inViewport && before.unclipped && before.hit && !before.disabled
  check(`${name}: touch coordinate hits enabled control`, ready, before, 'Enabled, unobstructed center within viewport')
  if (!ready) {
    await capture(`blocked-touch-${report.checks.length}`)
    report.checks.at(-1).evidence = recordedScreenshots()
    if (recoverNavigation && before.found) {
      // Keep the failed assertion; activation only permits inspection of independent pages.
      report.measurements.push({ ...context, name, diagnosticRecovery: 'Programmatic navigation after failed touch; does not satisfy the touch check.' })
      await evaluate(`(${locator}).click()`)
      return false
    }
    throw Error(`Cannot touch ${name}`)
  }
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...before.center, id: 1, radiusX: 3, radiusY: 3, force: 1 }] })
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await delay(100)
  check(`${name}: browser received real touch event`, await evaluate(`(window.__mobileQA?.touches.length??0)>${touchCount}`), undefined, 'touchstart captured')
  return true
}
async function setSelect(selector, value) {
  const locator = node(selector)
  await probe(`select ${selector}`, locator, { scroll: true })
  await evaluate(`(()=>{const e=${locator};e.value=${quote(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
  check(`select ${selector} retains selection`, await evaluate(`(${locator}).value===${quote(value)}`), value, value)
}
async function measureLayout(rootSelector, name) {
  const measured = await evaluate(`(()=>{
    const root=document.querySelector(${quote(rootSelector)}),v=visualViewport;
    if(!root)return {found:false};
    const visible=e=>{if(!e.getClientRects().length)return false;for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(p.inert||p.getAttribute('aria-hidden')==='true'||s.display==='none'||s.visibility==='hidden'||Number(s.opacity)<.02)return false;}return true;};
    const clipped=e=>{for(let p=e.parentElement;p&&p!==root.parentElement;p=p.parentElement){const s=getComputedStyle(p);if(['hidden','clip','auto','scroll'].includes(s.overflowX))return true;}return false;};
    const items=[root,...root.querySelectorAll('*')].filter(visible);
    const bounds=e=>{const r=e.getBoundingClientRect();return {selector:e.id?'#'+e.id:e.tagName.toLowerCase()+'.'+String(e.className??'').split(' ').join('.'),left:r.left,right:r.right,width:r.width,text:e.textContent?.trim().slice(0,90)}};
    const overflow=items.filter(e=>{const r=e.getBoundingClientRect();return (r.left< -1||r.right>innerWidth+1)&&!clipped(e)}).map(bounds);
    const scrollContainers=items.filter(e=>e.clientWidth>0&&e.scrollWidth>e.clientWidth+1&&['auto','scroll'].includes(getComputedStyle(e).overflowX)).map(e=>({...bounds(e),clientWidth:e.clientWidth,scrollWidth:e.scrollWidth}));
    const pageScrollers=items.filter(e=>e.matches('.workspace-page-viewport,.first-run main')).map(e=>({className:e.className,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,clientHeight:e.clientHeight,scrollHeight:e.scrollHeight}));
    const titleOverlaps=[...root.querySelectorAll('.workspace-heading')].flatMap(header=>{
      const copy=header.querySelector('.workspace-heading-copy');if(!copy)return [];
      const a=copy.getBoundingClientRect();if(!a.width||!a.height)return [];
      return [...header.children].filter(e=>e!==copy).flatMap(e=>{const b=e.getBoundingClientRect();return b.width&&b.height&&Math.min(a.right,b.right)-Math.max(a.left,b.left)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>1?[{copy:copy.textContent,action:e.textContent}]:[]})
    });
    return {found:true,documentWidth:document.documentElement.scrollWidth,innerWidth,innerHeight,visualViewport:{width:v?.width,height:v?.height,offsetTop:v?.offsetTop,scale:v?.scale},overflow:overflow.slice(0,25),titleOverlaps,scrollContainers,pageScrollers,
      theme:document.querySelector('.home-workspace')?.dataset.theme,glass:document.querySelector('.home-workspace')?.dataset.glass,
      focus:document.activeElement?.outerHTML.slice(0,180),errors:[...root.querySelectorAll('[role=alert],.p0-error,.mobile-startup-error')].filter(visible).map(e=>e.textContent.trim()).filter(Boolean)};
  })()`)
  report.measurements.push({ ...context, kind: 'layout', name, ...measured })
  check(`${name}: no horizontal document overflow`, measured.found && measured.documentWidth <= measured.innerWidth + 1, measured, 'document.scrollWidth ≤ innerWidth + 1')
  check(`${name}: no uncontained or overlapping header content`, measured.found && measured.overflow.length === 0 && measured.titleOverlaps.length === 0,
    { horizontalOverflow: measured.overflow, titleOverlaps: measured.titleOverlaps }, { horizontalOverflow: [], titleOverlaps: [] })
  check(`${name}: page scroll viewport does not overflow horizontally`, measured.found && measured.pageScrollers.every(item => item.scrollWidth <= item.clientWidth + 1), measured.pageScrollers, 'No unintended horizontal scrolling of the page viewport')
  check(`${name}: no visible error/alert`, measured.found && measured.errors.length === 0, measured.errors, [])
}
async function metrics(scenario, height = scenario.height) {
  await send('Emulation.setDeviceMetricsOverride', { width: scenario.width, height, screenWidth: scenario.width, screenHeight: scenario.height, deviceScaleFactor: 1, mobile: true })
  await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
}
async function navigate(title, root) {
  if (await evaluate(`!!document.querySelector('.xixi-settings')`)) {
    await tap('return from settings', node('.xixi-settings-close'), { recoverNavigation: true })
    await wait(`!document.querySelector('.xixi-settings')`)
  }
  if (!await evaluate(`document.querySelector('#home-menu')?.dataset.open==='true'`)) {
    await tap('open navigation', node('.home-brand'), { recoverNavigation: true })
    await wait(`document.querySelector('#home-menu')?.dataset.open==='true'`)
    await delay(350)
  }
  const openClock = await evaluate(`(()=>{const e=document.querySelector('.home-clock'),s=getComputedStyle(e);return {opacity:Number(s.opacity),pointerEvents:s.pointerEvents}})()`)
  check(`navigation to ${title}: menu owns top row without clock interception`, openClock.opacity === 0 && openClock.pointerEvents === 'none', openClock, { opacity: 0, pointerEvents: 'none' })
  await probe(`navigation action ${title}`, button('#home-menu button', title), { scroll: true, touchSize: true })
  await capture(`${context.page}-navigation-open`)
  await tap(`navigate ${title}`, button('#home-menu button', title), { scroll: true, recoverNavigation: true })
  await wait(`!!document.querySelector(${quote(root)})`)
  await delay(750)
  const clock = await control(node('.home-clock'))
  check(`navigation to ${title}: clock restored after menu closes`, clock.visible && clock.inViewport &&
    await evaluate(`document.querySelector('#home-menu')?.dataset.open!=='true'`), clock, 'Menu closed; date/time visible again')
}
async function tab(title) {
  await tap(`settings tab ${title}`, button('.xixi-settings-tabs button', title), { scroll: true, recoverNavigation: true })
  await wait(`document.querySelector('.xixi-settings-content')?.dataset.section===${quote(title)}`)
  await delay(350)
}
async function keyboard(scenario) {
  context.page = 'keyboard'
  await tap('focus composer before keyboard emulation', node('#home-compose'))
  await send('Input.insertText', { text: '仅离线布局验证，不发送给模型。' })
  const before = await evaluate(`({innerHeight,viewport:visualViewport.height,keyboard:document.documentElement.dataset.mobileKeyboard,cssHeight:document.documentElement.style.getPropertyValue('--mobile-viewport-height')})`)
  await metrics(scenario, scenario.height - 300)
  await delay(650)
  await capture('keyboard-resized')
  const after = await evaluate(`({innerHeight,viewport:visualViewport.height,keyboard:document.documentElement.dataset.mobileKeyboard,cssHeight:document.documentElement.style.getPropertyValue('--mobile-viewport-height'),shellHeight:document.querySelector('.p0').getBoundingClientRect().height,focused:document.activeElement?.id})`)
  report.measurements.push({ ...context, name: 'keyboard emulation', method: 'Emulation.setDeviceMetricsOverride', before, after,
    limitation: 'Both layout and visual viewport shrink; dataset.mobileKeyboard may remain closed. No native keyboard was shown.' })
  check('viewport height decreases by 300px under Emulation', Math.abs(before.viewport - after.viewport - 300) <= 2, { before, after }, '300px resize')
  check('mobile viewport CSS variable and shell follow real visualViewport', Math.abs(parseFloat(after.cssHeight) - after.viewport) <= 1 && Math.abs(after.shellHeight - after.viewport) <= 1, after, 'CSS height and shell height track visualViewport')
  check('focused composer survives viewport resize', after.focused === 'home-compose', after.focused, 'home-compose')
  await probe('keyboard composer', node('#home-compose'), { focus: false })
  await probe('keyboard image add', node('#home-xixi .xixi-attachment-button'), { focus: false, touchSize: true })
  await probe('keyboard send', node('#home-xixi .home-capture'), { focus: false })
  await measureLayout('#home-xixi', 'resized chat')
  await metrics(scenario)
  await delay(400)
}

async function runScenario(scenario, image) {
  context = { scenario: scenario.id, page: 'onboarding' }
  const start = report.checks.length
  await send('Page.navigate', { url: 'about:blank' })
  await wait(`location.href==='about:blank' && document.readyState==='complete'`)
  await send('Storage.clearDataForOrigin', { origin: base, storageTypes: 'all' })
  await metrics(scenario)
  await send('Page.navigate', { url: base })
  await wait(`document.documentElement?.dataset.mobile==='preview' && !!document.querySelector('.first-run[open]')`)
  await observe()
  check('fresh isolated database opens first setup', await evaluate(`!document.querySelector('.mobile-startup-error,.p0-error') && document.querySelector('.first-run').dataset.step==='0'`), undefined, 'First-run step 0, no startup errors')
  await evaluate(`document.querySelector('.first-run-customize').open=true`)
  await tap(`first-run theme ${scenario.theme}`, button('.first-run-options button', scenario.theme === 'dark' ? '深色' : '浅色'), { scroll: true })
  await tap(`first-run glass ${scenario.glass}`, button('.first-run-options button', scenario.glass === 'soft' ? '磨砂玻璃' : scenario.theme === 'dark' ? '黑色玻璃' : '通透玻璃'), { scroll: true })
  await tap('first-run manual render options', button('.first-run-render button', '手动调整'), { scroll: true })
  await wait(`!!document.querySelector('select[aria-label="初始帧率"]')`)
  const renderOptions = await evaluate(`({fps:[...document.querySelector('select[aria-label="初始帧率"]').options].map(e=>e.text),quality:[...document.querySelector('select[aria-label="初始画质"]').options].map(e=>e.value)})`)
  check('first setup offers 30/45/60/90/120 FPS and all quality presets', ['30 FPS','45 FPS','60 FPS','90 FPS','120 FPS'].every(value => renderOptions.fps.includes(value)) && ['ultra','high','low','safe'].every(value => renderOptions.quality.includes(value)), renderOptions)
  await setSelect('select[aria-label="初始帧率"]', 'full')
  await setSelect('select[aria-label="初始画质"]', 'ultra')
  await capture('onboarding-manual-render')
  await measureLayout('.first-run', 'first setup')
  await probe('first setup continue', node('.first-run-next'))
  await tap('save first-run appearance and rendering', node('.first-run-next'))
  await wait(`document.querySelector('.first-run')?.dataset.step==='1'`)
  const preferences = await api('preferences')
  check('first-run UI persists exact theme/glass/frame-rate/quality', preferences.theme === scenario.theme && preferences.glass === scenario.glass && preferences.render.profile === 'full' && preferences.render.quality === 'ultra',
    { theme: preferences.theme, glass: preferences.glass, render: preferences.render }, { theme: scenario.theme, glass: scenario.glass, profile: 'full', quality: 'ultra' })
  // Complete onboarding through the real worker after exercising its first UI step; no keys or model calls.
  await api('onboarding', { completed: true })
  await api('tasks/create', { title: 'QA：阅读并核对实验记录（仅隔离数据库）', estimateMin: 30, inbox: false, due: '2026-10-22' })
  await collectLocalCalls()
  await send('Page.reload')
  await wait(`!!document.querySelector('.home-brand') && !document.querySelector('.first-run') && !document.querySelector('.home-current-title')?.disabled`)
  await observe()
  context.page = 'home'
  await delay(1000)
  await capture('home')
  const tasks = await api('tasks')
  check('relaunch restores the one task from real SQLite/IndexedDB', Array.isArray(tasks) && tasks.length === 1 && tasks[0].title.startsWith('QA：阅读并核对'), { count: tasks.length, title: tasks[0]?.title }, 'One isolated fixture task after reload')
  const db = await evaluate('indexedDB.databases()')
  const workerTargets = (await send('Target.getTargets')).targetInfos.filter(target => target.type === 'worker' && target.url.startsWith(base))
  check('production data worker and IndexedDB are actually present', db.length > 0 && workerTargets.length > 0, { databases: db, workers: workerTargets.map(({ type, url }) => ({ type, url })) })
  await measureLayout('.home-workspace', 'home')
  await probe('home navigation', node('.home-brand'), { touchSize: true })
  const current = await probe('current task', node('.home-current-title'))
  const launch = await probe('open chat', node('.home-launch'))
  const currentBlock = await evaluate(`(()=>{const e=document.querySelector('.home-current'),r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,viewport:visualViewport.height,styleTop:getComputedStyle(e).top}})()`)
  check('current task uses the readable bottom-196 placement and does not overlap chat launch', Math.abs(currentBlock.top - (scenario.height - 196)) <= 2 && current.box.bottom <= launch.box.y + 1,
    { currentBlock, current: current.box, launch: launch.box }, 'top = viewport height − 196; current task ends above launch')
  await tap('expand chat', node('.home-launch'))
  await wait(`document.querySelector('.home-launch')?.getAttribute('aria-expanded')==='true' && !document.querySelector('#home-xixi').inert`)
  await delay(700)
  context.page = 'chat'
  await capture('chat-expanded')
  await measureLayout('#home-xixi', 'expanded chat')
  await probe('chat composer', node('#home-compose'))
  const plus = await probe('round image add', node('#home-xixi .xixi-attachment-button'), { touchSize: true })
  const attachment = await evaluate(`({count:document.querySelectorAll('#home-xixi .home-compose-actions .xixi-attachment-button').length,header:document.querySelectorAll('#home-xixi > header [aria-label*="图片"],#home-xixi > header input[type=file]').length,path:document.querySelector('#home-xixi .xixi-attachment-button path')?.getAttribute('d'),multiple:document.querySelector('#home-image-upload').multiple,accept:document.querySelector('#home-image-upload').accept})`)
  check('one round plus next to Send; no header image entry; one-image picker', attachment.count === 1 && attachment.header === 0 && !attachment.multiple && attachment.path === 'M8 3v10M3 8h10' && Math.abs(plus.box.width - plus.box.height) <= 1 && plus.radius === '50%', { attachment, plus }, 'Single circular plus, single image input, no top image button')
  await send('Page.setInterceptFileChooserDialog', { enabled: true })
  let chooser
  const chooserEvent = message => { if (message.method === 'Page.fileChooserOpened') chooser = message.params }
  eventObservers.add(chooserEvent)
  try {
    await tap('image picker plus', node('#home-xixi .xixi-attachment-button'))
    for (let attempt = 0; attempt < 50 && !chooser; attempt++) await delay(50)
    check('touch opens the real single-file chooser', chooser?.mode === 'selectSingle', chooser?.mode, 'selectSingle')
    if (!chooser) throw Error('No file chooser opened')
    await send('DOM.setFileInputFiles', { files: [image], backendNodeId: chooser.backendNodeId })
    await wait(`document.querySelectorAll('#home-xixi .xixi-attachment-chip img').length===1 && document.querySelector('#home-xixi .xixi-attachment-chip img').naturalWidth>0`)
  } finally { eventObservers.delete(chooserEvent); await send('Page.setInterceptFileChooserDialog', { enabled: false }) }
  await capture('chat-image-preview')
  const previewState = await evaluate(`({count:document.querySelectorAll('#home-xixi .xixi-attachment-chip img').length,name:document.querySelector('#home-xixi .xixi-attachment-chip span')?.textContent,inputCount:document.querySelector('#home-image-upload').files.length,sendDisabled:document.querySelector('#home-xixi .home-capture').disabled})`)
  check('exactly one real selected PNG is previewed; file input reset; Send enabled', previewState.count === 1 && previewState.name.includes('qa-single-image.png') && previewState.inputCount === 0 && !previewState.sendDisabled, previewState)
  await probe('image preview remove', node('#home-xixi .xixi-attachment-remove'))
  await tap('remove selected image', node('#home-xixi .xixi-attachment-remove'))
  await wait(`!document.querySelector('#home-xixi .xixi-attachment-preview')`)
  check('removing image clears preview and disables empty Send', await evaluate(`!document.querySelector('#home-xixi .xixi-attachment-chip') && document.querySelector('#home-xixi .home-capture').disabled`))
  await capture('chat-image-removed')
  await keyboard(scenario)
  context.page = 'chat'
  await tap('collapse chat', node('.home-collapse'))
  await wait(`document.querySelector('.home-launch')?.getAttribute('aria-expanded')==='false'`)
  await delay(400)

  for (const { title, page, root, primary } of [
    { title: '日程', page: 'schedule', root: '.planner[data-active=true]', primary: '.pl-header-add' },
    { title: '余时', page: 'free-time', root: '.free-time-page[data-active=true]', primary: '.free-time-wish-heading > button' },
    { title: '工作台', page: 'workbench', root: '.workbench[data-active=true]', primary: '.wb-task' },
  ]) {
    context.page = page
    await navigate(title, root)
    await capture(page)
    await measureLayout(root, title)
    await probe(`${title} primary action`, node(`${root} ${primary}`), { scroll: page === 'workbench' })
    if (page === 'schedule') {
      await probe('schedule every-week edit', node(`${root} .pl-header-edit`))
      await tap('switch schedule to week', node(`${root} .pl-segment button[data-mode=week]`))
      await wait(`document.querySelector(${quote(root)})?.dataset.mode==='week'`)
      check('schedule view actually changes after touch', await evaluate(`document.querySelector(${quote(root)})?.dataset.mode==='week'`))
      await capture('schedule-week')
      await measureLayout(root, 'weekly schedule')
    }
    if (page === 'free-time') {
      await tap('open wish composer', node(`${root} ${primary}`))
      await wait(`document.querySelector(${quote(`${root} ${primary}`)})?.getAttribute('aria-expanded')==='true'`)
      await probe('wish input focus and viewport', node(`${root} .free-time-wish-start textarea`), { scroll: true })
      await capture('free-time-wish')
    }
    if (page === 'workbench') {
      await tap('open isolated task in workbench', node(`${root} ${primary}`))
      await wait(`!!document.querySelector(${quote(`${root} .wb-back`)})`)
      await capture('workbench-task')
      await measureLayout(root, 'workbench task focus')
      await probe('workbench return', node(`${root} .wb-back`))
    }
  }
  context.page = 'settings'
  await navigate('设置', '.xixi-settings')
  await tab('通用')
  const tabs = await evaluate(`(()=>{const e=document.querySelector('.xixi-settings-tabs');return {clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,scrollLeft:e.scrollLeft,wrap:getComputedStyle(e).flexWrap,rows:[...new Set([...e.querySelectorAll('button')].map(b=>Math.round(b.getBoundingClientRect().top)))]}})()`)
  check('phone settings tabs wrap without hiding the final data tab horizontally', tabs.wrap === 'wrap' && tabs.rows.length >= 2 && tabs.scrollWidth <= tabs.clientWidth + 1 && tabs.scrollLeft === 0, tabs, 'Wrapped rows; no horizontal tab scrolling required')
  for (const title of ['通用', '析熙', '时间安排', '通知', '外观与动画', '数据']) {
    await probe(`settings tab ${title} at rest`, button('.xixi-settings-tabs button', title), { touchSize: true })
  }
  await capture('settings-general')
  await measureLayout('.xixi-settings', 'settings general')
  await probe('settings return', node('.xixi-settings-close'))
  await tab('析熙')
  await capture('settings-model')
  await measureLayout('.xixi-settings', 'settings model')
  await probe('API Key input accepts focus', node('#deepseek-local-key'), { scroll: true })
  await send('Input.insertText', { text: 'offline-input-check' })
  check('API Key input is editable after settings load', await evaluate(`document.querySelector('#deepseek-local-key').value==='offline-input-check' && !document.querySelector('#deepseek-local-key').disabled`))
  await evaluate(`(()=>{const e=document.querySelector('#deepseek-local-key');const set=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;set.call(e,'');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
  const modelText = await evaluate(`document.querySelector('.xixi-settings-content').textContent`)
  const localSupport = await api('settings/local/install-options?baseUrl=http%3A%2F%2F127.0.0.1%3A11434%2Fv1')
  const localButton = await control(button('.xixi-model-modes button', '本地模型这台电脑运行'))
  check('phone local model unsupported in real worker and UI', localSupport.supported === false && localSupport.options.length === 0 && /手机端不安装或运行本地模型/u.test(modelText) && /浏览器手机预览不连接云端模型/u.test(modelText) && (!localButton.found || !localButton.visible), { support: localSupport, modelText, localButton })
  check('preview remains preview and does not claim a native model connection', await evaluate(`document.documentElement.dataset.mobile==='preview' && !window.Capacitor?.isNativePlatform?.()`))
  await tab('通知')
  const systemReminder = '.xixi-notification-preferences [role=switch][aria-label="关闭 App 后仍提醒"]'
  await wait(`document.querySelector(${quote(systemReminder)})?.disabled===true`)
  await capture('settings-reminders')
  await measureLayout('.xixi-settings', 'settings reminders')
  const reminders = await api('desktop/reminders')
  const remindersText = await evaluate(`document.querySelector(${quote(systemReminder)}).closest('section').textContent`)
  await probe('unsupported system-reminder switch', node(systemReminder), { scroll: true, focus: false })
  await probe('preview system-reminder explanation', `document.querySelector(${quote(systemReminder)}).closest('section').querySelector('[role=status]')`, { scroll: true, focus: false })
  await capture('settings-reminders-boundary')
  check('preview reminders explicitly unsupported; no false scheduled/native success', reminders.supported === false && reminders.platform === 'web-preview' && reminders.enabled === false && /浏览器预览不保存系统预约/u.test(remindersText) && /浏览器预览不支持/u.test(remindersText) && !/已预约 \d+ 条/u.test(remindersText), { reminders, remindersText })
  check('preview has no test-reminder action', await evaluate(`![...document.querySelectorAll('.xixi-notification-preferences button')].some(e=>e.textContent.trim()==='发送测试提醒')`))
  await tab('数据')
  await wait(`!![...document.querySelectorAll('.xixi-settings-content button')].find(e=>e.textContent.trim()==='导出备份'&&!e.disabled)`)
  await capture('settings-data')
  await measureLayout('.xixi-settings', 'settings data')
  const dataBoundary = await evaluate(`({text:document.querySelector('.xixi-settings-content').textContent,folder:!!document.querySelector('.xixi-folder-sync'),configure:!!document.querySelector('[aria-label="同步传输方式"],[aria-label="同步连接方式"],[aria-label="同步密钥"]'),buttons:[...document.querySelectorAll('.xixi-settings-content button')].map(e=>e.textContent.trim())})`)
  check('mobile data tab explains directory sync not integrated and mounts no folder controls', /手机端.*(?:暂未|尚未).*目录同步/u.test(dataBoundary.text) && !dataBoundary.folder && !dataBoundary.configure && !dataBoundary.buttons.some(text => /选择目录|检查目录|同步组/u.test(text)), dataBoundary)
  await probe('backup export', button('.xixi-settings-content button', '导出备份'), { scroll: true })
  // The actual file input can be visually hidden; its visible label is the import touch target.
  await probe('backup import label', node('.xixi-file-label'), { scroll: true, focus: false })
  check('backup import has the real single JSON file input', await evaluate(`(()=>{const e=document.querySelector('input[aria-label="选择备份文件"]');return !!e&&!e.multiple&&!e.disabled&&e.accept.includes('json')})()`))
  const downloadDir = join(temporary, `downloads-${scenario.id}`)
  await mkdir(downloadDir)
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true })
  await tap('export real isolated local backup', button('.xixi-settings-content button', '导出备份'), { scroll: true })
  await wait(`document.querySelector('.xixi-settings-feedback')?.textContent.includes('备份已下载')`)
  let backupFiles = []
  for (let attempt = 0; attempt < 80; attempt++) {
    backupFiles = (await readdir(downloadDir)).filter(file => /^ASTaria-backup-.*\.json$/u.test(file))
    if (backupFiles.length) break
    await delay(50)
  }
  check('real browser backup download exists; preview does not claim native share success', backupFiles.length === 1 && await evaluate(`!document.querySelector('.xixi-settings-feedback').textContent.includes('备份分享已结束')`), { downloads: backupFiles, feedback: await evaluate(`document.querySelector('.xixi-settings-feedback').textContent`) })
  if (backupFiles.length === 1) {
    const bytes = await readFile(join(downloadDir, backupFiles[0])), backup = JSON.parse(bytes.toString('utf8'))
    check('downloaded backup contains isolated task and no credentials', backup.format === 'astaria-backup' && bytes.includes('QA：阅读并核对实验记录') && !/"(?:apiKey|password|privateKey|secret|token)"\s*:/iu.test(bytes.toString('utf8')), { format: backup.format, version: backup.version, bytes: bytes.length, sha256: digest(bytes) })
  }
  await capture('settings-backup-receipt')
  const calls = await evaluate('window.__mobileQA.calls')
  check('data tab makes no unavailable sync API request', !calls.some(call => /\/sync(?:\/|$)/u.test(call.path)), calls.filter(call => /sync/u.test(call.path)), [])
  check('all real local requests succeeded; no hidden 404', calls.every(call => call.status >= 200 && call.status < 300), calls.filter(call => call.status < 200 || call.status >= 300), [])
  check('QA never invokes model generation or stores a credential', !calls.some(call => /\/api\/(?:chat|settings\/key|settings\/local\/install)$/u.test(call.path)), calls.filter(call => /\/api\/(?:chat|settings\/key)$/u.test(call.path)), [])
  await collectLocalCalls()
  check('scenario completed all required flows', true, undefined, 'All requested pages, chat, settings, data and keyboard checks reached')
  const results = report.checks.slice(start)
  console.log(`${scenario.id}: ${results.filter(item => item.passed).length}/${results.length} checks passed`)
}

async function handle(message) {
  if (message.id) {
    const request = pending.get(message.id)
    if (request) { pending.delete(message.id); clearTimeout(request.timeout); message.error ? request.reject(Error(message.error.message)) : request.done(message.result) }
    return
  }
  for (const observer of eventObservers) observer(message)
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params
    attached.set(sessionId, targetInfo)
    if (targetInfo.type === 'worker') report.workers.push({ ...context, type: targetInfo.type, url: targetInfo.url })
    await send('Runtime.enable', {}, sessionId)
    if (legacyWebView) await send('Runtime.evaluate', { expression: disableModernApis }, sessionId)
    await send('Network.enable', {}, sessionId)
    // Dedicated workers lack the CDP Fetch domain. Install an outbound-only guard
    // before their real script runs; allowed requests retain the original fetch.
    await send('Runtime.addBinding', { name: '__mobileQABlocked' }, sessionId)
    await send('Runtime.evaluate', { expression: `(()=>{
      const original=globalThis.fetch;
      globalThis.fetch=function(input,init){
        const url=new URL(input instanceof Request?input.url:input,location.href);
        if(url.origin!==${quote(base)}&&!['data:','blob:'].includes(url.protocol)){
          globalThis.__mobileQABlocked(url.href);
          return Promise.reject(new TypeError('QA blocked an external worker request'));
        }
        return original.call(this,input,init);
      };
    })()` }, sessionId)
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId)
  }
  if (message.method === 'Runtime.bindingCalled' && message.params.name === '__mobileQABlocked') {
    report.blockedNetwork.push({ ...context, url: message.params.payload, target: 'worker' })
  }
  if (message.method === 'Fetch.requestPaused') {
    const { request, requestId } = message.params, url = new URL(request.url)
    const allowed = url.origin === base || ['data:', 'blob:'].includes(url.protocol)
    if (!allowed) report.blockedNetwork.push({ ...context, url: request.url, target: attached.get(message.sessionId)?.type ?? 'page' })
    await send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, message.sessionId)
  }
  if (message.method === 'Network.requestWillBeSent') report.network.push({ ...context, url: message.params.request.url, type: message.params.type, target: attached.get(message.sessionId)?.type ?? 'page' })
  if (message.method === 'Runtime.exceptionThrown') report.errors.push({ ...context, target: attached.get(message.sessionId)?.type ?? 'page', details: message.params.exceptionDetails })
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') report.consoleErrors.push({ ...context, values: message.params.args.map(arg => arg.value ?? arg.description) })
  if (message.method.startsWith('Browser.download')) downloads.push({ ...context, event: message.method, ...message.params })
}

async function buildMobile() {
  const startedAt = new Date().toISOString()
  const result = await new Promise((done, reject) => {
    const child = spawn('npm', ['run', 'build:mobile'], { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''
    child.stdout.on('data', chunk => { log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    child.on('error', reject)
    child.on('exit', code => done({ code, log }))
  })
  await writeFile(join(output, 'build.log'), result.log)
  const html = await readFile(join(project, 'dist-mobile/index.html'))
  report.build = { command: 'npm run build:mobile', startedAt, finishedAt: new Date().toISOString(), exitCode: result.code,
    log: 'build.log', indexSha256: digest(html), indexModifiedAt: (await stat(join(project, 'dist-mobile/index.html'))).mtime.toISOString(),
    reusedOlderDist: result.code !== 0, assets: [...html.toString().matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/gu)].map(match => match[1]) }
  check('latest production mobile build succeeds', result.code === 0, { exitCode: result.code, buildLog: 'build.log', reusedOlderDist: result.code !== 0 }, 0, ['build.log'])
  console.log(result.code === 0 ? 'Fresh production mobile build ready' : 'Build failed; older dist is diagnostic only and report remains failed')
}
try {
  await mkdir(output, { recursive: true })
  await buildMobile()
  temporary = await mkdtemp(join(tmpdir(), 'astaria-mobile-ui-'))
  const image = join(temporary, 'qa-single-image.png')
  server = await preview({ root: project, configFile: false, build: { outDir: 'dist-mobile' }, preview: {
    host: '127.0.0.1', port: 0, open: false,
    headers: { 'Content-Security-Policy': "connect-src 'self'; worker-src 'self' blob:" },
  } })
  base = `http://127.0.0.1:${server.httpServer.address().port}`
  const profile = join(temporary, 'chrome-profile')
  chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', 'about:blank'], { stdio: 'ignore' })
  let port
  for (let attempt = 0; attempt < 100; attempt++) {
    try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break } catch {}
    await delay(100)
  }
  if (!port) throw Error('Owned Chrome did not open a debug port')
  const target = (await fetch(`http://127.0.0.1:${port}/json`).then(response => response.json())).find(item => item.type === 'page')
  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((done, reject) => { socket.onopen = done; socket.onerror = reject })
  socket.onmessage = event => { void handle(JSON.parse(event.data)).catch(error => report.errors.push({ ...context, harness: error.message })) }
  await send('Page.enable')
  if (legacyWebView) await send('Page.addScriptToEvaluateOnNewDocument', { source: disableModernApis })
  await send('Runtime.enable')
  // Let Chrome encode a valid synthetic PNG; application validation is untouched.
  const png = await evaluate(`(()=>{const c=document.createElement('canvas');c.width=c.height=32;
    const g=c.getContext('2d');g.fillStyle='#3769c8';g.fillRect(0,0,32,32);g.fillStyle='#eac58c';g.fillRect(8,8,16,16);
    return c.toDataURL('image/png').split(',')[1]})()`)
  await writeFile(image, Buffer.from(png, 'base64'))
  await send('Network.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true })
  await send('Emulation.setUserAgentOverride', { userAgent: 'Mozilla/5.0 (Linux; Android 14; QA isolated Chrome) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Mobile Safari/537.36', platform: 'Android', acceptLanguage: 'zh-CN' })
  for (const scenario of selectedScenarios) {
    try { await runScenario(scenario, image) }
    catch (error) {
      let evidence = []
      try { evidence = [await capture(`failure-${context.page}`)]; await collectLocalCalls() } catch {}
      check('scenario completed all required flows', false, { error: error.message, stoppedPage: context.page }, 'All requested pages, chat, settings, data and keyboard checks reached', evidence)
      console.error(`${scenario.id} stopped at ${context.page}: ${error.message}`)
    }
  }
  context = { scenario: 'global', page: 'coverage' }
  for (const scenario of selectedScenarios) for (const page of ['onboarding', 'home', 'chat', 'keyboard', 'schedule', 'free-time', 'workbench', 'settings']) {
    check(`${scenario.id}: ${page} has measured and captured coverage`, report.measurements.some(item => item.scenario === scenario.id && item.page === page && item.kind === 'layout') && report.screenshots.some(item => item.scenario === scenario.id && item.page === page), undefined, 'Page layout measurement and screenshot present', report.screenshots.filter(item => item.scenario === scenario.id && item.page === page).map(item => item.file))
  }
  const finalIndex = await readFile(join(project, 'dist-mobile/index.html'))
  report.build.indexSha256AtFinish = digest(finalIndex)
  check('production index remains identical throughout browser QA', report.build.indexSha256AtFinish === report.build.indexSha256, { before: report.build.indexSha256, after: report.build.indexSha256AtFinish }, 'No concurrent dist-mobile rebuild during this run')
  check('no browser/worker runtime exceptions', report.errors.length === 0, report.errors, [])
  check('no console errors', report.consoleErrors.length === 0, report.consoleErrors, [])
  check('no external network/model attempts', report.blockedNetwork.length === 0 && report.network.every(item => new URL(item.url).origin === base || /^(?:data|blob):/u.test(item.url)), report.blockedNetwork, [])
  check('local API calls never reach the static network server', !report.network.some(item => new URL(item.url).pathname.startsWith('/api/')), report.network.filter(item => new URL(item.url).pathname.startsWith('/api/')), [])
} catch (error) {
  check('QA infrastructure completes', false, error.message, 'Owned Chrome and production preview available')
} finally {
  report.finishedAt = new Date().toISOString()
  report.totals = { passed: report.checks.filter(item => item.passed).length, failed: report.checks.filter(item => !item.passed).length, screenshots: report.screenshots.length }
  report.status = report.totals.failed ? 'failed' : 'passed'
  report.failures = report.checks.filter(item => !item.passed)
  await writeFile(join(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Mobile production QA: ${report.totals.passed} passed, ${report.totals.failed} failed; ${report.totals.screenshots} screenshots; ${join(output, 'report.json')}`)
  for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(Error('QA session closed')) }
  pending.clear()
  socket?.close()
  if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(done => chrome.once('exit', done))
    chrome.kill('SIGTERM')
    await Promise.race([exited, delay(3000)])
    if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited }
  }
  if (server) await new Promise(done => server.httpServer.close(done))
  if (temporary) await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  if (report.status === 'failed') process.exitCode = 1
}
