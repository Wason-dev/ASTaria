/** Beta12.1 regression: owned browser, in-memory data and scripted vision provider. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { DEFAULT_PREFERENCES } from '../server/preferences.mjs'
import { saveModelSettings } from '../server/modelSettings.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const temporary = await mkdtemp(join(tmpdir(), 'astaria-beta12-patch-'))
const output = resolve(process.env.PATCH_QA_OUTPUT ?? join(root, 'artifacts/beta12.1-ui'))
const profile = join(temporary, 'chrome-profile')
const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII='
const db = createDatabase(':memory:')
const task = db.createTask({ title: '核对实验记录', estimateMin: 30, inbox: false })
db.setPreference('onboarding-completed', true)
const preferences = { ...DEFAULT_PREFERENCES, render: { profile: 'full', quality: 'ultra', glass: 'auto' } }
db.setPreference('app', preferences)
saveModelSettings(db, { provider: 'local', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: false,
  contextBudget: { mode: 'auto', maxUnits: 48_000 }, webSearch: { enabled: false, maxUses: 2 },
  local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen3-vl:8b' } })
const checks = [], errors = [], calls = [], budgets = [], blockedRequests = []
let chrome, vite, ws, base, stopping = false, releaseReply, holdNext = false, chooser
const service = createLocalService({ db, dataDirectory: ':memory:',
  vault: { status: async () => true, read: async () => { throw Error('QA must never read credentials') } },
  fetcher: async () => { throw Error('QA must never contact external services') },
  complete: async payload => {
    calls.push(payload)
    if (holdNext) { holdNext = false; await new Promise(resolve => { releaseReply = resolve }) }
    return { choices: [{ message: { role: 'assistant', content: '收到了，我们接着看这件事。' } }] }
  },
})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let serial = 0
const pending = new Map()
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial
  const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 20000)
  pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = async expression => {
  for (let index = 0; index < 300; index++) {
    try { if (await evaluate(expression)) return }
    catch (error) {
      // Reload may invalidate the old execution context after Page.reload replies.
      if (!/Inspected target navigated or closed|Execution context was destroyed|Cannot find context/u.test(error.message)) throw error
    }
    await delay(100)
  }
  throw Error(`Timeout: ${expression}`)
}
const check = async (name, expression) => { assert.equal(await evaluate(expression), true, name); checks.push(name) }
const click = async selector => {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`)
  await delay(100)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(e.disabled||e.closest('[inert]')||!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Unavailable '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  await delay(100)
}
const nav = async text => {
  if (await evaluate(`document.querySelector('#home-menu').inert`)) await click('.home-brand')
  await evaluate(`(()=>{const e=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing navigation');e.dataset.patchClick='true'})()`)
  await click('[data-patch-click]'); await evaluate(`document.querySelectorAll('[data-patch-click]').forEach(e=>delete e.dataset.patchClick)`)
}
const shot = async name => writeFile(join(output, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
const drop = async (filesExpression, type = 'drop', extra = '') => evaluate(`(()=>{const d=new DataTransfer();for(const f of ${filesExpression})d.items.add(f);${extra}const e=new DragEvent(${JSON.stringify(type)},{bubbles:true,cancelable:true,dataTransfer:d});document.body.dispatchEvent(e);return e.defaultPrevented})()`)
const image = name => `[new File([Uint8Array.from(atob('${png}'),c=>c.charCodeAt(0))],${JSON.stringify(name)},{type:'image/png'})]`
const selected = (host, name) => `document.querySelector(${JSON.stringify(`${host} .xixi-attachment-chip`)})?.textContent.includes(${JSON.stringify(name)})`
const draft = async (selector, text) => evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`)
const settled = `!window.__ASTARIA_P0__.getSnapshot().cameraTransition`
const observe = () => evaluate(`(()=>{window.patchBudgets=[];window.patchObserving=true;const tick=()=>{if(!window.patchObserving)return;const s=window.__ASTARIA_P0__.getSnapshot();window.patchBudgets.push({moving:s.cameraTransition,fps:s.targetFps,scene:s.renderScene,quality:s.quality});requestAnimationFrame(tick)};tick();return true})()`)
const finishObservation = async (name, rate) => {
  const samples = await evaluate(`window.patchObserving=false;window.patchBudgets`)
  assert.ok(samples.some(sample => sample.moving), `${name}: real camera moved`)
  assert.ok(samples.every(sample => !sample.moving || sample.fps === rate), `${name}: all moving frames retain ${rate}: ${JSON.stringify(samples.filter(s=>s.moving&&s.fps!==rate))}`)
  assert.ok(samples.every(sample => sample.quality === 'ultra'), `${name}: manual quality retained`)
  budgets.push({ name, rate, frames: samples.length, movingFrames: samples.filter(s=>s.moving).length, movingBudgets: [...new Set(samples.filter(s=>s.moving).map(s=>s.fps))], final: samples.at(-1) })
  checks.push(`${name}: moving camera retains ${rate} FPS and ultra quality`)
}
const composer = async host => {
  await check(`${host}: no upload toolbar above textarea`, `!document.querySelector('${host} .home-input-shell .xixi-attachment-button,${host} .wb-input-shell .xixi-attachment-button,${host} .xixi-attachment-picker')`)
  await check(`${host}: circular plus directly left of Send`, `(()=>{const p=document.querySelector('${host} .xixi-attachment-button'),s=p.nextElementSibling,pr=p.getBoundingClientRect(),sr=s.getBoundingClientRect(),c=getComputedStyle(p);return p.parentElement.className==='xixi-send-actions'&&s.type==='submit'&&pr.right<sr.left&&Math.abs(pr.width-pr.height)<.1&&Math.abs(pr.y+pr.height/2-sr.y-sr.height/2)<1&&c.borderRadius==='50%'&&c.borderTopStyle==='solid'&&parseFloat(c.borderTopWidth)>=1&&c.borderTopColor!=='rgba(0, 0, 0, 0)'&&p.querySelector('svg')!==null})()`)
  await check(`${host}: file input hidden`, `getComputedStyle(document.querySelector('${host} input[type=file]')).display==='none'`)
}
try {
  await mkdir(output, { recursive: true })
  await writeFile(join(temporary, 'chooser.png'), Buffer.from(png, 'base64'))
  vite = await createServer({ configFile: false, root, cacheDir: join(temporary, 'vite-cache'), plugins: [react(), tailwindcss(), {
    name: 'isolated-qa-service', configureServer(server) { server.middlewares.use(service.middleware) },
  }], logLevel: 'error', server: { host: '127.0.0.1', port: 0, open: false } })
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}/`
  chrome = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' })
  let debugPort, chromeError
  chrome.on('error', error => { chromeError = error })
  for (let i = 0; i < 150; i++) {
    if (chromeError) throw chromeError
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break } catch {}
    if (chrome.exitCode !== null) throw Error(`Owned Chrome exited: ${chrome.exitCode}`)
    await delay(100)
  }
  assert.ok(debugPort)
  const target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(r=>r.json())).find(item=>item.type==='page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    if (message.method === 'Page.fileChooserOpened') chooser = message.params
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params
      const allowed = new URL(request.url).origin === new URL(base).origin
      if (!allowed) blockedRequests.push(request.url)
      void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }).catch(error=>{if(!stopping)errors.push(error.message)})
    }
    if (message.id) { const callback = pending.get(message.id); if (!callback) return; pending.delete(message.id); clearTimeout(callback.timeout); message.error ? callback.reject(message.error) : callback.resolve(message.result) }
  }
  await send('Page.enable'); await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await send('Page.setInterceptFileChooserDialog', { enabled: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 960, deviceScaleFactor: 1, mobile: false })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `localStorage.setItem('astaria-sqlite-migration-v1','complete')` })
  await send('Page.navigate', { url: base })
  await wait(`!!window.__ASTARIA_P0__ && !!document.querySelector('.home-launch') && !document.querySelector('.first-run')`)
  await click('.home-launch'); await wait(`${settled} && !document.querySelector('#home-xixi').inert`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-button')?.disabled===false`)
  await check('local service loaded before interaction checks', `!document.querySelector('#home-xixi .home-form-error')`)
  await composer('#home-xixi')
  await check('empty home composer has no attachment strip', `!document.querySelector('#home-xixi .xixi-attachment-preview')`)
  await shot('home-dark-clear')
  await click('#home-xixi .xixi-attachment-button')
  for (let i = 0; !chooser && i < 50; i++) await delay(100)
  assert.ok(chooser, 'plus opens the native file chooser')
  await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [join(temporary, 'chooser.png')] })
  await wait(selected('#home-xixi', 'chooser.png')); checks.push('plus opens chooser and attaches its selected image')
  await click('#home-xixi .xixi-attachment-remove')
  await check('remove clears attachment and empty strip', `!document.querySelector('#home-xixi .xixi-attachment-preview')`)
  assert.equal(await drop(image('拖图.png'), 'dragenter'), true)
  await check('file drag has a non-interactive drop hint', `getComputedStyle(document.querySelector('.xixi-image-drop')).pointerEvents==='none'`)
  await drop(image('拖图.png'), 'dragenter'); await drop(image('拖图.png'), 'dragleave')
  await check('nested dragleave with null relatedTarget retains hint', `!!document.querySelector('.xixi-image-drop')`)
  assert.equal(await drop(image('拖图.png')), true); await wait(selected('#home-xixi', '拖图.png'))
  await check('drop clears drag hint', `!document.querySelector('.xixi-image-drop')`)
  await click('#home-xixi .home-capture')
  await wait(`document.querySelector('#home-xixi .xixi-message-attachments img') && !document.querySelector('#home-xixi .home-capture').textContent.includes('正在')`)
  assert.ok(calls.at(-1).messages.some(m=>m.role==='user'&&Array.isArray(m.content)&&m.content.some(part=>part.type==='image_url')))
  checks.push('image-only message reaches scripted vision provider and persists in conversation')
  await drop(image('旧图.png')); await wait(selected('#home-xixi', '旧图.png'))
  await drop(`[new File(['text'],'note.txt',{type:'text/plain'})]`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('仅支持')`)
  await check('invalid replacement cannot silently reuse old image', `!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await draft('#home-compose', '纯文字测试'); await click('#home-xixi .home-capture')
  await wait(`!document.querySelector('#home-xixi .home-capture').textContent.includes('正在') && document.querySelector('#home-compose').value===''`)
  assert.equal(typeof calls.at(-1).messages.filter(m=>m.role==='user').at(-1).content, 'string'); checks.push('text after failed replacement sends no previous image')
  await drop(`[new File([new Uint8Array(2*1024*1024+1)],'large.png',{type:'image/png'})]`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('2 MB')`)
  await drop(`[...${image('one.png')},...${image('two.png')}]`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('一张')`)
  checks.push('unsupported, oversized and multiple files use shared validation')
  await check('text dragging is left to the editor', `(()=>{const d=new DataTransfer();d.setData('text/plain','文字');const e=new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:d});document.querySelector('#home-compose').dispatchEvent(e);return !e.defaultPrevented})()`)
  // Controlled FileReader completion catches actual React state races.
  await evaluate(`window.NativeFileReader=FileReader;window.patchReaders=[];window.FileReader=class{readAsDataURL(file){this.file=file;patchReaders.push(this)}}`)
  await draft('#home-compose', '读取中不得发送')
  const beforeRead = calls.length
  await drop(image('slow-old.png')); await drop(image('fast-new.png'))
  await evaluate(`document.querySelector('#home-xixi form').requestSubmit()`)
  await delay(150); assert.equal(calls.length, beforeRead); checks.push('Enter/form submission is blocked while image is reading')
  await evaluate(`patchReaders[1].result='data:image/png;base64,${png}';patchReaders[1].onload()`)
  await wait(selected('#home-xixi', 'fast-new.png'))
  await evaluate(`patchReaders[0].result='data:image/png;base64,${png}';patchReaders[0].onload()`)
  await check('old read completion cannot replace latest selection', selected('#home-xixi', 'fast-new.png'))
  await drop(image('bad-read.png')); await evaluate(`patchReaders.at(-1).onerror()`)
  await wait(`document.querySelector('#home-xixi .xixi-attachment-error')?.textContent.includes('读取失败')`)
  await check('failed read clears previous selection', `!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await evaluate(`window.FileReader=window.NativeFileReader`); await draft('#home-compose', '')
  // The 60 FPS budget survives the expanded-chat -> workbench transition.
  await observe(); await nav('工作台'); await wait(settled); await finishObservation('home chat to workbench', 60)
  await check('settled workbench returns to 30 FPS', `window.__ASTARIA_P0__.getSnapshot().targetFps===30`)
  await click(`.wb-task[data-task-id='${task.id}']`)
  await wait(`!!document.querySelector('.wb-xixi textarea') && !document.querySelector('.wb-scroll').inert`)
  await composer('.wb-xixi'); await shot('focus-dark-clear')
  await drop(image('专注.png')); await wait(selected('.wb-xixi', '专注.png'))
  await check('focus drop stays in current task chat', `document.querySelector('.home-workspace').dataset.page==='workbench'&&!document.querySelector('#home-xixi .xixi-attachment-chip')`)
  await click('.wb-xixi .xixi-attachment-button')
  await send('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [join(temporary, 'chooser.png')] })
  await wait(selected('.wb-xixi', 'chooser.png')); checks.push('focus plus uses its own native chooser')
  await click('.wb-xixi .xixi-send')
  await wait(`document.querySelector('.wb-xixi .xixi-message-attachments img') && !document.querySelector('.wb-xixi .xixi-send').textContent.includes('正在')`)
  assert.equal(db.listMessages(db.getActiveConversation().id).filter(m=>m.role==='user').at(-1).taskId, task.id); checks.push('focus image keeps real task context when sent')
  // Busy operation must neither replace the attachment nor navigate away.
  holdNext = true
  await draft('#wb-xixi-input', '等待回复'); await click('.wb-xixi .xixi-send')
  await wait(`document.querySelector('.wb-xixi .xixi-send').disabled`)
  assert.equal(await drop(image('busy.png')), true)
  await check('busy focus rejects drop without navigating or attaching', `document.querySelector('.home-workspace').dataset.page==='workbench'&&!document.querySelector('.wb-xixi .xixi-attachment-chip')`)
  for(let i=0;!releaseReply&&i<50;i++)await delay(50)
  assert.ok(releaseReply); releaseReply(); releaseReply = undefined
  await wait(`!document.querySelector('.wb-xixi .xixi-send').textContent.includes('正在')`)
  // Theme/material and narrow-width checks visit the same real focus and home composers.
  for (const [theme, glass, width, height] of [['light','clear',1400,960], ['light','soft',1400,960], ['dark','soft',1400,960], ['dark','clear',390,844]]) {
    const next = { ...preferences, theme, glass }
    db.setPreference('app', next)
    await evaluate(`window.dispatchEvent(new CustomEvent('astaria-preferences-change',{detail:${JSON.stringify(next)}}))`)
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width<600 }); await delay(500)
    await composer('.wb-xixi'); await shot(`focus-${theme}-${glass}-${width}`)
    await check(`focus ${theme}/${glass}/${width}: no horizontal overflow`, `document.querySelector('.wb-xixi').scrollWidth<=document.querySelector('.wb-xixi').clientWidth+1`)
    await nav('首页'); await click('.home-launch'); await wait(`${settled} && !document.querySelector('#home-xixi').inert`)
    await composer('#home-xixi'); await shot(`home-${theme}-${glass}-${width}`)
    await check(`home ${theme}/${glass}/${width}: no horizontal overflow`, `document.querySelector('#home-xixi').scrollWidth<=document.querySelector('#home-xixi').clientWidth+1`)
    await nav('工作台'); await wait(`!!document.querySelector('.wb-xixi textarea')`)
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 960, deviceScaleFactor: 1, mobile: false })
  db.setPreference('app', { ...preferences, render: { ...preferences.render, profile: 'smooth120' } })
  await send('Page.reload').catch(error => {
    if (error.message !== 'Inspected target navigated or closed') throw error
  })
  await wait(`!!window.__ASTARIA_P0__ && window.__ASTARIA_P0__.getSnapshot().targetFps===120`)
  await click('.home-launch'); await wait(settled)
  await observe(); await nav('工作台'); await wait(settled); await finishObservation('120 FPS chat to workspace', 120)
  await check('120 FPS selection settles to workspace 30', `window.__ASTARIA_P0__.getSnapshot().targetFps===30`)
  await nav('首页'); await click('.home-launch'); await wait(settled)
  await observe(); await nav('工作台'); await delay(200); await nav('首页'); await click('.home-launch'); await wait(settled)
  await finishObservation('120 FPS mid-flight reversal', 120)
  await check('reversal restores saved home frame rate', `window.__ASTARIA_P0__.getSnapshot().targetFps===120`)
  await nav('日程'); await wait(settled)
  await drop(image('从日程拖入.png'))
  await wait(`${selected('#home-xixi', '从日程拖入.png')} && ${settled} && !document.querySelector('#home-xixi').inert`)
  checks.push('dropping outside focus opens home chat with the selected image')
  assert.equal(errors.length, 0, JSON.stringify(errors)); assert.equal(blockedRequests.length, 0, JSON.stringify(blockedRequests))
  await writeFile(join(output,'results.json'), JSON.stringify({checks,budgets,errors,blockedRequests,providerCalls:calls.length,storage:':memory:',model:'scripted',scope:'Chrome UI and target frame budgets; not native OS performance'},null,2))
  console.log(`PASS Beta12.1 UI: ${checks.length} checks (${output})`)
} catch (error) {
  await shot('failure').catch(()=>{})
  await writeFile(join(output,'failure.json'),JSON.stringify({message:error.message,checks,budgets,errors,blockedRequests},null,2))
  throw error
} finally {
  stopping=true; releaseReply?.()
  if(ws?.readyState===WebSocket.OPEN)ws.close()
  if(chrome&&chrome.exitCode===null){chrome.kill('SIGTERM');await Promise.race([new Promise(resolve=>chrome.once('exit',resolve)),delay(3000)]);if(chrome.exitCode===null)chrome.kill('SIGKILL')}
  await vite?.close(); service.close(); await rm(temporary,{recursive:true,force:true})
}
