#!/usr/bin/env node
/**
 * 文档版本校验：package.json 里的当前版本必须出现在
 *   README.md、CHANGELOG.md、docs/RELEASE_NOTES_v<版本>.md、SECURITY.md
 *
 * 只校验「当前版本被声明」，不要求历史版本条目一致，也不回查历史发布说明。
 * 面向发布流程：改 package.json 版本后若忘记同步文档，这里会立即失败。
 *
 * 用法：
 *   node scripts/verify-doc-versions.mjs [--root <目录>] [--json] [--quiet] [--help]
 * 退出码：0 通过；1 有文档缺少当前版本；2 无法读取版本或参数错误。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

/** 必须声明当前版本的固定文档。 */
export const DOC_TARGETS = ['README.md', 'CHANGELOG.md', 'SECURITY.md']
/** 发布说明目录，文件名形如 RELEASE_NOTES_v0.1.0-beta.5.md。 */
export const RELEASE_NOTES_DIR = 'docs'
const RELEASE_NOTES_PATTERN = /^RELEASE_NOTES_.*\.md$/i
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
const ANY_VERSION_PATTERN = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g

const USAGE = `用法：node scripts/verify-doc-versions.mjs [--root <目录>] [--json] [--quiet]

校验 package.json 的当前版本出现在 README.md、CHANGELOG.md、
docs/RELEASE_NOTES_v<版本>.md 与 SECURITY.md 中。`

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 匹配版本号本身，且拒绝更长版本造成的前后缀误命中：
 * `v0.1.0-beta.4` 命中，`0.1.0-beta.40`、`0.1.0-beta.4-rc1`、`10.1.0-beta.4` 不命中。
 */
export function versionPattern(version) {
  return new RegExp(`(?<![0-9A-Za-z.])v?${escapeRegExp(version)}(?![0-9A-Za-z-])`)
}

/** 文档里出现过的版本号，用于失败时给出可操作的提示。 */
export function detectVersions(text, limit = 6) {
  return [...new Set(text.match(ANY_VERSION_PATTERN) ?? [])].slice(0, limit)
}

export async function readPackageVersion(root) {
  const file = path.join(root, 'package.json')
  let raw
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (error) {
    throw new Error(`读取 ${file} 失败：${error.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`解析 ${file} 失败：${error.message}`)
  }
  const version = typeof parsed.version === 'string' ? parsed.version.trim().replace(/^v/, '') : ''
  if (!SEMVER_PATTERN.test(version)) throw new Error(`${file} 的 version 不是可识别的版本号：${JSON.stringify(parsed.version)}`)
  return version
}

/**
 * 找到与当前版本对应的发布说明：优先 docs/RELEASE_NOTES_v<版本>.md，
 * 其次文件名包含版本号的发布说明（取最新一个）。
 */
export async function findReleaseNotes(root, version) {
  const directory = path.join(root, RELEASE_NOTES_DIR)
  const preferred = `RELEASE_NOTES_v${version}.md`
  let entries = []
  try {
    entries = await fs.readdir(directory)
  } catch (error) {
    return { file: path.join(RELEASE_NOTES_DIR, preferred), dirMissing: true, candidates: [], detail: `无法读取 ${directory}：${error.message}` }
  }
  const candidates = entries.filter(name => RELEASE_NOTES_PATTERN.test(name)).sort()
  if (candidates.includes(preferred)) return { file: path.join(RELEASE_NOTES_DIR, preferred), dirMissing: false, candidates }
  const containing = candidates.filter(name => name.toLowerCase().includes(version.toLowerCase()))
  if (containing.length > 0) return { file: path.join(RELEASE_NOTES_DIR, containing[containing.length - 1]), dirMissing: false, candidates }
  return { file: path.join(RELEASE_NOTES_DIR, preferred), dirMissing: false, candidates }
}

async function checkTextDocument(root, relative, version) {
  const file = path.join(root, relative)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (error) {
    return { id: relative, file: relative, ok: false, detail: error.code === 'ENOENT' ? '文件不存在' : `无法读取：${error.message}` }
  }
  if (versionPattern(version).test(text)) return { id: relative, file: relative, ok: true, detail: `已声明 ${version}` }
  const detected = detectVersions(text)
  return {
    id: relative,
    file: relative,
    ok: false,
    detail: `缺少当前版本 ${version}${detected.length > 0 ? `（文中出现的版本：${detected.join('、')}）` : '（文中没有版本号）'}`,
  }
}

/** 校验当前版本被全部文档声明，返回结构化结果（不抛错，便于测试与 --json 输出）。 */
export async function checkDocVersions({ root, version } = {}) {
  const resolvedRoot = path.resolve(root ?? process.cwd())
  const resolvedVersion = version ?? await readPackageVersion(resolvedRoot)
  const checks = []
  for (const relative of DOC_TARGETS) checks.push(await checkTextDocument(resolvedRoot, relative, resolvedVersion))

  const notes = await findReleaseNotes(resolvedRoot, resolvedVersion)
  const notesCheck = await checkTextDocument(resolvedRoot, notes.file, resolvedVersion)
  if (notesCheck.detail === '文件不存在') {
    const existing = notes.candidates.length > 0 ? `（现有：${notes.candidates.join('、')}）` : ''
    notesCheck.detail = `缺少与当前版本对应的发布说明：期望 ${notes.file}${existing}`
    if (notes.dirMissing) notesCheck.detail += `；${notes.detail}`
  }
  notesCheck.releaseNotes = notes.file
  checks.push(notesCheck)

  return { root: resolvedRoot, version: resolvedVersion, ok: checks.every(check => check.ok), checks }
}

export function formatReport(result) {
  const lines = [`文档版本校验：package.json 当前版本 ${result.version}`]
  for (const check of result.checks) lines.push(`${check.ok ? 'PASS' : 'FAIL'} ${check.file} — ${check.detail}`)
  lines.push(result.ok
    ? '通过：当前版本已在 README、CHANGELOG、对应发布说明与 SECURITY 中声明。'
    : '失败：请把 package.json 的当前版本同步到上述文档后重试。')
  return lines.join('\n')
}

export function parseArgs(argv) {
  const options = { root: undefined, json: false, quiet: false, help: false }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--root') {
      const value = argv[++index]
      if (!value) throw new Error('--root 需要一个目录参数')
      options.root = value
    } else if (arg.startsWith('--root=')) options.root = arg.slice('--root='.length)
    else if (arg === '--json') options.json = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--help' || arg === '-h') options.help = true
    else throw new Error(`未知参数：${arg}`)
  }
  return options
}

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
  let result
  try {
    result = await checkDocVersions({ root: options.root })
  } catch (error) {
    io.error(`无法确定当前版本：${error.message}`)
    return 2
  }
  if (options.json) io.log(JSON.stringify(result, null, 2))
  else if (!options.quiet || !result.ok) io.log(formatReport(result))
  return result.ok ? 0 : 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main()
}
