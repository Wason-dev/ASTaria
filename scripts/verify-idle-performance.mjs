/** Isolated desktop-renderer A/B. Counts work, not watts or GPU performance.
 * Run after npm run build:desktop. Both builds use disposable, identically seeded
 * databases and Chrome profiles. All instrumentation exists only in this test.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createDatabase } from '../server/database.mjs'
import { createLocalService } from '../server/index.mjs'
import { createDesktopHandler } from '../desktop/server.mjs'

const baseline = resolve(process.env.IDLE_QA_BASELINE ?? 'artifacts/performance/idle-work-before-20260928')
const current = resolve(process.env.IDLE_QA_CURRENT ?? 'dist')
const artifacts = resolve('artifacts/performance/idle-work')
const sampleMs = 20_000
const delay = ms => new Promise(yes => setTimeout(yes, ms))

// Inject before React loads. Timer wrappers preserve native scheduling. The
// DevTools shim only counts commits; no component logic is changed for the A/B.
const preload = `(() => {
  const original = {
    setInterval: window.setInterval.bind(window), clearInterval: window.clearInterval.bind(window),
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window),
    fetch: window.fetch.bind(window), now: Date.now.bind(Date),
  };
  let intervals = {}, timeouts = {}, requests = {}, commits = 0, renderers = 0;
  let sampledAt = performance.now(), clockOffset = 0, visibility;
  const pendingIntervals = new Map(), pendingTimeouts = new Map();
  const count = (target, key) => { target[key] = (target[key] || 0) + 1; };
  window.setInterval = (handler, milliseconds = 0, ...args) => {
    const interval = Number(milliseconds) || 0;
    const callback = typeof handler === 'function' ? handler : () => (0, eval)(handler);
    const id = original.setInterval((...values) => { count(intervals, interval); callback.apply(window, values); }, milliseconds, ...args);
    pendingIntervals.set(id, interval); return id;
  };
  window.clearInterval = id => { pendingIntervals.delete(id); pendingTimeouts.delete(id); original.clearInterval(id); };
  window.setTimeout = (handler, milliseconds = 0, ...args) => {
    const timeout = Number(milliseconds) || 0;
    const callback = typeof handler === 'function' ? handler : () => (0, eval)(handler);
    const id = original.setTimeout((...values) => { pendingTimeouts.delete(id); count(timeouts, timeout); callback.apply(window, values); }, milliseconds, ...args);
    pendingTimeouts.set(id, timeout); return id;
  };
  window.clearTimeout = id => { pendingTimeouts.delete(id); pendingIntervals.delete(id); original.clearTimeout(id); };
  window.fetch = (input, init) => {
    try { count(requests, new URL(typeof input === 'string' || input instanceof URL ? input : input.url, location.href).pathname); } catch {}
    return original.fetch(input, init);
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(),
    inject(renderer) { const id = ++renderers; this.renderers.set(id, renderer); return id; },
    onCommitFiberRoot() { commits += 1; }, onCommitFiberUnmount() {}, checkDCE() {},
  };
  window.__idleQA = {
    reset() { intervals = {}; timeouts = {}; requests = {}; commits = 0; sampledAt = performance.now(); },
    snapshot() {
      const histogram = values => { const result = {}; for (const value of values) count(result, value); return result; };
      return { elapsedMs: performance.now() - sampledAt, intervalCallbacks: { ...intervals },
        timeoutCallbacks: { ...timeouts }, fetchRequests: { ...requests }, reactCommits: commits,
        reactRenderers: renderers, pendingIntervals: histogram(pendingIntervals.values()),
        pendingTimeouts: histogram(pendingTimeouts.values()) };
    },
    visibility(value) {
      visibility = value;
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => visibility === 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    },
    shiftClock(milliseconds) { clockOffset += milliseconds; Date.now = () => original.now() + clockOffset; },
  };
  localStorage.setItem('astaria-sqlite-migration-v1', 'complete');
})();`

async function runBuild(name, root, verifyFocus = false) {
  const index = await readFile(join(root, 'index.html'), 'utf8')
  const buildAssets = await Promise.all([...index.matchAll(/(?:src|href)="(\/assets\/[^\"]+\.(?:js|css))"/g)].map(async ([, path]) => ({
    path, sha256: createHash('sha256').update(await readFile(join(root, path))).digest('hex'),
  })))
  const directory = await mkdtemp(join(tmpdir(), `astaria-idle-${name}-`))
  const db = createDatabase(join(directory, 'test.sqlite'))
  const task = db.createTask({ title: '性能验收：独立专注事项', estimateMin: 35, inbox: false })
  db.createTask({ title: '性能验收：独立阅读事项', estimateMin: 20, inbox: false })
  let modelCalls = 0
  const service = createLocalService({
    db, vault: { status: async () => false }, dataDirectory: directory,
    complete: async () => { modelCalls += 1; throw Error('Performance QA must never invoke a model') },
  })
  const token = 'isolated-idle-qa-capability-000000000000'
  const handler = createDesktopHandler({ root, service, token })
  const serverRequests = []
  const server = createServer((req, res) => {
    serverRequests.push({ at: Date.now(), path: new URL(req.url, 'http://isolated.invalid').pathname })
    req.headers['x-astaria-desktop'] = token
    void handler(req, res)
  })
  await new Promise(yes => server.listen(0, '127.0.0.1', yes))
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--remote-debugging-port=0',
    `--user-data-dir=${join(directory, 'chrome')}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader', 'about:blank',
  ], { stdio: 'ignore' })
  let ws, session
  const errors = [], externalRequests = []
  try {
    let devtools
    for (let i = 0; i < 100; i++) {
      try { devtools = (await readFile(join(directory, 'chrome', 'DevToolsActivePort'), 'utf8')).trim().split('\n'); break } catch { await delay(100) }
    }
    assert.ok(devtools, `${name}: isolated Chrome starts`)
    ws = new WebSocket(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`)
    await new Promise((yes, no) => { ws.onopen = yes; ws.onerror = no })
    let serial = 0
    const pending = new Map()
    const send = (method, params = {}, targetSession = session) => new Promise((yes, no) => {
      const id = ++serial
      pending.set(id, { yes, no })
      ws.send(JSON.stringify({ id, method, params, ...(targetSession ? { sessionId: targetSession } : {}) }))
    })
    ws.onmessage = event => {
      const value = JSON.parse(event.data)
      if (value.method === 'Runtime.exceptionThrown') errors.push(value.params.exceptionDetails)
      if (value.method === 'Fetch.requestPaused') {
        const request = value.params.request
        const allowed = request.url.startsWith(`${origin}/`) || request.url.startsWith('data:') || request.url.startsWith('blob:')
        if (!allowed) externalRequests.push(request.url)
        void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', {
          requestId: value.params.requestId, ...(!allowed ? { errorReason: 'BlockedByClient' } : {}),
        }, value.sessionId).catch(reason => errors.push(String(reason)))
      }
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
      await wait(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e && !e.disabled && !e.closest('[inert]'); })()`)
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'}); true`)
      await delay(100)
      const point = await evaluate(`(() => {
        const e = document.querySelector(${JSON.stringify(selector)}), r = e.getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
        if (!e.contains(document.elementFromPoint(x, y))) throw Error('Occluded: ' + ${JSON.stringify(selector)});
        return { x, y };
      })()`)
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
    }
    const target = await send('Target.createTarget', { url: 'about:blank' })
    session = (await send('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId
    await send('Page.enable')
    await send('Runtime.enable')
    await send('Network.enable')
    await send('Network.setBypassServiceWorker', { bypass: true })
    await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
    await send('Page.addScriptToEvaluateOnNewDocument', { source: preload })
    await send('Page.navigate', { url: origin })
    await send('Page.bringToFront')
    await wait('!!document.querySelector(".home-brand") && !!window.__idleQA')
    await delay(2000)
    assert.equal(await evaluate('document.visibilityState'), 'visible', `${name}: foreground measurement`)
    assert.equal(await evaluate(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true)
    const requestStart = serverRequests.length
    await evaluate('window.__idleQA.reset(); true')
    console.log(`${name}: sampling foreground home idle for ${sampleMs / 1000}s`)
    await delay(sampleMs)
    const idle = await evaluate('window.__idleQA.snapshot()')
    idle.serverRequests = serverRequests.slice(requestStart).reduce((counts, request) => {
      if (request.path.startsWith('/api/')) counts[request.path] = (counts[request.path] ?? 0) + 1
      return counts
    }, {})
    assert.ok(idle.reactRenderers > 0, `${name}: React commit instrumentation attached`)
    let focus = null
    if (verifyFocus) {
      await click('.home-brand')
      await evaluate(`(() => { const e = [...document.querySelectorAll('#home-menu button')].find(e => e.textContent.trim() === '工作台'); if (!e) throw Error('No workbench entry'); e.dataset.qaWorkbench = 'true'; return true; })()`)
      await click('[data-qa-workbench]')
      await wait('document.querySelector(".workbench")?.dataset.active === "true"')
      await click(`.wb-task[data-task-id="${task.id}"]`)
      await wait(`document.querySelector('.wb-focus-primary-actions .wb-action')?.textContent === '开始专注'`)
      await click('.wb-focus-primary-actions .wb-action')
      await wait(`document.querySelector('.wb-focus-primary-actions .wb-action')?.textContent === '暂停'`)
      await delay(500)
      await evaluate('window.__idleQA.reset(); true')
      await delay(1100)
      const running = await evaluate('window.__idleQA.snapshot()')
      assert.ok((running.timeoutCallbacks['250'] ?? 0) >= 4, 'visible running focus still updates every 250ms')
      const remaining = () => evaluate(`Number(document.querySelector('.wb-clock').getAttribute('aria-label').match(/(\\d+) 秒/)[1])`)
      await evaluate(`window.__idleQA.visibility('hidden'); true`)
      await delay(100)
      const hiddenRemaining = await remaining()
      await evaluate('window.__idleQA.reset(); true')
      await delay(3600)
      const hidden = await evaluate('window.__idleQA.snapshot()')
      assert.equal(hidden.timeoutCallbacks['250'] ?? 0, 0, 'hidden focus has no 250ms timeout wakeups')
      assert.equal(hidden.intervalCallbacks['250'] ?? 0, 0, 'hidden focus has no legacy 250ms interval')
      assert.equal(await remaining(), hiddenRemaining, 'hidden focus UI does not redraw the countdown')
      await evaluate(`window.__idleQA.visibility('visible'); true`)
      await delay(150)
      const restoredRemaining = await remaining()
      assert.ok(hiddenRemaining - restoredRemaining >= 3 && hiddenRemaining - restoredRemaining <= 5, 'restoring visibility catches up to wall time immediately')
      await click('.wb-focus-primary-actions .wb-action')
      await wait(`document.querySelector('.wb-focus-primary-actions .wb-action')?.textContent === '继续专注'`)
      const pausedRemaining = await remaining()
      await delay(300)
      await evaluate('window.__idleQA.reset(); true')
      await delay(1500)
      const paused = await evaluate('window.__idleQA.snapshot()')
      assert.equal(paused.timeoutCallbacks['250'] ?? 0, 0, 'paused focus has no 250ms timeout wakeups')
      assert.equal(paused.intervalCallbacks['250'] ?? 0, 0, 'paused focus has no legacy 250ms interval')
      assert.equal(await remaining(), pausedRemaining, 'paused focus preserves remaining time')

      // Simulate OS suspension exceeding the deadline without a 35-minute wait.
      await click('.wb-focus-primary-actions .wb-action')
      await wait(`document.querySelector('.wb-focus-primary-actions .wb-action')?.textContent === '暂停'`)
      await evaluate(`window.__idleQA.visibility('hidden'); window.__idleQA.shiftClock(35 * 60_000); window.__idleQA.visibility('visible'); true`)
      await wait(`document.querySelector('.wb-focus-primary-actions .wb-action')?.textContent.startsWith('休息 ')`)
      const saved = await evaluate(`JSON.parse(localStorage.getItem('astaria-focus-v1')).tasks[${JSON.stringify(task.id)}]`)
      assert.equal(saved.phase, 'finished', 'suspended round completion is persisted')
      assert.equal(saved.elapsedMs, saved.durationMs, 'elapsed time caps at round duration')
      assert.equal(saved.spentMs, saved.durationMs, 'resume never double-counts focus time')
      await writeFile(join(artifacts, 'focus-finished.png'), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
      focus = { running, hidden, paused, hiddenRemaining, restoredRemaining, pausedRemaining, saved,
        visibilitySimulation: 'document.visibilityState/hidden override plus visibilitychange; native hidden throttling is not measured',
        deadlineSimulation: 'Date.now advanced 35 minutes while hidden, then visibility restored; real wall-clock wait not performed' }
    }
    assert.deepEqual(errors, [], `${name}: no uncaught renderer errors`)
    assert.deepEqual(externalRequests, [], `${name}: no attempted external application requests`)
    assert.equal(modelCalls, 0, `${name}: no model calls`)
    return { name, root, buildAssets, idle, focus, errors, externalRequests, modelCalls }
  } finally {
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
}

await mkdir(artifacts, { recursive: true })
const report = {
  passed: false, timestamp: new Date().toISOString(), sampleMs, settleMs: 2000,
  method: 'Same two synthetic tasks, new SQLite/profile per build, foreground home, reduced motion, 1440x1000, Chrome headless SwiftShader. Test-only preload counts interval/timeout callbacks, fetch requests and React root commits.',
  limitations: [
    'This measures business-work callback and request counts, not GPU load, battery use, watts or a power-saving percentage.',
    'Each build is measured once for 20 seconds after a 2-second settle. Boundary timing can shift low-frequency counts by one.',
    'Reduced motion isolates idle business work; it does not measure the cost or visual quality of normal black-hole/glass animation.',
    'Renderer only: Electron native window polling is not part of these samples.',
  ],
  builds: [],
}
try {
  await readFile(join(baseline, 'index.html'))
  await readFile(join(current, 'index.html'))
  report.builds.push(await runBuild('before', baseline))
  report.builds.push(await runBuild('after', current, true))
  report.passed = true
} catch (error) {
  report.error = error.stack ?? String(error)
  throw error
} finally {
  await writeFile(join(artifacts, 'result.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, builds: report.builds.map(({ name, idle }) => ({ name, idle })), result: join(artifacts, 'result.json') }))
}
