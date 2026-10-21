#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { signReleaseManifest } from './sign-release-manifest.mjs'
import { copyMacBundle } from './copy-mac-bundle.mjs'
import { prepareDmgPresentation } from './dmg-presentation.mjs'
import { discoverMacSigningTargets, refreshMacSigningManifest, validateMacSigningOptions, verifyMacSignature } from './macos-signing.mjs'

const USAGE = 'node scripts/package-dmg.mjs --app /path/to/ASTaria.app --out /path/to/output --instructions /path/to/INSTALL.md [--signing-options /path/to/public-options.json] [--sign-manifest /private/update-ed25519.pem]'
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
function fail(message) { throw new Error(message) }
function runTool(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, shell: false })
  return { status: result.status, error: Boolean(result.error), stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
async function exists(path, files) {
  try { await files.lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function requirePath(path, files, directory = false) {
  const info = await files.lstat(path)
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile())) fail(`Expected a regular ${directory ? 'directory' : 'file'}, not a symlink: ${path}`)
}
function inside(path, parent) {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
async function outputPath(path, files) {
  try { return await files.realpath(path) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    return join(await outputPath(dirname(path), files), basename(path))
  }
}
export function argumentsFor(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null
  const options = {}
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index], value = argv[index + 1]
    if (!['--app', '--out', '--instructions', '--sign-manifest', '--signing-options'].includes(name)
      || !value || value.startsWith('--') || /[\x00-\x1f\x7f]/u.test(value) || options[name]) fail(`Expected unique --app, --out and --instructions arguments.\n${USAGE}`)
    options[name] = resolve(value)
  }
  if (!options['--app'] || !options['--out'] || !options['--instructions']) fail(`All three arguments are required.\n${USAGE}`)
  return { app: options['--app'], out: options['--out'], instructions: options['--instructions'], signingKey: options['--sign-manifest'],
    ...(options['--signing-options'] ? { signingOptionsFile: options['--signing-options'] } : {}) }
}
async function hashAsset(path) {
  const info = await fs.lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) fail('Expected a regular artifact to hash.')
  const digest = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(path)) { digest.update(chunk); sizeBytes += chunk.length }
  if (sizeBytes !== info.size) fail('Artifact changed while hashing.')
  return { sha256: digest.digest('hex'), sizeBytes }
}

/** The leaf identity must be unique; chain authorities are not additional application identities. */
export function verifyDmgDeveloperSignature(report, options, verification = {}) {
  if (typeof report !== 'string') fail('Expected a codesign report.')
  const lines = report.split(/\r?\n/u), authorities = lines.filter(line => line.startsWith('Authority='))
  if (authorities[0] !== `Authority=${options.identity}`
    || authorities.filter(line => line.startsWith('Authority=Developer ID Application:')).length !== 1
    || ['TeamIdentifier=', 'Timestamp=', 'CDHash=', 'CodeDirectory '].some(prefix => lines.filter(line => line.startsWith(prefix)).length !== 1)) {
    fail('Expected one exact Developer ID application identity and signature report.')
  }
  const verified = verifyMacSignature(report, options, verification)
  if (verified.status !== 'developer-id') fail('Developer ID verification is required.')
  return verified
}

export function validateDmgSigningInput({ options: input, app, out, version, buildInfo, plist }) {
  const options = validateMacSigningOptions(input)
  if (options.app !== app || options.version !== version || options.artifact !== join(out, basename(options.artifact))) fail('Signing options do not match the app, version or output artifact.')
  if (plist.CFBundleIdentifier !== 'dev.wason.ASTaria' || buildInfo?.schemaVersion !== 1
    || buildInfo.name !== 'ASTaria' || buildInfo.bundleId !== plist.CFBundleIdentifier || buildInfo.platform !== 'darwin'
    || buildInfo.version !== version || buildInfo.arch !== options.arch || buildInfo.source?.dirty !== false
    || typeof buildInfo.source.commit !== 'string' || !/^[a-f0-9]{40,64}$/u.test(buildInfo.source.commit)
    || /[\x00-\x1f\x7f]/u.test(buildInfo.source.commit)) fail('Developer ID packaging requires matching clean build provenance.')
  return options
}

