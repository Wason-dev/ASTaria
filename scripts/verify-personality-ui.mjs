/** Focused settings QA: owned Chrome, intercepted in-memory API and zero model calls. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { getPreferences } from '../server/preferences.mjs'

const base = process.env.PERSONALITY_QA_URL ?? 'http://127.0.0.1:5188/'
const output = process.env.PERSONALITY_QA_OUTPUT ?? '/tmp/astaria-personality-ui'
const temporary = await mkdtemp(join(tmpdir(), 'astaria-personality-ui-'))
const profile = join(temporary, 'chrome-profile')
const db = createDatabase(':memory:')
const fixture = getPreferences(db)
fixture.assistant.autonomy = 'propose'
fixture.assistant.useMemory = false
fixture.assistant.useHistory = false
fixture.notifications = { enabled: false, quietStart: '22:15', quietEnd: '07:45', opportunities: false }
db.setPreference('app', fixture)
db.createTask({ title: '个性设置验收事项', estimateMin: 30, inbox: false })
let providerCalls = 0, chrome, ws, failure, stopping = false, serial = 0
const checks = [], errors = [], requests = [], blockedRequests = [], layouts = [], pending = new Map()
const service = createLocalService({ db, dataDirectory: ':memory:', vault: {
  status: async () => true, read: async () => { throw Error('QA must never read credentials') },
}, complete: async () => { providerCalls++; throw Error('Personality settings must not call the provider') } })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial, timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 15000)
  pending.set(id, { resolve, reject, timeout }); ws.send(JSON.stringify({ id, method, params }))
})
const api = request => new Promise(resolve => {
  const url = new URL(request.url), req = Readable.from(request.postData ? [Buffer.from(request.postData)] : [])
  requests.push({ method: request.method, path: url.pathname })
  req.url = url.pathname + url.search; req.method = request.method
  req.socket = { remoteAddress: '127.0.0.1', localPort: Number(url.port) }
  req.headers = { host: url.host, origin: url.origin, 'x-astaria-local': '1', 'content-type': 'application/json' }
  const res = { statusCode: 200, setHeader() {}, end(body) { resolve({ status: this.statusCode, body }) } }
  service.middleware(req, res, () => resolve({ status: 404, body: '{}' }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}
const wait = async expression => { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(75) } throw Error(`Timeout: ${expression}`) }
const check = async (name, value) => { const pass = typeof value === 'string' ? await evaluate(value) : value; checks.push({ name, pass }); assert.equal(pass, true, name); console.log('PASS', name) }
const click = async selector => {
  await wait(`!!document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled`)
  const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect();if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Occluded '+${JSON.stringify(selector)});return{x:r.x+r.width/2,y:r.y+r.height/2}})()`)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await delay(100)
}
const textClick = async (selector, text) => {
  await evaluate(`(()=>{document.querySelectorAll('[data-personality-qa]').forEach(e=>e.removeAttribute('data-personality-qa'));const e=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e)throw Error('Missing '+${JSON.stringify(text)});e.dataset.personalityQa='yes';return true})()`)
  await click('[data-personality-qa=yes]')
}
const shot = async name => writeFile(join(output, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
const openSettings = async () => {
  await click('.home-brand'); await wait('document.querySelector("#home-menu").dataset.open==="true"')
  await textClick('#home-menu button', '设置')
  await wait('!!document.querySelector(".xixi-personality-options button:not(:disabled)")'); await delay(350)
}
const closeSettings = async () => { await click('.xixi-settings-close'); await wait('!document.querySelector(".xixi-settings")'); await delay(250) }
const tab = async label => { await textClick('.xixi-settings-tabs button', label); await delay(300) }
const selected = (label, description) => `document.querySelectorAll('.xixi-personality-options button[aria-pressed=true]').length===1&&document.querySelector('.xixi-personality-options button[aria-pressed=true]').textContent===${JSON.stringify(label)}&&document.querySelector('.xixi-personality-options').closest('.xixi-setting-row').querySelector('small').textContent===${JSON.stringify(description)}`
const unrelated = preferences => { const copy = structuredClone(preferences); delete copy.assistant.personality; return copy }
const baseline = unrelated(fixture)
const baselineTasks = db.listTasks()
const baselinePlanner = db.getPlanner()

try {
  await mkdir(output, { recursive: true })
  chrome = spawn(process.env.PERSONALITY_QA_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--disable-component-update', '--disable-sync', '--disable-default-apps',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank',
  ], { stdio: 'ignore' })
  let chromeError, debugPort
  chrome.on('error', error => { chromeError = error })
  for (let i = 0; i < 100; i++) {
    if (chromeError) throw chromeError
    try { debugPort = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); if (debugPort) break } catch {}
    if (chrome.exitCode !== null) throw Error(`Owned Chrome exited: ${chrome.exitCode}`)
    await delay(100)
  }
  assert.ok(debugPort, 'owned browser debugging port is available')
  const target = (await fetch(`http://127.0.0.1:${debugPort}/json`).then(response => response.json())).find(item => item.type === 'page')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = event => {
    const message = JSON.parse(event.data)
    if (message.id) { const callback = pending.get(message.id); if (!callback) return; pending.delete(message.id); clearTimeout(callback.timeout); message.error ? callback.reject(message.error) : callback.resolve(message.result) }
    else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
    else if (message.method === 'Fetch.requestPaused') {
      const { requestId, request } = message.params, url = new URL(request.url)
      const handle = async () => {
        if (url.origin !== new URL(base).origin) { blockedRequests.push(request.url); await send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }) }
        else if (url.pathname.startsWith('/api/')) {
          const result = await api(request)
          await send('Fetch.fulfillRequest', { requestId, responseCode: result.status, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }], body: Buffer.from(result.body).toString('base64') })
        } else await send('Fetch.continueRequest', { requestId })
      }
      void handle().catch(error => { if (!stopping) errors.push(error.message) })
    }
  }
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Network.setBypassServiceWorker', { bypass: true }); await send('Network.setCacheDisabled', { cacheDisabled: true })
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
  await send('Page.addScriptToEvaluateOnNewDocument', { source: "localStorage.setItem('astaria-sqlite-migration-v1','complete')" })
  await send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: base }); await wait('!!window.__ASTARIA_P0__&&!!document.querySelector(".home-current-title:not(:disabled)")')
  await openSettings()
  await check('fresh settings default to high personality with the matching description', selected('高', '有主见，嘴硬一点，做事认真'))
  for (const [index, value, label, description] of [[1, 'low', '低', '简洁温和'], [2, 'medium', '中', '自然俏皮'], [3, 'high', '高', '有主见，嘴硬一点，做事认真']]) {
    await click(`.xixi-personality-options button:nth-child(${index})`)
    await wait(`${selected(label, description)}&&!document.querySelector('.xixi-personality-options button').disabled`)
    await check(`${value}: UI selection persists to isolated SQLite`, getPreferences(db).assistant.personality === value)
    await check(`${value}: autonomy, memory, history, notifications and all other preferences remain unchanged`, JSON.stringify(unrelated(getPreferences(db))) === JSON.stringify(baseline))
    await shot(`personality-${value}`)
    await closeSettings(); await openSettings()
    await check(`${value}: closing and reopening retains the selection and description`, selected(label, description))
    await closeSettings(); await send('Page.reload', { ignoreCache: true })
    await wait('!!window.__ASTARIA_P0__&&!!document.querySelector(".home-current-title:not(:disabled)")'); await openSettings()
    await check(`${value}: full browser reload retains the selection`, selected(label, description))
  }
  for (const [width, height] of [[1366, 768], [1024, 768]]) {
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await delay(400)
    const layout = await evaluate(`(()=>{const s=document.querySelector('.xixi-settings-scroll'),f=document.querySelector('.xixi-settings-feedback').getBoundingClientRect(),p=document.querySelector('.xixi-personality-options').getBoundingClientRect();return{width:innerWidth,height:innerHeight,scrollTop:s.scrollTop,scrollHeight:s.scrollHeight,clientHeight:s.clientHeight,scrollWidth:s.scrollWidth,clientWidth:s.clientWidth,footerBottom:f.bottom,personality:{left:p.left,right:p.right,top:p.top,bottom:p.bottom}}})()`)
    layouts.push(layout)
    await check(`${width}×${height}: the entire Xixi tab fits without vertical or horizontal scrolling`, layout.scrollTop === 0 && layout.scrollHeight <= layout.clientHeight + 1 && layout.scrollWidth <= layout.clientWidth + 1 && layout.footerBottom <= height && layout.personality.bottom <= height)
    await shot(`dark-${width}x${height}`)
  }
  await tab('外观与动画')
  await evaluate(`(()=>{const e=document.querySelector('select[aria-label="界面外观"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'light');e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`)
  await wait('document.querySelector(".xixi-settings").dataset.theme==="light"&&!document.querySelector("select[aria-label=界面外观]").disabled')
  await check('light theme persists through the same settings endpoint', getPreferences(db).theme === 'light')
  await tab('析熙')
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false }); await delay(400)
  await check('390px light layout has no horizontal overflow', `(()=>{const s=document.querySelector('.xixi-settings-scroll'),p=document.querySelector('.xixi-settings-panel').getBoundingClientRect();return s.scrollWidth<=s.clientWidth+1&&p.left>=0&&p.right<=innerWidth&&document.documentElement.scrollWidth<=innerWidth})()`)
  await evaluate("document.querySelector('.xixi-personality-options').scrollIntoView({block:'center',inline:'nearest'});true"); await delay(200)
  await check('390px light personality control and all three buttons remain visible and inside the viewport', `(()=>{const buttons=[...document.querySelectorAll('.xixi-setting-row .xixi-personality-options button')];return buttons.length===3&&buttons.every(e=>{const r=e.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})})()`)
  await check('light narrow layout still shows the saved high personality', selected('高', '有主见，嘴硬一点，做事认真'))
  await check('scrolling settings cannot paint content across global navigation', `(()=>{const viewport=document.querySelector('.xixi-settings-scroll').getBoundingClientRect(),nav=document.querySelector('.home-brand').getBoundingClientRect();return viewport.top>=nav.bottom+6})()`)
  await shot('light-390x844')
  await evaluate("document.querySelector('.xixi-settings-scroll').scrollTop=0;true"); await delay(200)
  await check('light narrow settings header keeps one brand mark and starts below global navigation', `(()=>{const localBrand=document.querySelector('.xixi-settings-page-header>div>span'),title=document.querySelector('.xixi-settings-page-header h2'),global=document.querySelector('.home-brand').getBoundingClientRect(),heading=title.getBoundingClientRect();return !localBrand&&heading.top>=global.bottom+6})()`)
  await shot('light-390x844-header')
  await check('personality changes and layout checks make zero model calls', providerCalls === 0)
  await check('writes are limited to preference saves and the normal free-time ensure on page load', requests.filter(request => request.method !== 'GET').every(request => ['/api/preferences', '/api/companion/free-time/ensure'].includes(request.path)))
  assert.deepEqual(db.listTasks(), baselineTasks, 'settings checks must not change tasks')
  assert.deepEqual(db.getPlanner(), baselinePlanner, 'settings checks must not change the planner')
  await check('preference saves and empty free-time ensure leave tasks and planner unchanged', true)
  await check('browser raised no runtime exceptions', errors.length === 0)
  await writeFile(join(output, 'results.json'), JSON.stringify({ checks, layouts, requests, blockedRequests, errors, providerCalls }, null, 2))
  console.log(`PASS ${checks.length} isolated personality UI checks\nArtifacts: ${output}`)
} catch (reason) {
  failure = reason
  await shot('failure').catch(() => {})
  const page = await evaluate('({text:document.body.innerText,url:location.href})').catch(() => null)
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: reason.message, stack: reason.stack, checks, layouts, requests, blockedRequests, errors, providerCalls, page }, null, 2))
  console.error(`FAIL ${reason.message}\nArtifacts: ${output}`)
} finally {
  stopping = true
  if (ws?.readyState === WebSocket.OPEN) ws.close()
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM'); await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)])
    if (chrome.exitCode === null) { chrome.kill('SIGKILL'); await delay(150) }
  }
  for (const callback of pending.values()) clearTimeout(callback.timeout)
  service.close()
  await rm(temporary, { recursive: true, force: true })
}
if (failure) throw failure
