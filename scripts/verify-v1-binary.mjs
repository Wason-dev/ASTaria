#!/usr/bin/env node
/** Offline GPU acceptance: one production renderer, frozen inputs, scalar-only A/B. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(process.env.BINARY_QA_OUTPUT ?? join(root, 'artifacts/v1-binary'))
const temporary = await mkdtemp(join(tmpdir(), 'astaria-v1-binary-'))
const width = 1400, height = 960, fixedTime = 42
const baseline = '.00052', candidate = '.00070'
const protectedFiles = ['src/prototype/shaders.ts', 'src/prototype/BlackHoleRenderer.ts', 'src/prototype/postprocessing.ts', 'src/prototype/renderProfile.ts', 'src/prototype/responseEffects.ts']
const hashes = async () => Object.fromEntries(await Promise.all(protectedFiles.map(async file => [file, createHash('sha256').update(await readFile(join(root, file))).digest('hex')])) )
const beforeHashes = await hashes()
const errors = [], blockedRequests = [], cases = [], checks = []
let vite, chrome, base, stopping = false, serial = 0, received = ''
const pending = new Map()
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++serial
  const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)) }, 30000)
  pending.set(id, { resolve, reject, timeout })
  chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0')
})
let session
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session)
  if (result.exceptionDetails) throw Error(JSON.stringify(result.exceptionDetails))
  return result.result.value
}

// This function is served only by the isolated harness, never the app entry.
function browserHarness(BlackHoleRenderer, options) {
  const fail = (condition, message) => { if (!condition) throw Error(message) }
  const renderer = new BlackHoleRenderer(document.querySelector('#scene'), undefined, message => window.qaErrors.push(message))
  renderer.setRenderProfile('full', 'home', 'ultra')
  renderer.setPaused(true)
  renderer.cancelFrame()
  renderer.resizeObserver.disconnect()
  const gpu = renderer.renderer, material = renderer.material, uniforms = material.uniforms, gl = gpu.getContext()
  const originalShader = material.fragmentShader
  const declaration = /float brightness = \.00070;/g
  fail(originalShader.match(declaration)?.length === 1, 'Expected one candidate binaryInterior brightness declaration')
  fail(originalShader.indexOf('float brightness = .00070;') > originalShader.indexOf('vec3 binaryInterior('), 'Brightness is outside binaryInterior')
  const sourceA = originalShader.replace(declaration, `float brightness = ${options.baseline};`)
  const sourceB = originalShader
  const neutralSource = shader => shader.replace(/float brightness = \.\d+;/, 'float brightness = QA_SCALAR;')
  fail(neutralSource(sourceA) === neutralSource(sourceB), 'A/B differs beyond the brightness scalar')
  gpu.debug.checkShaderErrors = true
  gpu.debug.onShaderError = (context, program, vertex, fragment) => window.qaErrors.push({
    type: 'shader', program: context.getProgramInfoLog(program), vertex: context.getShaderInfoLog(vertex), fragment: context.getShaderInfoLog(fragment),
  })
  renderer.renderStars()
  uniforms.uTime.value = options.fixedTime
  renderer.simulationTime = options.fixedTime
  const resolution = uniforms.uResolution.value
  fail(resolution.x === options.width && resolution.y === options.height, 'Unexpected drawing buffer dimensions')
  const extension = gl.getExtension('WEBGL_debug_renderer_info')
  const context = {
    renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    vendor: extension ? gl.getParameter(extension.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
    version: gl.getParameter(gl.VERSION), shadingLanguage: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
    preserveDrawingBuffer: gl.getContextAttributes().preserveDrawingBuffer, devicePixelRatio: devicePixelRatio,
    width: resolution.x, height: resolution.y,
  }
  const pixels = options.width * options.height
  const png = (bytes, crop) => {
    const canvas = document.createElement('canvas'), area = crop ?? { x: 0, y: 0, width: options.width, height: options.height }
    canvas.width = area.width; canvas.height = area.height
    const context = canvas.getContext('2d'), image = context.createImageData(area.width, area.height)
    for (let y = 0; y < area.height; y++) {
      const start = ((options.height - 1 - area.y - y) * options.width + area.x) * 4
      image.data.set(bytes.subarray(start, start + area.width * 4), y * area.width * 4)
    }
    context.putImageData(image, 0, 0)
    return canvas.toDataURL('image/png').split(',')[1]
  }
  const uniformState = () => Object.fromEntries(Object.entries(uniforms).map(([key, { value }]) => [key,
    value?.isTexture ? { uuid: value.uuid } : value?.toArray ? value.toArray() : value,
  ]))
  const invariantState = () => ({
    uniforms: uniformState(), renderer: gpu.uuid ?? renderer.geometry.uuid, geometry: renderer.geometry.uuid,
    material: material.uuid, scene: renderer.scene.uuid, camera: renderer.camera.uuid,
    sceneTarget: renderer.sceneTarget.texture.uuid, starTarget: renderer.target.texture.uuid,
    quality: renderer.quality, requestedQuality: renderer.requestedQuality, targetFps: renderer.targetFps,
    time: renderer.simulationTime, pointer: renderer.pointer.toArray(), pointerStrength: renderer.pointerStrength,
    toneMapping: gpu.toneMapping, exposure: gpu.toneMappingExposure, outputColorSpace: gpu.outputColorSpace,
    bloomShaders: [renderer.bloom.prefilter.fragmentShader, renderer.bloom.blur.fragmentShader, renderer.bloom.composite.fragmentShader],
  })
  const capture = (shader, enabled = 1) => {
    material.fragmentShader = shader
    material.needsUpdate = true
    uniforms.uBinaryEnabled.value = enabled
    gpu.setRenderTarget(renderer.sceneTarget)
    gpu.render(renderer.scene, renderer.camera)
    renderer.bloom.render(renderer.sceneTarget.texture, renderer.night, renderer.pointer, renderer.pointerStrength)
    // preserveDrawingBuffer=false: read before yielding to CDP or another task.
    const screen = new Uint8Array(pixels * 4)
    gl.readPixels(0, 0, options.width, options.height, gl.RGBA, gl.UNSIGNED_BYTE, screen)
    const raw = new Uint8Array(pixels * 4)
    gpu.readRenderTargetPixels(renderer.sceneTarget, 0, 0, options.width, options.height, raw)
    const error = gl.getError()
    fail(error === gl.NO_ERROR, `WebGL error ${error}`)
    fail(!gl.isContextLost(), 'WebGL context lost')
    for (const program of gpu.info.programs) {
      fail(gl.getProgramParameter(program.program, gl.LINK_STATUS), gl.getProgramInfoLog(program.program))
      fail(program.diagnostics?.runnable !== false, 'Shader diagnostics marked a program unrunnable')
    }
    return { raw, screen }
  }
  const same = (a, b) => a.every((value, index) => value === b[index])
  const intensityValue = { gentle: .42, standard: .7, vivid: 1 }
  const summarize = (a, b, off, spatial) => {
    const regions = Object.fromEntries(['all', 'shadow', 'outsideShadow', 'brightDisk', 'darkGlyphs', 'neutralCore'].map(name => [name, {
      pixels: 0, changedPixels: 0, sumBefore: [0, 0, 0], sumAfter: [0, 0, 0], sumDelta: [0, 0, 0], sumAbs: [0, 0, 0], maxIncrease: [0, 0, 0], maxDecrease: [0, 0, 0], maxAfter: [0, 0, 0],
    }]))
    let neutralDeltaSpread = 0, neutralBeforeSpread = 0, neutralAfterSpread = 0, darkAfterSpread = 0, minRadius = Infinity, maxRadius = 0
    const diff = new Uint8Array(a.length)
    for (let index = 0; index < pixels; index++) {
      const offset = index * 4, x = index % options.width, y = Math.floor(index / options.width)
      const radius = Math.hypot(((x + .5) / options.width - spatial.center[0]) * spatial.aspect * spatial.scale, ((y + .5) / options.height - spatial.center[1]) * spatial.scale) / spatial.radius
      const changed = [0, 1, 2].some(channel => a[offset + channel] !== b[offset + channel])
      const dark = radius < .99 && Math.max(...off.subarray(offset, offset + 3)) <= 8
      // Disk/halo warmth already exists in the no-digit control. Check neutral emission on
      // all dark glyph changes; check absolute neutrality only where A was neutral too.
      const beforeValues = a.subarray(offset, offset + 3)
      const beforeSpread = Math.max(...beforeValues) - Math.min(...beforeValues)
      const neutral = dark && changed && beforeSpread <= 1
      const brightDisk = radius < 1 && Math.max(...off.subarray(offset, offset + 3)) >= 64
      const names = ['all', radius < 1 ? 'shadow' : 'outsideShadow', ...(brightDisk ? ['brightDisk'] : []), ...(dark && changed ? ['darkGlyphs'] : []), ...(neutral ? ['neutralCore'] : [])]
      if (changed) { minRadius = Math.min(minRadius, radius); maxRadius = Math.max(maxRadius, radius) }
      for (const name of names) {
        const region = regions[name]; region.pixels++; if (changed) region.changedPixels++
        for (let channel = 0; channel < 3; channel++) {
          const before = a[offset + channel], after = b[offset + channel], delta = after - before
          region.sumBefore[channel] += before; region.sumAfter[channel] += after
          region.sumDelta[channel] += delta; region.sumAbs[channel] += Math.abs(delta)
          region.maxIncrease[channel] = Math.max(region.maxIncrease[channel], delta)
          region.maxDecrease[channel] = Math.max(region.maxDecrease[channel], -delta)
          region.maxAfter[channel] = Math.max(region.maxAfter[channel], after)
        }
      }
      if (dark && changed) {
        const deltas = [0, 1, 2].map(channel => b[offset + channel] - a[offset + channel])
        const values = [0, 1, 2].map(channel => b[offset + channel])
        neutralDeltaSpread = Math.max(neutralDeltaSpread, Math.max(...deltas) - Math.min(...deltas))
        darkAfterSpread = Math.max(darkAfterSpread, Math.max(...values) - Math.min(...values))
        if (neutral) {
          neutralBeforeSpread = Math.max(neutralBeforeSpread, beforeSpread)
          neutralAfterSpread = Math.max(neutralAfterSpread, Math.max(...values) - Math.min(...values))
        }
      }
      for (let channel = 0; channel < 3; channel++) diff[offset + channel] = Math.min(255, Math.abs(b[offset + channel] - a[offset + channel]) * 32)
      diff[offset + 3] = 255
      fail(a[offset + 3] === b[offset + 3] && b[offset + 3] === 255, 'Alpha changed or an empty GPU buffer was read')
    }
    for (const region of Object.values(regions)) {
      region.changedFraction = region.changedPixels / Math.max(1, region.pixels)
      for (const [name, sum] of [['meanBefore', 'sumBefore'], ['meanAfter', 'sumAfter'], ['meanDelta', 'sumDelta'], ['meanAbsoluteDelta', 'sumAbs']]) region[name] = region[sum].map(value => value / Math.max(1, region.pixels))
      for (const sum of ['sumBefore', 'sumAfter', 'sumDelta', 'sumAbs']) delete region[sum]
    }
    return { regions, neutralDeltaSpread, neutralBeforeSpread, neutralAfterSpread, darkAfterSpread, changedRadius: [Number.isFinite(minRadius) ? minRadius : null, maxRadius], diff }
  }
  const run = (theme, intensity) => {
    renderer.setNight(theme === 'dark' ? 1 : 0, true)
    renderer.setResponseEffect({ style: 'tide', intensity, motion: 'full' })
    renderer.setResponsePhase('thinking')
    renderer.syncResponseEffect(0)
    renderer.cancelFrame()
    uniforms.uTime.value = options.fixedTime
    fail(uniforms.uBinaryEnabled.value === 1, 'Thinking digits must be fully enabled')
    fail(uniforms.uBinaryBrightness.value === intensityValue[intensity], 'Intensity mapping changed')
    const frozen = JSON.stringify(invariantState())
    const oldOff = capture(sourceA, 0), newOff = capture(sourceB, 0)
    fail(same(oldOff.raw, newOff.raw) && same(oldOff.screen, newOff.screen), 'Brightness altered the scene with digits disabled')
    const old = capture(sourceA), next = capture(sourceB), repeat = capture(sourceA)
    fail(same(old.raw, repeat.raw) && same(old.screen, repeat.screen), 'A/B/A pixels drifted')
    fail(JSON.stringify(invariantState()) === frozen, 'Geometry/time/theme/intensity/quality/pointer/bloom changed during A/B')
    const aspect = options.width / options.height, scale = (aspect < .8 ? 13.8 : 10.2) / uniforms.uZoom.value
    const distance = uniforms.uFlightCameraRadius.value
    const sine = uniforms.uCriticalImpact.value * Math.sqrt(1 - 1 / distance) / distance
    const spatial = { aspect, scale, center: uniforms.uCenter.value.toArray(), radius: 30 * sine / Math.sqrt(1 - sine * sine) }
    const raw = summarize(old.raw, next.raw, oldOff.raw, spatial), screen = summarize(old.screen, next.screen, oldOff.screen, spatial)
    const crop = { x: Math.max(0, Math.floor(spatial.center[0] * options.width - spatial.radius / scale * options.height)), y: Math.max(0, Math.floor((1 - spatial.center[1]) * options.height - spatial.radius / scale * options.height)), width: Math.ceil(2 * spatial.radius / scale * options.height), height: Math.ceil(2 * spatial.radius / scale * options.height) }
    const artifacts = { old: png(old.screen), new: png(next.screen), diff32: png(screen.diff), 'old-shadow': png(old.screen, crop), 'new-shadow': png(next.screen, crop), 'diff32-shadow': png(screen.diff, crop) }
    delete raw.diff; delete screen.diff
    const state = invariantState(); delete state.bloomShaders
    return { theme, intensity, raw, screen, state, spatial, crop, artifacts, offControlExact: true, repeatExact: true, scalarOnly: true, linkedPrograms: gpu.info.programs.length }
  }
  return { run, context, dispose: () => { material.fragmentShader = originalShader; material.needsUpdate = true; renderer.dispose() } }
}

try {
  await mkdir(output, { recursive: true })
  const entry = `<!doctype html><meta charset="utf-8"><style>body{margin:0}#scene{width:${width}px;height:${height}px}</style><div id="scene"></div><script type="module">
    import {BlackHoleRenderer} from '/src/prototype/BlackHoleRenderer.ts';
    window.qaErrors=[];
    try { window.binaryQA=(${browserHarness.toString()})(BlackHoleRenderer,${JSON.stringify({ width, height, fixedTime, baseline, candidate })}); }
    catch(error){window.qaErrors.push(error.stack);window.qaFailed=true;}
  </script>`
  vite = await createServer({ configFile: false, root, cacheDir: join(temporary, 'vite-cache'), logLevel: 'error',
    server: { host: '127.0.0.1', port: 0, open: false, hmr: false },
    plugins: [{ name: 'isolated-binary-qa', configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url?.split('?')[0] !== '/__v1-binary.html') return next()
      response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(entry)
    }) } }],
  })
  await vite.listen(); base = `http://127.0.0.1:${vite.httpServer.address().port}`
  chrome = spawn(process.env.CHROME_BINARY ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${join(temporary, 'chrome-profile')}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--disable-default-apps', '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  chrome.on('error', error => errors.push(error.message))
  chrome.stdio[4].on('data', chunk => {
    received += chunk
    let end
    while ((end = received.indexOf('\0')) !== -1) {
      const message = JSON.parse(received.slice(0, end)); received = received.slice(end + 1)
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails)
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map(arg => arg.value ?? arg.description))
      if (message.method === 'Fetch.requestPaused') {
        const { requestId, request } = message.params, allowed = new URL(request.url).origin === base
        if (!allowed) blockedRequests.push(request.url)
        void send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', allowed ? { requestId } : { requestId, errorReason: 'BlockedByClient' }, session).catch(error => { if (!stopping) errors.push(error.message) })
      }
      if (message.id && pending.has(message.id)) {
        const callback = pending.get(message.id); pending.delete(message.id); clearTimeout(callback.timeout)
        message.error ? callback.reject(Error(JSON.stringify(message.error))) : callback.resolve(message.result)
      }
    }
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  session = (await send('Target.attachToTarget', { targetId, flatten: true })).sessionId
  await send('Runtime.enable', {}, session); await send('Page.enable', {}, session)
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, session)
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session)
  await send('Page.navigate', { url: `${base}/__v1-binary.html` }, session)
  let ready = false
  for (let index = 0; index < 200; index++) {
    if (await evaluate('Boolean(window.qaFailed)')) throw Error(JSON.stringify(await evaluate('window.qaErrors')))
    if (await evaluate('Boolean(window.binaryQA)')) { ready = true; break }
    if (chrome.exitCode !== null) throw Error(`Chrome exited ${chrome.exitCode}`)
    await delay(100)
  }
  assert.ok(ready, 'GPU harness loaded')
  const context = await evaluate('window.binaryQA.context')
  const limits = { maxChannelIncrease: 4, maxChannelDecrease: 0, meanAbsoluteChannelDelta: .1, changedCanvasFraction: .04, unchangedOutsideShadow: 0, brightDiskMeanAbsoluteDelta: .005, brightDiskMaxChannelDelta: 1, darkGlyphMaxChannel: 32, neutralChannelSpread: 2 }
  for (const theme of ['light', 'dark']) for (const intensity of ['gentle', 'standard', 'vivid']) {
    const result = await evaluate(`window.binaryQA.run(${JSON.stringify(theme)},${JSON.stringify(intensity)})`)
    for (const [name, encoded] of Object.entries(result.artifacts)) await writeFile(join(output, `${theme}-${intensity}-${name}.png`), Buffer.from(encoded, 'base64'))
    delete result.artifacts
    cases.push(result)
    for (const [stage, data] of [['sceneTarget', result.raw], ['screen', result.screen]]) {
      const { all, outsideShadow, brightDisk, darkGlyphs, neutralCore } = data.regions, prefix = `${theme}/${intensity}/${stage}`
      assert.ok(all.changedPixels > 0, `${prefix}: glyphs visibly changed`)
      assert.ok(all.changedFraction <= limits.changedCanvasFraction, `${prefix}: change stayed local`)
      assert.ok(all.maxIncrease.every(value => value <= limits.maxChannelIncrease), `${prefix}: maximum increase is bounded`)
      assert.ok(all.maxDecrease.every(value => value <= limits.maxChannelDecrease), `${prefix}: pixels did not darken`)
      assert.ok(all.meanAbsoluteDelta.every(value => value <= limits.meanAbsoluteChannelDelta), `${prefix}: average increase is bounded`)
      assert.equal(outsideShadow.changedPixels, limits.unchangedOutsideShadow, `${prefix}: sky and exterior disk unchanged`)
      assert.ok(brightDisk.pixels > 0 && brightDisk.meanAbsoluteDelta.every(value => value <= limits.brightDiskMeanAbsoluteDelta) && brightDisk.maxIncrease.every(value => value <= limits.brightDiskMaxChannelDelta), `${prefix}: bright disk exposure retained`)
      assert.ok(darkGlyphs.pixels > 0 && darkGlyphs.maxAfter.every(value => value <= limits.darkGlyphMaxChannel), `${prefix}: digits stay near black`)
      assert.ok(neutralCore.pixels > 0 && data.neutralDeltaSpread <= limits.neutralChannelSpread && data.neutralAfterSpread <= limits.neutralChannelSpread, `${prefix}: near-black digits stay neutral`)
    }
    assert.equal(result.state.quality, 'ultra'); assert.equal(result.state.requestedQuality, 'ultra')
    assert.equal(result.state.targetFps, 60); assert.equal(result.state.time, fixedTime)
    checks.push(`${theme}/${intensity}: scalar-only A/B, exact A/B/A and binary-off controls, bounded neutral glyph pixels, exterior/exposure preserved`)
    console.log(`PASS ${theme}/${intensity}: ${result.screen.regions.all.changedPixels} changed pixels, max RGB +${Math.max(...result.screen.regions.all.maxIncrease)}, mean ${result.screen.regions.all.meanAbsoluteDelta.map(value => value.toFixed(6)).join('/')}`)
  }
  const shaderErrors = await evaluate('window.qaErrors')
  assert.deepEqual(shaderErrors, []); assert.deepEqual(errors, []); assert.deepEqual(blockedRequests, [])
  const afterHashes = await hashes(); assert.deepEqual(afterHashes, beforeHashes, 'Product shaders/renderer/frame budgets unchanged on disk')
  const report = { status: 'passed', checks, baseline, candidate, width, height, fixedTime, limits, context, cases, shaderErrors, errors, blockedRequests, beforeHashes, afterHashes,
    measurement: 'All channel statistics use 8-bit units (0–255). Shadow is the production projected critical-impact silhouette. brightDisk selects no-digit RGB max >=64 inside that silhouette; exterior disk and sky must be byte-identical. darkGlyphs selects changed pixels with no-digit RGB max <=8 and radius <.99. neutralDeltaSpread checks added RGB light on every dark glyph; neutralCore requires A channel spread <=1 and its B spread must remain <=2, so inherited warm disk/bloom pixels cannot masquerade as tinted emission. darkAfterSpread retains their unfiltered measurement.',
    capture: 'Production sceneTarget and bloom pipeline, immediate WebGL readPixels plus readRenderTargetPixels, PNGs encode those exact bytes; diff32 is 32× absolute pixel difference.',
    controls: 'Same BlackHoleRenderer/material/geometry/star atlas; time, theme, intensity, quality, pointer and postprocessing fixed within each pair. Only fragmentShader brightness differs, with needsUpdate. Binary-off A/B and A/B/A repeat must match exactly.',
    isolation: 'Owned temporary Chrome profile; constructor-only harness; no application/user database, credentials or external service. Mac Chrome GPU visual QA; no native Windows or frame-rate conclusion.',
  }
  await writeFile(join(output, 'results.json'), JSON.stringify(report, null, 2))
  await rm(join(output, 'failure.json'), { force: true })
  console.log(`PASS V1 binary GPU QA: ${checks.length} theme/intensity pairs (${output})`)
} catch (error) {
  await writeFile(join(output, 'failure.json'), JSON.stringify({ message: error.message, cases, checks, errors, blockedRequests, beforeHashes }, null, 2)).catch(() => {})
  throw error
} finally {
  stopping = true
  if (session) await evaluate('window.binaryQA?.dispose(); true').catch(() => {})
  for (const callback of pending.values()) { clearTimeout(callback.timeout); callback.reject(Error('QA closed')) }
  pending.clear()
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM')
    await Promise.race([new Promise(resolve => chrome.once('exit', resolve)), delay(3000)])
    if (chrome.exitCode === null) chrome.kill('SIGKILL')
  }
  await vite?.close(); await rm(temporary, { recursive: true, force: true })
}
