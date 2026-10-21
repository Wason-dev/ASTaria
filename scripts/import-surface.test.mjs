/** Real rendered component checks, with synthetic files/API and an owned Chrome.
 * No application server, real database, model, credentials or user images.
 * Run: node --test scripts/import-surface.test.mjs
 * Screenshots are evidence to review separately, not a visual-quality assertion.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'

const root = resolve(import.meta.dirname, '..')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const preferences = { version: 1, startupPage: 'home', theme: 'dark', grid: true, glass: 'clear', density: 'compact', cardEdges: 'both', effect: { style: 'off', intensity: 'gentle', motion: 'system' }, render: { profile: 'full', quality: 'auto', glass: 'auto' }, assistant: { autonomy: 'act', personality: 'medium', useMemory: true, useHistory: true }, notifications: { enabled: false, quietStart: '23:00', quietEnd: '08:00', opportunities: false }, focus: { focusMin: 35, restMin: 10 }, scheduling: { bufferMin: 0 } }
const emptyPlanner = () => ({ revision: 10, routines: [], blocks: [], dayEvents: [], details: {}, checked: {} })
const row = (id, subject, weekday, classGroup = '', patch = {}) => ({ id, subject, subjectGroup: subject ? 'Econ' : '', weekday, classGroup, period: '1', start: '08:00', end: '08:40', location: '演示教室', note: '', uncertain: false, cell: '演示格子', weekCycle: 'weekly', ...patch })
const draft = { kind: 'combined', rows: [row('ma', 'Econ1', 1, 'A'), row('mb', 'Econ1', 1, 'B'), row('ta', 'Econ1', 4, 'A'), row('tb', 'Econ1', 4, 'B'), row('other', 'Econ2', 2), row('unknown', '', null, '', { uncertain: true, start: '', end: '', note: '演示：无法判断的原图格子' })] }
const harness = `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{TimetableImport}from'/src/planner/TimetableImport.tsx';import{IcsTimetableImport}from'/src/planner/IcsTimetableImport.tsx';
import{publishPreferences}from'/src/xixi/preferences.ts';
window.setAppearance=(theme,glass,motion='system')=>publishPreferences({...${JSON.stringify(preferences)},theme,glass,effect:{...${JSON.stringify(preferences.effect)},motion}});
function Harness(){const[open,setOpen]=useState(''),[covered,setCovered]=useState(false);return <><div className="fixture-scene"/><div data-import-underlay data-import-covered={covered} inert={covered}><p>底层日程文字 UNDERLAY MUST NOT SHOW</p><button id="open-photo" onClick={()=>setOpen('photo')}>导入课表</button><button id="open-ics" onClick={()=>setOpen('ics')}>导入 ICS</button></div>{open==='photo'&&<TimetableImport onOpenChange={setCovered} onClose={()=>setOpen('')} onSaved={()=>{window.savedNotifications=(window.savedNotifications||0)+1}}/>}{open==='ics'&&<IcsTimetableImport onOpenChange={setCovered} onClose={()=>setOpen('')} onSaved={()=>{window.savedNotifications=(window.savedNotifications||0)+1}}/>}</>};(window.__qaRoot??=createRoot(document.getElementById('root'))).render(<Harness/>);`
const html = `<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}body{background:#0b101b;font:13px Inter,Arial,sans-serif}.fixture-scene{position:fixed;inset:0;background:radial-gradient(ellipse 50% 8% at 65% 45%,#f2e7c9d0 0%,#b99a7155 35%,transparent 90%),radial-gradient(circle at 64% 43%,#020309 0 13%,#263345 20%,#131d30 34%,#0b101b 60%)}[data-import-underlay]{position:relative;padding:70px;color:#f6cfef}[data-import-underlay] p{font-size:36px}</style><div id="root"></div><script type="module" src="/__import_surface_test__/main.tsx"></script>`

test('import surfaces: actual hits, exclusive steps, retained drafts, themes, geometry, focus and receipts', { timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'astaria-import-surface-'))
  const output = process.env.IMPORT_SURFACE_QA_OUTPUT ?? '/tmp/astaria-import-surface-qa'
  await mkdir(output, { recursive: true })
  const calls = [], errors = [], checks = []
  let planner = emptyPlanner(), configured = false, conflict = false, recognitionDelay = 0, chooser, chrome, ws, vite, serial = 0
  const pending = new Map()
  t.after(async () => { ws?.close(); if (chrome && chrome.exitCode === null) await new Promise(resolve => { const timer = setTimeout(resolve, 3000); chrome.once('exit', () => { clearTimeout(timer); resolve() }); chrome.kill() }); await vite?.close(); await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })
  const api = async (path, body) => {
    calls.push({ path, body })
    if (path === '/api/preferences') return preferences
    if (path === '/api/status') return { configured, supportsVision: true, model: '演示视觉模型' }
    if (path === '/api/planner') return planner
    if (path === '/api/planner/import/recognize') { await delay(recognitionDelay); return { draft } }
    if (path === '/api/planner/import/confirm') {
      if (conflict) { conflict = false; return { error: '演示版本冲突', status: 409 } }
      planner = { ...planner, revision: planner.revision + body.rows.length, routines: body.rows.map((item, index) => ({ id: `photo-${index}`, title: item.subject, kind: 'class', weekdays: [item.weekday % 7], start: item.start, end: item.end })) }
      return { state: planner, importedCount: body.rows.length, importedIds: planner.routines.map(item => item.id), operation: { id: 'photo-operation', summary: `已保存 ${body.rows.length} 项课程`, undoable: true, undoneAt: null } }
    }
    if (path === '/api/planner/import/ics/preview') return { draft: { timezone: body.timezone, rows: Array.from({ length: 18 }, (_, index) => ({ id: `ics-${index}`, subject: index === 0 ? '演示长课程名称 / Extended course title' : `演示课程 ${index + 1}`, date: `2030-01-${String(index + 1).padStart(2, '0')}`, start: '09:00', end: '09:45', location: '演示地点', note: '演示备注' })) } }
    if (path === '/api/planner/import/ics/confirm') {
      planner = { ...planner, revision: planner.revision + body.rows.length, dayEvents: body.rows.map((item, index) => ({ ...item, title: item.subject.trim(), id: `saved-ics-${index}`, items: [] })) }
      return { state: planner, importedCount: body.rows.length, importedIds: planner.dayEvents.map(item => item.id), operation: { id: 'ics-operation', undoable: true, undoneAt: null } }
    }
    if (/\/operations\/.+\/undo$/u.test(path)) { planner = { ...emptyPlanner(), revision: planner.revision + 1 }; return { id: path.includes('photo') ? 'photo-operation' : 'ics-operation', summary: '已撤销演示课程导入', undoable: false, undoneAt: '2030-01-01T00:00:00Z' } }
    throw Error(`Unmocked API: ${path}`)
  }
  vite = await createServer({ configFile: false, root, cacheDir: join(temporary, 'vite-cache'), logLevel: 'error', plugins: [react(), {
    name: 'isolated-import-fixture',
    resolveId(id) { if (id === '/__import_surface_test__/main.tsx' || id === join(root, '__import_surface_test__.tsx')) return join(root, '__import_surface_test__.tsx') },
    load(id) { if (id === join(root, '__import_surface_test__.tsx')) return harness },
    configureServer(server) { server.middlewares.use(async (req, res, next) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end(await server.transformIndexHtml('/', html)); return }
      if (!req.url?.startsWith('/api/')) return next()
      try { let raw = ''; for await (const chunk of req) raw += chunk; const value = await api(req.url, raw ? JSON.parse(raw) : undefined); res.statusCode = value.status ?? 200; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
      catch (error) { errors.push(String(error)); res.statusCode = 500; res.end('{}') }
    }) },
  }], server: { host: '127.0.0.1', port: 0, open: false, hmr: false } })
  await vite.listen()
  const base = `http://127.0.0.1:${vite.httpServer.address().port}`
  const profile = join(temporary, 'chrome-profile')
  chrome = spawn(process.env.IMPORT_SURFACE_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps', 'about:blank'], { stdio: 'ignore' })
  let port
  for (let i = 0; i < 100; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (port) break } catch {} await delay(50) }
  assert.ok(port, 'owned Chrome is available')
  const page = (await fetch(`http://127.0.0.1:${port}/json`).then(r => r.json())).find(item => item.type === 'page')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++serial; const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout ${method}`)) }, 12000); pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params })) })
  ws.onmessage = event => {
    const m = JSON.parse(event.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.text)
    if (m.method === 'Page.fileChooserOpened') chooser = m.params
    if (m.id) { const p = pending.get(m.id); if (p) { clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result) } }
  }
  const evaluate = async expression => { const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails)); return r.result.value }
  const wait = async expression => { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await delay(35) } throw Error(`Timeout ${expression}`) }
  const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
  const click = async (selector, position = .5) => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`)
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width*${position},y=r.y+r.height/2;if(e.disabled||!e.contains(document.elementFromPoint(x,y)))throw Error('Disabled/occluded '+${JSON.stringify(selector)});return{x,y}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const key = async (key, code, windowsVirtualKeyCode) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }) }
  const shot = async name => { const r = await send('Page.captureScreenshot', { format: 'png' }); await writeFile(join(output, `${name}.png`), Buffer.from(r.data, 'base64')) }
  const screen = async value => { await wait(`document.querySelector('.import-surface')?.dataset.step===${JSON.stringify(value)}&&!document.querySelector('.import-step[data-leaving=true]')`); await delay(220) }
  const geometry = () => evaluate(`(()=>{const r=document.querySelector('dialog').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()`)
  const noOverflow = name => check(name, `(()=>{const d=document.querySelector('dialog'),b=d.querySelector('.import-body'),f=d.querySelector('footer'),r=d.getBoundingClientRect(),fr=f.getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&b.scrollWidth<=b.clientWidth+1&&r.left>=-1&&r.right<=innerWidth+1&&fr.bottom<=innerHeight+1&&fr.top>=0})()`)
  const close = async () => { await click('.import-close:not(.import-back)'); await wait(`!document.querySelector('dialog')`); await delay(20) }
  const pick = async (file, selector = '.import-drop') => { chooser = null; await click(selector); for (let i = 0; i < 50 && !chooser; i++) await delay(20); assert.ok(chooser, 'real file-chooser request fired'); await send('DOM.setFileInputFiles', { files: [file], backendNodeId: chooser.backendNodeId }) }
  await send('Page.enable'); await send('Runtime.enable'); await send('Page.setInterceptFileChooserDialog', { enabled: true })
  await send('Network.enable'); await send('Network.setBlockedURLs', { urls: ['https://*', 'http://localhost/*'] })
  await send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Shanghai' })
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: base }); await wait(`!!document.querySelector('#open-photo')`)
  const png = await evaluate(`(()=>{const c=document.createElement('canvas');c.width=320;c.height=480;const x=c.getContext('2d');x.fillStyle='#eee9d9';x.fillRect(0,0,320,480);x.strokeStyle='#7d807c';for(let n=0;n<8;n++){x.strokeRect(n*40,0,40,480)}for(let n=0;n<12;n++){x.strokeRect(0,n*40,320,40)}x.fillStyle='#28333d';x.font='16px sans-serif';x.fillText('SYNTHETIC QA',30,25);return c.toDataURL()})()`)
  const imageFile = join(temporary, 'synthetic-timetable.png'), icsFile = join(temporary, 'synthetic.ics')
  await writeFile(imageFile, Buffer.from(png.split(',')[1], 'base64')); await writeFile(icsFile, 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR')
  await click('#open-photo')
  const firstGeometry = await geometry(); await shot('entry-initial'); await delay(60); await shot('entry-middle'); assert.deepEqual(await geometry(), firstGeometry, 'entry has final shell geometry at start and middle'); await delay(220); assert.deepEqual(await geometry(), firstGeometry); await shot('entry-settled')
  await check('upload has no empty code/group/preview panels', `document.querySelector('dialog').dataset.step==='upload'&&!document.querySelector('[data-testid=timetable-codes]')&&!document.querySelector('[data-testid=timetable-preview]')&&!document.querySelector('[data-testid=timetable-groups]')`)
  await check('parent foreground hidden while scene stays visible', `getComputedStyle(document.querySelector('[data-import-underlay]')).visibility==='hidden'&&getComputedStyle(document.querySelector('.fixture-scene')).visibility==='visible'`)
  await click('[role=switch]', .15); await check('switch text hits before file/model', `document.querySelector('[role=switch]').getAttribute('aria-checked')==='true'&&!document.querySelector('[role=switch]').disabled&&document.querySelector('[data-testid=timetable-recognize]').disabled`)
  await click('[role=switch]', .9); await check('switch track hits too', `document.querySelector('[role=switch]').getAttribute('aria-checked')==='false'`)
  await click('[role=switch]'); await key(' ', 'Space', 32); await check('switch supports native keyboard activation', `document.querySelector('[role=switch]').getAttribute('aria-checked')==='false'`)
  await check('disabled recognition explains disconnected model', `document.querySelector('.tti-model-status').textContent.includes('模型尚未连接')`)
  for (const width of [1280, 390, 320]) {
    await evaluate(`document.getElementById('root').classList.toggle('m-app',${width < 700})`)
    await send('Emulation.setDeviceMetricsOverride', { width, height: width > 700 ? 900 : 780, deviceScaleFactor: 1, mobile: width < 700 })
    for (const theme of ['dark', 'light']) for (const glass of ['clear', 'soft']) {
      await evaluate(`window.setAppearance('${theme}','${glass}')`); await delay(60)
      await noOverflow(`${width} ${theme}/${glass} upload fits`)
      await shot(`upload-${width}-${theme}-${glass}`)
    }
  }
  await evaluate(`window.setAppearance('dark','clear')`)
  configured = true; await click('.tti-model-status button'); await wait(`!document.querySelector('.tti-model-status button')`)
  await click('[role=switch]'); await pick(imageFile); await wait(`!!document.querySelector('.tti-preview img')&&document.querySelector('.tti-preview img').complete`)
  await click('.tti-preview'); await screen('image'); await key('Escape','Escape',27); await screen('upload'); await check('Escape returns from original image without closing import', `!!document.querySelector('dialog[open]')&&!!document.querySelector('.tti-preview img')`)
  recognitionDelay = 180
  await click('[data-testid=timetable-recognize]'); await check('recognizing prevents repeated submit and switch changes', `document.querySelector('[data-testid=timetable-recognize]').disabled&&document.querySelector('[role=switch]').disabled`); await shot('recognizing-320')
  await screen('codes')
  const recognition = calls.find(item => item.path.endsWith('/recognize')).body
  assert.equal(recognition.split, true); assert.equal(recognition.images.length, 7); assert.equal(recognition.images[0].data, png)
  await check('codes screen mounts only after draft and focuses heading', `!!document.querySelector('[data-testid=timetable-codes]')&&!document.querySelector('[data-testid=timetable-upload]')&&!document.querySelector('[data-testid=timetable-preview]')&&document.activeElement.matches('[data-step-heading]')`)
  await click('[data-code=Econ1]'); await click('[data-testid=timetable-continue-codes]'); await click('[data-import-back]'); await screen('codes'); await check('rapid step reversal preserves selection without duplicate panels', `document.querySelectorAll('.import-step').length===1&&document.querySelector('[data-code=Econ1]').getAttribute('aria-pressed')==='true'`); await click('[data-testid=timetable-continue-codes]'); await delay(45); await shot('step-out-middle'); await screen('groups')
  await shot('groups-320'); await noOverflow('320 groups fit')
  await click('.tti-code-chips button'); await click('[data-testid=timetable-continue-groups]'); await screen('preview')
  await check('all-week selected group and unknown cells preserved', `document.querySelectorAll('.tti-rows>.tti-row').length===2&&!!document.querySelector('.tti-unresolved')&&document.querySelector('[data-testid=timetable-confirm]').disabled`)
  await shot('preview-unknown-320'); await noOverflow('320 preview fits')
  await click('.tti-unresolved .tti-row-title button'); await check('explicit unknown removal enables confirmation', `!document.querySelector('[data-testid=timetable-confirm]').disabled`)
  await click('.tti-rows .tti-row details summary'); await click('.tti-rows .tti-row .tti-subject input')
  await evaluate(`window.imeInput=document.activeElement;window.imeInput.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));true`)
  await send('Input.imeSetComposition', { text: '演示输入', selectionStart: 4, selectionEnd: 4 })
  await check('IME composition retains input node and focus', `window.imeInput===document.activeElement&&window.imeInput.isConnected`)
  await send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 })
  await evaluate(`window.imeInput.select()`); await send('Input.insertText', { text: 'Econ1-reviewed' })
  await evaluate(`document.getElementById('root').style.setProperty('--m-visible-height','480px');document.getElementById('root').style.setProperty('--m-safe-top','24px');document.getElementById('root').style.setProperty('--m-safe-bottom','20px')`)
  await check('mobile safe-area variables reach header and footer', `getComputedStyle(document.querySelector('.import-header')).paddingTop==='38px'&&getComputedStyle(document.querySelector('.import-footer')).paddingBottom==='32px'`)
  await check('keyboard variable only resizes foreground, keeping scene stable', `document.querySelector('dialog').getBoundingClientRect().bottom<=480&&document.querySelector('.fixture-scene').getBoundingClientRect().height===780`)
  await wait(`(()=>{const e=window.imeInput.getBoundingClientRect(),b=document.querySelector('.import-body').getBoundingClientRect();return e.top>=b.top&&e.bottom<=b.bottom})()`)
  await check('focused editor stays above the footer after keyboard resize', `window.imeInput===document.activeElement&&window.imeInput.getBoundingClientRect().bottom<=document.querySelector('.import-body').getBoundingClientRect().bottom`)
  await noOverflow('foreground remains contained with a shorter keyboard viewport')
  await shot('keyboard-viewport-320'); await evaluate(`document.getElementById('root').style.removeProperty('--m-visible-height');document.getElementById('root').style.removeProperty('--m-safe-top');document.getElementById('root').style.removeProperty('--m-safe-bottom')`); await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
  // Return through groups: answers, edited DOM state, selection and rows survive.
  await click('[data-import-back]'); await screen('groups'); await check('group answer survives back', `document.querySelector('.tti-code-chips [aria-pressed=true]').textContent==='A'`)
  await click('[data-testid=timetable-continue-groups]'); await screen('preview')
  await check('review edits survive back and rematching', `document.querySelector('.tti-rows>.tti-row').textContent.includes('Econ1-reviewed')`)
  conflict = true; await click('[data-testid=timetable-confirm]'); await wait(`!!document.querySelector('[role=alert]')`)
  await check('version conflict retains draft and blocks resubmit', `document.querySelectorAll('.tti-rows>.tti-row').length===2&&document.querySelector('[data-testid=timetable-confirm]').disabled`); await shot('version-conflict-desktop')
  await click('.tti-feedback button'); await wait(`!document.querySelector('[data-testid=timetable-confirm]').disabled`)
  await click('[data-testid=timetable-confirm]'); await screen('saved')
  await check('saved is exclusive and receipt replaces editor', `!!document.querySelector('[data-testid=timetable-receipt]')&&!document.querySelector('[data-testid=timetable-preview]')&&!document.querySelector('[role=switch]')`)
  const confirm = calls.filter(item => item.path === '/api/planner/import/confirm').at(-1).body
  assert.equal(confirm.rows.length, 2); assert.ok(confirm.rows.every(item => item.classGroup === 'A')); assert.equal(confirm.expectedRevision, 10)
  await shot('saved-desktop'); await click('.tti-footer button:first-of-type'); await wait(`document.querySelector('.tti-saved h3').textContent.includes('已撤销')`)
  await click('.import-close:not(.import-back)'); await check('exit keeps modal and underlay covered before onClose', `document.querySelector('dialog')?.dataset.closing==='true'&&getComputedStyle(document.querySelector('[data-import-underlay]')).visibility==='hidden'`); await delay(80); await shot('exit-middle'); await wait(`!document.querySelector('dialog')`); await delay(10)
  await check('close restores opener focus and parent foreground', `document.activeElement.id==='open-photo'&&getComputedStyle(document.querySelector('[data-import-underlay]')).visibility==='visible'`)
  // No groups for a single unambiguous code, including long strings.
  draft.rows = [row('long', 'Econ2_ExtendedCourseCode_ABCDEFGHIJKLMNOPQRSTUVWXYZ', 2)]
  await click('#open-photo'); await pick(imageFile); await wait(`!document.querySelector('[data-testid=timetable-recognize]').disabled`); await click('[data-testid=timetable-recognize]'); await screen('codes'); await click('[data-testid=timetable-code]'); await click('[data-testid=timetable-continue-codes]'); await screen('preview'); await check('unambiguous draft skips groups', `!document.querySelector('[data-testid=timetable-groups]')&&document.querySelectorAll('.tti-rows>.tti-row').length===1`)
  for (const theme of ['dark', 'light']) for (const glass of ['clear', 'soft']) { await evaluate(`window.setAppearance('${theme}','${glass}')`); await delay(60); await shot(`preview-desktop-${theme}-${glass}`) }
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 780, deviceScaleFactor: 1, mobile: true }); await noOverflow('320 long code fits'); await shot('preview-long-320'); await close()
  // Manual route, including stable custom select and retained draft on back.
  await click('#open-photo'); await click('.tti-manual button'); await screen('preview'); await check('manual route opens editable review directly', `!!document.querySelector('.tti-row details[open]')&&!document.querySelector('[data-testid=timetable-codes]')`)
  await click('.import-select > button'); await click('.import-select-options [role=option]:nth-child(2)'); await check('custom weekday selector works', `document.querySelector('.import-select > button').textContent.includes('周一')`)
  await click('[data-import-back]'); await screen('upload'); await click('.tti-footer button:nth-last-child(2)'); await screen('preview'); await check('manual draft retained on back', `document.querySelectorAll('.tti-rows>.tti-row').length===1&&document.querySelector('.import-select > button').textContent.includes('周一')`); await close()
  // ICS is a separate one-task-at-a-time flow, with one vertical scroll owner.
  await click('#open-ics'); await check('ICS upload has no empty selection table or confirm', `!document.querySelector('table')&&!document.querySelector('[data-testid=ics-timetable-confirm]')`); await shot('ics-upload-320')
  await pick(icsFile); await screen('preview'); await noOverflow('ICS table is contained at 320')
  for (const width of [1280,390,320]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height: width > 700 ? 900 : 780, deviceScaleFactor: 1, mobile: width < 700 })
    await evaluate(`document.getElementById('root').classList.toggle('m-app',${width < 700})`)
    for (const theme of ['dark','light']) for (const glass of ['clear','soft']) { await evaluate(`window.setAppearance('${theme}','${glass}')`); await delay(50); await noOverflow(`ICS ${width} ${theme}/${glass} fits`); await shot(`ics-preview-${width}-${theme}-${glass}`) }
  }
  await evaluate(`window.setAppearance('dark','clear')`)
  await check('ICS body owns vertical scrolling; table only scrolls horizontally', `(()=>{const t=document.querySelector('.ics-import-table-scroll');return t.scrollHeight<=t.clientHeight+1&&t.scrollWidth>t.clientWidth&&document.querySelector('.import-body').scrollHeight>document.querySelector('.import-body').clientHeight})()`)
  await click('.ics-import-pick'); await shot('ics-preview-320'); await click('[data-testid=ics-timetable-confirm]'); await screen('saved'); await shot('ics-saved-320')
  await click('.ics-import-footer button:first-of-type'); await wait(`document.querySelector('.ics-import-receipt h3').textContent.includes('已撤销')`); await close()
  preferences.effect.motion = 'reduced'
  await evaluate(`window.setAppearance('dark','clear','reduced')`); await click('#open-photo'); await delay(50)
  await check('app reduced motion disables animation', `getComputedStyle(document.querySelector('.import-surface-content')).animationName==='none'`); await close()
  preferences.effect.motion = 'system'
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await evaluate(`window.setAppearance('dark','clear','system')`); await click('#open-photo'); await delay(40)
  await check('system reduced motion disables animation', `getComputedStyle(document.querySelector('.import-step')).animationName==='none'`); await close()
  assert.deepEqual(errors, [], 'no runtime errors')
  await writeFile(join(output, 'checks.json'), JSON.stringify({ checks, screenshots: output, note: 'Synthetic scene; screenshot review and native IME/device verification are separate.' }, null, 2))
  t.diagnostic(`${checks.length} interaction/layout assertions. Screenshots: ${output}`)
})
