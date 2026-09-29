/**
 * verify-doc-versions.mjs 的独立单元测试。
 *
 * 全部用例都在临时目录里自建 fixture，不读取真实仓库文档，
 * 因此发布期间 package.json 与文档的同步状态不会影响 `npm test`。
 * 真实仓库的校验由 `node scripts/verify-doc-versions.mjs`（CI 步骤）负责。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  checkDocVersions,
  detectVersions,
  formatReport,
  main,
  parseArgs,
  readPackageVersion,
  versionPattern,
} from './verify-doc-versions.mjs'

const CLI = fileURLToPath(new URL('./verify-doc-versions.mjs', import.meta.url))

/** 建立一个最小文档仓库 fixture；omit 里的相对路径不会写入。 */
async function makeFixture(t, { version = '0.1.0-beta.5', files = {}, omit = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'astaria-doc-versions-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const contents = {
    'package.json': `${JSON.stringify({ name: 'astaria', private: true, version }, null, 2)}\n`,
    'README.md': `# ASTaria\n\n当前版本 ${version} 面向 macOS 内测。\n`,
    'CHANGELOG.md': `# 变更记录\n\n## ${version} · 2026-09-30\n\n- 测试条目。\n`,
    'SECURITY.md': `# 安全问题与隐私\n\n当前受支持的内测线为 ${version}。\n`,
    [`docs/RELEASE_NOTES_v${version}.md`]: `# ASTaria ${version}\n\n测试发布说明。\n`,
    ...files,
  }
  for (const [relative, content] of Object.entries(contents)) {
    if (omit.includes(relative)) continue
    const target = join(root, relative)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  return root
}

const runCli = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
const checkFor = (result, file) => result.checks.find(check => check.file === file)

test('当前版本出现在全部文档时通过，并列出四项检查', async t => {
  const root = await makeFixture(t)
  const result = await checkDocVersions({ root })
  assert.equal(result.ok, true)
  assert.equal(result.version, '0.1.0-beta.5')
  assert.deepEqual(result.checks.map(check => check.file), [
    'README.md',
    'CHANGELOG.md',
    'SECURITY.md',
    'docs/RELEASE_NOTES_v0.1.0-beta.5.md',
  ])
  assert.ok(result.checks.every(check => check.ok), formatReport(result))
})

test('SECURITY 只写历史版本时失败，并提示文中出现的版本', async t => {
  const root = await makeFixture(t, { files: { 'SECURITY.md': '# 安全问题与隐私\n\n当前仅维护 `0.1.0-beta.4` 内测线。\n' } })
  const result = await checkDocVersions({ root })
  assert.equal(result.ok, false)
  const security = checkFor(result, 'SECURITY.md')
  assert.equal(security.ok, false)
  assert.match(security.detail, /缺少当前版本 0\.1\.0-beta\.5/)
  assert.match(security.detail, /0\.1\.0-beta\.4/)
  assert.match(formatReport(result), /FAIL SECURITY\.md/)
})

test('缺少对应发布说明时失败并指出期望文件名', async t => {
  const root = await makeFixture(t, { omit: ['docs/RELEASE_NOTES_v0.1.0-beta.5.md'] })
  const result = await checkDocVersions({ root })
  assert.equal(result.ok, false)
  const notes = checkFor(result, 'docs/RELEASE_NOTES_v0.1.0-beta.5.md')
  assert.equal(notes.ok, false)
  assert.match(notes.detail, /缺少与当前版本对应的发布说明/)
})

test('对应的发布说明存在但没写当前版本时失败', async t => {
  const root = await makeFixture(t, { files: { 'docs/RELEASE_NOTES_v0.1.0-beta.5.md': '# ASTaria 0.1.0-beta.4\n\n上一版说明。\n' } })
  const result = await checkDocVersions({ root })
  assert.equal(result.ok, false)
  assert.equal(checkFor(result, 'docs/RELEASE_NOTES_v0.1.0-beta.5.md').ok, false)
  assert.equal(checkFor(result, 'README.md').ok, true)
})

test('发布说明文件名不带 v 时按版本号回退匹配', async t => {
  const root = await makeFixture(t, {
    omit: ['docs/RELEASE_NOTES_v0.1.0-beta.5.md'],
    files: { 'docs/RELEASE_NOTES_0.1.0-beta.5.md': '# ASTaria 0.1.0-beta.5\n\n草稿说明。\n' },
  })
  const result = await checkDocVersions({ root })
  assert.equal(result.ok, true)
  assert.equal(checkFor(result, 'docs/RELEASE_NOTES_0.1.0-beta.5.md').ok, true)
})

test('更长的版本号不会被当成当前版本', async t => {
  const root = await makeFixture(t, {
    version: '0.1.0-beta.4',
    files: {
      'README.md': '# ASTaria\n\n当前版本 0.1.0-beta.40 面向 macOS 内测。\n',
      'CHANGELOG.md': '# 变更记录\n\n## 0.1.0-beta.4-rc1 · 2026-09-30\n\n- 候选版本。\n',
    },
  })
  const result = await checkDocVersions({ root })
  assert.equal(result.ok, false)
  assert.equal(checkFor(result, 'README.md').ok, false)
  assert.equal(checkFor(result, 'CHANGELOG.md').ok, false)
  assert.equal(checkFor(result, 'SECURITY.md').ok, true)
})

test('v 前缀写法与代码块中的版本号同样被认可', async t => {
  const root = await makeFixture(t, {
    files: {
      'README.md': '# ASTaria\n\n当前 [v0.1.0-beta.5](https://example.invalid) 已发布。\n',
      'docs/RELEASE_NOTES_v0.1.0-beta.5.md': '# ASTaria\n\n本版为 `v0.1.0-beta.5`。\n',
    },
  })
  const result = await checkDocVersions({ root })
  assert.equal(result.ok, true)
  assert.ok(versionPattern('0.1.0-beta.5').test('`v0.1.0-beta.5`'))
})

test('package.json 版本缺失或不可识别时抛出可读错误', async t => {
  const missing = await makeFixture(t, { files: { 'package.json': '{"name":"astaria"}\n' } })
  await assert.rejects(readPackageVersion(missing), /不是可识别的版本号/)
  const invalid = await makeFixture(t, { files: { 'package.json': '{"name":"astaria","version":"beta"}\n' } })
  await assert.rejects(checkDocVersions({ root: invalid }), /不是可识别的版本号/)
  const broken = await makeFixture(t, { files: { 'package.json': '{oops' } })
  await assert.rejects(readPackageVersion(broken), /解析 .*package\.json 失败/)
})

test('显式传入版本时不依赖 package.json', async t => {
  const root = await makeFixture(t, { omit: ['package.json'], version: '0.1.0-beta.6' })
  const result = await checkDocVersions({ root, version: '0.1.0-beta.6' })
  assert.equal(result.ok, true)
})

test('CLI 通过 fixture 时退出码 0，失败时退出码 1', async t => {
  const passing = await makeFixture(t)
  const ok = runCli('--root', passing)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /PASS README\.md/)
  assert.match(ok.stdout, /通过：当前版本已在/)

  const failing = await makeFixture(t, { files: { 'SECURITY.md': '# 安全问题与隐私\n\n当前仅维护 `0.1.0-beta.1`。\n' } })
  const bad = runCli('--root', failing)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /FAIL SECURITY\.md/)
  assert.match(bad.stdout, /失败：请把 package\.json/)
})

