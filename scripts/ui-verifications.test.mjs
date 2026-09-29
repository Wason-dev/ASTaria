/**
 * run-ui-verifications.mjs 的单元测试：纯函数与进程行为用临时目录 fixture，另有一组
 * 「白名单/工作流不变量」用例读取真实仓库文件，确保登记表不会指向不存在的脚本、不会漏掉
 * 未登记的 verify-*.mjs（默认拒绝）、手动工作流不会偷偷变成自动触发。用例只在
 * decision-fixture 用例里真正执行 node 模式脚本（无浏览器）；其余用例不启动 Chrome/Vite。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ISOLATED_VERIFICATIONS,
  ROOT,
  formatListing,
  formatSummary,
  main,
  parseArgs,
  preflight,
  runVerification,
  selectEntries,
  signalGroup,
  tail,
} from './run-ui-verifications.mjs'

const DEFAULTS = { list: false, only: null, timeoutMs: 300_000, output: null, keepTemp: false, help: false }
const isAlive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms))

async function waitGone(pid, timeoutMs = 5_000) {
  for (let waited = 0; waited < timeoutMs; waited += 50) {
    if (!isAlive(pid)) return true
    await sleep(50)
  }
  return !isAlive(pid)
}

test('parseArgs 解析开关并拒绝非法值', () => {
  assert.deepEqual(parseArgs([]), DEFAULTS)
  assert.deepEqual(parseArgs(['--list', '--keep-temp']), { ...DEFAULTS, list: true, keepTemp: true })
  assert.deepEqual(parseArgs(['--only', 'a, b']), { ...DEFAULTS, only: ['a', 'b'] })
  assert.deepEqual(parseArgs(['--only=a,b']), { ...DEFAULTS, only: ['a', 'b'] })
  assert.deepEqual(parseArgs(['--timeout', '30']), { ...DEFAULTS, timeoutMs: 30_000 })
  assert.deepEqual(parseArgs(['--timeout=45']), { ...DEFAULTS, timeoutMs: 45_000 })
  assert.deepEqual(parseArgs(['--output=/tmp/x']), { ...DEFAULTS, output: '/tmp/x' })
  assert.throws(() => parseArgs(['--timeout', '0']), /需要正数秒/)
  assert.throws(() => parseArgs(['--timeout']), /需要正数秒/)
  assert.throws(() => parseArgs(['--only']), /需要一个值/)
  assert.throws(() => parseArgs(['--output']), /需要一个值/)
  assert.throws(() => parseArgs(['--nope']), /未知参数/)
})

test('selectEntries 默认整套白名单，--only 支持 id 与文件名', () => {
  assert.deepEqual(selectEntries({ only: null }).map(entry => entry.id), ISOLATED_VERIFICATIONS.map(entry => entry.id))
  assert.deepEqual(selectEntries({ only: ['schedule-ui'] }).map(entry => entry.id), ['schedule-ui'])
  assert.deepEqual(selectEntries({ only: ['verify-schedule-ui.mjs'] }).map(entry => entry.id), ['schedule-ui'])
  assert.deepEqual(selectEntries({ only: ['beta5-ui', 'decision-fixture'] }).map(entry => entry.id), ['beta5-ui', 'decision-fixture'])
  assert.throws(() => selectEntries({ only: ['nope'] }), /没有登记的脚本/)
})

test('preflight 只选 node 模式时不要求 Chrome，self 模式与 dist 仍会拦截', async t => {
  const root = await mkdtemp(join(tmpdir(), 'astaria-ui-runner-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const chrome = join(root, 'chrome')
  await writeFile(chrome, '#!/bin/sh\n', 'utf8')
  const missing = join(root, 'missing-chrome')
  const nodeEntry = ISOLATED_VERIFICATIONS.find(entry => entry.mode === 'node')
  const selfEntry = ISOLATED_VERIFICATIONS.find(entry => entry.mode === 'self')
  const distEntry = ISOLATED_VERIFICATIONS.find(entry => entry.needsDist)

  assert.deepEqual((await preflight([nodeEntry], { root, chrome: missing })).blockers, [])
  assert.deepEqual((await preflight([nodeEntry, nodeEntry], { root, chrome: missing })).blockers, [])
  assert.match((await preflight([selfEntry], { root, chrome: missing })).blockers.join('；'), /找不到 Chrome/)
  assert.match((await preflight([distEntry], { root, chrome })).blockers.join('；'), /缺少 dist\//)
  await mkdir(join(root, 'dist'), { recursive: true })
  await writeFile(join(root, 'dist', 'index.html'), '<html></html>\n', 'utf8')
  assert.deepEqual((await preflight([distEntry], { root, chrome })).blockers, [])
  assert.match((await preflight([{ id: 'ghost', script: 'verify-ghost.mjs' }], { root, chrome })).blockers.join('；'), /缺少脚本/)
})

test('白名单登记了 beta5-ui，且 --list 会列出它', async () => {
  const beta5 = ISOLATED_VERIFICATIONS.find(entry => entry.id === 'beta5-ui')
  assert.equal(beta5.script, 'verify-beta5-ui.mjs')
  assert.equal(beta5.mode, 'self')
  assert.deepEqual(beta5.chromeEnv, ['BETA5_QA_CHROME'])
  assert.equal(beta5.outputEnv, 'BETA5_QA_OUTPUT')
  assert.equal(beta5.needsDist, undefined)

  const lines = []
  assert.equal(await main(['--list'], { log: line => lines.push(line), error: () => {} }), 0)
  const listing = lines.join('\n')
  assert.match(listing, /beta5-ui\s+scripts\/verify-beta5-ui\.mjs\s+\[self\]/)
  assert.match(listing, /可自动运行的隔离验证（8 个）/)
})

test('decision-fixture 在 CHROME_BINARY 无效时依然跑通（node 模式不需要 Chrome）', async t => {
  const output = await mkdtemp(join(tmpdir(), 'astaria-ui-runner-node-'))
  const previous = process.env.CHROME_BINARY
  t.after(async () => {
    if (previous === undefined) delete process.env.CHROME_BINARY
    else process.env.CHROME_BINARY = previous
    await rm(output, { recursive: true, force: true })
  })
  process.env.CHROME_BINARY = join(output, 'no-such-chrome')

  const lines = [], errors = []
  const status = await main(['--only', 'decision-fixture', '--output', output], { log: line => lines.push(line), error: line => errors.push(line) })
  assert.equal(status, 0, errors.join('\n'))
  assert.deepEqual(errors, [])
  assert.match(lines.join('\n'), /PASS\s+decision-fixture/)
  assert.match(lines.join('\n'), /1\/1 通过/)
  assert.ok(existsSync(join(output, 'logs', 'decision-fixture.log')))
  assert.equal(existsSync(join(output, 'tmp')), false, '一次性 TMPDIR 已清理')
})

test('runVerification 记录失败退出码、耗时与日志', async t => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'astaria-ui-runner-log-'))
  const tempDirectory = join(runDirectory, 'tmp')
  t.after(() => rm(runDirectory, { recursive: true, force: true }))
  await mkdir(tempDirectory, { recursive: true })
  const result = await runVerification(
    { id: 'missing-script', script: 'verify-does-not-exist.mjs', mode: 'node', outputEnv: null },
    { runDirectory, tempDirectory, timeoutMs: 60_000, chrome: process.execPath },
  )
  assert.equal(result.status, 'fail')
  assert.ok(result.durationMs >= 0)
  const log = await readFile(result.logFile, 'utf8')
  assert.match(log, /missing-script mode=node exit=1/)
  assert.match(log, /ERR_MODULE_NOT_FOUND|Cannot find module/)
})

test('spawn 失败记为 error 状态、写进日志且不会挂死', async t => {
  const runDirectory = await mkdtemp(join(tmpdir(), 'astaria-ui-runner-spawn-'))
  const tempDirectory = join(runDirectory, 'tmp')
  t.after(() => rm(runDirectory, { recursive: true, force: true }))
  await mkdir(tempDirectory, { recursive: true })
  const result = await runVerification(
    { id: 'bad-binary', script: 'verify-decision-ui.mjs', mode: 'node', outputEnv: null },
    { runDirectory, tempDirectory, timeoutMs: 5_000, chrome: process.execPath, nodeBinary: join(runDirectory, 'missing-node') },
  )
  assert.equal(result.status, 'error')
  assert.match(result.output, /spawn error/)
  assert.match(await readFile(result.logFile, 'utf8'), /spawn error/)
})

test('signalGroup 在 leader 退出后仍能终止组内后代进程', async t => {
  const leaderCode = "const { spawn } = require('node:child_process');"
    + "const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });"
    + 'process.stdout.write(String(child.pid)); setTimeout(() => process.exit(0), 100)'
  const leader = spawn(process.execPath, ['-e', leaderCode], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const pidReady = new Promise(resolvePid => leader.stdout.once('data', chunk => resolvePid(Number(String(chunk).trim()))))
  t.after(() => { try { process.kill(-leader.pid, 'SIGKILL') } catch {} })
  await new Promise(done => leader.once('close', done))
  const grandchildPid = await pidReady
  assert.ok(grandchildPid > 0, '后代进程 pid 可读')
  assert.equal(isAlive(grandchildPid), true, 'leader 退出后后代进程仍然存活')
  assert.equal(signalGroup(leader.pid, 'SIGKILL'), true, 'leader 退出后进程组仍可发信号')
  assert.equal(await waitGone(grandchildPid), true, '进程组信号终止了后代进程')
  assert.equal(signalGroup(0, 'SIGKILL'), false)
})

test('main 在参数错误与预检失败时返回 2，--list 返回 0', async () => {
  const lines = [], errors = []
  const io = { log: line => lines.push(line), error: line => errors.push(line) }
  assert.equal(await main(['--nope'], io), 2)
  assert.match(errors.join('\n'), /未知参数/)
  assert.equal(await main(['--only', 'nope'], io), 2)
  assert.match(errors.join('\n'), /没有登记的脚本/)
  assert.equal(await main(['--list'], io), 0)
  assert.match(lines.join('\n'), /可自动运行的隔离验证/)
  assert.match(lines.join('\n'), /默认排除/)
})

test('白名单不变量：脚本都存在、模式与字段合法、其余 verify 脚本全部显式排除', async () => {
  const files = (await readdir(join(ROOT, 'scripts'))).filter(name => /^verify-.*\.mjs$/.test(name)).sort()
  assert.equal(new Set(ISOLATED_VERIFICATIONS.map(entry => entry.id)).size, ISOLATED_VERIFICATIONS.length, 'id 必须唯一')
  for (const entry of ISOLATED_VERIFICATIONS) {
    assert.ok(files.includes(entry.script), `${entry.id} 的脚本不存在`)
    assert.ok(['self', 'node'].includes(entry.mode), `${entry.id} 的模式必须是 self 或 node`)
    assert.equal(typeof entry.summary, 'string', entry.id)
    assert.ok(Object.hasOwn(entry, 'outputEnv'), entry.id)
    if (entry.mode === 'self' && entry.chromeEnv !== undefined) assert.ok(Array.isArray(entry.chromeEnv) && entry.chromeEnv.every(name => typeof name === 'string'), entry.id)
    if (entry.mode === 'node') assert.ok(entry.env && Object.keys(entry.env).length > 0, entry.id)
  }
  const listed = formatListing({ runnable: ISOLATED_VERIFICATIONS, excluded: files.filter(name => !ISOLATED_VERIFICATIONS.some(entry => entry.script === name)) })
  for (const file of files) assert.ok(listed.includes(file), `${file} 既没登记也没在清单里说明`)
})

test('手动 UI 验证工作流：仅 workflow_dispatch，且步骤与产物收集完整', async () => {
  const workflow = await readFile(join(ROOT, '.github', 'workflows', 'ui-verifications.yml'), 'utf8')
  assert.match(workflow, /^on:\n {2}workflow_dispatch:/m)
  assert.doesNotMatch(workflow, /^ {2}(push|pull_request|pull_request_target|schedule):/m)
  assert.match(workflow, /runs-on: macos-14/)
  assert.match(workflow, /node-version: 24\.19\.0/)
  for (const step of ['npm ci', 'npm run build:desktop', 'scripts/run-ui-verifications.mjs', 'actions/upload-artifact', 'artifacts/verification/']) {
    assert.ok(workflow.includes(step), `工作流缺少步骤或产物：${step}`)
  }
  for (const banned of ['verify-flow', 'verify-geodesics', 'verify-spatial', 'verify-horizon-smart-20', 'npm run dev', 'npm run preview']) {
    assert.ok(!workflow.includes(banned), `工作流不应引用 ${banned}`)
  }
})

test('formatSummary 与 tail 输出状态、耗时和日志末尾', async () => {
  const text = formatSummary([
    { id: 'a', mode: 'self', status: 'pass', durationMs: 1234, logFile: '/tmp/a.log' },
    { id: 'b', mode: 'node', status: 'timeout', durationMs: 5000, logFile: '/tmp/b.log' },
  ], { runDirectory: '/tmp/run' })
  assert.match(text, /PASS\s+a\s+self/)
  assert.match(text, /TIMEOUT\s+b\s+node/)
  assert.match(text, /1\/2 通过/)
  assert.equal(tail('1\n2\n3\n4', 2), '3\n4')
})
