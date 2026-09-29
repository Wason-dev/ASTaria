#!/usr/bin/env node
/**
 * 隔离 UI 验证 runner：串行运行白名单里的 scripts/verify-*.mjs，汇总结果并清理现场。
 * 白名单只收自带隔离环境的脚本：self 模式自己起 headless Chrome（一次性 profile）、
 * SQLite 用 :memory: 或 mkdtemp、用桩 vault 与桩模型；node 模式无浏览器。
 * runner 负责：串行执行、每脚本超时（SIGTERM→SIGKILL 整个自有进程组，含 leader 退出后
 * 残留的后代）、把子进程 TMPDIR 指向本次运行目录（脚本内部 mkdtemp 的 Chrome profile、
 * 临时库、Vite 缓存都落在这里，跑完删除）、汇总日志、失败时打印日志末尾。
 * 不启动共享 Chrome 或开发服务器：vite.config.ts 的 localServicePlugin() 按默认参数
 * 调用 createLocalService()，即打开 ~/Library/Application Support/ASTARIA 的真实数据库
 * 与真实钥匙串（见 server/index.mjs），所以需要人工先跑开发/预览服务器的 verify-*.mjs
 * 一律不进自动流程；黑洞渲染读回与真实模型/数据脚本同样排除。只跑 node 模式无需 Chrome。
 *
 * 用法：node scripts/run-ui-verifications.mjs [--list] [--only a,b] [--timeout <秒>]
 *                                            [--output <目录>] [--keep-temp] [--help]
 * 退出码：0 全部通过；1 有失败、超时或 spawn 错误；2 参数或预检失败。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT_DIR = join(ROOT, 'scripts')
const DEFAULT_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DEFAULT_TIMEOUT_MS = 300_000
const KILL_GRACE_MS = 5_000
const LOG_TAIL_LINES = 20

/** 白名单：只登记隔离性已核对过的脚本；新增 verify-*.mjs 默认被排除。 */
export const ISOLATED_VERIFICATIONS = [
  { id: 'schedule-ui', script: 'verify-schedule-ui.mjs', mode: 'self', chromeEnv: ['SCHEDULE_QA_CHROME'], outputEnv: 'SCHEDULE_QA_OUTPUT', summary: '日程视图、隔周课表与单日调课（临时 Vite + 内存 SQLite）' },
  { id: 'task-steps-ui', script: 'verify-task-steps-ui.mjs', mode: 'self', chromeEnv: ['TASK_STEPS_QA_CHROME'], outputEnv: 'TASK_STEPS_QA_OUTPUT', summary: '任务步骤拆分与勾选，API 全程 CDP 拦截（临时 Vite + 内存 SQLite）' },
  { id: 'free-time-ui', script: 'verify-free-time-ui.mjs', mode: 'self', needsDist: true, outputEnv: null, summary: '余时目标恢复与自动安排（mkdtemp SQLite + dist）' },
  { id: 'free-time-completion-sync', script: 'verify-free-time-completion-sync.mjs', mode: 'self', needsDist: true, outputEnv: null, summary: '余时完成/撤回同步与构建资源一致性（mkdtemp SQLite + dist）' },
  { id: 'app-updates-ui', script: 'verify-app-updates-ui.mjs', mode: 'self', needsDist: true, outputEnv: null, summary: '更新检查/下载/失败回退（mock updater，不访问网络）' },
  { id: 'beta4-ui', script: 'verify-beta4-ui.mjs', mode: 'self', needsDist: true, outputEnv: null, summary: '隔周课表、提醒与心愿澄清（mkdtemp SQLite + 桩模型与桩通知）' },
  { id: 'beta5-ui', script: 'verify-beta5-ui.mjs', mode: 'self', chromeEnv: ['BETA5_QA_CHROME'], outputEnv: 'BETA5_QA_OUTPUT', summary: 'beta.5 日程/提醒/更新验收（临时 Vite + 内存 SQLite，无外部数据）' },
  { id: 'decision-fixture', script: 'verify-decision-ui.mjs', mode: 'node', env: { DECISION_QA_FIXTURE_ONLY: '1' }, outputEnv: null, summary: '决策工作室无浏览器 fixture 分支（进程内内存服务）' },
]

const scriptPath = entry => join(SCRIPT_DIR, entry.script)
const matchesId = (entry, id) => entry.id === id || entry.script === id || entry.script.replace(/\.mjs$/, '') === id

