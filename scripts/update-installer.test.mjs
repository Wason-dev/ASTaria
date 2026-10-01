import test from 'node:test'
import { createHash } from 'node:crypto'
import { signTestManifest, testReleaseKeys } from './fixtures/release-signing.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp, realpath, stat, readdir, chmod, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { promisify } from 'node:util'
import { INSTALL_SCRIPT, validateUpdateBundle, prepareMacUpdate, launchMacUpdate, acknowledgeMacUpdate } from '../desktop/updateInstaller.mjs'
const run = promisify(execFile)
const dmgBytes = Buffer.from('verified dmg fixture')
const manifest = signTestManifest({ sha256: createHash('sha256').update(dmgBytes).digest('hex'), sizeBytes: dmgBytes.length, version: '0.1.0-beta.3', arch: 'arm64', appCDHash: 'a'.repeat(40), buildInfo: { builtAt: '2026-09-29T00:00:00Z', source: { commit: 'b'.repeat(40) } } })
const build = { version: manifest.version, arch: 'arm64', platform: 'darwin', ...manifest.buildInfo, source: { ...manifest.buildInfo.source, dirty: false } }
const info = { CFBundleIdentifier: 'dev.wason.ASTaria', CFBundleExecutable: 'Electron' }
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "astaria-update-test-'$-")))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'ASTaria.app'), payload = join(app, 'Contents', 'Resources', 'app')
  await mkdir(payload, { recursive: true }); await mkdir(join(app, 'Contents', 'MacOS'))
  await writeFile(join(app, 'Contents', 'Info.plist'), 'placeholder')
  await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'astaria', version: manifest.version }))
  await writeFile(join(payload, 'build-info.json'), JSON.stringify(build))
  await writeFile(join(app, 'Contents', 'MacOS', 'Electron'), 'binary')
  const execute = async (tool, args) => {
    if (tool.endsWith('/plutil')) return { stdout: JSON.stringify(info) }
    if (tool.endsWith('/lipo')) return { stdout: 'arm64\n' }
    if (tool.endsWith('/codesign')) return { stderr: `CDHash=${manifest.appCDHash}\n` }
    throw Error(`Unexpected command ${tool} ${args}`)
  }
  return { root, app, payload, execute }
}
const installReason = reason => `请先把 ASTaria 移到可写的应用目录：${reason}`
const rejectsInstall = (promise, reason) => assert.rejects(promise, { message: installReason(reason) })
const installable = appBundle => prepareMacUpdate({ trustedKeys: testReleaseKeys, appBundle, path: '', manifest, resultFile: '' })
const directoryWritable = path => access(path, constants.W_OK).then(() => true, () => false)
// macOS publishes every mounted volume below /Volumes and exposes the boot
// volume through an alias there. Addressing a real bundle through that alias
// yields a genuine /Volumes path whose final directory is not a link, so only
// the disk image policy can reject it.
async function volumesMountPath(app) {
  let entries = []
  try { entries = await readdir('/Volumes') } catch { return null }
  for (const entry of entries) {
    const candidate = join('/Volumes', entry, app)
    try { if (await realpath(candidate) === app) return candidate } catch { /* This volume does not expose the bundle. */ }
  }
  return null
}
test('updater validates exact bundle identity, architecture, provenance and seal', async t => {
  const f = await fixture(t)
  assert.equal(await validateUpdateBundle(f.app, manifest, f.execute), 'Electron')
  for (const patch of [{ version: '9.0.0' }, { platform: 'win32' }, { arch: 'x64' }, { source: { ...build.source, dirty: true } }, { builtAt: 'different' }]) {
    await writeFile(join(f.payload, 'build-info.json'), JSON.stringify({ ...build, ...patch }))
    await assert.rejects(validateUpdateBundle(f.app, manifest, f.execute), /身份|构建/)
  }
  await writeFile(join(f.payload, 'build-info.json'), JSON.stringify(build))
  await assert.rejects(validateUpdateBundle(f.app, { ...manifest, appCDHash: 'c'.repeat(40) }, f.execute), /签名/)
  await assert.rejects(validateUpdateBundle(f.app, manifest, async (tool, args) => tool.endsWith('/lipo') ? { stdout: 'x86_64' } : f.execute(tool, args)), /架构/)
  await assert.rejects(validateUpdateBundle(f.app, manifest, async (tool, args) => { if (args[0] === '--verify') throw Error('invalid seal'); return f.execute(tool, args) }), /invalid seal/)
  await symlink(tmpdir(), join(f.app, 'outside'))
  await assert.rejects(validateUpdateBundle(f.app, manifest, f.execute), /外部链接/)
})
test('preparing a copied app never changes the existing app; rejects aliases', async t => {
  const f = await fixture(t), commands = []
  await writeFile(join(f.root, 'payload.dmg'), dmgBytes)
  const prepared = await prepareMacUpdate({ trustedKeys: testReleaseKeys, appBundle: f.app, path: join(f.root, 'payload.dmg'), manifest, resultFile: join(f.root, 'result'), run: async (tool, args) => {
    commands.push([tool, args])
    if (tool.endsWith('/hdiutil')) { if (args[0] === 'attach') await cp(f.app, join(args[4], 'ASTaria.app'), { recursive: true }); return {} }
    if (tool.endsWith('/ditto')) { await cp(args[0], args[1], { recursive: true }); return {} }
    return f.execute(tool, args)
  } })
  assert.equal(await readFile(join(f.app, 'Contents/MacOS/Electron'), 'utf8'), 'binary')
  assert.equal(prepared.executable, 'Electron')
  assert.ok(commands.some(([tool, args]) => tool.endsWith('/hdiutil') && args[0] === 'detach'))
  await symlink(f.app, join(f.root, 'linked.app'))
  await assert.rejects(prepareMacUpdate({ trustedKeys: testReleaseKeys, appBundle: join(f.root, 'linked.app'), path: '', manifest, resultFile: '' }), /结构/)
})

