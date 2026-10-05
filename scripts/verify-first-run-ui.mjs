#!/usr/bin/env node
/**
 * BetaX 首次引导（真实首页引导）隔离验收。
 *
 * 用临时数据库 + 隔离 Chrome 走真实 UI：
 *   1. 空库：跳过模型连接 → 工作台空态文案/按钮 → 继续进入弦轨 → 完成引导，全程不得伪造任务；
 *   2. 真实任务：建立一个未排程 todo 后重置引导，工作台必须要求打开真实任务，可跳过，
 *      打开任务再返回后进度变为已完成；
 *   3. 注入态：延迟/失败 /api/tasks，确认 loading 与 error 不被误判成 empty。
 * 覆盖 dark/light × clear/soft，截图与 JSON 写入 artifacts/verification/betax-first-run-ui。
 *
 * 只使用本机临时数据与内存凭据；不访问真实数据库、钥匙串或模型，不联网。
 */
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

const artifacts = resolve('artifacts/verification/betax-first-run-ui')
const root = resolve('dist')
const CASES = [
  { id: 'empty', theme: 'dark', glass: 'clear', tasks: [], inject: null },
  { id: 'task', theme: 'light', glass: 'soft', tasks: ['真实任务：完成实验报告'], inject: null },
  { id: 'loading', theme: 'light', glass: 'clear', tasks: [], inject: 'delay' },
  { id: 'error', theme: 'dark', glass: 'soft', tasks: [], inject: 'fail' },
]
const delay = ms => new Promise(yes => setTimeout(yes, ms))
const summary = { passed: false, cases: [], injected: {}, externalRequests: [], pageErrors: [] }

