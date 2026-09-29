import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, cp, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { INSTALL_SCRIPT, validateUpdateBundle, prepareMacUpdate, acknowledgeMacUpdate } from '../desktop/updateInstaller.mjs'
const run = promisify(execFile)
const manifest = { version: '0.1.0-beta.3', arch: 'arm64', appCDHash: 'a'.repeat(40), buildInfo: { builtAt: '2026-09-29T00:00:00Z', source: { commit: 'b'.repeat(40) } } }
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
  const prepared = await prepareMacUpdate({ appBundle: f.app, path: join(f.root, 'payload.dmg'), manifest, resultFile: join(f.root, 'result'), run: async (tool, args) => {
    commands.push([tool, args])
    if (tool.endsWith('/hdiutil')) { if (args[0] === 'attach') await cp(f.app, join(args[4], 'ASTaria.app'), { recursive: true }); return {} }
    if (tool.endsWith('/ditto')) { await cp(args[0], args[1], { recursive: true }); return {} }
    return f.execute(tool, args)
  } })
  assert.equal(await readFile(join(f.app, 'Contents/MacOS/Electron'), 'utf8'), 'binary')
  assert.equal(prepared.executable, 'Electron')
  assert.ok(commands.some(([tool, args]) => tool.endsWith('/hdiutil') && args[0] === 'detach'))
  await symlink(f.app, join(f.root, 'linked.app'))
  await assert.rejects(prepareMacUpdate({ appBundle: join(f.root, 'linked.app'), path: '', manifest, resultFile: '' }), /结构/)
})
for (const success of [true, false]) test(`atomic replacement ${success ? 'waits for startup acknowledgement' : 'rolls back a crashed new app'}`, async t => {
  const f = await fixture(t), staging = await mkdtemp(join(f.root, '.astaria-update-'))
  const newApp = join(staging, 'ASTaria.app')
  await cp(f.app, newApp, { recursive: true })
  await writeFile(join(newApp, 'Contents/MacOS/Electron'), success ? '#!/bin/sh\nprintf ready > "$2"\nsleep 1\n' : '#!/bin/sh\nexit 1\n', { mode: 0o700 })
  // cp preserves the existing mode; executable permission is set explicitly.
  const { chmod } = await import('node:fs/promises'); await chmod(join(newApp, 'Contents/MacOS/Electron'), 0o700)
  const script = join(staging, 'install.sh'), result = join(f.root, 'result')
  await writeFile(script, INSTALL_SCRIPT)
  const inode = (await stat(f.app)).ino
  let failed = false
  try { await run('/bin/sh', [script, '2147483647', f.app, staging, result, 'Electron'], { timeout: 10000 }) } catch { failed = true }
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