test('a real app behind a parent alias remains eligible for automatic updates', async t => {
  const f = await fixture(t), commands = [], aliasParent = join(f.root, 'Applications')
  await symlink(f.root, aliasParent)
  const appBundle = join(aliasParent, 'ASTaria.app')
  await writeFile(join(f.root, 'payload.dmg'), dmgBytes)
  const prepared = await prepareMacUpdate({ trustedKeys: testReleaseKeys, appBundle, path: join(f.root, 'payload.dmg'), manifest,
    resultFile: join(f.root, 'result'), run: async (tool, args) => {
      commands.push([tool, args])
      if (tool.endsWith('/hdiutil')) { if (args[0] === 'attach') await cp(f.app, join(args[4], 'ASTaria.app'), { recursive: true }); return {} }
      if (tool.endsWith('/ditto')) { await cp(args[0], args[1], { recursive: true }); return {} }
      return f.execute(tool, args)
    } })
  assert.equal(prepared.target, appBundle)
  assert.ok(commands.some(([tool, args]) => tool.endsWith('/hdiutil') && args[0] === 'detach'))
  await rm(prepared.staging, { recursive: true, force: true })
})

test('apps launched from App Translocation are rejected with a specific reason', async t => {
  const f = await fixture(t), location = join(f.root, 'AppTranslocation', 'Data', 'ASTaria.app')
  await mkdir(join(f.root, 'AppTranslocation', 'Data'), { recursive: true })
  await cp(f.app, location, { recursive: true })
  await assert.rejects(prepareMacUpdate({ trustedKeys: testReleaseKeys, appBundle: location, path: '', manifest, resultFile: '' }), /App Translocation/u)
})

test('an ASTaria.app symbolic link is rejected as a Finder alias with the exact reason', async t => {
  const f = await fixture(t), aliases = join(f.root, 'aliases')
  await mkdir(aliases)
  const link = join(aliases, 'ASTaria.app')
  await symlink(f.app, link)
  // The basename is genuine, so only the bundle symlink check may reject it.
  await rejectsInstall(installable(link), '当前应用是符号链接或 Finder 替身，请复制实际的 ASTaria.app')
  assert.deepEqual(await readdir(aliases), ['ASTaria.app'], '被拒绝的替身不会留下暂存目录')
})

test('an app addressed through a /Volumes mount is rejected with the exact disk image reason', async t => {
  const f = await fixture(t)
  const mounted = await volumesMountPath(f.app)
  if (!mounted) { t.skip('此环境没有可通过 /Volumes 访问的挂载点'); return }
  assert.equal(await realpath(mounted), f.app, '/Volumes 路径必须指向真实应用包而不是替身')
  await rejectsInstall(installable(mounted), '当前应用仍在磁盘映像（/Volumes）中运行，请先拖入“应用程序”文件夹')
})

