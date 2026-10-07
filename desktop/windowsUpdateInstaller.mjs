import { spawn } from 'node:child_process'
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, win32 } from 'node:path'

import { RELEASE_KEYS, verifyReleaseManifest } from './releaseTrust.mjs'
import { verifyAsset } from './updateDownload.mjs'

export function standardWindowsInstall(executable, localAppData) {
  if (!localAppData || !executable) return false
  return win32.normalize(executable).toLowerCase() === win32.join(localAppData, 'Programs', 'ASTaria', 'ASTaria.exe').toLowerCase()
}

const psString = value => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value, 'utf8').toString('base64')}'))`

export function windowsInstallScript({ pid, setup, target, staging, resultFile, health, sha256, version, commit }) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !/^[a-f0-9]{64}$/u.test(sha256)
    || !/^[a-f0-9]{40,64}$/u.test(commit) || !/^\d+\.\d+\.\d+(?:-beta\.\d+)?$/u.test(version)
    || [setup, target, staging, resultFile, health].some(value => typeof value !== 'string' || !win32.isAbsolute(value))
    || win32.dirname(health).toLowerCase() !== win32.normalize(staging).toLowerCase()) throw new Error('更新安装参数无效')
  return `$ErrorActionPreference = 'Stop'
$parentId = ${pid}
$setup = ${psString(setup)}
$target = ${psString(target)}
$staging = ${psString(staging)}
$resultFile = ${psString(resultFile)}
$health = ${psString(health)}
$expectedHash = '${sha256}'
$expectedVersion = '${version}'
$expectedCommit = '${commit}'
$previous = Join-Path $staging 'previous'
$moved = $false
$newProcess = $null
$restored = $true
try {
  $parent = Get-Process -Id $parentId -ErrorAction SilentlyContinue
  if ($parent) { [void]$parent.WaitForExit(60000) }
  if (Get-Process -Id $parentId -ErrorAction SilentlyContinue) { throw 'App did not exit' }
  if ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expectedHash) { throw 'Package changed' }
  if (-not (Test-Path -LiteralPath $target -PathType Container) -or (Test-Path -LiteralPath $previous)) { throw 'Install location changed' }
  Move-Item -LiteralPath $target -Destination $previous
  $moved = $true
  $install = Start-Process -FilePath $setup -ArgumentList ('/S /D=' + $target) -Wait -PassThru
  if ($install.ExitCode -ne 0) { throw ('Installer failed (exit code ' + $install.ExitCode + ')') }
  $exe = Join-Path $target 'ASTaria.exe'
  $buildPath = Join-Path $target 'resources\\app\\build-info.json'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'Installed App missing' }
  $build = Get-Content -LiteralPath $buildPath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($build.version -cne $expectedVersion -or $build.source.commit -cne $expectedCommit -or
      $build.source.dirty -ne $false -or $build.platform -cne 'win32' -or $build.arch -cne 'x64') { throw 'Installed App identity mismatch' }
  $newProcess = Start-Process -FilePath $exe -ArgumentList ('--astaria-update-health "' + $health + '"') -PassThru
  $deadline = [DateTime]::UtcNow.AddSeconds(50)
  while (-not (Test-Path -LiteralPath $health -PathType Leaf)) {
    if ($newProcess.HasExited -or [DateTime]::UtcNow -ge $deadline) { throw 'Updated App did not start' }
    Start-Sleep -Milliseconds 200
  }
  if ((Get-Content -LiteralPath $health -Raw -Encoding UTF8) -cne 'ready') { throw 'Updated App health check failed' }
  [IO.File]::WriteAllText($resultFile, 'installed')
  $moved = $false
  Remove-Item -LiteralPath $previous -Recurse -Force -ErrorAction SilentlyContinue
} catch {
  $restored = -not $moved
  if ($newProcess -and -not $newProcess.HasExited) {
    & taskkill.exe /PID $newProcess.Id /T /F 2>$null | Out-Null
    Start-Sleep -Milliseconds 500
  }
  if ($moved -and (Test-Path -LiteralPath $previous -PathType Container)) {
    $restored = $false
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not (Test-Path -LiteralPath $target)) {
      Move-Item -LiteralPath $previous -Destination $target -ErrorAction SilentlyContinue
      if (Test-Path -LiteralPath (Join-Path $target 'ASTaria.exe') -PathType Leaf) {
        $restored = $true
        Start-Process -FilePath (Join-Path $target 'ASTaria.exe') -ErrorAction SilentlyContinue
      }
    }
  }
  if ($moved -and -not $restored) { [IO.File]::WriteAllText($resultFile, 'recovery-required') }
  else { [IO.File]::WriteAllText($resultFile, 'failed') }
} finally {
  if ($restored -and -not (Test-Path -LiteralPath $previous)) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
}
`
}

export async function prepareWindowsUpdate({ executable, localAppData, path, manifest, resultFile, trustedKeys = RELEASE_KEYS }) {
  verifyReleaseManifest(manifest, trustedKeys)
  if (manifest.platform !== 'win32' || manifest.arch !== 'x64' || !path.toLowerCase().endsWith('.exe')
    || manifest.buildInfo?.version !== manifest.version || manifest.buildInfo?.source?.dirty !== false
    || !/^[a-f0-9]{40,64}$/u.test(manifest.buildInfo?.source?.commit ?? '')) throw new Error('Windows 更新清单无效')
  if (!standardWindowsInstall(executable, localAppData)) throw new Error('便携版或非标准安装位置请手动安装更新')
  const info = await lstat(executable)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('当前安装位置无效')
  await verifyAsset(path, manifest)
  const target = dirname(executable), parent = dirname(target)
  const targetInfo = await lstat(target)
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) throw new Error('当前安装位置无效')
  const root = await realpath(parent)
  if (win32.normalize(await realpath(target)).toLowerCase() !== win32.join(root, 'ASTaria').toLowerCase()) throw new Error('当前安装位置无效')
  const staging = await mkdtemp(join(root, '.astaria-win-update-'))
  const health = join(staging, 'started')
  await mkdir(dirname(resultFile), { recursive: true })
  await writeFile(resultFile, 'prepared')
  return { setup: path, target, staging, health, resultFile, sha256: manifest.sha256,
    version: manifest.version, commit: manifest.buildInfo.source.commit }
}

export async function acknowledgeWindowsUpdate(localAppData, health) {
  const staging = dirname(health), expectedParent = await realpath(join(localAppData, 'Programs'))
  const canonical = await realpath(staging), info = await lstat(staging)
  if (basename(health) !== 'started' || !basename(staging).startsWith('.astaria-win-update-')
    || dirname(canonical).toLowerCase() !== expectedParent.toLowerCase()
    || !info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid update acknowledgement')
  await writeFile(health, 'ready', { flag: 'wx' })
}

export async function launchWindowsUpdate(prepared, pid = process.pid, spawnProcess = spawn, files = { writeFile, rm }) {
  const script = windowsInstallScript({ ...prepared, pid })
  try {
    const child = spawnProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { cwd: win32.dirname(prepared.staging), detached: true, stdio: 'ignore', windowsHide: true })
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    child.unref()
  } catch (error) {
    await files.writeFile(prepared.resultFile, 'failed').catch(() => {})
    await files.rm(prepared.staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}
