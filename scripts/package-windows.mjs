#!/usr/bin/env node
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyPayload, sourceProvenance } from './package-desktop.mjs'
import { copyServerDependencies } from './desktop-dependencies.mjs'
import { generateNotices } from './third-party-notices.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const run = (exe, args, cwd) => {
  const result = spawnSync(exe, args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(result.error?.message ?? result.stderr ?? `${exe} failed`)
  return result.stdout.trim()
}
const hash = async file => createHash('sha256').update(await readFile(file)).digest('hex')

export async function packageWindows({ runtime, out, makensis, rcedit }) {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  if (!/^\d+\.\d+\.\d+(?:-beta\.[1-9]\d*(?:\.(?:0|[1-9]\d*))?)?$/u.test(pkg.version)) throw new Error('Invalid package version')
  const stem = `ASTaria-${pkg.version}-win-x64`, release = join(out, stem)
  try { await stat(release); throw new Error('Output already exists') } catch (error) { if (error.code !== 'ENOENT') throw error }
  const binary = await readFile(join(runtime, 'electron.exe'))
  const pe = binary.readUInt32LE(0x3c)
  if (binary.toString('ascii', 0, 2) !== 'MZ' || binary.readUInt16LE(pe + 4) !== 0x8664) throw new Error('A clean x64 Windows Electron runtime is required')
  const resources = await readdir(join(runtime, 'resources'))
  if (resources.includes('app') || resources.includes('app.asar')) throw new Error('Runtime already contains an application')
  const notices = await generateNotices(ROOT)
  if (notices.missing.length || notices.review.length || notices.text !== await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8')) throw new Error('Third-party notices are stale')
  await mkdir(out, { recursive: true })
  const stage = await mkdtemp(join(out, '.astaria-windows-')), portable = join(stage, stem)
  await cp(runtime, portable, { recursive: true, errorOnExist: true, force: false })
  await rename(join(portable, 'electron.exe'), join(portable, 'ASTaria.exe'))
  if (rcedit) {
    const version = pkg.version.split('-')[0]
    run(rcedit, [join(portable, 'ASTaria.exe'), '--set-icon', join(ROOT, 'public', 'astaria.ico'),
      '--set-version-string', 'ProductName', 'ASTaria', '--set-version-string', 'FileDescription', 'ASTaria',
      '--set-version-string', 'CompanyName', 'Wason-dev', '--set-version-string', 'OriginalFilename', 'ASTaria.exe',
      '--set-file-version', version, '--set-product-version', version,
      '--set-version-string', 'ProductVersion', pkg.version])
  }
  const payload = join(portable, 'resources', 'app')
  await mkdir(payload)
  for (const name of ['desktop', 'server', 'src']) await copyPayload(join(ROOT, name), join(payload, name))
  await cp(join(ROOT, 'dist'), join(payload, 'dist'), { recursive: true })
  const dependencies = await copyServerDependencies(ROOT, payload)
  await writeFile(join(payload, 'package.json'), JSON.stringify({ name: 'astaria', productName: 'ASTaria', version: pkg.version, type: 'module', main: 'desktop/main.cjs', license: 'Apache-2.0' }, null, 2))
  for (const [source, target] of [['LICENSE', 'ASTARIA-LICENSE.txt'], ['NOTICE', 'ASTARIA-NOTICE.txt'], ['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'], ['third-party/gsap-3.15.0-LICENSE.txt', 'GSAP-LICENSE.txt']]) await copyFile(join(ROOT, source), join(portable, target))
  const instructions = await readFile(join(ROOT, 'install.txt'), 'utf8')
  await writeFile(join(stage, 'install.txt'), instructions)
  await writeFile(join(portable, 'install.txt'), instructions)
  const build = { schemaVersion: 1, name: 'ASTaria', version: pkg.version, platform: 'win32', arch: 'x64',
    builtAt: new Date().toISOString(), source: sourceProvenance(ROOT), signing: 'unsigned', serverDependencies: dependencies,
    runtimeExeSha256: createHash('sha256').update(binary).digest('hex'), executableSha256: await hash(join(portable, 'ASTaria.exe')),
    branded: Boolean(rcedit), gsapLicenseSha256: await hash(join(portable, 'GSAP-LICENSE.txt')) }
  await writeFile(join(payload, 'build-info.json'), JSON.stringify(build, null, 2))
  const archive = `${stem}-portable.zip`
  if (process.platform === 'darwin') run('/usr/bin/ditto', ['-c', '-k', '--keepParent', portable, join(stage, archive)])
  else run('tar', ['-a', '-cf', join(stage, archive), stem], stage)
  const installer = `${stem}-setup.exe`
  const uninstall = []
  async function removalList(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name)
      if (entry.isDirectory()) await removalList(path)
      else uninstall.push(`Delete "$INSTDIR\\${relative(portable, path).split(sep).join('\\')}"`)
    }
    if (folder !== portable) uninstall.push(`RMDir "$INSTDIR\\${relative(portable, folder).split(sep).join('\\')}"`)
  }
  await removalList(portable)
  uninstall.push('Delete "$INSTDIR\\Uninstall.exe"', 'RMDir "$INSTDIR"')
  const closeGuard = `IfFileExists "$INSTDIR\\ASTaria.exe" 0 astaria_closed
System::Call 'kernel32::CreateFileW(w "$INSTDIR\\ASTaria.exe", i 0x40000000, i 0, p 0, i 3, i 0, p 0) p .r0'
StrCmp $0 -1 0 astaria_close_handle
MessageBox MB_OK|MB_ICONEXCLAMATION "请先退出 ASTaria，再重试安装或卸载；程序文件正在使用或不可写。" /SD IDOK
SetErrorLevel 2
Abort
astaria_close_handle:
System::Call 'kernel32::CloseHandle(p r0)'
astaria_closed:
`
  await copyFile(join(ROOT, 'public', 'astaria.ico'), join(stage, 'astaria.ico'))
  const nsi = `Unicode true\nIcon "astaria.ico"\nUninstallIcon "astaria.ico"\nName "ASTaria"\nOutFile "${installer}"\nInstallDir "$LOCALAPPDATA\\Programs\\ASTaria"\nRequestExecutionLevel user\nSetCompressor /SOLID lzma\n!include "MUI2.nsh"\n!insertmacro MUI_PAGE_WELCOME\n!insertmacro MUI_PAGE_DIRECTORY\n!insertmacro MUI_PAGE_INSTFILES\n!insertmacro MUI_UNPAGE_CONFIRM\n!insertmacro MUI_UNPAGE_INSTFILES\n!insertmacro MUI_LANGUAGE "SimpChinese"\nSection\n${closeGuard}SetOutPath "$INSTDIR"\nFile /r "${stem}\\*"\nWriteUninstaller "$INSTDIR\\Uninstall.exe"\nCreateShortcut "$SMPROGRAMS\\ASTaria.lnk" "$INSTDIR\\ASTaria.exe"\nWriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ASTaria" "DisplayName" "ASTaria"\nWriteRegStr HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ASTaria" "UninstallString" '"$INSTDIR\\Uninstall.exe"'\nSectionEnd\nSection "Uninstall"\n${closeGuard}Delete "$SMPROGRAMS\\ASTaria.lnk"\nDeleteRegKey HKCU "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ASTaria"\n${uninstall.join('\n')}\nSectionEnd\n`
  await writeFile(join(stage, 'installer.nsi'), `\uFEFF${nsi}`)
  if (makensis) run(makensis, [join(stage, 'installer.nsi')], stage)
  const assets = []
  for (const name of [archive, ...(makensis ? [installer] : [])]) {
    const sha256 = await hash(join(stage, name)), sizeBytes = (await stat(join(stage, name))).size
    assets.push({ name, sha256, sizeBytes })
    await writeFile(join(stage, `${name}.sha256`), `${sha256}  ${name}\n`)
  }
  const setupAsset = assets.find(asset => asset.name === installer)
  await writeFile(join(stage, `${stem}.manifest.json`), JSON.stringify({ ...build, bundleId: 'dev.wason.ASTaria',
    ...(setupAsset ? { setup: installer, sha256: setupAsset.sha256, sizeBytes: setupAsset.sizeBytes } : {}),
    buildInfo: build, assets, instructions: 'install.txt', instructionsSha256: await hash(join(stage, 'install.txt')),
    nsisBuilt: Boolean(makensis), includesUserData: false }, null, 2))
  await rename(stage, release)
  return release
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), options = {}
    if (args.length === 1 && args[0] === '--help') { console.log('node scripts/package-windows.mjs --runtime <extracted Electron win32-x64> --out <directory> [--makensis <compiler>] [--rcedit <tool>]'); process.exit(0) }
    for (let i = 0; i < args.length; i += 2) {
      if (!['--runtime', '--out', '--makensis', '--rcedit'].includes(args[i]) || !args[i + 1]) throw new Error('Invalid packaging arguments')
      options[args[i].slice(2)] = resolve(args[i + 1])
    }
    if (!options.runtime || !options.out) throw new Error('--runtime and --out are required')
    console.log(`Built: ${await packageWindows(options)}`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