test('a read-only parent directory is rejected with the exact reason', async t => {
  const f = await fixture(t), parent = join(f.root, 'readonly')
  await mkdir(parent)
  const app = join(parent, 'ASTaria.app')
  await cp(f.app, app, { recursive: true })
  await chmod(parent, 0o500)
  try {
    if (await directoryWritable(parent)) { t.skip('此环境忽略目录写权限位，无法验证只读父目录'); return }
    await rejectsInstall(installable(app), '应用所在目录不可写')
    assert.deepEqual(await readdir(parent), ['ASTaria.app'], '拒绝发生在创建暂存目录之前')
  } finally { await chmod(parent, 0o700) }
})

test('an unwritable app bundle is rejected with the exact reason', async t => {
  const f = await fixture(t), parent = join(f.root, 'writable')
  await mkdir(parent)
  const app = join(parent, 'ASTaria.app')
  await cp(f.app, app, { recursive: true })
  await chmod(app, 0o500)
  try {
    if (await directoryWritable(app)) { t.skip('此环境忽略目录写权限位，无法验证不可写应用包'); return }
    assert.equal(await directoryWritable(parent), true, '父目录仍可写，只有应用包本身不可写')
    await rejectsInstall(installable(app), '当前应用包不可写')
    assert.deepEqual(await readdir(parent), ['ASTaria.app'], '拒绝发生在创建暂存目录之前')
  } finally { await chmod(app, 0o700) }
})

test('every install location failure names its own reason', async t => {
  const f = await fixture(t), plain = join(f.root, 'plain')
  await mkdir(plain)
  await writeFile(join(plain, 'ASTaria.app'), 'not a bundle')
  const cases = [
    [join(f.root, 'missing', 'ASTaria.app'), '找不到当前应用包'],
    [join(plain, 'ASTaria.app'), '当前应用包不是有效的目录'],
    [join(plain, 'ASTaria Beta.app'), '应用包结构无效，必须命名为 ASTaria.app'],
  ]
  for (const [appBundle, reason] of cases) await rejectsInstall(installable(appBundle), reason)
})