export function parseArgs(argv) {
  const options = { list: false, only: null, timeoutMs: DEFAULT_TIMEOUT_MS, output: null, keepTemp: false, help: false }
  const seconds = value => {
    const parsed = Number(value)
    if (!Number.isFinite(parsed) || parsed <= 0) throw new Error('--timeout 需要正数秒')
    return parsed * 1000
  }
  const valueOf = (arg, name, next) => {
    const value = arg === name ? next() : arg.slice(name.length + 1)
    if (!value) throw new Error(`${name} 需要一个值`)
    return value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index], next = () => argv[++index]
    if (arg === '--list') options.list = true
    else if (arg === '--keep-temp') options.keepTemp = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--only' || arg.startsWith('--only=')) options.only = valueOf(arg, '--only', next).split(',').map(item => item.trim()).filter(Boolean)
    else if (arg === '--output' || arg.startsWith('--output=')) options.output = valueOf(arg, '--output', next)
    else if (arg === '--timeout') options.timeoutMs = seconds(next())
    else if (arg.startsWith('--timeout=')) options.timeoutMs = seconds(arg.slice('--timeout='.length))
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

export function selectEntries(options) {
  if (!options.only || options.only.length === 0) return ISOLATED_VERIFICATIONS
  const missing = options.only.filter(id => !ISOLATED_VERIFICATIONS.some(entry => matchesId(entry, id)))
  if (missing.length > 0) throw new Error(`--only 里没有登记的脚本：${missing.join('、')}（用 --list 查看可用 id）`)
  return ISOLATED_VERIFICATIONS.filter(entry => options.only.some(id => matchesId(entry, id)))
}

/** 预检：有 self 模式脚本才要求 Chrome；需要 dist 的脚本要有构建产物。只跑 node 模式无需 Chrome。 */
export function preflight(entries, { root = ROOT, chrome = process.env.CHROME_BINARY ?? DEFAULT_CHROME } = {}) {
  const blockers = []
  if (entries.some(entry => entry.mode === 'self') && !existsSync(chrome)) blockers.push(`找不到 Chrome：${chrome}（可用 CHROME_BINARY 指定；只跑 node 模式不需要）`)
  for (const entry of entries) {
    if (!existsSync(scriptPath(entry))) blockers.push(`缺少脚本：scripts/${entry.script}`)
    if (entry.needsDist && !existsSync(join(root, 'dist', 'index.html'))) blockers.push(`缺少 dist/：先运行 npm run build:desktop（${entry.id} 需要它）`)
  }
  return { ok: blockers.length === 0, blockers }
}

/** 只对 runner 自己创建的进程组发信号：leader 退出后仍能清理组内存活的后代进程（如 Chrome）。 */
export function signalGroup(pgid, signal) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false
  try { process.kill(-pgid, signal); return true } catch { return false }
}

/** 运行单个脚本：一次性 TMPDIR、超时、进程组清理、spawn 错误处理、日志落盘。 */
export async function runVerification(entry, { runDirectory, tempDirectory, timeoutMs, chrome, nodeBinary = process.execPath }) {
  const logFile = join(runDirectory, 'logs', `${entry.id}.log`)
  await mkdir(dirname(logFile), { recursive: true })
  const env = {
    ...process.env,
    TMPDIR: tempDirectory,
    CHROME_BINARY: chrome,
    ...Object.fromEntries((entry.chromeEnv ?? []).map(name => [name, chrome])),
    ...(entry.env ?? {}),
  }
  if (entry.outputEnv) {
    env[entry.outputEnv] = join(runDirectory, 'output', entry.id)
    await mkdir(env[entry.outputEnv], { recursive: true })
  }
  const startedAt = Date.now()
  const child = spawn(nodeBinary, [scriptPath(entry)], { cwd: ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  const collect = chunk => { if (output.length < 4 * 1024 * 1024) output += chunk.toString('utf8') }
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)
  // 'close' 同时覆盖正常退出与 spawn 失败，并保证 stdio 已读完；'error' 先行兜底避免挂死。
  const finished = new Promise(done => {
    child.once('error', error => done({ code: null, signal: null, error }))
    child.once('close', (code, signal) => done({ code, signal, error: null }))
  })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    signalGroup(child.pid, 'SIGTERM')
    setTimeout(() => signalGroup(child.pid, 'SIGKILL'), KILL_GRACE_MS).unref()
  }, timeoutMs)
  const result = await finished
  clearTimeout(timer)
  // 无条件收尾整个进程组：脚本可能在 leader 退出（或被超时杀掉）前留下 Chrome 等后代进程。
  signalGroup(child.pid, 'SIGKILL')
  const durationMs = Date.now() - startedAt
  const spawnNote = result.error ? `spawn error: ${result.error.message}\n` : ''
  const status = timedOut ? 'timeout' : result.error ? 'error' : result.code === 0 ? 'pass' : 'fail'
  await writeFile(logFile, `${entry.id} mode=${entry.mode} exit=${result.code} signal=${result.signal ?? 'none'} timeout=${timedOut} duration=${durationMs}ms\n\n${spawnNote}${output}`, 'utf8')
  return { id: entry.id, mode: entry.mode, status, durationMs, logFile, output: spawnNote + output }
}