function provenance(info, version, arch, developerId) {
  if (!info) return null
  if (info.version !== version || info.arch !== arch) fail('App build provenance does not match its package.')
  const gitHash = value => typeof value === 'string' && /^[a-f0-9]{40,64}$/u.test(value) && !/[\x00-\x1f\x7f]/u.test(value) ? value : null
  const source = { commit: gitHash(info.source?.commit), tree: gitHash(info.source?.tree),
    dirty: typeof info.source?.dirty === 'boolean' ? info.source.dirty : null }
  // Retain known provenance only; local paths or unrelated fields never enter a release manifest.
  const result = { schemaVersion: info.schemaVersion, version: info.version, source }
  for (const key of ['electronVersion', 'buildNodeVersion', 'builtAt', 'packagerSha256', 'packageLockSha256']) {
    if (typeof info[key] === 'string') result[key] = info[key]
  }
  if (developerId) {
    Object.assign(result, { name: info.name, bundleId: info.bundleId, platform: info.platform, arch: info.arch })
    if (info.nativeHelpers?.keychainSha256 !== undefined) {
      if (typeof info.nativeHelpers.keychainSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(info.nativeHelpers.keychainSha256)
        || info.nativeHelpers.keychainSha256.length !== 64) fail('Invalid signed helper hash.')
      result.nativeHelpers = { keychainSha256: info.nativeHelpers.keychainSha256 }
    }
  }
  return result
}