await mkdir(artifacts, { recursive: true })
let active = null
try {
  for (const item of CASES) summary.cases.push(await runCase(item))
  summary.injected = summary.cases.filter(item => item.injected).map(item => `${item.id}:${item.injected}`)
  assert.deepEqual(summary.externalRequests, [], '没有向外部主机发起请求')
  assert.deepEqual(summary.pageErrors, [], 'no uncaught page exceptions')
  summary.passed = true
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify(summary, null, 2)}\n`)
  console.log(JSON.stringify(summary))
} catch (error) {
  await writeFile(join(artifacts, 'result.json'), `${JSON.stringify({ ...summary, passed: false, failure: error.message }, null, 2)}\n`)
  console.error(error.stack ?? error.message)
  process.exitCode = 1
} finally {
  await cleanup()
}

/** 每个用例一套临时目录、临时数据库与隔离浏览器，跑完立即回收。 */
async function runCase({ id, theme, glass, tasks, inject }) {
  const directory = await mkdtemp(join(tmpdir(), `astaria-first-run-${id}-`))
  const dataDirectory = join(directory, 'data')
  await mkdir(dataDirectory, { recursive: true })
  const db = createDatabase(join(dataDirectory, 'test.sqlite'))
  const service = createLocalService({
    db,
    vault: { status: async () => false, read: async () => { throw Error('凭据不得被访问') }, save: async () => { throw Error('凭据不得被写入') }, remove: async () => {} },
    complete: async () => { throw Error('不得调用模型') },
    dataDirectory,
  })
  const token = `isolated-first-run-${id}-000000000000`
  const handler = createDesktopHandler({ root, service, token, updates: null, reminders: null })
  const server = createServer((request, response) => { request.headers['x-astaria-desktop'] = token; void handler(request, response) })
  await new Promise(yes => server.listen(0, '127.0.0.1', yes))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
    '--remote-debugging-port=0', `--user-data-dir=${join(directory, 'chrome')}`,
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: 'ignore' })
  active = { server, service, browser, directory }
  let ws
  try {
    const debugPortNumber = await debugPort(join(directory, 'chrome'), browser)
    // 命令走页面级 WebSocket：不需要跨会话路由，行为在 Chrome 各版本间一致。
    const targets = await (await fetch(`http://127.0.0.1:${debugPortNumber}/json/list`)).json()
    const page = targets.find(item => item.type === 'page')
    assert.ok(page?.webSocketDebuggerUrl, '隔离浏览器提供页面调试端点')
    ws = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
    let serial = 0, injected = null, injecting = false
    const pending = new Map()
    const send = (method, params = {}) => new Promise((yes, no) => {
      const id = ++serial
      const timeout = setTimeout(() => { pending.delete(id); no(Error(`CDP 超时：${method}`)) }, 15000)
      pending.set(id, { yes: value => { clearTimeout(timeout); yes(value) }, no: error => { clearTimeout(timeout); no(error) } })
      ws.send(JSON.stringify({ id, method, params }))
    })
    ws.onmessage = event => {
      const value = JSON.parse(event.data)
      if (value.method === 'Runtime.exceptionThrown') summary.pageErrors.push(String(value.params.exceptionDetails?.text ?? 'exception'))
      if (value.method === 'Network.requestWillBeSent') {
        const url = new URL(value.params.request.url)
        if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:', 'about:'].includes(url.protocol)) summary.externalRequests.push(url.href)
      }
      if (value.method === 'Fetch.requestPaused') {
        const { requestId, request } = value.params
        const path = new URL(request.url).pathname
        // 只注入工作台依赖的 /api/planner，保持真实引导流程不变
        if (injecting && inject && path === '/api/planner') {
          injected = { mode: inject, url: request.url }
          if (inject === 'delay') setTimeout(() => void send('Fetch.continueRequest', { requestId }).catch(() => {}), 8000)
          else void send('Fetch.failRequest', { requestId, errorReason: 'ConnectionFailed' }).catch(() => {})
        } else void send('Fetch.continueRequest', { requestId }).catch(() => {})
      }
      const callback = pending.get(value.id)
      if (callback) { pending.delete(value.id); value.error ? callback.no(value.error) : callback.yes(value.result) }
    }
    const evaluate = async expression => {
      const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
      if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
      return result.result.value
    }
    const wait = async (expression, label = expression) => {
      for (let index = 0; index < 120; index++) { if (await evaluate(expression)) return; await delay(100) }
      throw Error(`等待超时：${label}`)
    }
    const click = async selector => {
      await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});return e&&!e.disabled&&!e.closest('[inert]')})()`, `可点击 ${selector}`)
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'});true`)
      await delay(200)
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('控件被遮挡: '+${JSON.stringify(selector)});return{x,y}})()`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    }
    const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent.trim() ?? null`)
    const nextLabel = () => text('.first-run-next')
    const shot = async name => writeFile(join(artifacts, name), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
    const stepIndex = () => evaluate(`Number(document.querySelector('.first-run')?.dataset.step ?? -1)`)

    /** 跳过模型连接后，沿导览一路点进工作台步骤（step 5）。 */
    const advanceToWorkbenchStep = async () => {
      await wait(`document.querySelector('.first-run')?.dataset.tour === 'true'`, '进入导览步骤')
      assert.equal(await stepIndex(), 2, '导览从首页步骤开始')
      for (const step of ['3', '4', '5']) {
        await click('.first-run-next')
        await wait(`document.querySelector('.first-run')?.dataset.step === '${step}'`, `进入导览步骤 ${step}`)
      }
      await wait(`document.querySelector('.home-workspace')?.dataset.page === 'workbench'`, '首页切到工作台')
    }

    await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable')
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await send('Page.navigate', { url: origin })
    await wait('!!document.querySelector(".home-brand")', '首页挂载')
    await wait('!!document.querySelector(".first-run[open][data-tour=false]")', '首次引导第一步出现')
    assert.notEqual(db.getPreference('onboarding-completed'), true, '引导完成前不写入 onboarding 状态')

    // 第一步：外观、玻璃与个性（真实写入偏好）
    await evaluate(`[...document.querySelectorAll('.first-run fieldset')].find(e=>e.textContent.includes('玻璃质感')).querySelectorAll('button')[${glass === 'soft' ? 0 : 1}].dataset.qaPick='glass';true`)
    await click('[data-qa-pick=glass]')
    await evaluate(`[...document.querySelectorAll('.first-run fieldset')].find(e=>e.textContent.includes('背景')).querySelectorAll('button')[${theme === 'dark' ? 0 : 1}].dataset.qaPick='theme';true`)
    await click('[data-qa-pick=theme]')
    assert.equal(await evaluate(`document.querySelector('.first-run').dataset.theme`), theme, '引导主题与选择一致')
    assert.equal(await evaluate(`document.querySelector('.first-run').dataset.glass`), glass, '引导玻璃与选择一致')
    assert.equal(await evaluate(`[...document.querySelectorAll('.first-run-render button')].find(e=>e.textContent==='ASTaria 推荐').getAttribute('aria-pressed')`), 'true')
    if (tasks.length) {
      await evaluate(`[...document.querySelectorAll('.first-run-render button')].find(e=>e.textContent==='手动调整').dataset.qaManual='1';true`)
      await click('[data-qa-manual]')
      await evaluate(`for(const [label,value] of [['初始帧率','smooth90'],['初始画质','high']]){const e=document.querySelector('select[aria-label="'+label+'"]');e.value=value;e.dispatchEvent(new Event('change',{bubbles:true}))}true`)
    }
    await send('Emulation.setDeviceMetricsOverride', { width:390, height:760, deviceScaleFactor:1, mobile:false })
    await delay(250)
    assert.equal(await evaluate(`(()=>{const d=document.querySelector('.first-run'),b=d.querySelector('.first-run-next').getBoundingClientRect();return d.scrollWidth<=d.clientWidth+1&&b.bottom<=innerHeight&&b.top>=0})()`), true, 'narrow guide keeps footer reachable')
    await shot(`${id}-narrow-${theme}-${glass}.png`)
    await send('Emulation.setDeviceMetricsOverride', { width:1440, height:1000, deviceScaleFactor:1, mobile:false })
    await delay(250)
    await shot(`${id}-01-appearance-${theme}-${glass}.png`)
    assert.equal(await nextLabel(), '继续')
    await click('.first-run-next')
    await wait(`(()=>{const p=document.querySelector('.first-run');return p&&p.dataset.step==='1'})()`, '进入模型连接步骤')
    const saved = getPreferences(db)
    assert.equal(saved.theme, theme, '偏好写入主题')
    assert.equal(saved.glass, glass, '偏好写入玻璃')
    assert.equal(saved.render.profile, tasks.length ? 'smooth90' : 'full')
    assert.equal(saved.render.quality, tasks.length ? 'high' : 'auto')
    await wait(`window.__ASTARIA_P0__?.getSnapshot().requestedQuality === '${tasks.length ? 'high' : 'auto'}'`)

    // 第二步：跳过模型连接（不填 Key，不触碰凭据）
    await wait(`!!document.querySelector('#first-run-key')`, '模型连接步骤已渲染')
    assert.equal(await nextLabel(), '稍后配置')
    assert.equal(db.getPreference('model-connection'), null, '跳过模型连接不写连接设置')
    await click('.first-run-next')

    if (inject) {
      // 进入工作台步骤前开始注入 /api/planner 延迟或失败：保持真实引导流程，
      // 只有工作台数据变慢/变错，用来确认 step 5 不会把 loading/error 误判成 empty。
      injecting = true
    }
    await advanceToWorkbenchStep()

    if (inject) {
      const seen = new Set(), copies = {}
      for (let index = 0; index < 60; index++) {
        const snapshot = await evaluate(`(()=>{const w=document.querySelector('.wb-scroll');return {state:w?.dataset.guideState ?? null, action:document.querySelector('#first-run-action')?.textContent ?? ''}})()`)
        if (snapshot.state) { seen.add(snapshot.state); copies[snapshot.state] ??= snapshot.action }
        if (snapshot.state === (inject === 'delay' ? 'loading' : 'error') && snapshot.action.includes(inject === 'delay' ? '正在读取' : '事项暂时未能读取')) { copies[snapshot.state] = snapshot.action; break }
        await delay(100)
      }
      const expected = inject === 'delay' ? 'loading' : 'error'
      assert.ok(seen.has(expected), `${id}: 注入后先出现 ${expected}，实际 ${[...seen].join(',')}`)
      assert.ok(!seen.has('empty'), `${id}: 注入态没有被误判成空态`)
      if (inject === 'delay') assert.ok(copies.loading?.includes('正在读取'), `延迟时文案说明还在读取：${copies.loading}`)
      else assert.ok(copies.error?.includes('事项暂时未能读取'), `失败时文案说明读取失败：${copies.error}`)
      assert.equal(await evaluate(`document.querySelector('.home-workspace')?.dataset.page`), 'workbench', '注入期间仍停在工作台导览')
      assert.equal(await evaluate(`document.querySelector('.first-run')?.dataset.step`), '5', '注入期间引导仍在 step 5')
      await shot(`${id}-01-workbench-${expected}-${theme}-${glass}.png`)
      injecting = false
      const injectedRecord = { id, injected: `${inject}:${expected}`, observed: [...seen], copies }
      await writeFile(join(artifacts, `${id}-injected.json`), `${JSON.stringify(injectedRecord, null, 2)}\n`)
      return injectedRecord
    }

    if (tasks.length) {
      // 真实任务：通过本机 API 建立未排程 todo，再重置引导重新读取
      const created = await evaluate(`(async()=>{const response=await fetch('/api/tasks/create',{method:'POST',headers:{'X-ASTaria-Local':'1','Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ title: tasks[0], status: 'todo', inbox: false })})});if(!response.ok)throw Error('create failed '+response.status);return await response.json()})()`)
      assert.ok(created?.id, '真实任务创建成功')
      assert.equal(created.inbox, false, '任务使用 inbox:false')
      assert.equal(created.status, 'todo')
      assert.ok(!created.startAt && !created.due, '任务未排程')
      db.setPreference('onboarding-completed', false)
      await evaluate(`document.querySelector('.wb-scroll').dataset.qaGuide='1';true`)
      await send('Page.navigate', { url: origin })
      await wait('!!document.querySelector(".first-run[open][data-tour=false]")', '重建后引导重新出现')
      await wait(`!document.querySelector('[data-qa-guide]')`, '重建后旧工作台标记已消失')
      await wait(`!!document.querySelector('.wb-scroll') && document.querySelector('.wb-scroll').dataset.qaGuide === undefined`, '重建后是新的工作台节点')
      // 重建后引导从 step 0 重新开始：先走完外观与模型两步，再进工作台
      await click('.first-run-next')
      await wait(`document.querySelector('.first-run')?.dataset.step === '1'`, '重建后进入模型连接步骤')
      await click('.first-run-next')
      await advanceToWorkbenchStep()
      await wait(`document.querySelector('.wb-scroll')?.dataset.guideState === 'ready'`, '工作台读到真实任务')
      await wait(`document.querySelectorAll('.wb-available .wb-task').length === 1`, '真实任务出现在可开始列表')
      assert.equal(await evaluate(`document.querySelectorAll('.wb-available .wb-task').length`), 1, '工作台只显示这一项真实任务')
      assert.ok((await text('.wb-available .wb-task'))?.includes(tasks[0]), '工作台显示真实任务标题')
      await evaluate(`document.querySelector('.wb-available .wb-task').dataset.qaTask='1';true`)
      await click('[data-qa-task]')
      await wait(`!!document.querySelector('.wb-back')`, '真实任务已打开')
      assert.equal(await nextLabel(), '跳过此步', '打开任务但尚未返回时仍是跳过')
      await click('.wb-back')
      await wait(`!document.querySelector('.wb-back')`, '已返回选择')
      await wait(`document.querySelector('.first-run .first-run-feedback')?.textContent.trim() === '已完成这一步'`, '打开并返回后进度完成')
      assert.equal(await evaluate(`document.querySelector('.first-run')?.dataset.step`), '5', '仍在工作台导览步骤')
      assert.equal(await text('.first-run .first-run-feedback'), '已完成这一步', '打开并返回后显示已完成')
      assert.equal(await nextLabel(), '继续', '返回后按钮回到继续')
      await shot(`${id}-03-workbench-task-${theme}-${glass}.png`)
    } else {
      // 空库：文案说明没有可开始事项，按钮为继续，不得出现跳过
      await wait(`document.querySelector('.wb-scroll')?.dataset.guideState === 'empty'`, '工作台空态')
      await wait(`document.querySelector('#first-run-action')?.textContent.includes('现在没有可开始的事项')`)
      const action = await text('#first-run-action')
      assert.ok(action?.includes('现在没有可开始的事项'), `空态文案正确：${action}`)
      assert.equal(await nextLabel(), '继续')
      assert.equal(await text('.wb-available .wb-task').catch(() => null), null, '空库没有任务卡')
      assert.deepEqual(db.listTasks({ includeDeleted: true }), [], '数据库里没有任何任务行')
      await shot(`${id}-02-workbench-empty-${theme}-${glass}.png`)
    }

    // 前进到弦轨并完成引导
    await click('.first-run-next')
    await wait(`document.querySelector('.first-run')?.dataset.step === '6'`, '进入弦轨步骤')
    assert.equal(await evaluate(`document.querySelector('.home-workspace')?.dataset.page`), 'home', '弦轨步骤回到首页')
    assert.equal(await nextLabel(), '跳过并开始')
    await click('.first-run-next')
    await wait(`!document.querySelector('.first-run[open]')`, '引导结束')
    assert.equal(db.getPreference('onboarding-completed'), true, '完成后写入 onboarding 状态')
    assert.deepEqual(db.listTasks({ includeDeleted: true }).length, tasks.length, '引导没有创建额外任务')
    await shot(`${id}-04-finished-${theme}-${glass}.png`)
    return { id, theme, glass, tasks: tasks.length, guideState: tasks.length ? 'ready' : 'empty', finished: true }
  } finally {
    ws?.close()
    await cleanup()
  }
}

async function debugPort(profile, browser) {
  for (let index = 0; index < 150; index++) {
    if (browser.exitCode !== null) throw Error(`隔离浏览器提前退出：${browser.exitCode}`)
    try {
      const value = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n')
      const port = Number(value[0])
      if (Number.isInteger(port) && port > 0) return port
    } catch { /* 端口文件稍后出现 */ }
    await delay(100)
  }
  throw Error('隔离浏览器没有开放调试端口')
}

async function cleanup() {
  const current = active
  active = null
  if (!current) return
  const { server, service, browser, directory } = current
  const stopped = new Promise(yes => browser.once('exit', yes))
  browser.kill('SIGTERM')
  await Promise.race([stopped, delay(5000)])
  if (browser.exitCode === null) browser.kill('SIGKILL')
  server.closeAllConnections()
  await new Promise(yes => server.close(yes))
  service.close()
  await rm(directory, { recursive: true, force: true })
}