for (const success of [true, false]) test(`atomic replacement ${success ? 'waits for startup acknowledgement' : 'rolls back a crashed new app'}`, async t => {
  const f = await fixture(t), staging = await mkdtemp(join(f.root, '.astaria-update-'))
  const newApp = join(staging, 'ASTaria.app')
  await cp(f.app, newApp, { recursive: true })
  await writeFile(join(newApp, 'Contents/MacOS/Electron'), success ? '#!/bin/sh\nprintf ready > "$2"\nsleep 1\n' : '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  // cp preserves the existing mode; executable permission is set explicitly.
  const { chmod } = await import('node:fs/promises'); await chmod(join(newApp, 'Contents/MacOS/Electron'), 0o700)
  const script = join(staging, 'install.sh'), result = join(f.root, 'result')
  const verifier = join(f.root, 'codesign')
  await writeFile(verifier, '#!/bin/sh\nif [ \"$1\" = \"--display\" ]; then echo CDHash=' + manifest.appCDHash + ' >&2; fi\n', {mode:0o700})
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  await writeFile(script, INSTALL_SCRIPT.replaceAll('/usr/bin/codesign', quote(verifier)))
  const inode = (await stat(f.app)).ino
  let failed = false
  try { await run('/bin/sh', [script, '2147483647', f.app, staging, result, 'Electron', manifest.appCDHash], { timeout: 10000 }) } catch { failed = true }
  assert.equal((await stat(f.app)).ino, inode, "outer app inode and Finder aliases survive replacement")
  assert.equal(failed, !success)
  assert.equal(await readFile(result, 'utf8'), success ? 'installed' : 'failed')
  assert.equal(await readFile(join(success ? join(staging, 'previous.app') : f.app, 'Contents/MacOS/Electron'), 'utf8'), 'binary')
})
test('startup acknowledgements cannot write to arbitrary paths', async t => {
  const f = await fixture(t)
  await assert.rejects(acknowledgeMacUpdate(f.app, join(f.root, 'started')), /Invalid/)
  const staging = await mkdtemp(join(f.root, '.astaria-update-'))
  await mkdir(join(staging, 'previous.app'))
  await acknowledgeMacUpdate(f.app, join(staging, 'started'))
  assert.equal(await readFile(join(staging, 'started'), 'utf8'), 'ready')
  await assert.rejects(acknowledgeMacUpdate(f.app, join(staging, 'started')), /EEXIST/)
})

for (const rejection of ['seal', 'cdhash']) test(`post-exit ${rejection} rejection keeps the original bundle untouched`, { timeout: 10000 }, async t => {
  const f = await fixture(t)
  await writeFile(join(f.root, 'payload.dmg'), dmgBytes)
  const prepared = await prepareMacUpdate({ trustedKeys: testReleaseKeys, appBundle: f.app, path: join(f.root, 'payload.dmg'), manifest,
    resultFile: join(f.root, 'result'), run: async (tool, args) => {
      if (tool.endsWith('/hdiutil')) { if (args[0] === 'attach') await cp(f.app, join(args[4], 'ASTaria.app'), { recursive: true }); return {} }
      if (tool.endsWith('/ditto')) { await cp(args[0], args[1], { recursive: true }); return {} }
      return f.execute(tool, args)
    } })
  const inode = (await stat(f.app)).ino, quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const verifier = join(f.root, 'final-codesign'), calls = join(f.root, 'verifier-calls')
  await writeFile(verifier, `#!/bin/sh
printf '%s\\n' "$1" >> ${quote(calls)}
for bundle do :; done
if [ "$1" = '--verify' ]; then
  ${rejection === 'seal' ? '[ "$(cat "$bundle/Contents/MacOS/Electron")" = binary ] || exit 1' : 'exit 0'}
else
  printf '%s\\n' 'CDHash=${'c'.repeat(40)}' >&2
fi
`, { mode: 0o700 })
  const waiting = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const stopped = once(waiting, 'exit')
  t.after(() => waiting.kill('SIGKILL'))
  const child = spawn('/bin/sh', ['-s', '--', String(waiting.pid), prepared.target, prepared.staging,
    prepared.resultFile, prepared.executable, prepared.appCDHash], { stdio: ['pipe', 'pipe', 'pipe'] })
  t.after(() => child.kill('SIGKILL'))
  const finished = once(child, 'exit')
  let output = ''
  const enteredWait = new Promise(resolve => child.stdout.on('data', chunk => { output += chunk; if (output.includes('waiting')) resolve() }))
  // Substitute only external OS commands and expose the actual exit-wait loop.
  // The production check order, hash comparison and replacement code all run.
  child.stdin.end(INSTALL_SCRIPT.replaceAll('/usr/bin/codesign', quote(verifier)).replaceAll('/usr/bin/open', '/usr/bin/true')
    .replace('while /bin/kill -0 "$pid" 2>/dev/null; do\n', 'while /bin/kill -0 "$pid" 2>/dev/null; do\nprintf "waiting\\n"\n'))
  await enteredWait
  await assert.rejects(readFile(calls), { code: 'ENOENT' }, 'verification must not run before the old app exits')
  await writeFile(join(prepared.staging, 'ASTaria.app/Contents/MacOS/Electron'), 'tampered after preparation')
  waiting.kill(); await stopped
  const [code] = await finished
  assert.notEqual(code, 0)
  assert.equal(await readFile(prepared.resultFile, 'utf8'), 'failed')
  assert.equal((await stat(f.app)).ino, inode)
  assert.equal(await readFile(join(f.app, 'Contents/MacOS/Electron'), 'utf8'), 'binary')
  await assert.rejects(stat(join(prepared.staging, 'previous.app')), { code: 'ENOENT' }, 'rejection happens before moving the original Contents')
  await assert.rejects(stat(join(prepared.staging, 'started')), { code: 'ENOENT' })
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n'), rejection === 'seal' ? ['--verify'] : ['--verify', '--display'])
})

test('launching an update ignores a writable staging script', { timeout: 10000 }, async t => {
  const f = await fixture(t), staging = await mkdtemp(join(f.root, '.astaria-update-'))
  const script = join(staging, 'install.sh'), marker = join(staging, 'untrusted-executed'), resultFile = join(staging, 'result')
  await writeFile(script, '#!/bin/sh\ntouch "$(dirname "$0")/untrusted-executed"\n')
  // A missing target safely stops the genuine template before codesign, launch
  // or replacement, while a path-based implementation would run the poison.
  await launchMacUpdate({ script, target: join(f.root, 'missing.app'), staging, resultFile,
    executable: 'Electron', appCDHash: manifest.appCDHash }, 2147483647)
  let result
  for (let attempt = 0; attempt < 100 && result === undefined; attempt++) {
    try { result = await readFile(resultFile, 'utf8') } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  assert.equal(result, 'failed')
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})