/** Tests inject every effect; importing this module never runs packaging or Apple tools. */
export async function packageDmg(args, { platform = process.platform, files = fs, run = runTool,
  copyBundle = copyMacBundle, discover = discoverMacSigningTargets, hashAsset: hash = hashAsset,
  signManifest = signReleaseManifest, preparePresentation = prepareDmgPresentation, onStep = () => {}, now = () => new Date().toISOString() } = {}) {
  let stage = 'preflight', staging, published = false
  async function command(id, tool, argv) {
    stage = id
    onStep({ id, status: 'running' })
    const result = await run(tool, argv)
    if (!result || result.error || result.status !== 0) fail('DMG command failed.')
    onStep({ id, status: 'complete' })
    return { stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() }
  }
  try {
    if (platform !== 'darwin') fail('DMG packaging requires macOS.')
    await requirePath(args.app, files, true)
    await requirePath(args.instructions, files)
    const app = await files.realpath(args.app), out = await outputPath(args.out, files)
    if (basename(app) !== 'ASTaria.app') fail('--app must name ASTaria.app.')
    if (inside(out, app)) fail('Output must be outside the app bundle.')
    const payload = join(app, 'Contents', 'Resources', 'app'), packagePath = join(payload, 'package.json')
    await requirePath(packagePath, files)
    const packageBytes = await files.readFile(packagePath), pkg = JSON.parse(packageBytes.toString('utf8'))
    if (pkg.name !== 'astaria' || typeof pkg.version !== 'string' || !VERSION.test(pkg.version)) fail('The app must contain a valid ASTaria package version.')
    const version = pkg.version, buildInfoPath = join(payload, 'build-info.json')
    let info = null, buildBytes
    if (await exists(buildInfoPath, files)) {
      await requirePath(buildInfoPath, files)
      buildBytes = await files.readFile(buildInfoPath)
      info = JSON.parse(buildBytes.toString('utf8'))
    }
    let options = null
    if (args.signingOptionsFile) {
      stage = 'signing-options'
      await requirePath(args.signingOptionsFile, files)
      options = validateMacSigningOptions(JSON.parse(await files.readFile(args.signingOptionsFile, 'utf8')))
    }
    const arch = options?.arch ?? 'arm64', stem = `ASTaria-${version}-mac-${arch}-${options ? 'signed' : 'adhoc'}`
    const names = [`${stem}.dmg`, `${stem}.dmg.sha256`, `${stem}.manifest.json`, 'install.txt']
    stage = 'output-preflight'
    for (const name of names) if (await exists(join(out, name), files)) fail('Version output already exists; use a new version or output directory.')
    const instructionsBytes = await files.readFile(args.instructions)
    if (!instructionsBytes.length || instructionsBytes.length > 2 * 1024 * 1024) fail('Installation instructions must be nonempty UTF-8 text under 2 MiB.')
    new TextDecoder('utf-8', { fatal: true }).decode(instructionsBytes)
    const plist = JSON.parse((await command('read-plist', '/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents', 'Info.plist')])).stdout)
    if (typeof plist.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9 _.-]+$/u.test(plist.CFBundleExecutable)) fail('Unsupported app executable name.')
    stage = 'validate-build'
    if (options) options = validateDmgSigningInput({ options, app, out, version, buildInfo: info, plist })
    const buildInfo = provenance(info, version, arch, Boolean(options))
    const mainExecutable = `Contents/MacOS/${plist.CFBundleExecutable}`
    if (options && !options.targets.some(target => target.kind === 'macho' && target.path === mainExecutable)) fail('App executable must be in the code inventory.')

    async function verifyApp(bundle, phase, previous) {
      stage = `${phase}-inventory`
      if (options) {
        const inventory = validateMacSigningOptions({ ...options, targets: await discover(bundle, files) }).targets
        if (JSON.stringify(inventory) !== JSON.stringify(options.targets)) fail('Code inventory changed.')
      }
      await command(`${phase}-verify`, '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', bundle])
      const display = await command(`${phase}-display`, '/usr/bin/codesign', ['--display', '--verbose=4', bundle])
      const report = `${display.stderr}\n${display.stdout}`, codeHashes = []
      let appCDHash
      if (options) {
        appCDHash = verifyDmgDeveloperSignature(report, options, { verified: true }).appCDHash
        for (const [index, target] of options.targets.entries()) {
          const path = join(bundle, target.path)
          if (target.kind === 'macho') {
            const actual = (await command(`${phase}-architecture-${index}`, '/usr/bin/lipo', ['-archs', path])).stdout
            if (actual !== (arch === 'x64' ? 'x86_64' : 'arm64')) fail('Code architecture does not match signing options.')
          }
          await command(`${phase}-verify-${index}`, '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path])
          const nested = await command(`${phase}-display-${index}`, '/usr/bin/codesign', ['--display', '--verbose=4', path])
          codeHashes.push(verifyDmgDeveloperSignature(`${nested.stderr}\n${nested.stdout}`, options, { verified: true }).appCDHash)
        }
      } else {
        if (!/^Signature=adhoc$/mu.test(report)) fail('The default DMG command requires an ad-hoc signed app.')
        appCDHash = /^CDHash=([a-f0-9]+)$/mu.exec(report)?.[1]
        if (!appCDHash) fail('The app signature does not report a CDHash.')
        if ((await command(`${phase}-architecture`, '/usr/bin/lipo', ['-archs', join(bundle, mainExecutable)])).stdout !== 'arm64') fail('The app must contain only the arm64 architecture.')
      }
      stage = `${phase}-preservation`
      if (previous && (previous.appCDHash !== appCDHash || JSON.stringify(previous.codeHashes) !== JSON.stringify(codeHashes))) fail('The copied app signature changed.')
      return { report, appCDHash, codeHashes }
    }
    const sourceSignature = await verifyApp(app, 'source-app')
    stage = 'create-staging'
    await files.mkdir(out, { recursive: true })
    staging = await files.mkdtemp(join(out, `.astaria-dmg-${version}-`))
    const imageRoot = join(staging, 'image')
    await files.mkdir(imageRoot)
    const copiedApp = join(imageRoot, 'ASTaria.app')
    stage = 'copy-app'
    await copyBundle(app, copiedApp)
    await files.symlink('/Applications', join(imageRoot, 'Applications'))
    await files.writeFile(join(imageRoot, '安装与打开说明.txt'), instructionsBytes)
    let copiedSignature = sourceSignature
    if (options) {
      copiedSignature = await verifyApp(copiedApp, 'copied-app', sourceSignature)
      stage = 'copied-app-metadata'
      const copiedPayload = join(copiedApp, 'Contents', 'Resources', 'app')
      if (!packageBytes.equals(await files.readFile(join(copiedPayload, 'package.json')))
        || !buildBytes.equals(await files.readFile(join(copiedPayload, 'build-info.json')))) fail('Copied app metadata changed.')
    } else await command('copied-app-verify', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', copiedApp])
    const dmg = join(staging, names[0])
    const presentation = await preparePresentation({ imageRoot, staging, dmg, files, command })
    await command('sign-dmg', '/usr/bin/codesign', ['--force', '--sign', options?.identity ?? '-', options ? '--timestamp' : '--timestamp=none', dmg])
    await command('verify-dmg', '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', dmg])
    let dmgReport
    if (options) {
      const display = await command('display-dmg', '/usr/bin/codesign', ['--display', '--verbose=4', dmg])
      dmgReport = `${display.stderr}\n${display.stdout}`
      verifyDmgDeveloperSignature(dmgReport, options, { verified: true, hardenedRuntime: false })
    }
    await command('verify-image', '/usr/bin/hdiutil', ['verify', dmg])
    stage = 'final-manifest'
    let manifest = { schemaVersion: 1, name: 'ASTaria', version, platform: 'darwin', arch,
      bundleId: plist.CFBundleIdentifier, signing: 'ad-hoc', notarized: false, builtAt: now(),
      dmg: names[0], appCDHash: sourceSignature.appCDHash, buildInfo,
      packagerSha256: (await hash(fileURLToPath(import.meta.url))).sha256,
      instructionsSha256: createHash('sha256').update(instructionsBytes).digest('hex'),
      contents: ['ASTaria.app', 'Applications', '安装与打开说明.txt', '.background', '.DS_Store'], presentation, imageVerified: true, appSignatureVerified: true }
    let checksum
    if (options) {
      const refreshed = await refreshMacSigningManifest({ manifest, options: { ...options, artifact: dmg },
        appSignatureReport: copiedSignature.report, dmgSignatureReport: dmgReport, appVerified: true, dmgVerified: true }, { hashAsset: hash })
      manifest = { ...refreshed.manifest, imageVerified: true } // This invocation just verified this image.
      checksum = refreshed.checksum
    } else {
      const digest = await hash(dmg)
      manifest = { ...manifest, sha256: digest.sha256, sizeBytes: digest.sizeBytes }
      checksum = `${digest.sha256}  ${names[0]}\n`
    }
    stage = 'sign-release-manifest'
    if (args.signingKey) manifest = await signManifest(manifest, args.signingKey)
    stage = 'write-sidecars'
    await files.writeFile(join(staging, names[1]), checksum)
    await files.writeFile(join(staging, names[2]), `${JSON.stringify(manifest, null, 2)}\n`)
    await files.writeFile(join(staging, names[3]), instructionsBytes)
    stage = 'publish-local-files'
    for (const name of names) if (await exists(join(out, name), files)) fail('Another build created the same version output.')
    for (const name of names) await files.rename(join(staging, name), join(out, name))
    published = true
    stage = 'cleanup-staging'
    await files.rm(staging, { recursive: true }) // Only the fresh staging copy owned by this invocation.
    return { artifact: join(out, names[0]), manifest, checksum }
  } catch {
    // Never forward tool output, signing options, private-key errors or exception causes.
    const error = new Error(`DMG packaging stopped at ${stage}`)
    if (staging && !published) error.staging = staging
    throw error
  }
}

async function main() {
  const args = argumentsFor(process.argv.slice(2))
  if (!args) { console.log(USAGE); return }
  const result = await packageDmg(args)
  console.log(`Built: ${result.artifact}\nSHA-256: ${result.manifest.sha256}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`ASTaria DMG packaging failed: ${error.message}`)
    if (error.staging) console.error(`DMG did not publish. Its isolated staging files remain for inspection: ${error.staging}`)
    process.exitCode = 1
  })
}
