// Opt-in browser regression: SETTINGS_LAYOUT_UI=1 node --test scripts/settings-layout.test.mjs
// Production assets + the real local service, an in-memory database and an owned
// Chrome profile. No user database, credentials, existing browser or dev server.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('settings content flow, navigation, durable saves and routine editor', { skip: process.env.SETTINGS_LAYOUT_UI !== '1', timeout: 300_000 }, async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const temporary = await mkdtemp(join(tmpdir(), 'astaria-settings-layout-'))
  const output = resolve(process.env.SETTINGS_LAYOUT_OUTPUT ?? join(temporary, 'evidence'))
  await mkdir(output, { recursive: true })
  const [{ build, preview }, { createDatabase }, { createLocalService }, { DEFAULT_PREFERENCES }] = await Promise.all([
    import('vite'), import('../server/database.mjs'), import('../server/index.mjs'), import('../server/preferences.mjs'),
  ])
  const db = createDatabase(':memory:')
  db.setPreference('onboarding-completed', true)
  db.setPreference('app', { ...structuredClone(DEFAULT_PREFERENCES), render: { profile: 'full', quality: 'ultra', glass: 'auto' } })
  db.updatePlanner({ type: 'save-routine', routine: { id: 'layout-fixture', title: '实验记录与课程资料核对', kind: 'class', weekdays: [0,1,2,3,4,5,6], start: '09:00', end: '09:40', location: '科学楼 203', items: ['实验记录'], enabled: true } }, db.getPlanner().revision)
  const prohibited = () => { throw Error('UI fixture must never access credentials or external services') }
  const service = createLocalService({ db, dataDirectory: temporary, vault: { status: async () => false, read: prohibited }, compatibleVault: { status: async () => false, read: prohibited }, fetcher: prohibited, compatibleFetcher: prohibited, complete: prohibited })
  let server, chrome, ws, serial = 0, releaseSave, holdSave = false, failSave = false
  const pending = new Map(), errors = [], layouts = [], dialogs = [], blocked = [], motion = []
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++serial
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 20_000)
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const wait = async expression => {
    for (let i = 0; i < 200; i++) {
      try { if (await evaluate(expression)) return } catch (error) { if (!/context|navigated/i.test(error.message)) throw error }
      await delay(100)
    }
    throw Error(`Timed out: ${expression}`)
  }
  const point = async selector => {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`)
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`)
    return evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(e.disabled||e.closest('[inert]')||!e.contains(document.elementFromPoint(x,y)))throw Error('Blocked control: '+${JSON.stringify(selector)});return{x,y}})()`)
  }
  const click = async selector => {
    const position = await point(selector)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...position })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...position })
    await delay(100)
  }
  const key = async key => { const windowsVirtualKeyCode = { Escape:27, Tab:9, Enter:13 }[key]; await send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode }) }
  const choose = async (label, value, waitForSave = true) => {
    const selector = `.xixi-settings select[aria-label="${label}"]`
    await point(selector)
    await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.focus();e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}))})()`)
    if (waitForSave) await wait(`!document.querySelector(${JSON.stringify(selector)})?.disabled`)
  }
  const nav = async name => {
    if (await evaluate(`document.querySelector('.home-brand').getAttribute('aria-expanded')!=='true'`)) await click('.home-brand')
    await evaluate(`(()=>{const e=[...document.querySelectorAll('#home-menu button')].find(e=>e.textContent.trim()===${JSON.stringify(name)});if(!e)throw Error('Missing menu item');e.dataset.layoutNav='true'})()`)
    await click('[data-layout-nav]')
    await evaluate(`document.querySelectorAll('[data-layout-nav]').forEach(e=>delete e.dataset.layoutNav)`)
    await delay(350)
  }
  const tab = async () => {
    await wait(`!!document.querySelector('.xixi-settings-tabs')`)
    await evaluate(`(()=>{const e=[...document.querySelectorAll('.xixi-settings-tabs button')].find(e=>e.textContent==='外观与动画');e.dataset.layoutTab='true'})()`)
    await click('[data-layout-tab]')
    await wait(`!!document.querySelector('.xixi-settings select[aria-label="特效强度"]:not(:disabled)')`)
    await delay(250)
  }
  const viewport = async (width, height) => { await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); await delay(150) }
  const shot = async name => writeFile(join(output, `${name}.png`), Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'))
  try {
    await build({ root, envDir: false, configFile: join(root, 'vite.config.ts'), mode: 'design-preview', logLevel: 'warn', build: { outDir: join(temporary, 'dist'), emptyOutDir: true } })
    server = await preview({ root, configFile: false, logLevel: 'warn', build: { outDir: join(temporary, 'dist') }, preview: { host: '127.0.0.1', port: 0, open: false }, plugins: [{ name: 'isolated-settings-service', configurePreviewServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (req.url === '/api/preferences' && req.method === 'POST') {
          if (holdSave) { holdSave = false; await new Promise(resolve => { releaseSave = resolve }) }
          if (failSave) { failSave = false; res.statusCode = 503; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ error: '本次保存未完成，请重试' })); return }
        }
        service.middleware(req, res, next)
      })
    } }] })
    const base = `http://127.0.0.1:${server.httpServer.address().port}`
    const profile = join(temporary, 'chrome')
    chrome = spawn(process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1440,1000', 'about:blank'], { stdio: 'ignore' })
    let port
    for (let i = 0; i < 100; i++) { try { port = Number((await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break } catch { await delay(100) } }
    assert.ok(port, 'owned Chrome started')
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    ws = new WebSocket(targets.find(target => target.type === 'page').webSocketDebuggerUrl)
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
    ws.onmessage = event => {
      const message = JSON.parse(event.data)
      if (message.id) { const request = pending.get(message.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); message.error ? request.reject(Error(JSON.stringify(message.error))) : request.resolve(message.result) }
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params
        const allowed = request.url.startsWith(base + '/') || /^(data:|blob:|about:)/.test(request.url)
        if (!allowed) blocked.push(request.url)
        void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' })
      }
    }
    await send('Runtime.enable'); await send('Page.enable'); await send('Fetch.enable', { patterns: [{ urlPattern: '*' }] })
    await viewport(1440, 1000)
    await send('Page.navigate', { url: base })
    await wait(`!!document.querySelector('.home-brand')`)
    await nav('设置'); await tab()
    assert.equal(await evaluate(`document.querySelectorAll('.xixi-settings-page-header button').length`), 0, 'no redundant header return')
    const geometry = () => evaluate(`(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right}},panel=document.querySelector('.xixi-appearance-response'),rows=[...panel.querySelectorAll('.xixi-appearance-response-controls>.xixi-setting-row')].map(rect);return{viewport:innerWidth,panel:rect(panel),rows,gaps:rows.slice(1).map((r,i)=>r.y-rows[i].bottom),overflow:[...document.querySelectorAll('.xixi-appearance-columns select,.xixi-appearance-columns button,.xixi-appearance-columns strong')].filter(e=>{const r=rect(e);return r.x<0||r.right>innerWidth}).map(e=>e.textContent),pageOverflow:document.documentElement.scrollWidth>innerWidth}})()`)
    for (const density of ['compact', 'comfortable']) for (const theme of ['dark', 'light']) for (const glass of ['clear', 'soft']) {
      await choose('界面外观', theme); await choose('玻璃质感', glass); await choose('信息密度', density)
      const widths = density === 'compact' ? [[1440,1000],[900,768],[390,844],[320,760]] : [[1440,1000],[320,760]]
      for (const [width,height] of widths) {
        await viewport(width,height)
        await evaluate(`document.querySelector('.xixi-appearance-response').scrollIntoView({block:'center'})`)
        await delay(150)
        const layout = { density, theme, glass, ...(await geometry()) }
        assert.equal(layout.rows.length, 3)
        assert.ok(layout.gaps.every(gap => gap >= -1 && gap <= 2), `rows follow their contents: ${JSON.stringify(layout)}`)
        assert.deepEqual(layout.overflow, [], 'controls stay within narrow viewport')
        assert.equal(layout.pageOverflow, false)
        layouts.push(layout); await shot(`settings-${density}-${theme}-${glass}-${width}`)
      }
    }
    await viewport(1440,1000)
    const beforeRender = structuredClone(db.getPreference('app').render)
    holdSave = true
    await choose('特效强度', 'vivid', false)
    await wait(`document.querySelector('[aria-label="特效强度"]').disabled`)
    for (let i=0;i<50 && !releaseSave;i++) await delay(20)
    assert.ok(releaseSave)
    await key('Escape')
    assert.equal(await evaluate(`!!document.querySelector('.xixi-settings')`), true, 'Escape cannot discard a pending save')
    releaseSave(); releaseSave = undefined
    await wait(`!document.querySelector('[aria-label="特效强度"]').disabled`)
    assert.equal(db.getPreference('app').effect.intensity, 'vivid', 'real service committed intensity')
    assert.deepEqual(db.getPreference('app').render, beforeRender, 'quality and FPS stay intact')
    await click('.xixi-settings [role=switch][aria-label="思考时显示数字"]')
    await wait(`!document.querySelector('[aria-label="思考时显示数字"]').disabled`)
    assert.equal(db.getPreference('app').effect.binary.enabled,false,'binary switch commits through real service')
    failSave = true; await choose('动态偏好', 'reduced')
    assert.equal(db.getPreference('app').effect.motion, 'system', 'failed save is not reported as saved')
    await wait(`document.querySelector('.xixi-settings-feedback').textContent.includes('本次保存未完成')`)
    await shot('settings-save-error')
    await key('Escape'); await wait(`!document.querySelector('.xixi-settings')`)
    await nav('设置'); await tab()
    assert.equal(await evaluate(`document.querySelector('[aria-label="特效强度"]').value`), 'vivid', 'reopening reads saved preferences')
    await key('Escape'); await wait(`!document.querySelector('.xixi-settings')`)
    await nav('日程')
    const openRoutine = async () => {
      await click('.pl-header-actions [aria-label="每周安排"]')
      await wait(`!!document.querySelector('.pl-routine-entry:not(:disabled)')`)
      await evaluate(`(()=>{const e=[...document.querySelectorAll('.pl-routine-entry')].find(e=>e.textContent.includes('实验记录与课程资料核对'));e.dataset.layoutEdit='true'})()`)
      await click('[data-layout-edit]'); await wait(`!!document.querySelector('.pl-routine-editor[open]')`); await delay(250)
    }
    await openRoutine()
    for (const theme of ['dark','light']) for (const glass of ['clear','soft']) {
      db.setPreference('app', { ...db.getPreference('app'), theme, glass })
      // Reload the real entry so all consumers obtain the same saved preference.
      await send('Page.reload'); await wait(`!!document.querySelector('.home-brand')`); await nav('日程'); await openRoutine()
      for (const [width,height] of [[1440,1000],[390,844],[320,760]]) {
        await viewport(width,height)
        const info = await evaluate(`(()=>{const d=document.querySelector('.pl-routine-editor'),r=d.getBoundingClientRect(),b=d.querySelector('.pl-dialog-body'),labels=[...d.querySelectorAll('.pl-routine-fields>label')].slice(0,2).map(e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width}});return{width:r.width,height:r.height,x:r.x,y:r.y,bodyOverflow:b.scrollWidth>b.clientWidth,labels,underlay:getComputedStyle(document.querySelector('.planner>.pl-scroll')).visibility,background:getComputedStyle(d).backgroundColor,filter:d.querySelector('.home-glass-surface').style.backdropFilter,theme:d.dataset.theme,glass:d.dataset.glass}})()`)
        assert.equal(info.width, width>700 ? 720 : width)
        if (width<=700) assert.equal(info.height,height)
        assert.equal(info.bodyOverflow,false)
        assert.equal(info.theme,theme)
        assert.equal(info.glass,glass)
        assert.equal(info.underlay,'hidden','no page text in glass sampling')
        assert.equal(info.background,'rgba(0, 0, 0, 0)','outer dialog has no opaque board')
        if (width>700) assert.equal(info.labels[0].y,info.labels[1].y,'related fields share a desktop row')
        dialogs.push({theme,glass,viewport:width,...info}); await shot(`routine-${theme}-${glass}-${width}`)
      }
    }
    await viewport(1440,1000)
    // Inspect actual authored keyframes at controlled times, then play them and
    // measure live RAF samples. Screenshot review remains a separate step.
    for (const time of [0,80,200]) {
      await evaluate(`document.querySelectorAll('.pl-routine-editor>.pl-dialog-header,.pl-routine-editor>.pl-dialog-body').forEach(e=>e.getAnimations().forEach(a=>{a.pause();a.currentTime=${time}}))`)
      await shot(`routine-entry-${time}ms`)
    }
    motion.push(await evaluate(`new Promise(resolve=>{const d=document.querySelector('.pl-routine-editor'),samples=[],start=performance.now();d.querySelectorAll(':scope>.pl-dialog-header,:scope>.pl-dialog-body').forEach(e=>e.getAnimations().forEach(a=>{a.currentTime=0;a.play()}));const sample=now=>{const r=d.getBoundingClientRect();samples.push({at:now-start,width:r.width,height:r.height,opacity:getComputedStyle(d.querySelector('.pl-dialog-body')).opacity});now-start<260?requestAnimationFrame(sample):resolve(samples)};requestAnimationFrame(sample)})`))
    assert.ok(Math.max(...motion[0].map(s=>s.width))-Math.min(...motion[0].map(s=>s.width))<1,'entry never scales dialog width')
    assert.ok(Math.max(...motion[0].map(s=>s.height))-Math.min(...motion[0].map(s=>s.height))<1,'entry never expands dialog height')
    await key('Tab')
    assert.equal(await evaluate(`!!document.activeElement.closest('.pl-routine-editor')`),true,'native modal keeps keyboard focus inside')
    const input = async (selector,value) => {
      await point(selector)
      await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    }
    const revision = db.getPlanner().revision
    await input('.pl-routine-fields>label:first-child input','')
    await click('.pl-routine-editor button[type=submit]')
    assert.equal(db.getPlanner().revision,revision,'required name cannot save an empty routine')
    assert.equal(await evaluate(`document.querySelector('.pl-routine-fields>label:first-child input').validity.valueMissing`),true)
    await input('.pl-routine-fields>label:first-child input','实验记录与课程资料核对')
    await input('.pl-routine-fields>.pl-form-pair:first-of-type label:last-child input','08:00')
    await click('.pl-routine-editor button[type=submit]')
    await wait(`!!document.querySelector('.pl-routine-editor .pl-error')`)
    assert.equal(db.getPlanner().revision,revision,'server rejects invalid end time without saving')
    await shot('routine-validation-error')
    await input('.pl-routine-fields>.pl-form-pair:first-of-type label:last-child input','09:40')
    await point('.pl-routine-fields>label:first-child input')
    await evaluate(`(()=>{const e=document.querySelector('.pl-routine-fields>label:first-child input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'实验记录核对 · 已更新');e.dispatchEvent(new Event('input',{bubbles:true}))})()`)
    await click('.pl-routine-editor button[type=submit]')
    await wait(`!document.querySelector('.pl-routine-editor')`)
    assert.equal(db.getPlanner().routines.find(r=>r.id==='layout-fixture').title,'实验记录核对 · 已更新','routine uses the real validated save')
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.planner>.pl-scroll')).visibility`),'visible','closing restores foreground')
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
    await click('.pl-header-actions [aria-label="每周安排"]'); await delay(100)
    assert.equal(await evaluate(`document.querySelector('.pl-dialog').getAnimations({subtree:true}).some(a=>a.playState==='running'&&a.effect.getTiming().duration>1)`),false,'reduced motion skips travel animation')
    await key('Escape'); await wait(`!document.querySelector('.pl-dialog[open]')`)
    await delay(100)
    const focusState = await evaluate(`(()=>{const opener=document.querySelector('.pl-header-actions [aria-label="每周安排"]');return{active:document.activeElement?.outerHTML.slice(0,500),label:document.activeElement?.getAttribute('aria-label'),visibility:getComputedStyle(opener).visibility,inert:!!opener.closest('[inert]'),modal:document.querySelector('.planner').dataset.modalOpen}})()`)
    assert.equal(focusState.label,'每周安排',`Escape restores opener focus: ${JSON.stringify(focusState)}`)
    assert.deepEqual(errors,[], 'no runtime exceptions')
    await rm(join(output,'failure.json'),{force:true})
    await rm(join(output,'failure.png'),{force:true})
    await writeFile(join(output,'report.json'),JSON.stringify({base,layouts,dialogs,motion,errors,blocked,checks:['real preference and binary switch persistence','pending save blocks Escape','failed save preserves stored value','Escape close and opener focus','real routine save and validation','stable entry geometry and reduced motion','quality/FPS unchanged']},null,2))
    console.log(`UI evidence: ${output}`)
  } catch (error) {
    if (ws?.readyState === WebSocket.OPEN) await shot('failure').catch(()=>{})
    await writeFile(join(output,'failure.json'),JSON.stringify({error:String(error),layouts,dialogs,errors},null,2))
    throw error
  } finally {
    releaseSave?.()
    ws?.close()
    if (chrome) { chrome.kill('SIGTERM'); await new Promise(resolve=>{ chrome.once('exit',resolve); setTimeout(resolve,2000).unref() }) }
    await new Promise(resolve => server ? server.httpServer.close(resolve) : resolve())
    await service.whenIdle(); service.close()
    await rm(join(temporary,'dist'),{recursive:true,force:true})
    await rm(join(temporary,'chrome'),{recursive:true,force:true})
    console.log(`Screenshots require visual review: ${output}`)
  }
})
