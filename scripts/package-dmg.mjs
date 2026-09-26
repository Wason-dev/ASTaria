#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const USAGE = 'node scripts/package-dmg.mjs --app /path/to/ASTaria.app --out /path/to/output --instructions docs/INSTALL.md'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
function fail(message) { throw new Error(message) }
function run(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${command} failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`)
  return { stdout: result.stdout.trim(), stderr: result.stderr.trim() }
}
async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function requirePath(path, directory = false) {
  const info = await lstat(path)
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) fail(`Expected a regular ${directory ? 'directory' : 'file'}, not a symlink: ${path}`)
}
function inside(path, parent) {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
async function outputPath(path) {
  try { return await realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(await outputPath(dirname(path)), basename(path))
  }
}
export function argumentsFor(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1]
    if (!['--app', '--out', '--instructions'].includes(name) || !value || value.startsWith('--') || options[name]) fail(`Expected unique --app, --out and --instructions arguments.\n${USAGE}`)
    options[name] = resolve(value)
  }
  if (!options['--app'] || !options['--out'] || !options['--instructions']) fail(`All three arguments are required.\n${USAGE}`)
  return { app: options['--app'], out: options['--out'], instructions: options['--instructions'] }
}
async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
async function main() {
  const args = argumentsFor(process.argv.slice(2))
  if (!args) { console.log(USAGE); return }
  if (process.platform !== 'darwin') fail('DMG packaging requires macOS.')
  await requirePath(args.app, true)
  await requirePath(args.instructions)
  const app = await realpath(args.app)
  if (basename(app) !== 'ASTaria.app') fail('--app must name ASTaria.app.')
  const out = await outputPath(args.out)
  if (inside(out, app)) fail('Output must be outside the app bundle.')
  const payload = join(app, 'Contents', 'Resources', 'app')
  await requirePath(join(payload, 'package.json'))
  const pkg = JSON.parse(await readFile(join(payload, 'package.json'), 'utf8'))
  if (pkg.name !== 'astaria' || typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) fail('The app must contain a valid ASTaria package version.')
  const version = pkg.version, stem = `ASTaria-${version}-mac-arm64-adhoc`
  const names = [`${stem}.dmg`, `${stem}.dmg.sha256`, `${stem}.manifest.json`]
  for (const name of names) if (await exists(join(args.out, name))) fail(`Version output already exists; use a new version or output directory: ${name}`)
  const instructionsBytes = await readFile(args.instructions)
  if (!instructionsBytes.length || instructionsBytes.length > 2 * 1024 * 1024) fail('Installation instructions must be nonempty UTF-8 text under 2 MiB.')
  new TextDecoder('utf-8', { fatal: true }).decode(instructionsBytes)
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
  const signature = run('/usr/bin/codesign', ['--display', '--verbose=4', app]).stderr
  if (!/^Signature=adhoc$/mu.test(signature)) fail('This internal-beta DMG command requires an ad-hoc signed app.')
  const appCDHash = /^CDHash=([a-f0-9]+)$/mu.exec(signature)?.[1]
  if (!appCDHash) fail('The app signature does not report a CDHash.')
  const plist = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')]).stdout)
  if (typeof plist.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9 _.-]+$/u.test(plist.CFBundleExecutable)) fail('Unsupported app executable name.')
  if (run('/usr/bin/lipo', ['-archs', join(app, 'Contents', 'MacOS', plist.CFBundleExecutable)]).stdout !== 'arm64') fail('The app must contain only the arm64 architecture.')
  let buildInfo = null
  const buildInfoPath = join(payload, 'build-info.json')
  if (await exists(buildInfoPath)) {
    await requirePath(buildInfoPath)
    const info = JSON.parse(await readFile(buildInfoPath, 'utf8'))
    // Copy only the known, path-free provenance fields into the DMG manifest.
    if (info.version !== version || info.arch !== 'arm64') fail('App build provenance does not match its package.')
    const gitHash = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/u.test(value) ? value : null
    const source = { commit: gitHash(info.source?.commit), tree: gitHash(info.source?.tree),
      dirty: typeof info.source?.dirty === 'boolean' ? info.source.dirty : null }
    buildInfo = { schemaVersion: info.schemaVersion, version: info.version, source,
      electronVersion: info.electronVersion, buildNodeVersion: info.buildNodeVersion, builtAt: info.builtAt,
      packagerSha256: info.packagerSha256, packageLockSha256: info.packageLockSha256 }
  }
  await mkdir(out, { recursive: true })
  const staging = await mkdtemp(join(out, `.astaria-dmg-${version}-`))
  let published = false
  try {
    const imageRoot = join(staging, 'image')
    await mkdir(imageRoot)
    const copiedApp = join(imageRoot, 'ASTaria.app')
    run('/usr/bin/ditto', [app, copiedApp])
    await symlink('/Applications', join(imageRoot, 'Applications'))
    await writeFile(join(imageRoot, '安装与打开说明.txt'), instructionsBytes)
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', copiedApp])
    const dmg = join(staging, names[0])
    run('/usr/bin/hdiutil', ['create', '-volname', `ASTaria ${version}`, '-srcfolder', imageRoot, '-format', 'UDZO', dmg])
    run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', dmg])
    run('/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmg])
    run('/usr/bin/hdiutil', ['verify', dmg])
    const digest = await sha256(dmg)
    const manifest = { schemaVersion: 1, name: 'ASTaria', version, platform: 'darwin', arch: 'arm64',
      bundleId: plist.CFBundleIdentifier, signing: 'ad-hoc', notarized: false, builtAt: new Date().toISOString(),
      dmg: names[0], sha256: digest, sizeBytes: (await stat(dmg)).size, appCDHash, buildInfo,
      packagerSha256: await sha256(fileURLToPath(import.meta.url)),
      instructionsSha256: createHash('sha256').update(instructionsBytes).digest('hex'),
      contents: ['ASTaria.app', 'Applications', '安装与打开说明.txt'], imageVerified: true, appSignatureVerified: true }
    await writeFile(join(staging, names[1]), `${digest}  ${names[0]}\n`)
    await writeFile(join(staging, names[2]), `${JSON.stringify(manifest, null, 2)}\n`)
    for (const name of names) if (await exists(join(out, name))) fail(`Another build created the same version output: ${name}`)
    for (const name of names) await rename(join(staging, name), join(out, name))
    published = true
    await rm(staging, { recursive: true }) // Only the fresh staging copy owned by this invocation.
    console.log(`Built: ${join(out, names[0])}\nSHA-256: ${digest}`)
  } finally {
    if (!published) console.error(`DMG did not publish. Its isolated staging files remain for inspection: ${staging}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`ASTaria DMG packaging failed: ${error.message}`); process.exitCode = 1 })
}
