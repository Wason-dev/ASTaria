import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { access, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = fileURLToPath(new URL('../', import.meta.url))
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const delay = ms => new Promise(done => setTimeout(done, ms))

// Mount only the requested components. All local APIs, backup data and model
// status are synthetic; the official app entry, database and vault never run.
const fixture = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import { LocalSettings } from './src/xixi/LocalSettings.tsx'
import { SystemReminders } from './src/xixi/SystemReminders.tsx'
import { DEFAULT_PREFERENCES, publishPreferences } from './src/xixi/preferences.ts'
const f = window.fixture = { calls: [], hookCalls: [], nativeShareCalls: [], downloads: [], theme: 'dark', glass: 'clear', platform: 'android', provider: 'deepseek', scenario: 'reminders' }
const backup = { format: 'astaria-backup', version: 1, tables: { tasks: [], state: [] }, checksum: 'synthetic' }
const providerSettings = { provider: 'deepseek', cloudModel: 'deepseek-flash', reasoningEffort: 'low', streamResponses: true, contextBudget: { mode: 'auto', maxUnits: 48000 }, webSearch: { enabled: false, maxUses: 2 }, local: { engine: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '' } }
f.reminders = { supported: true, platform: 'android', enabled: false, authorization: 2, count: 0, through: null, omitted: 0, error: null }
f.api = async (path, body) => {
  f.calls.push({ path, body })
  if (path === '/desktop/reminders') { if (f.initialGate) return f.initialGate; if (f.readFailure) throw Error('虚构的读取失败'); return structuredClone(f.reminders) }
  if (path === '/desktop/reminders/enabled') { if (f.enableGate) await f.enableGate; f.reminders = { ...f.reminders, enabled: body.enabled, count: body.enabled ? 1 : 0 }; return structuredClone(f.reminders) }
  if (path === '/desktop/reminders/refresh') return structuredClone(f.reminders)
  if (path === '/desktop/reminders/test') return { message: '已预约测试；实际送达取决于系统设置' }
  if (path === '/status') return { name: 'ASTaria', version: 'synthetic', configured: false, model: 'deepseek-flash', storage: '内存测试', provider: f.provider, providerSettings: { ...providerSettings, provider: f.provider } }
  if (path === '/preferences') return structuredClone(f.preferences)
  if (path === '/planner') return { revision: 1, timetableConfirmed: false, routines: [], blocks: [], details: {}, checked: {} }
  if (path === '/memories' || path === '/operations') return []
  if (path === '/data/export') return structuredClone(backup)
  if (path === '/settings/provider') { f.provider = body.provider; return {} }
  return { supported: false }
}
HTMLAnchorElement.prototype.click = function () { f.downloads.push(this.download) }
let root
f.mount = async (scenario = 'reminders', options = {}) => {
  root?.unmount(); f.calls = []; f.hookCalls = []; f.nativeShareCalls = []; f.downloads = []; f.scenario = scenario
  Object.assign(f, options)
  if (f.platform === 'desktop') delete document.documentElement.dataset.mobile
  else document.documentElement.dataset.mobile = f.platform
  f.preferences = structuredClone(DEFAULT_PREFERENCES); f.preferences.theme = f.theme; f.preferences.glass = f.glass; publishPreferences(f.preferences)
  document.body.style.background = f.theme === 'light' ? '#f2f3f5' : '#0b0d13'
  root = createRoot(document.querySelector('#root'))
  const hook = options.noHook ? undefined : async (value, name) => { f.hookCalls.push({ value, name }); if (f.shareFailure) throw Error('已取消备份分享；尚未确认保存') }
  root.render(scenario === 'reminders'
    ? <div className="xixi-settings" data-theme={f.theme}><SystemReminders /></div>
    : <LocalSettings initialTab={scenario === 'data' ? '数据' : '析熙'} onClose={() => {}} onSaved={() => {}} onExportBackup={hook} />)
  await f.wait(() => document.querySelector(scenario === 'reminders' ? '[role=switch]' : '.xixi-settings-content'))
  if (scenario !== 'reminders') await f.wait(() => f.calls.some(call => call.path === '/operations'))
  await new Promise(requestAnimationFrame)
}
f.wait = async condition => { for (let i = 0; i < 120; i++) { if (condition()) return; await new Promise(requestAnimationFrame) } throw Error('Fixture did not settle') }
f.button = text => [...document.querySelectorAll('button')].find(button => button.textContent === text)
f.stateText = () => document.querySelector('[role=status]')?.textContent
f.feedback = () => document.querySelector('.xixi-settings-feedback')?.textContent
f.ready = true
`

test('synthetic browser verifies phone notification, backup hook and model restrictions in both themes', { timeout: 60000 }, async t => {
  try { await access(chromePath) } catch { t.skip('Local Chrome is unavailable; no browser is downloaded'); return }
  const temporary = await mkdtemp(join(tmpdir(), 'astaria-mobile-ui-'))
  let chrome, socket, server
  t.after(async () => {
    socket?.close()
    if (chrome && chrome.exitCode === null && chrome.signalCode === null) {
      const exited = new Promise(done => chrome.once('close', done))
      chrome.kill(); await Promise.race([exited, delay(2000)])
      if (chrome.exitCode === null && chrome.signalCode === null) { chrome.kill('SIGKILL'); await exited }
    }
    if (server) await new Promise(done => server.close(done))
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const fixtureId = join(project, '__synthetic-mobile-settings__.tsx')
  const output = await build({
    configFile: false, root: project, publicDir: false, cacheDir: join(temporary, 'vite-cache'), logLevel: 'error',
    define: { 'import.meta.env.MODE': '"test"', 'import.meta.env.DEV': 'true', 'import.meta.env.PROD': 'false' },
    plugins: [react(), { name: 'synthetic-local-api', enforce: 'pre',
      resolveId(id, importer) {
        if (id === 'virtual:mobile-fixture') return fixtureId
        if (/(?:^|\/)api(?:\.ts)?$/.test(id) && importer?.includes('/src/')) return '\0synthetic-api'
        if (/(?:^|\/)backupShare(?:\.ts)?$/.test(id) && importer?.endsWith('/src/xixi/LocalSettings.tsx')) return '\0synthetic-backup-share'
      },
      load(id) {
        if (id === fixtureId) return fixture
        if (id === '\0synthetic-api') return 'export class LocalApiError extends Error { constructor(message, status) { super(message); this.status=status } } export const localApi = (path, body) => window.fixture.api(path, body);'
        if (id === '\0synthetic-backup-share') return 'export async function shareMobileBackup(value, name) { const f = window.fixture; f.nativeShareCalls.push({ value, name }); if (f.nativeShareFailure) throw Error("已取消备份分享；尚未确认保存") }'
      },
    }],
    build: { write: false, outDir: temporary, emptyOutDir: false, minify: false, cssCodeSplit: false, assetsInlineLimit: 10000000,
      rollupOptions: { input: 'virtual:mobile-fixture', output: { entryFileNames: 'app.js', assetFileNames: 'app.[ext]' } },
    },
  })
  const assets = new Map((Array.isArray(output) ? output : [output]).flatMap(result => result.output).map(file => [`/${file.fileName}`, file.type === 'chunk' ? file.code : file.source]))
  server = createServer((request, response) => {
    if (request.url === '/') { response.setHeader('Content-Type', 'text/html'); response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{margin:0;font-family:system-ui}.p0{height:100vh}.xixi-settings:not([aria-label]){position:relative;padding:24px}</style><div class="p0"><div id="root"></div></div><script type="module" src="/app.js"></script>'); return }
    const asset = assets.get(request.url)
    if (!asset) { response.statusCode = 404; response.end(); return }
    response.setHeader('Content-Type', request.url.endsWith('.css') ? 'text/css' : 'text/javascript'); response.end(asset)
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const profile = join(temporary, 'profile')
  chrome = spawn(chromePath, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update'], { stdio: 'ignore' })
  let port
  for (let attempt = 0; attempt < 120; attempt++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await delay(50) } }
  assert.ok(port, 'Chrome opens a temporary debug profile')
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  socket = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
  await new Promise((done, fail) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', fail, { once: true }) })
  let id = 0; const waiting = new Map()
  socket.addEventListener('message', event => { const message = JSON.parse(event.data); if (message.id) { const item = waiting.get(message.id); waiting.delete(message.id); if (message.error) item.reject(Error(message.error.message)); else item.resolve(message.result) } })
  const command = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; waiting.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async expression => { const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text); return result.result.value }
  await command('Page.enable'); await command('Runtime.enable')
  await command('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  await command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
  for (let attempt = 0; attempt < 120 && !await evaluate('Boolean(window.fixture?.ready)'); attempt++) await delay(50)
  assert.equal(await evaluate('Boolean(window.fixture?.ready)'), true)

  const checks = []
  for (const theme of ['dark', 'light']) for (const glass of ['clear', 'soft']) {
    const result = await evaluate(`(async () => {
      const f = window.fixture; f.reminders = { supported:true, platform:'android', enabled:false, authorization:2, count:0, through:null, omitted:0, error:null }
      await f.mount('reminders', { theme:${JSON.stringify(theme)}, glass:${JSON.stringify(glass)}, platform:'android' })
      await f.wait(() => !document.querySelector('[role=switch]').disabled)
      const toggle = document.querySelector('[role=switch]'); toggle.focus(); const focus = document.activeElement === toggle
      toggle.click(); toggle.click(); await f.wait(() => document.querySelector('[role=switch]').getAttribute('aria-checked') === 'true')
      return { focus, title:toggle.getAttribute('aria-label'), requests:f.calls.filter(call => call.path === '/desktop/reminders/enabled').length, text:document.body.textContent, overflow:document.documentElement.scrollWidth > innerWidth + 1, color:getComputedStyle(toggle).color }
    })()`)
    assert.equal(result.focus, true); assert.equal(result.requests, 1); assert.equal(result.title, 'App 外系统提醒')
    assert.ok(result.text.includes('强制停止') && result.text.includes('不能保证精确时刻')); assert.ok(!result.text.includes('由 macOS 保存预约'))
    assert.equal(result.overflow, false); checks.push(`${theme}/${glass}: Android switch, focus, no double submission, narrow layout (${result.color})`)

    const backup = await evaluate(`(async () => {
      const f = window.fixture; await f.mount('data', { shareFailure:false, noHook:false })
      await f.wait(() => !f.button('导出备份').disabled); f.button('导出备份').click(); await f.wait(() => f.feedback().includes('备份分享已结束'))
      return { count:f.hookCalls.length, nativeCount:f.nativeShareCalls.length, name:f.hookCalls[0]?.name, value:f.hookCalls[0]?.value, downloads:f.downloads.length, notice:f.feedback(), theme:document.querySelector('[aria-label=设置]').dataset.theme, overflow:document.documentElement.scrollWidth > innerWidth + 1 }
    })()`)
    assert.equal(backup.count, 1); assert.match(backup.name, /^ASTaria-backup-.*\.json$/u); assert.equal(backup.value.format, 'astaria-backup')
    assert.equal(backup.downloads, 0); assert.equal(backup.nativeCount, 0, 'the injected hook takes precedence'); assert.ok(backup.notice.includes('确认保存')); assert.equal(backup.theme, theme); assert.equal(backup.overflow, false)
    checks.push(`${theme}/${glass}: backup platform hook, no download, cautious receipt`)
    if (process.env.ASTARIA_MOBILE_UI_OUTPUT) {
      await evaluate('Promise.all(document.querySelector(".xixi-settings").getAnimations({subtree:true}).map(animation => animation.finished.catch(() => {})))')
      const folder = resolve(process.env.ASTARIA_MOBILE_UI_OUTPUT); await mkdir(folder, { recursive: true })
      const image = await command('Page.captureScreenshot', { format: 'png' }); await writeFile(join(folder, `${theme}-${glass}.png`), Buffer.from(image.data, 'base64'))
    }
  }
  const edge = await evaluate(`(async () => {
    const f = window.fixture, results = []
    f.reminders = { ...f.reminders, supported:false, platform:'web-preview', enabled:false }
    await f.mount('reminders', { platform:'preview' }); await f.wait(() => f.stateText().includes('预览不支持'))
    results.push(document.querySelector('[role=switch]').disabled && !f.button('发送测试提醒'))
    f.reminders = { ...f.reminders, supported:true, platform:'ios', enabled:true, count:99, error:'虚构的预约失败' }
    await f.mount(); await f.wait(() => f.stateText() === '虚构的预约失败'); results.push(!f.stateText().includes('99'))
    f.readFailure = true; await f.mount(); await f.wait(() => f.stateText() === '虚构的读取失败'); results.push(Boolean(f.button('重新同步提醒')))
    f.readFailure = false; f.reminders = { ...f.reminders, error:null, count:1 }; f.button('重新同步提醒').click(); await f.wait(() => f.stateText().includes('已预约 1')); results.push(true)
    await f.mount('data', { shareFailure:true }); await f.wait(() => !f.button('导出备份').disabled); f.button('导出备份').click(); await f.wait(() => f.feedback().includes('已取消备份分享')); results.push(!f.feedback().includes('备份分享已结束') && f.downloads.length === 0)
    await f.mount('data', { platform:'android', noHook:true, shareFailure:false, nativeShareFailure:false }); await f.wait(() => !f.button('导出备份').disabled); f.button('导出备份').click(); await f.wait(() => f.feedback().includes('备份分享已结束')); results.push(f.downloads.length === 0 && f.nativeShareCalls.length === 1 && f.hookCalls.length === 0 && f.nativeShareCalls[0].value.format === 'astaria-backup')
    await f.mount('data', { platform:'ios', noHook:true, nativeShareFailure:false }); await f.wait(() => !f.button('导出备份').disabled); f.button('导出备份').click(); await f.wait(() => f.feedback().includes('备份分享已结束')); results.push(f.downloads.length === 0 && f.nativeShareCalls.length === 1)
    await f.mount('data', { platform:'android', noHook:true, nativeShareFailure:true }); await f.wait(() => !f.button('导出备份').disabled); f.button('导出备份').click(); await f.wait(() => f.feedback().includes('已取消备份分享')); results.push(!f.feedback().includes('备份分享已结束') && f.downloads.length === 0)
    await f.mount('data', { platform:'preview', noHook:true, nativeShareFailure:false }); await f.wait(() => !f.button('导出备份').disabled); f.button('导出备份').click(); await f.wait(() => f.feedback().includes('备份已下载')); results.push(f.downloads.length === 1 && f.nativeShareCalls.length === 0)
    await f.mount('model', { noHook:false, provider:'deepseek', platform:'android' }); await f.wait(() => document.querySelector('.xixi-model-modes button'))
    results.push(document.querySelectorAll('.xixi-model-modes button').length === 1 && document.body.textContent.includes('不安装或运行本地模型') && document.body.textContent.includes('会发送给该服务'))
    await f.mount('model', { provider:'local' }); await f.wait(() => f.button('切换到 DeepSeek'))
    results.push(!document.querySelector('.xixi-model-install-disclosure') && !f.calls.some(call => call.path === '/settings/device'))
    f.button('切换到 DeepSeek').click(); await f.wait(() => document.querySelector('.xixi-model-modes'))
    results.push(f.calls.some(call => call.path === '/settings/provider' && call.body.provider === 'deepseek'))
    await f.mount('model', { platform:'desktop', provider:'deepseek' }); await f.wait(() => document.querySelector('.xixi-model-modes button:nth-child(2)'))
    results.push(getComputedStyle(document.querySelector('.xixi-model-modes button:nth-child(2)')).display !== 'none')
    let release; f.initialGate = new Promise(done => { release = done }); f.reminders = { ...f.reminders, supported:true, platform:'android', enabled:true, count:1, error:null }
    await f.mount(); f.button('重新同步提醒').click(); await f.wait(() => f.stateText().includes('已预约 1'))
    release({ ...f.reminders, count:99 }); f.initialGate = null; await new Promise(requestAnimationFrame); results.push(!f.stateText().includes('99'))
    await f.mount('data', { platform:'desktop', noHook:true }); await f.wait(() => !f.button('导出备份').disabled)
    f.button('导出备份').click(); await f.wait(() => f.feedback().includes('备份已下载')); results.push(f.downloads.length === 1 && f.hookCalls.length === 0)
    return results
  })()`)
  assert.deepEqual(edge, Array(15).fill(true))
  for (const item of checks) t.diagnostic(item)
  t.diagnostic('15 additional checks: preview, errors/retry, native sharing without a hook, sharing cancellation, model restrictions/migration, preview/desktop downloads and stale read')
})
