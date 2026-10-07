#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { signTestManifest, testReleaseKeys } from './fixtures/release-signing.mjs'
import { prepareWindowsUpdate, windowsInstallScript } from '../desktop/windowsUpdateInstaller.mjs'

if (process.platform !== 'win32' || process.argv.length !== 5) {
  console.error('Usage (Windows): node scripts/windows-update-acceptance.mjs <setup.exe> <previous app directory> <test root>')
  process.exit(2)
}

const [setup, previous, base] = process.argv.slice(2).map(value => resolve(value))
const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ASTaria'
const shortcut = join(process.env.APPDATA ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ASTaria.lnk')
assert.ok(process.env.APPDATA && process.env.LOCALAPPDATA, 'Windows profile directories are required')
assert.equal(spawnSync('reg.exe', ['query', uninstallKey], { windowsHide: true }).status, 1,
  'The user already has an ASTaria uninstall entry; do not overwrite it')
await assert.rejects(stat(shortcut), { code: 'ENOENT' }, 'The user already has an ASTaria shortcut; do not overwrite it')
const sandbox = await mkdtemp(join(base, 'native acceptance-'))
const localAppData = join(sandbox, 'Local AppData')
const appData = join(sandbox, 'Roaming AppData')
const target = join(localAppData, 'Programs', 'ASTaria')
const resultFile = join(sandbox, 'update-result.txt')
const manifestPath = join(dirname(setup), 'ASTaria-0.1.0-beta.11-win-x64.manifest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
assert.equal(manifest.source?.dirty, false, 'Only a clean package may be used for this acceptance run')
assert.equal(manifest.setup, setup.split(/[\\/]/u).at(-1))
await mkdir(dirname(target), { recursive: true })
await mkdir(appData)
await cp(previous, target, { recursive: true })
const previousBuild = await readFile(join(target, 'resources', 'app', 'build-info.json'), 'utf8')
const signed = signTestManifest(manifest)

async function runInstaller(prepared, expectedCommit, profile) {
  const script = windowsInstallScript({ ...prepared, pid: 999999, commit: expectedCommit })
    .replace('} catch {\n', '} catch {\n  [Console]::Error.WriteLine($_.Exception.Message)\n  [Console]::Error.WriteLine($_.InvocationInfo.PositionMessage)\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    cwd: dirname(prepared.staging),
    env: { ...process.env, APPDATA: profile.appData, LOCALAPPDATA: profile.localAppData },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-4000) })
  const exitCode = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('Installer timed out')) }, 120_000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolveExit(code) })
  })
  assert.equal(exitCode, 0, output)
  return { status: (await readFile(prepared.resultFile, 'utf8')).trim(), output }
}

const args = { executable: join(target, 'ASTaria.exe'), localAppData, path: setup,
  manifest: signed, resultFile, trustedKeys: testReleaseKeys }
try {
  let prepared = await prepareWindowsUpdate(args)
  const wrongCommit = manifest.source.commit === 'f'.repeat(40) ? 'e'.repeat(40) : 'f'.repeat(40)
  const rollback = await runInstaller(prepared, wrongCommit, { appData, localAppData })
  assert.equal(rollback.status, 'failed', `Identity mismatch must roll back: ${rollback.output}`)
  assert.equal(await readFile(join(target, 'resources', 'app', 'build-info.json'), 'utf8'), previousBuild)
  await assert.rejects(stat(prepared.staging), { code: 'ENOENT' })
  console.log('ROLLBACK_PASSED', sandbox)

  const installSandbox = await mkdtemp(join(base, 'native install-'))
  const installLocalAppData = join(installSandbox, 'Local AppData')
  const installAppData = join(installSandbox, 'Roaming AppData')
  const installTarget = join(installLocalAppData, 'Programs', 'ASTaria')
  await mkdir(dirname(installTarget), { recursive: true })
  await mkdir(installAppData)
  await cp(previous, installTarget, { recursive: true })
  prepared = await prepareWindowsUpdate({ ...args, executable: join(installTarget, 'ASTaria.exe'),
    localAppData: installLocalAppData, resultFile: join(installSandbox, 'update-result.txt') })
  const install = await runInstaller(prepared, manifest.source.commit,
    { appData: installAppData, localAppData: installLocalAppData })
  assert.equal(install.status, 'installed', `Real package must install and start: ${install.output}`)
  const installed = JSON.parse(await readFile(join(installTarget, 'resources', 'app', 'build-info.json'), 'utf8'))
  assert.equal(installed.version, manifest.version)
  assert.equal(installed.source.commit, manifest.source.commit)
  assert.equal(installed.source.dirty, false)
  await assert.rejects(stat(prepared.staging), { code: 'ENOENT' })
  console.log('INSTALL_PASSED', installSandbox)
} finally {
  // NSIS writes these two per-user shell entries even when /D points to an
  // isolated directory. Both were verified absent before this test started.
  spawnSync('reg.exe', ['delete', uninstallKey, '/f'], { windowsHide: true })
  await rm(shortcut, { force: true })
}
