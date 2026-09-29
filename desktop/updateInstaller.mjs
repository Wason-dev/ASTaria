import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { constants } from 'node:fs'
import { access, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'

const execute = promisify(execFile)
const inside = (value, root) => value === root || value.startsWith(`${root}${sep}`)

// Every path is an argv value, never executable shell text. Both renamed Contents
// directories live on the destination volume so replacement/rollback are atomic.
export const INSTALL_SCRIPT = `#!/bin/sh
set -eu
pid="$1"; target="$2"; staging="$3"; result="$4"; executable="$5"
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
  if (basename(health) !== 'started' || dirname(staging) !== dirname(target)
    || !basename(staging).startsWith('.astaria-update-') || await realpath(staging) !== staging
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

export async function prepareMacUpdate({ appBundle, path: dmg, manifest, resultFile, run = execute }) {
  const target = resolve(appBundle)
  await regular(target, true)
  if (basename(target) !== 'ASTaria.app' || await realpath(target) !== target || target.startsWith('/Volumes/') || target.includes('/AppTranslocation/')) {
    throw new Error('请先把 ASTaria 移到可写的应用目录，再使用自动安装')
  }
  await access(dirname(target), constants.W_OK)
  const staging = await mkdtemp(join(dirname(target), '.astaria-update-'))
  const mount = join(staging, 'image'), candidate = join(staging, 'ASTaria.app')
  let mounted = false, prepared = false, attachAttempted = false
  try {
    await mkdir(mount, { mode: 0o700 })
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
    return { target, staging, resultFile, script, executable }
  } finally {
    if (mounted || attachAttempted) {
      mounted = true
      try { await run('/usr/bin/hdiutil', ['detach', mount, '-quiet'], { timeout: 60_000 }); mounted = false } catch { /* Never recursively remove a mounted image. */ }
    }
    if (!prepared && !mounted) await rm(staging, { recursive: true, force: true })
  }
}

export async function launchMacUpdate(prepared, pid = process.pid) {
  const child = spawn('/bin/sh', [prepared.script, String(pid), prepared.target, prepared.staging, prepared.resultFile, prepared.executable], { detached: true, stdio: 'ignore' })
  await new Promise((yes, no) => { child.once('spawn', yes); child.once('error', no) })
  child.unref()
}
