#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import { posix as path } from 'node:path'
import { fileURLToPath } from 'node:url'

const MACHO_MAGIC = new Set(['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'])
const OPTIONS = ['app', 'arch', 'version', 'identity', 'teamId', 'keychainProfile', 'scratch', 'artifact', 'targets', 'compatibility']
const CONTROL = /[\x00-\x1f\x7f]/u
const KEYCHAIN_HELPER = 'Contents/Resources/app/bin/astaria-keychain'
const BUILD_INFO = 'Contents/Resources/app/build-info.json'
const MANIFEST_METADATA = ['builtAt', 'instructions', 'instructionsSha256', 'packagerSha256', 'contents', 'includesUserData']
const USAGE = 'node scripts/macos-signing.mjs --plan <public-options.json> | --execute-local-signing <public-options.json>'

function requireValue(condition, message) { if (!condition) throw new Error(message) }
function fields(value, allowed) {
  requireValue(value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).every(key => allowed.includes(key)), 'Unsupported signing options')
}
function absolute(value) {
  requireValue(typeof value === 'string' && value !== '/' && value.length <= 4096 && !CONTROL.test(value)
    && path.isAbsolute(value) && path.normalize(value) === value, 'Expected a normalized absolute artifact path')
  return value
}
function inside(child, parent) { return child === parent || child.startsWith(`${parent}/`) }
function canonicalVersion(value) {
  if (typeof value !== 'string' || value.length > 120) return false
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(value)
  return Boolean(match && match[0] === value
    && !(match[4]?.split('.') ?? []).some(part => /^0\d+$/u.test(part)))
}
function validCommit(value) { return typeof value === 'string' && /^[a-f0-9]{40,64}$/u.test(value) && !CONTROL.test(value) }
function freeze(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value) }
  return value
}
function validateIdentity(identity, teamId) {
  requireValue(typeof teamId === 'string' && /^[A-Z0-9]{10}$/u.test(teamId)
    && teamId.length === 10, 'Expected an exact ten-character Apple team ID')
  const match = typeof identity === 'string'
    ? /^Developer ID Application: ([^\r\n()"]+) \(([A-Z0-9]{10})\)$/u.exec(identity) : null
  requireValue(match && match[0] === identity && !CONTROL.test(identity)
    && match[1] === match[1].trim() && match[1].length > 0 && identity.length <= 300
    && match[2] === teamId, 'Expected an exact Developer ID Application identity matching team ID')
}

export function validateMacSigningOptions(options) {
  fields(options, OPTIONS)
  requireValue(['arm64', 'x64'].includes(options.arch), 'Expected arm64 or x64')
  requireValue(canonicalVersion(options.version), 'Expected canonical three-part SemVer')
  validateIdentity(options.identity, options.teamId)
  requireValue(typeof options.keychainProfile === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u.test(options.keychainProfile)
    && !CONTROL.test(options.keychainProfile), 'Expected an existing keychain profile name')
  const app = absolute(options.app), scratch = absolute(options.scratch), artifact = absolute(options.artifact)
  requireValue(path.basename(app) === 'ASTaria.app', 'Expected ASTaria.app')
  requireValue(!inside(scratch, app) && !inside(app, scratch) && !inside(artifact, app)
    && !inside(artifact, scratch) && artifact !== scratch, 'Signing scratch and artifacts must be outside the app and separate')
  requireValue(path.basename(artifact) === `ASTaria-${options.version}-mac-${options.arch}-signed.dmg`, 'Expected the canonical signed DMG name')
  const compatibility = options.compatibility ?? {}
  fields(compatibility, ['allowUnsignedExecutableMemory', 'disableLibraryValidation'])
  requireValue(Object.values(compatibility).every(value => typeof value === 'boolean'), 'Expected boolean entitlement compatibility flags')
  requireValue(Array.isArray(options.targets) && options.targets.length > 0 && options.targets.length <= 20000, 'Expected an explicit code inventory')
  const seen = new Set()
  const targets = options.targets.map(target => {
    fields(target, ['path', 'kind'])
    requireValue(typeof target.path === 'string' && target.path.startsWith('Contents/') && !CONTROL.test(target.path)
      && target.path.length <= 4096 && path.normalize(target.path) === target.path && !seen.has(target.path)
      && ['macho', 'app', 'framework'].includes(target.kind), 'Invalid or duplicate code inventory target')
    requireValue(target.kind === 'macho' || target.path.endsWith(`.${target.kind}`), 'Code bundle kind does not match its path')
    seen.add(target.path)
    return { path: target.path, kind: target.kind }
  })
  requireValue(targets.some(target => target.kind === 'macho' && /^Contents\/MacOS\/[^/]+$/u.test(target.path)), 'Main executable is missing from the code inventory')
  targets.sort((a, b) => b.path.split('/').length - a.path.split('/').length
    || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return { app, scratch, artifact, arch: options.arch, version: options.version, identity: options.identity,
    teamId: options.teamId, keychainProfile: options.keychainProfile, targets, compatibility: { ...compatibility } }
}

export function electronEntitlements(compatibility = {}) {
  fields(compatibility, ['allowUnsignedExecutableMemory', 'disableLibraryValidation'])
  requireValue(Object.values(compatibility).every(value => typeof value === 'boolean'), 'Expected boolean entitlement compatibility flags')
  const keys = ['com.apple.security.cs.allow-jit']
  if (compatibility.allowUnsignedExecutableMemory) keys.push('com.apple.security.cs.allow-unsigned-executable-memory')
  if (compatibility.disableLibraryValidation) keys.push('com.apple.security.cs.disable-library-validation')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${keys.map(key => `<key>${key}</key><true/>`).join('\n')}\n</dict></plist>\n`
}
function electronTarget(target) {
  return target.kind === 'app' ? target.path.startsWith('Contents/Frameworks/')
    : target.kind === 'macho' && (/^Contents\/MacOS\/[^/]+$/u.test(target.path)
      || /^Contents\/Frameworks\/.+\.app\/Contents\/MacOS\/[^/]+$/u.test(target.path))
}
const command = (id, tool, args, extra = {}) => ({ id, kind: 'command', tool, args, ...extra })

export function createMacSigningPlan(input) {
  const options = validateMacSigningOptions(input)
  const entitlementFile = path.join(options.scratch, 'electron-entitlements.plist')
  const sign = (id, target, electron) => command(id, '/usr/bin/codesign', ['--force', '--sign', options.identity,
    '--timestamp', '--options', 'runtime', ...(electron ? ['--entitlements', entitlementFile] : []), target])
  const local = [command('find-identity', '/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])]
  options.targets.filter(target => target.kind === 'macho').forEach((target, index) => {
    local.push(command(`architecture-${index}`, '/usr/bin/lipo', ['-archs', path.join(options.app, target.path)]))
  })
  local.push({ id: 'write-entitlements', kind: 'entitlements', path: entitlementFile, contents: electronEntitlements(options.compatibility) })
  options.targets.forEach((target, index) => local.push(sign(`sign-${index}`, path.join(options.app, target.path), electronTarget(target))))
  local.push({ id: 'refresh-native-hashes', kind: 'native-hashes' }, sign('sign-app', options.app, true))
  local.push(command('verify-app', '/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', options.app]))
  for (const [index, target] of options.targets.entries()) {
    local.push(command(`verify-${index}`, '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', path.join(options.app, target.path)]))
    local.push(command(`display-${index}`, '/usr/bin/codesign', ['--display', '--verbose=4', path.join(options.app, target.path)]))
  }
  local.push(command('display-app', '/usr/bin/codesign', ['--display', '--verbose=4', options.app]))

  const archive = path.join(path.dirname(options.artifact), `ASTaria-${options.version}-mac-${options.arch}-notary.zip`)
  const publicOptions = path.join(path.dirname(options.artifact), `ASTaria-${options.version}-mac-${options.arch}-signing-options.json`)
  const submit = (id, artifact) => command(id, '/usr/bin/xcrun', ['notarytool', 'submit', artifact,
    '--keychain-profile', options.keychainProfile, '--wait', '--output-format', 'json'], { network: true, requiresStatus: 'Accepted' })
  const later = [
    command('archive-app', '/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', options.app, archive]),
    submit('submit-app', archive),
    command('staple-app', '/usr/bin/xcrun', ['stapler', 'staple', options.app]),
    command('validate-app-ticket', '/usr/bin/xcrun', ['stapler', 'validate', options.app]),
    command('assess-app', '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', options.app]),
    { id: 'write-dmg-options', kind: 'integration', path: publicOptions, requires: 'Write plan.options as public JSON at this path; no passwords or private keys. The DMG command requires this exact app and output artifact.' },
    command('package-signed-dmg', process.execPath, [fileURLToPath(new URL('./package-dmg.mjs', import.meta.url)),
      '--app', options.app, '--out', path.dirname(options.artifact),
      '--instructions', fileURLToPath(new URL('../INSTALL.md', import.meta.url)), '--signing-options', publicOptions],
    { network: true, producesStatus: 'developer-id', notarized: false }), // codesign's secure timestamp can use Apple's service.
    submit('submit-dmg', options.artifact),
    command('staple-dmg', '/usr/bin/xcrun', ['stapler', 'staple', options.artifact]),
    command('validate-dmg-ticket', '/usr/bin/xcrun', ['stapler', 'validate', options.artifact]),
    command('assess-dmg', '/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose=2', options.artifact]),
    command('verify-final-dmg', '/usr/bin/codesign', ['--verify', '--strict', '--verbose=2', options.artifact]),
    command('display-final-dmg', '/usr/bin/codesign', ['--display', '--verbose=4', options.artifact]),
    command('verify-final-image', '/usr/bin/hdiutil', ['verify', options.artifact]),
    { id: 'refresh-manifest', kind: 'integration', requires: 'Call refreshMacSigningManifest with fresh verification reports and bound App/DMG Accepted receipts after final stapling. Rehash final DMG bytes and size, replace the package command\'s pre-notarization checksum/manifest, discard its Ed25519 signature, and sign the final release manifest last.' },
  ]
  return freeze({ schemaVersion: 1, status: 'prepared', notarized: false, options, local, later })
}

/** Review output contains public identity metadata, never tool output or authentication material. */
export function reviewMacSigningPlan(plan) {
  const reviewed = structuredClone(plan)
  reviewed.options.keychainProfile = '<existing-keychain-profile>'
  for (const step of reviewed.later) {
    const index = step.args?.indexOf('--keychain-profile') ?? -1
    if (index >= 0) step.args[index + 1] = '<existing-keychain-profile>'
  }
  return reviewed
}

/** Discover only the explicitly selected public build bundle; retain framework symlinks without following them twice. */
export async function discoverMacSigningTargets(app, files = fs) {
  absolute(app)
  const rootInfo = await files.lstat(app)
  requireValue(rootInfo.isDirectory() && !rootInfo.isSymbolicLink() && await files.realpath(app) === app, 'Expected a canonical, regular app bundle')
  const targets = []
  async function walk(directory) {
    for (const entry of await files.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name), rel = path.relative(app, full)
      if (entry.isSymbolicLink()) {
        requireValue(inside(await files.realpath(full), app), 'External code bundle symlink is not allowed')
        continue
      }
      if (entry.isDirectory()) {
        const kind = entry.name.endsWith('.app') ? 'app' : entry.name.endsWith('.framework') ? 'framework' : null
        if (kind) targets.push({ path: rel, kind })
        await walk(full)
      } else if (entry.isFile()) {
        const handle = await files.open(full, 'r')
        try {
          const bytes = Buffer.alloc(4), { bytesRead } = await handle.read(bytes, 0, 4, 0)
          if (bytesRead === 4 && MACHO_MAGIC.has(bytes.toString('hex'))) targets.push({ path: rel, kind: 'macho' })
        } finally { await handle.close() }
      }
    }
  }
  await walk(app)
  return targets
}

function runTool(tool, args) {
  const result = spawnSync(tool, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, shell: false })
  return { status: result.status, error: Boolean(result.error), stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}
function exactIdentityFingerprint(report, identity) {
  const matches = [...report.matchAll(/^\s*\d+\) ([A-Fa-f0-9]{40}) "([^"\r\n]+)"\s*$/gmu)].filter(match => match[2] === identity)
  requireValue(matches.length === 1, 'Exactly one matching local Developer ID identity is required')
  return matches[0][1]
}

export function verifyMacSignature(report, options, { verified = false, hardenedRuntime = true } = {}) {
  requireValue(verified && typeof report === 'string', 'A successful codesign verification is required')
  validateIdentity(options?.identity, options?.teamId)
  const lines = report.split(/\r?\n/u)
  const cdHash = lines.find(line => /^CDHash=[a-f0-9]{40,64}$/u.test(line))?.slice(7)
  requireValue(cdHash, 'Verified signature CDHash is missing')
  if (lines.includes('Signature=adhoc')) return { status: 'adhoc', notarized: false, appCDHash: cdHash }
  const flags = /^CodeDirectory [^\r\n]*\bflags=0x([a-f0-9]+)\b/imu.exec(report)?.[1]
  requireValue(lines.includes(`Authority=${options.identity}`) && lines.includes(`TeamIdentifier=${options.teamId}`)
    && lines.some(line => /^Timestamp=\S/u.test(line) && !/^Timestamp=(?:none|\(null\))\s*$/iu.test(line))
    && (!hardenedRuntime || (flags && (BigInt(`0x${flags}`) & 0x10000n) !== 0n)), 'Developer ID identity, team, timestamp or hardened runtime verification failed')
  return { status: 'developer-id', notarized: false, appCDHash: cdHash, teamId: options.teamId }
}

/** This entry executes local signing only. No later/notarization command is dispatched here. */
export async function executeLocalMacSigning(input, { confirmLocalSigning = false, platform = process.platform,
  run = runTool, files = fs, discover = discoverMacSigningTargets, onStep = () => {} } = {}) {
  const plan = createMacSigningPlan(input), options = plan.options
  requireValue(confirmLocalSigning === true && platform === 'darwin', 'Explicit local signing on macOS is required')
  let currentStep = 'preflight', ownsScratch = false
  try {
    const inventory = await discover(options.app, files)
    const actual = validateMacSigningOptions({ ...options, targets: inventory }).targets
    requireValue(JSON.stringify(actual) === JSON.stringify(options.targets), 'Code inventory changed; review a new plan')
    requireValue(await files.realpath(path.dirname(options.scratch)) === path.dirname(options.scratch), 'Signing scratch parent must be canonical')
    const buildPath = path.join(options.app, BUILD_INFO)
    const build = JSON.parse(await files.readFile(buildPath, 'utf8'))
    noCredentialFields(build)
    requireValue(build.version === options.version && build.arch === options.arch && build.platform === 'darwin'
      && build.name === 'ASTaria' && build.bundleId === 'dev.wason.ASTaria'
      && build.source?.dirty === false && validCommit(build.source?.commit), 'Release build identity or clean provenance does not match')
    let fingerprint, signature
    for (const step of plan.local) {
      currentStep = step.id
      onStep({ id: step.id, status: 'running' })
      if (step.kind === 'entitlements') {
        await files.mkdir(options.scratch, { mode: 0o700 })
        ownsScratch = true
        await files.writeFile(step.path, step.contents, { mode: 0o600, flag: 'wx' })
      } else if (step.kind === 'native-hashes') {
        if (options.targets.some(target => target.path === KEYCHAIN_HELPER)) {
          const helperHash = createHash('sha256').update(await files.readFile(path.join(options.app, KEYCHAIN_HELPER))).digest('hex')
          build.nativeHelpers = { ...build.nativeHelpers, keychainSha256: helperHash }
          await files.writeFile(buildPath, `${JSON.stringify(build, null, 2)}\n`)
        }
      } else {
        const args = [...step.args], identityIndex = args.indexOf('--sign')
        if (identityIndex >= 0) args[identityIndex + 1] = fingerprint
        const reply = await run(step.tool, args)
        requireValue(reply && !reply.error && reply.status === 0, 'Local signing command failed')
        if (step.id === 'find-identity') fingerprint = exactIdentityFingerprint(reply.stdout, options.identity)
        else if (step.id.startsWith('architecture-')) requireValue(reply.stdout.trim() === (options.arch === 'x64' ? 'x86_64' : 'arm64'), 'Code architecture does not match')
        else if (step.id.startsWith('display-')) {
          signature = verifyMacSignature(`${reply.stderr}\n${reply.stdout}`, options, { verified: true })
          requireValue(signature.status === 'developer-id', 'All code must have Developer ID signatures')
        }
      }
      onStep({ id: step.id, status: 'complete' })
    }
    return { ...signature, app: options.app, arch: options.arch, version: options.version }
  } catch {
    // Do not forward subprocess output, exception causes, credentials or raw arguments.
    throw new Error(`macOS local signing stopped at ${currentStep}`)
  } finally {
    if (ownsScratch) await files.rm(options.scratch, { recursive: true, force: true }).catch(() => {})
  }
}

async function hashArtifact(artifact) {
  const info = await fs.lstat(artifact)
  requireValue(info.isFile() && !info.isSymbolicLink(), 'Expected a regular release artifact')
  const digest = createHash('sha256')
  let sizeBytes = 0
  for await (const chunk of createReadStream(artifact)) { digest.update(chunk); sizeBytes += chunk.length }
  requireValue(sizeBytes === info.size, 'Release artifact changed while hashing')
  return { sha256: digest.digest('hex'), sizeBytes }
}
function acceptedReceipt(value) {
  return value?.status === 'Accepted' && typeof value.id === 'string'
    && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value.id) && value.id.length === 36
}
function noCredentialFields(value) {
  if (!value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value)) {
    requireValue(!/(?:password|passphrase|private.?key|secret|credential|token|apple.?id|api.?key)/iu.test(key), 'Authentication fields are not accepted in release metadata')
    noCredentialFields(child)
  }
}

/** Rehash after ALL mutations; return an unsigned manifest for the separate Ed25519 release-signing step. */
export async function refreshMacSigningManifest({ manifest, options: input, appSignatureReport, dmgSignatureReport,
  appVerified = false, dmgVerified = false, notarization }, { hashAsset = hashArtifact } = {}) {
  const options = validateMacSigningOptions(input)
  noCredentialFields(manifest)
  requireValue(manifest?.schemaVersion === 1 && manifest.name === 'ASTaria' && manifest.bundleId === 'dev.wason.ASTaria'
    && manifest.platform === 'darwin' && manifest.arch === options.arch && manifest.version === options.version
    && manifest.buildInfo?.version === options.version && manifest.buildInfo?.source?.dirty === false
    && validCommit(manifest.buildInfo?.source?.commit), 'Release manifest identity or clean provenance does not match')
  const signature = verifyMacSignature(appSignatureReport, options, { verified: appVerified })
  requireValue(signature.status === 'developer-id', 'Developer ID app verification is required for a signed DMG')
  const dmgSignature = verifyMacSignature(dmgSignatureReport, options, { verified: dmgVerified, hardenedRuntime: false })
  requireValue(dmgSignature.status === 'developer-id', 'Developer ID DMG verification is required')
  let digest
  try { digest = await hashAsset(options.artifact) } catch { throw new Error('Final release artifact hashing failed') }
  const { sha256, sizeBytes } = digest ?? {}
  requireValue(typeof sha256 === 'string' && /^[a-f0-9]{64}$/u.test(sha256) && sha256.length === 64
    && Number.isSafeInteger(sizeBytes) && sizeBytes > 0, 'Final artifact hash or size is invalid')
  let status = 'developer-id'
  if (notarization !== undefined) {
    requireValue(notarization && typeof notarization === 'object' && acceptedReceipt(notarization.appSubmission) && acceptedReceipt(notarization.dmgSubmission)
      && notarization.appSubmission.id !== notarization.dmgSubmission.id
      && notarization.appStaplerExitCode === 0 && notarization.dmgStaplerExitCode === 0
      && notarization.appGatekeeperExitCode === 0 && notarization.dmgGatekeeperExitCode === 0
      && notarization.artifact === options.artifact && notarization.finalSha256 === sha256
      && notarization.appCDHash === signature.appCDHash && notarization.teamId === options.teamId,
    'Accepted notarization receipts and successful ticket/Gatekeeper checks for the final artifact are required')
    status = 'notarized'
  }
  // Old artifact lists and verification flags describe earlier bytes; carry only immutable metadata.
  const metadata = Object.fromEntries(MANIFEST_METADATA.filter(key => Object.hasOwn(manifest, key)).map(key => [key, structuredClone(manifest[key])]))
  return { status, manifest: { ...metadata, schemaVersion: 1, name: 'ASTaria', bundleId: 'dev.wason.ASTaria',
    version: options.version, arch: options.arch, platform: 'darwin', buildInfo: structuredClone(manifest.buildInfo),
    signing: 'developer-id', notarized: status === 'notarized',
    dmg: path.basename(options.artifact), sha256, sizeBytes, appCDHash: signature.appCDHash,
    appSignatureVerified: true },
  checksum: `${sha256}  ${path.basename(options.artifact)}\n`, needsReleaseManifestSignature: true }
}

export function macSigningArguments(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null
  requireValue(argv.length === 2 && ['--plan', '--execute-local-signing'].includes(argv[0]), 'Expected a plan or explicit local signing invocation')
  return { execute: argv[0] === '--execute-local-signing', optionsFile: absolute(argv[1]) }
}
async function main(argv) {
  const args = macSigningArguments(argv)
  if (!args) { console.log(USAGE); return }
  const options = JSON.parse(await fs.readFile(args.optionsFile, 'utf8'))
  if (!args.execute) console.log(JSON.stringify(reviewMacSigningPlan(createMacSigningPlan(options)), null, 2))
  else console.log(JSON.stringify(await executeLocalMacSigning(options, { confirmLocalSigning: true })))
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(() => { console.error('macOS signing preparation or explicit local signing failed; no authentication details are printed.'); process.exitCode = 1 })
}
