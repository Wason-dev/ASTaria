import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { RELEASE_KEYS, verifyReleaseManifest } from './releaseTrust.mjs'
import { verifyAsset } from './updateDownload.mjs'

const execute = promisify(execFile)
const inside = (value, root) => value === root || value.startsWith(`${root}${sep}`)

// Every path is an argv value, never executable shell text. Both renamed Contents
// directories live on the destination volume so replacement/rollback are atomic.
export const INSTALL_SCRIPT = `#!/bin/sh
set -eu
pid="$1"; target="$2"; staging="$3"; result="$4"; executable="$5"; expectedHash="$6"
new="$staging/ASTaria.app"; old="$staging/previous.app"; health="$staging/started"
moved=0; launched=""
restore() {
  code=$?
  if [ "$code" -ne 0 ]; then
    if [ -n "$launched" ]; then
      /bin/kill "$launched" 2>/dev/null || true
      /bin/sleep 1
      /bin/kill -9 "$launched" 2>/dev/null || true
    fi
    if [ "$moved" -eq 1 ] && [ -d "$old" ]; then
      if [ -d "$target/Contents" ] && [ ! -e "$new/Contents" ]; then /bin/mv "$target/Contents" "$new/Contents"; fi
      if [ ! -e "$target/Contents" ]; then /bin/mv "$old/Contents" "$target/Contents"; fi
    fi
    /usr/bin/printf '%s' 'failed' > "$result"
    if [ -d "$target" ]; then /usr/bin/open "$target" || true; fi
  fi
}
trap restore EXIT
count=0
while /bin/kill -0 "$pid" 2>/dev/null; do
  count=$((count + 1)); [ "$count" -lt 300 ] || exit 1
  /bin/sleep 0.2
done
[ -d "$new" ] && [ ! -L "$new" ] && [ -d "$target" ] && [ ! -L "$target" ] && [ ! -e "$old" ] && [ ! -e "$health" ]
# The running application may take time to quit. Revalidate after that wait,
# immediately before replacement, against the authenticated release CDHash.
/usr/bin/codesign --verify --deep --strict "$new"
actualHash=$(/usr/bin/codesign --display --verbose=4 "$new" 2>&1 | /usr/bin/sed -n 's/^CDHash=//p')
[ -n "$expectedHash" ] && [ "$actualHash" = "$expectedHash" ]
# Keep the outer bundle inode so Finder aliases continue to find this App.
[ -d "$target/Contents" ] && [ ! -L "$target/Contents" ] && [ -d "$new/Contents" ] && [ ! -L "$new/Contents" ]
/bin/mkdir "$old"
/bin/mv "$target/Contents" "$old/Contents"
moved=1
/bin/mv "$new/Contents" "$target/Contents"
"$target/Contents/MacOS/$executable" --astaria-update-health "$health" &
launched=$!
count=0
while [ ! -f "$health" ]; do
  /bin/kill -0 "$launched" 2>/dev/null || exit 1
  count=$((count + 1)); [ "$count" -lt 225 ] || exit 1
  /bin/sleep 0.2
done
[ ! -L "$health" ] && [ "$(/bin/cat "$health")" = 'ready' ]
/usr/bin/printf '%s' 'installed' > "$result"
trap - EXIT
# Keep one recovery copy. All of it is inside our private, same-volume staging.
`

/** Acknowledge only an update launched from our own adjacent private staging. */
export async function acknowledgeMacUpdate(appBundle, health) {
  const target = resolve(appBundle), staging = dirname(health), info = await lstat(staging)
  let targetParent, stagingParent, stagingCanonical
  try {
    [targetParent, stagingParent, stagingCanonical] = await Promise.all([
      realpath(dirname(target)), realpath(dirname(staging)), realpath(staging),
    ])
  } catch {
    throw new Error('Invalid update acknowledgement')
  }
  if (basename(health) !== 'started' || stagingParent !== targetParent
    || dirname(stagingCanonical) !== targetParent || basename(stagingCanonical) !== basename(staging)
    || !basename(staging).startsWith('.astaria-update-')
    || !info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Invalid update acknowledgement')
  await regular(join(staging, 'previous.app'), true)
  await writeFile(health, 'ready', { flag: 'wx', mode: 0o600 })
}

async function regular(path, directory = false) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) throw new Error('更新包结构无效')
}

async function safeLinks(directory, root = directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) {
      if (!inside(await realpath(path), root)) throw new Error('更新包包含外部链接')
    } else if (entry.isDirectory()) await safeLinks(path, root)
  }
}

function installLocationError(reason) {
  return new Error(`请先把 ASTaria 移到可写的应用目录：${reason}`)
}

function isMountedImagePath(path) {
  const value = path.toLowerCase()
  return value === '/volumes' || value.startsWith('/volumes/')
}

function isAppTranslocationPath(path) {
  return path.toLowerCase().includes('/apptranslocation/')
}

/**
 * Resolve the location that the running app can replace safely.
 *
 * The bundle itself must be a real directory. Parent aliases are harmless on
 * macOS (and /Applications can be represented by a firmlink), so only the
 * bundle symlink is rejected; all policy checks also run against its canonical
 * parent to catch a DMG or App Translocation path hidden behind an alias.
 */
