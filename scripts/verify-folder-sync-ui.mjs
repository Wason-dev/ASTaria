/** Isolated settings UI with real folder sync, temporary data and an in-memory credential provider. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'
import { createFolderSync } from '../desktop/folderSync.mjs'
import { getPreferences } from '../server/preferences.mjs'
const directory = await mkdtemp(join(tmpdir(), 'astaria-sync-ui-'))
const artifacts = resolve('artifacts/verification/betax-sync-ui')
const local = join(directory, 'local'), shared = join(directory, 'shared')
for (const path of [artifacts, local, shared]) await mkdir(path, { recursive: true })
const db = createDatabase(join(local, 'test.sqlite'))
db.setPreference('onboarding-completed', true)
const values = new Map()
const secrets = { available: () => true, read: key => values.get(key), write: (key, value) => values.set(key, value), remove: key => values.delete(key) }
const sync = createFolderSync({ store: db.sync, secrets, dataDirectory: local, selectDirectory: async () => shared, saveKey: async () => {} })
const service = createLocalService({ db, vault: { status: async () => false }, complete: async () => { throw Error('No model calls allowed') }, dataDirectory: local })
const token = 'isolated-sync-ui-capability-00000000'
const handler = createDesktopHandler({ root: resolve('dist'), service, token, sync })
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
  const origin = `http://127.0.0.1:${server.address().port}`
  const openSettings = async () => {
    await send('Page.navigate', { url: origin })
    await wait('!!document.querySelector(".home-brand")')
    await click('.home-brand')
    await evaluate(`[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()==='设置').dataset.qaSettings='1';true`)
    await click('[data-qa-settings]')
    await wait('!!document.querySelector(".xixi-settings-tabs")')
    await tab('数据')
    await wait('!!document.querySelector(".xixi-folder-sync")')
  }
  const button = async text => {
    await evaluate(`[...document.querySelectorAll('.xixi-folder-sync button')].forEach(e=>e.removeAttribute('data-qa-sync'));[...document.querySelectorAll('.xixi-folder-sync button')].find(e=>e.textContent.trim()===${JSON.stringify(text)}).dataset.qaSync='1';true`)
    await click('[data-qa-sync]')
  }
  const matrix = []
  for (const theme of ['dark', 'light']) for (const glass of ['clear', 'soft']) {
    db.setPreference('app', { ...getPreferences(db), theme, glass })
    for (const width of [1440, 390]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false })
      await openSettings()
      await delay(300)
      const overflow = await evaluate(`['html','.xixi-settings-scroll','.xixi-folder-sync'].map(s=>{const e=document.querySelector(s);return {selector:s,client:e.clientWidth,scroll:e.scrollWidth}})`)
      for (const size of overflow) assert.ok(size.scroll <= size.client + 1, JSON.stringify({ theme, glass, width, size }))
      const blur = await evaluate(`document.querySelector('.xixi-settings-panel .home-glass-definitions feGaussianBlur')?.getAttribute('stdDeviation')`)
      assert.equal(blur, glass === 'soft' ? '6' : '0')
      await screenshot(`${theme}-${glass}-${width}.png`)
      matrix.push({ theme, glass, width, blur })
    }
  }
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await button('选择目录并建立')
  await wait(`document.querySelector('.xixi-folder-sync').textContent.includes('待导出 0 条')`)
  assert.ok(db.sync.config())
  assert.equal(db.sync.outbox().length, 0)
  await button('暂停同步')
  await wait(`document.querySelector('.xixi-folder-sync').textContent.includes('同步已暂停')`)
  assert.equal(db.sync.config().paused, true)
  db.createTask({ title: 'UI sync fixture' })
  await button('继续同步')
  await wait(`document.querySelector('.xixi-folder-sync [role=status]')?.textContent.includes('本机目录已检查') && !document.querySelector('.xixi-folder-sync button')?.disabled && document.querySelector('.xixi-folder-sync').textContent.includes('待导出 0 条')`)
  assert.equal(db.sync.outbox().length, 0)
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await evaluate(`document.querySelector('.xixi-folder-sync button').focus();true`)
  assert.ok(await evaluate(`document.activeElement.matches('.xixi-folder-sync button')`))
  await screenshot('configured-light-soft-keyboard-reduced.png')
  await button('断开此设备')
  await wait(`document.querySelector('.xixi-folder-sync').textContent.includes('确认断开')`)
  await button('取消')
  assert.ok(db.sync.config())
  assert.deepEqual(errors, [])
  assert.deepEqual(network.filter(url => !url.startsWith(origin) && !url.startsWith('data:') && !url.startsWith('blob:')), [])
  const result = { passed: true, matrix, configured: true, pauseResume: true, outboxExport: true, keyboard: true, reducedMotion: true, errors, modelCalls: 0 }
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
} finally {
  ws?.close()
  const stopped = new Promise(yes => browser.once('exit', yes))
  browser.kill('SIGTERM'); await Promise.race([stopped, delay(5000)])
  if (browser.exitCode === null) browser.kill('SIGKILL')
  server.closeAllConnections(); await new Promise(yes => server.close(yes))
  await sync.close(); service.close()
  await rm(directory, { recursive: true, force: true })
}