test('CLI --json 输出可解析，--help 通过，未知参数退出码 2', async t => {
  const root = await makeFixture(t)
  const json = runCli('--root', root, '--json')
  assert.equal(json.status, 0, json.stderr)
  const parsed = JSON.parse(json.stdout)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.version, '0.1.0-beta.5')

  const help = runCli('--help')
  assert.equal(help.status, 0)
  assert.match(help.stdout, /用法：node scripts\/verify-doc-versions\.mjs/)

  const unknown = runCli('--root', root, '--nope')
  assert.equal(unknown.status, 2)
  assert.match(unknown.stderr, /未知参数：--nope/)
})

test('--root 缺少参数时 main 返回 2 而不是崩溃', async () => {
  const lines = [], errors = []
  const status = await main(['--root'], { log: line => lines.push(line), error: line => errors.push(line) })
  assert.equal(status, 2)
  assert.equal(lines.length, 0)
  assert.match(errors.join('\n'), /--root 需要一个目录参数/)
})

test('parseArgs 支持 --root= 形式与 --quiet', () => {
  assert.deepEqual(parseArgs(['--root=/tmp/example', '--quiet']), { root: '/tmp/example', json: false, quiet: true, help: false })
  assert.deepEqual(parseArgs(['--root', '/tmp/example', '--json']), { root: '/tmp/example', json: true, quiet: false, help: false })
})

test('detectVersions 去重并限制数量', () => {
  assert.deepEqual(detectVersions('0.1.0-beta.4 与 0.1.0-beta.5，还有 0.1.0-beta.4'), ['0.1.0-beta.4', '0.1.0-beta.5'])
  assert.deepEqual(detectVersions('没有任何版本号的文档'), [])
})
