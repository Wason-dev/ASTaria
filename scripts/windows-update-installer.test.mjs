import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { signTestManifest, testReleaseKeys } from './fixtures/release-signing.mjs'
import { launchWindowsUpdate, prepareWindowsUpdate, standardWindowsInstall, windowsInstallScript } from '../desktop/windowsUpdateInstaller.mjs'

test('Windows 自动安装只接受标准当前用户安装位置', () => {
  const local = 'C:\\Users\\Test User\\AppData\\Local'
  const standard = win32.join(local, 'Programs', 'ASTaria', 'ASTaria.exe')
  assert.equal(standardWindowsInstall(standard.toUpperCase(), local), true)
  assert.equal(standardWindowsInstall('D:\\Portable\\ASTaria.exe', local), false)
  assert.equal(standardWindowsInstall(standard, ''), false)
})

async function setupFixture(t, version = '0.1.0-beta.12') {
  const root = await mkdtemp(join(tmpdir(), 'astaria-win-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const local = join(root, 'Local'), target = join(local, 'Programs', 'ASTaria')
  await mkdir(target, { recursive: true })
  const executable = join(target, 'ASTaria.exe'), setup = join(root, 'cache.exe')
  const bytes = Buffer.from('setup fixture')
  await writeFile(executable, 'old app')
  await writeFile(setup, bytes)
  const unsigned = { schemaVersion: 1, name: 'ASTaria', bundleId: 'dev.wason.ASTaria',
    version, platform: 'win32', arch: 'x64', setup: `ASTaria-${version}-win-x64-setup.exe`,
    sha256: createHash('sha256').update(bytes).digest('hex'), sizeBytes: bytes.length,
    buildInfo: { version, source: { commit: 'b'.repeat(40), dirty: false } } }
  const manifest = signTestManifest(unsigned)
  const args = { executable, localAppData: local, path: setup, manifest, trustedKeys: testReleaseKeys,
    resultFile: join(root, 'state', 'result') }
  return { args, executable, target, unsigned }
}

test('Windows 安装准备先核验发布者签名、哈希与构建来源', async t => {
  const { args, executable, target, unsigned } = await setupFixture(t)
  const prepared = await prepareWindowsUpdate(args)
  assert.equal(prepared.target, target)
  assert.equal(await readFile(args.resultFile, 'utf8'), 'prepared')
  assert.equal(await readFile(executable, 'utf8'), 'old app')
  await assert.rejects(prepareWindowsUpdate({ ...args, manifest: unsigned }), /发布者签名/u)
  await assert.rejects(prepareWindowsUpdate({ ...args, manifest: signTestManifest({ ...unsigned, sha256: 'a'.repeat(64) }) }), /校验失败/u)
  for (const source of [{ commit: 'b'.repeat(40), dirty: true }, { commit: 'not-a-commit', dirty: false }]) {
    await assert.rejects(prepareWindowsUpdate({ ...args, manifest: signTestManifest({ ...unsigned,
      buildInfo: { ...unsigned.buildInfo, source } }) }), /Windows 更新清单无效/u)
  }
  for (const version of ['v1.0', 'v1.0.0', '1.0.0-rc.01', '1.0.0\n']) {
    await assert.rejects(prepareWindowsUpdate({ ...args, manifest: signTestManifest({ ...unsigned, version,
      buildInfo: { ...unsigned.buildInfo, version } }) }), /Windows 更新清单无效/u)
  }
})

for (const version of ['0.1.0-beta.12', '0.1.0-beta.12.1', '1.0.0-rc.1', '1.0.0', '1.0.0+build.001']) test(`Windows 安装脚本支持 ${version}，等待退出、重查哈希、验证新构建并有回退路径`, () => {
  const script = windowsInstallScript({ pid: 1234, setup: 'C:\\Users\\A B\\cache.exe', target: 'C:\\Users\\A B\\ASTaria',
    staging: 'C:\\Users\\A B\\staging', resultFile: 'C:\\Users\\A B\\result', health: 'C:\\Users\\A B\\staging\\started',
    sha256: 'a'.repeat(64), version, commit: 'b'.repeat(40) })
  for (const expected of ['WaitForExit', 'Get-FileHash', 'Move-Item', 'Start-Process', 'build-info.json',
    'expectedVersion', 'expectedCommit', 'taskkill.exe', "'installed'", "'failed'", "'recovery-required'"]) assert.ok(script.includes(expected), expected)
  assert.ok(!script.includes('C:\\Users\\A B'), '路径作为编码后的数据进入脚本')
  assert.ok(script.includes(`$expectedVersion = '${version}'`))
  assert.throws(() => windowsInstallScript({ pid: 0 }), /参数无效/u)
})

test('Windows 安装脚本拒绝非 canonical 版本、前导零与注入', () => {
  for (const version of ['v1.0', 'v1.0.0', '1.0', '01.0.0', '1.0.0-beta.012.1', '1.0.0-rc.01',
    '1.0.0\n', "1.0.0'; Write-Output 'injected", '1.0.0$(whoami)', null, undefined]) {
    assert.throws(() => windowsInstallScript({ pid: 1234, setup: 'C:\\cache.exe', target: 'C:\\Programs\\ASTaria',
      staging: 'C:\\Programs\\.astaria-win-update-test', resultFile: 'C:\\state\\result',
      health: 'C:\\Programs\\.astaria-win-update-test\\started', sha256: 'a'.repeat(64), version,
      commit: 'b'.repeat(40) }), /参数无效/u, String(version))
  }
})

test('Windows 更新器从安装目录外启动，允许安装目录被移走', async () => {
  const prepared = { setup: 'C:\\Users\\A B\\cache.exe', target: 'C:\\Users\\A B\\Programs\\ASTaria',
    staging: 'C:\\Users\\A B\\Programs\\.astaria-win-update-test', resultFile: 'C:\\Users\\A B\\result',
    health: 'C:\\Users\\A B\\Programs\\.astaria-win-update-test\\started',
    sha256: 'a'.repeat(64), version: '0.1.0-beta.12.1', commit: 'b'.repeat(40) }
  let launched
  await launchWindowsUpdate(prepared, 1234, (file, args, options) => {
    launched = { file, args, options }
    const child = new EventEmitter()
    child.unref = () => {}
    queueMicrotask(() => child.emit('spawn'))
    return child
  })
  assert.equal(launched.file, 'powershell.exe')
  assert.equal(launched.options.cwd, win32.dirname(prepared.staging))
  assert.notEqual(launched.options.cwd, prepared.target)
  assert.equal(launched.options.detached, true)
  assert.ok(launched.args.includes('-EncodedCommand'))
  const script = Buffer.from(launched.args[launched.args.indexOf('-EncodedCommand') + 1], 'base64').toString('utf16le')
  assert.ok(script.includes("$expectedVersion = '0.1.0-beta.12.1'"))
  assert.ok(script.includes(`$expectedHash = '${prepared.sha256}'`))
  assert.ok(script.includes(`$expectedCommit = '${prepared.commit}'`))
})

test('脚本生成失败也写 failed 并清理已验证 prepared.staging，保留当前安装与安装包', async t => {
  const { args, executable } = await setupFixture(t, '0.1.0-beta.12.1')
  const prepared = await prepareWindowsUpdate(args)
  assert.equal(await readFile(prepared.resultFile, 'utf8'), 'prepared')
  assert.equal((await lstat(prepared.staging)).isDirectory(), true)
  let launched = false
  await assert.rejects(launchWindowsUpdate(prepared, 0, () => { launched = true }), /参数无效/u)
  assert.equal(launched, false)
  assert.equal(await readFile(prepared.resultFile, 'utf8'), 'failed')
  await assert.rejects(lstat(prepared.staging), { code: 'ENOENT' })
  assert.equal(await readFile(executable, 'utf8'), 'old app')
  assert.equal(await readFile(prepared.setup, 'utf8'), 'setup fixture')
})

test('PowerShell 无法启动时留下明确失败状态并清理暂存目录', async () => {
  const prepared = { setup: 'C:\\cache.exe', target: 'C:\\Programs\\ASTaria',
    staging: 'C:\\Programs\\.astaria-win-update-test', resultFile: 'C:\\state\\result',
    health: 'C:\\Programs\\.astaria-win-update-test\\started',
    sha256: 'a'.repeat(64), version: '0.1.0-beta.12', commit: 'b'.repeat(40) }
  const actions = []
  await assert.rejects(launchWindowsUpdate(prepared, 1234, () => {
    const child = new EventEmitter()
    queueMicrotask(() => child.emit('error', new Error('powershell blocked')))
    return child
  }, { writeFile: async (...args) => { actions.push(['write', ...args]) },
    rm: async (...args) => { actions.push(['remove', ...args]) } }), /powershell blocked/u)
  assert.deepEqual(actions, [['write', prepared.resultFile, 'failed'],
    ['remove', prepared.staging, { recursive: true, force: true }]])
})