async function validateInstallLocation(appBundle) {
  const target = resolve(appBundle)
  if (basename(target) !== 'ASTaria.app') {
    throw installLocationError('应用包结构无效，必须命名为 ASTaria.app')
  }

  let targetInfo
  try {
    targetInfo = await lstat(target)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw installLocationError('找不到当前应用包')
    }
    throw installLocationError('无法访问当前应用包')
  }
  if (targetInfo.isSymbolicLink()) {
    throw installLocationError('当前应用是符号链接或 Finder 替身，请复制实际的 ASTaria.app')
  }
  if (!targetInfo.isDirectory()) {
    throw installLocationError('当前应用包不是有效的目录')
  }

  const parent = dirname(target)
  let canonicalParent
  try {
    canonicalParent = await realpath(parent)
  } catch {
    throw installLocationError('无法解析当前应用所在目录')
  }
  const canonicalTarget = join(canonicalParent, basename(target))
  const paths = [target, parent, canonicalTarget, canonicalParent]
  if (paths.some(isMountedImagePath)) {
    throw installLocationError('当前应用仍在磁盘映像（/Volumes）中运行，请先拖入“应用程序”文件夹')
  }
  if (paths.some(isAppTranslocationPath)) {
    throw installLocationError('当前应用由 macOS App Translocation 临时运行，请先移动到“应用程序”文件夹后重新打开')
  }

  try {
    await access(parent, constants.W_OK)
  } catch {
    throw installLocationError('应用所在目录不可写')
  }
  try {
    await access(target, constants.W_OK)
  } catch {
    throw installLocationError('当前应用包不可写')
  }
  return { target, parent, canonicalParent }
}

/** Verify identity, exact provenance and sealed resources before the running app exits. */
export async function validateUpdateBundle(bundle, manifest, run = execute) {
  await regular(bundle, true)
  await safeLinks(bundle)
  const payload = join(bundle, 'Contents', 'Resources', 'app')
  for (const path of [join(bundle, 'Contents', 'Info.plist'), join(payload, 'package.json'), join(payload, 'build-info.json')]) await regular(path)
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents', 'Info.plist')])
  const info = JSON.parse(stdout), pkg = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8'))
  const build = JSON.parse(await readFile(join(payload, 'build-info.json'), 'utf8'))
  if (info.CFBundleIdentifier !== 'dev.wason.ASTaria' || pkg.name !== 'astaria' || pkg.version !== manifest.version
    || build.version !== manifest.version || build.platform !== 'darwin' || build.arch !== manifest.arch
    || build.builtAt !== manifest.buildInfo?.builtAt || build.source?.commit !== manifest.buildInfo?.source?.commit
    || !/^[a-f0-9]{40,64}$/u.test(build.source?.commit ?? '') || build.source?.dirty !== false
    || !/^[A-Za-z0-9 _.-]+$/u.test(info.CFBundleExecutable ?? '') || info.CFBundleExecutable.startsWith('.')) throw new Error('App 身份或构建信息校验失败')
  const binary = join(bundle, 'Contents', 'MacOS', info.CFBundleExecutable)
  await regular(binary)
  const architecture = await run('/usr/bin/lipo', ['-archs', binary])
  if (architecture.stdout.trim() !== manifest.arch) throw new Error('App 与此设备架构不匹配')
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], { timeout: 120_000 })
  const signature = await run('/usr/bin/codesign', ['--display', '--verbose=4', bundle])
  const cdHash = /^CDHash=([a-f0-9]+)$/mu.exec(signature.stderr)?.[1]
  if (!/^[a-f0-9]{40,64}$/u.test(manifest.appCDHash ?? '') || cdHash !== manifest.appCDHash) throw new Error('App 签名与发布清单不一致')
  return info.CFBundleExecutable
}

export async function prepareMacUpdate({ appBundle, path: dmg, manifest, resultFile, run = execute, trustedKeys = RELEASE_KEYS }) {
  verifyReleaseManifest(manifest, trustedKeys)
  const { target, parent } = await validateInstallLocation(appBundle)
  const staging = await mkdtemp(join(parent, '.astaria-update-'))
  const mount = join(staging, 'image'), candidate = join(staging, 'ASTaria.app')
  let mounted = false, prepared = false, attachAttempted = false
  try {
    await mkdir(mount, { mode: 0o700 })
    await verifyAsset(dmg, manifest)
    attachAttempted = true
    await run('/usr/bin/hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, dmg], { timeout: 120_000 })
    mounted = true
    const source = join(mount, 'ASTaria.app')
    await validateUpdateBundle(source, manifest, run)
    await run('/usr/bin/ditto', [source, candidate], { timeout: 180_000 })
    const executable = await validateUpdateBundle(candidate, manifest, run)
    await run('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { timeout: 60_000 })
    mounted = false; attachAttempted = false
    const script = join(staging, 'install.sh')
    await writeFile(script, INSTALL_SCRIPT, { mode: 0o700, flag: 'wx' })
    await mkdir(dirname(resultFile), { recursive: true, mode: 0o700 })
    await writeFile(resultFile, 'prepared', { mode: 0o600 })
    prepared = true
    return { target, staging, resultFile, script, executable, appCDHash: manifest.appCDHash }
  } finally {
    if (mounted || attachAttempted) {
      mounted = true
      try { await run('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { timeout: 60_000 }); mounted = false } catch { /* Never recursively remove a mounted image. */ }
    }
    if (!prepared && !mounted) await rm(staging, { recursive: true, force: true })
  }
}

export async function launchMacUpdate(prepared, pid = process.pid) {
  // Execute this process's verified template, not a writable script path left
  // in staging while the application waits for outstanding work to finish.
  const child = spawn('/bin/sh', ['-s', '--', String(pid), prepared.target, prepared.staging, prepared.resultFile, prepared.executable, prepared.appCDHash], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] })
  child.stdin.on('error', () => {})
  child.stdin.end(INSTALL_SCRIPT)
  await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no) })
  child.unref()
}