export const tail = (text, lines = LOG_TAIL_LINES) => text.trimEnd().split('\n').slice(-lines).join('\n')

export function formatSummary(results, { runDirectory }) {
  const rows = results.map(result => `  ${result.status.toUpperCase().padEnd(8)}${result.id.padEnd(28)}${result.mode.padEnd(6)}${(result.durationMs / 1000).toFixed(1).padStart(7)}s  ${result.logFile}`)
  const passed = results.filter(result => result.status === 'pass').length
  return [`UI 验证汇总（run 目录：${runDirectory}）`, ...rows, `${passed}/${results.length} 通过`].join('\n')
}

export function formatListing({ runnable, excluded }) {
  const rows = runnable.map(entry => `  ${entry.id.padEnd(28)} scripts/${entry.script.padEnd(38)} [${entry.mode}${entry.needsDist ? ',dist' : ''}]  ${entry.summary}`)
  const note = `未登记的 verify-*.mjs（${excluded.length} 个，默认排除：需要人工先启动开发服务器/浏览器，或依赖 GPU 读回、真实数据与真实模型）：`
  return [`可自动运行的隔离验证（${runnable.length} 个）：`, ...rows, '', note, ...excluded.map(name => `  ${name}`)].join('\n')
}

const USAGE = `用法：node scripts/run-ui-verifications.mjs [--list] [--only a,b] [--timeout <秒>]
                                            [--output <目录>] [--keep-temp] [--help]

串行运行白名单里自带临时 Chrome/后端的隔离验证脚本；runner 负责一次性 TMPDIR、超时、
进程组清理、汇总与失败日志。只跑 node 模式（decision-fixture）时不需要 Chrome。`

export async function main(argv = process.argv.slice(2), io = { log: console.log, error: console.error }) {
  let options
  try {
    options = parseArgs(argv)
  } catch (error) {
    io.error(`${error.message}\n\n${USAGE}`)
    return 2
  }
  if (options.help) {
    io.log(USAGE)
    return 0
  }
  const registered = new Set(ISOLATED_VERIFICATIONS.map(entry => entry.script))
  const files = (await readdir(SCRIPT_DIR)).filter(name => /^verify-.*\.mjs$/.test(name)).sort()
  if (options.list) {
    io.log(formatListing({ runnable: ISOLATED_VERIFICATIONS.filter(entry => files.includes(entry.script)), excluded: files.filter(name => !registered.has(name)) }))
    return 0
  }
  let entries
  try {
    entries = selectEntries(options)
  } catch (error) {
    io.error(error.message)
    return 2
  }
  const chrome = process.env.CHROME_BINARY ?? DEFAULT_CHROME
  const checked = preflight(entries, { chrome })
  if (!checked.ok) {
    for (const blocker of checked.blockers) io.error(`预检失败：${blocker}`)
    return 2
  }

  await mkdir(join(ROOT, 'artifacts', 'verification'), { recursive: true })
  const runDirectory = options.output ? resolve(options.output) : await mkdtemp(join(ROOT, 'artifacts', 'verification', 'ui-run-'))
  const tempDirectory = join(runDirectory, 'tmp')
  await mkdir(tempDirectory, { recursive: true })
  const results = []
  try {
    for (const entry of entries) {
      io.log(`▶ ${entry.id} …`)
      const result = await runVerification(entry, { runDirectory, tempDirectory, timeoutMs: options.timeoutMs, chrome })
      results.push(result)
      io.log(`  ${result.status.toUpperCase()} ${(result.durationMs / 1000).toFixed(1)}s`)
      if (result.status !== 'pass') io.error(`--- ${entry.id} 日志末尾 ---\n${tail(result.output)}\n---`)
    }
  } finally {
    if (!options.keepTemp) await rm(tempDirectory, { recursive: true, force: true }).catch(() => {})
  }
  io.log(formatSummary(results, { runDirectory }))
  return results.every(result => result.status === 'pass') ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
