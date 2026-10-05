/** Desktop settings UI QA against a temporary SQLite profile and a mock updater.
 * Run after npm run build:desktop. Never fetches a release or downloads an App. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'
import { getPreferences } from '../server/preferences.mjs'

const directory = await mkdtemp(join(tmpdir(), 'astaria-updates-ui-'))
const artifacts = resolve('artifacts/verification/app-updates-ui')
await mkdir(artifacts, { recursive: true })
const db = createDatabase(join(directory, 'test.sqlite'))
db.setPreference('onboarding-completed', true)
const calls = []
let updateState = {
  supported: true,
  current: { version: '0.1.0-beta.2', builtAt: '2026-09-28T02:09:30.985Z', commit: 'installed' },
  automatic: true, status: 'available', error: null,
  lastCheckedAt: '2026-09-28T06:00:00.000Z', nextCheckAt: null,
  latest: {
    version: '0.1.0-beta.3', tag: 'v0.1.0-beta.3', notes: '改进工作台与更新检查。\n<script>alert("plain text only")</script>',
    publishedAt: '2026-09-28T05:00:00.000Z', releaseUrl: 'https://github.com/Wason-dev/ASTaria/releases/tag/v0.1.0-beta.3',
    downloadUrl: 'https://github.com/Wason-dev/ASTaria/releases/download/v0.1.0-beta.3/ASTaria-0.1.0-beta.3-mac-arm64-adhoc.dmg',
    assetName: 'ASTaria-0.1.0-beta.3-mac-arm64-adhoc.dmg', size: 200 * 1024 * 1024,
  },
  releasesUrl: 'https://github.com/Wason-dev/ASTaria/releases',
}
let nextManualResult
const timers = new Set()
const snapshot = () => structuredClone(updateState)
const updates = {
  getStatus: async () => { calls.push('get'); return snapshot() },
  check: async ({ force }) => {
    calls.push(force ? 'manual' : 'automatic')
    if (force && nextManualResult) {
      const result = nextManualResult
      nextManualResult = null
      updateState = { ...updateState, status: 'checking', error: null }
      const timer = setTimeout(() => { timers.delete(timer); updateState = { ...updateState, ...result } }, 250)
      timers.add(timer)
    }
    return snapshot()
  },
  download: async () => { calls.push('download'); updateState = { ...updateState, status: 'downloading', download: { version: updateState.latest.version, sizeBytes: 200 * 1024 * 1024, downloadedBytes: 20 * 1024 * 1024 }, canInstall: false }; return snapshot() },
  cancelDownload: async () => { calls.push('cancel'); updateState = { ...updateState, status: 'available', download: null }; return snapshot() },
  install: async () => { calls.push('install'); updateState = { ...updateState, status: 'ready', error: '测试安装失败，原应用已保留' }; return snapshot() },
  setAutomatic: async enabled => { calls.push(`enabled:${enabled}`); updateState.automatic = enabled; return snapshot() },
}
const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw Error('UI QA must not call a model') }, dataDirectory: directory })
const token = 'isolated-updates-ui-capability-00000000'
const handler = createDesktopHandler({ root: resolve('dist'), service, token, updates })
const server = createServer((req, res) => { req.headers['x-astaria-desktop'] = token; void handler(req, res) })
await new Promise(yes => server.listen(0, '127.0.0.1', yes))
const browser = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
], { stdio: 'ignore' })
const delay = ms => new Promise(yes => setTimeout(yes, ms))
let ws
try {
  let devtools
  for (let i = 0; i < 100; i++) {
    try { devtools = (await readFile(join(directory, 'chrome', 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break } catch { await delay(100) }
  }
  assert.ok(devtools, 'isolated Chrome starts')
  ws = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
  await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
  let serial = 0, session
  const pending = new Map(), errors = [], network = []
  const send = (method, params = {}) => new Promise((yes, no) => {
    const id = ++serial
    pending.set(id, { yes, no })
    ws.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }))
  })
  ws.onmessage = event => {
    const value = JSON.parse(event.data)
    if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
    if (value.method === 'Network.requestWillBeSent') network.push(value.params.request.url)
    const callback = pending.get(value.id)
    if (callback) { pending.delete(value.id); value.error ? callback.no(value.error) : callback.yes(value.result) }
  }
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async expression => {
    for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await delay(100) }
    throw Error(`Timeout: ${expression}`)
  }
  const click = async selector => {
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`)
    await delay(250)
    const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Control is occluded: '+${JSON.stringify(selector)});return {x,y}})()`)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
  }
  const tab = async label => {
    await evaluate(`[...document.querySelectorAll('.xixi-settings-tabs button')].forEach(e=>e.removeAttribute('data-qa-tab'));[...document.querySelectorAll('.xixi-settings-tabs button')].find(e=>e.textContent.trim()===${JSON.stringify(label)}).dataset.qaTab='1';true`)
    await click('[data-qa-tab]')
  }
  const screenshot = async name => {
    await writeFile(join(artifacts, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  }
  const checkOverflow = async width => {
    await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
    await delay(300)
    const sizes = await evaluate(`['html','.xixi-settings-scroll','.xixi-settings-panel','.xixi-app-updates'].map(selector=>{const e=document.querySelector(selector);return {selector,client:e.clientWidth,scroll:e.scrollWidth}})`)
    for (const size of sizes) assert.ok(size.scroll <= size.client + 1, `${width}px: ${size.selector} has no horizontal overflow (${size.scroll}/${size.client})`)
    return sizes
  }
  const target = await send('Target.createTarget', { url: 'about:blank' })
  session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
  await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const origin = `http://127.0.0.1:${server.address().port}`
  await send('Page.navigate', { url: origin })
  await wait('!!document.querySelector(".home-brand")')
  await click('.home-brand')
  await wait('!!document.querySelector("#home-menu")')
  await evaluate(`[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()==='设置').dataset.qaSettings='1';true`)
  await click('[data-qa-settings]')
  await wait('!!document.querySelector(".xixi-settings-tabs")')
  await tab('通用')
  await wait(`document.querySelector('.xixi-app-update-feedback')?.textContent.includes('发现新版本 0.1.0-beta.3')`)
  assert.ok(calls.includes('automatic'), 'opening settings requests a cached automatic check')
  assert.equal(await evaluate(`document.querySelector('.xixi-app-update-actions a').href`), updateState.latest.downloadUrl)
  await click('.xixi-app-update-notes summary')
  assert.equal(await evaluate(`document.querySelector('.xixi-app-update-notes p').textContent`), updateState.latest.notes)
  assert.equal(await evaluate(`document.querySelectorAll('.xixi-app-update-notes script').length`), 0, 'release notes are inert text')
  const overflow1440 = await checkOverflow(1440)
  await screenshot('available-dark-clear-1440.png')
  const overflow1024 = await checkOverflow(1024)
  await screenshot('available-dark-clear-1024.png')

  await click('.xixi-app-update-download')
  await wait('!!document.querySelector("progress[aria-label=更新下载进度]")')
  assert.equal(await evaluate('document.querySelector("progress").value'), 20 * 1024 * 1024)
  await click('.xixi-app-update-download')
  await wait(`document.querySelector('.xixi-app-update-download')?.textContent.includes('下载并校验')`)
  assert.ok(calls.includes('cancel'))
  await click('.xixi-app-update-download')
  updateState = { ...updateState, status: 'ready', canInstall: true }
  await wait(`document.querySelector('.xixi-app-update-download')?.textContent==='安装并重启'`)
  await click('.xixi-app-update-download')
  await wait(`document.querySelector('.xixi-app-update-feedback')?.textContent.includes('测试安装失败')`)
  assert.ok(calls.includes('install'))
  assert.equal(await evaluate(`document.querySelector('.xixi-app-update-download').disabled`), false)
  await screenshot('verified-install-retry.png')
  updateState = { ...updateState, status: 'available', canInstall: false, error: null, download: null }
  await tab('析熙'); await tab('通用')
  await wait(`document.querySelector('.xixi-app-update-download')?.textContent.includes('下载并校验')`)

  await click('[role=switch][aria-label="自动检查更新"]')
  await wait(`document.querySelector('[role=switch][aria-label="自动检查更新"]').getAttribute('aria-checked')==='false'`)
  assert.equal(updateState.automatic, false)
  const automaticBefore = calls.filter(value => value === 'automatic').length
  await click('[role=switch][aria-label="自动检查更新"]')
  await wait(`document.querySelector('[role=switch][aria-label="自动检查更新"]').getAttribute('aria-checked')==='true'`)
  assert.equal(updateState.automatic, true)
  assert.equal(calls.filter(value => value === 'automatic').length, automaticBefore + 1, 'enabling checks requests cached automatic check')

  nextManualResult = { status: 'error', error: 'GitHub 暂时无法连接，请稍后重试。', latest: null }
  await click('.xixi-app-update-actions button')
  await wait(`document.querySelector('.xixi-app-update-feedback')?.textContent.includes('GitHub 暂时无法连接')`)
  await screenshot('error-retry-1024.png')
  assert.equal(await evaluate(`document.querySelector('.xixi-app-update-actions button').disabled`), false, 'failure allows retry')
  nextManualResult = { status: 'up-to-date', error: null, latest: null }
  await click('.xixi-app-update-actions button')
  await wait(`document.querySelector('.xixi-app-update-feedback')?.textContent.includes('当前已是最新可用版本')`)
  assert.equal(await evaluate(`!!document.querySelector('.xixi-app-update-download')`), false, 'current build offers no update download')

  // Seed appearance only in this disposable profile, then inspect a real reload.
  db.setPreference('app', { ...getPreferences(db), theme: 'light', glass: 'soft' })
  await send('Page.reload')
  await wait('!!document.querySelector(".home-brand")')
  await click('.home-brand')
  await evaluate(`[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()==='设置').dataset.qaSettings='1';true`)
  await click('[data-qa-settings]')
  await wait(`document.querySelector('.xixi-settings')?.dataset.theme==='light'`)
  await tab('通用')
  await wait(`document.querySelector('.xixi-app-update-feedback')?.textContent.includes('当前已是最新可用版本')`)
  await checkOverflow(1024)
  await screenshot('current-light-soft-1024.png')
  const glass = await evaluate(`(()=>{const e=document.querySelector('.xixi-settings-panel .home-glass-surface'),f=document.querySelector('.xixi-settings-panel .home-glass-definitions feGaussianBlur');return {backdropFilter:getComputedStyle(e).backdropFilter,blurDeviation:f?.getAttribute('stdDeviation'),theme:document.querySelector('.xixi-settings').dataset.theme}})()`)
  assert.equal(glass.blurDeviation, '6', 'soft glass uses existing six-pixel SVG blur')

  updateState = { ...updateState, status: 'checking' }
  await click('.xixi-app-update-actions button')
  await wait(`document.querySelector('.xixi-app-update-feedback')?.textContent.includes('正在检查 GitHub 更新')`)
  await tab('析熙')
  const readsBefore = calls.filter(value => value === 'get').length
  await delay(1300)
  assert.equal(calls.filter(value => value === 'get').length, readsBefore, 'leaving the update panel stops status polling')
  assert.deepEqual(errors, [], 'no uncaught page exceptions')
  assert.deepEqual(network.filter(url => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')), [], 'no external requests or downloads')
  const result = { passed: true, artifacts, manualChecks: calls.filter(value => value === 'manual').length, overflow1440, overflow1024, glass, states: ['downloading', 'cancelled', 'ready', 'install-failed-retry', 'available', 'error/retry', 'up-to-date', 'checking'], modelCalls: 0, externalRequests: 0 }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  for (const timer of timers) clearTimeout(timer)
  ws?.close()
  const stopped = new Promise(yes => browser.once('exit', yes))
  browser.kill('SIGTERM')
  await Promise.race([stopped, delay(5000)])
  if (browser.exitCode === null) browser.kill('SIGKILL')
  server.closeAllConnections()
  await new Promise(yes => server.close(yes))
  await service.close()
  await rm(directory, { recursive: true, force: true })
}
