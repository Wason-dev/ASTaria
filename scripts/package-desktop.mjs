#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateNotices } from './third-party-notices.mjs'
import { copyServerDependencies } from './desktop-dependencies.mjs'
import { copyMacBundle } from './copy-mac-bundle.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const NAME = 'ASTaria', BUNDLE_ID = 'dev.wason.ASTaria', ARCH = 'arm64'
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.css', '.md', '.m', '.h', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.woff', '.woff2', '.wasm'])
const ASSET_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, '.json', '.html', '.txt', '.webmanifest', '.ico', '.icns', '.gif', '.mp3', '.mp4', '.mov', '.ogg', '.wav'])
const EXCLUDED_NAMES = new Set(['node_modules', 'data', 'userdata', 'user-data', 'logs', 'backups', 'coverage', 'cache', 'caches', 'tmp', 'temp', 'test-results', 'playwright-report'])
const USAGE = 'node scripts/package-desktop.mjs --runtime /path/to/Electron.app --out /path/to/output'

function fail(message) { throw new Error(message) }
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, ...options })
  if (result.error) throw result.error
  if (result.status !== 0) fail(`${command} failed (${result.status ?? result.signal}):\n${result.stderr || result.stdout}`)
  return result.stdout.trim()
}
async function exists(path) {
  try { await lstat(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
function inside(path, parent) {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}
function argumentsFor(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return null
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index], value = argv[index + 1]
    if (!['--runtime', '--out'].includes(option) || !value || value.startsWith('--') || result[option]) fail(`Expected unique --runtime and --out arguments.\n${USAGE}`)
    result[option] = resolve(value)
  }
  if (!result['--runtime'] || !result['--out']) fail(`Both --runtime and --out are required.\n${USAGE}`)
  return { runtime: result['--runtime'], out: result['--out'] }
}
export function bundleVersionFor(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-(alpha|beta|rc)\.(\d+)(?:\.(\d+))?)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version)
  if (!match) fail('Desktop bundle version requires major.minor.patch with an optional alpha, beta, or rc number.')
  const [, major, minor, patch, stage, stageNumber, betaRevision] = match
  // Apple's prerelease suffix has one number (b1..b255). Keep the published
  // beta.1..beta.12 bundle values unchanged; reserve b120..b129 for beta.12.x
  // and b130 onward for later betas so beta.12.1 outranks beta.12 but remains
  // below beta.13 and the stable 0.1.0 bundle.
  if (betaRevision !== undefined && (stage !== 'beta' || Number(stageNumber) < 12
    || Number(betaRevision) > 9 || /^0\d/u.test(betaRevision))) fail('Desktop bundle version exceeds macOS version limits.')
  const ordinal = stage === 'beta' && Number(stageNumber) >= 12 && (betaRevision !== undefined || Number(stageNumber) > 12)
    ? Number(stageNumber) * 10 + Number(betaRevision ?? 0) : Number(stageNumber)
  if ([major, minor, patch].some(value => Number(value) > 9999) || Number(major) > 9997
    || (stage && (Number(stageNumber) < 1 || ordinal > 255))) fail('Desktop bundle version exceeds macOS version limits.')
  // Reserve versions 0-1 for early signed helpers, including the iconless
  // verification app registered as version 1 on development machines.
  const suffix = stage ? `${{ alpha: 'a', beta: 'b', rc: 'fc' }[stage]}${ordinal}` : ''
  return `${Number(major) + 2}.${Number(minor)}.${Number(patch)}${suffix}`
}
async function requirePath(path, kind) {
  const stat = await lstat(path).catch(error => { if (error.code === 'ENOENT') fail(`Required ${kind} missing: ${path}`); throw error })
  if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) fail(`Expected a regular ${kind}, not a symlink: ${path}`)
}
export async function copyPayload(source, destination, extensions = SOURCE_EXTENSIONS) {
  const stat = await lstat(source)
  if (stat.isSymbolicLink()) fail(`Source symlinks are not allowed in the application payload: ${source}`)
  if (stat.isDirectory()) {
    await mkdir(destination, { recursive: true })
    for (const entry of (await readdir(source, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const lower = entry.name.toLowerCase()
      // Only code/static assets from named roots are copied. Never carry local
      // settings, credentials, runtime databases, dependency trees or reports.
      if (entry.name.startsWith('.') || EXCLUDED_NAMES.has(lower) || /(?:^|[._-])(?:credentials?|secrets?|tokens?|api[-_]?keys?)(?:[._-]|$)/iu.test(lower)) continue
      const from = join(source, entry.name), to = join(destination, entry.name)
      if (entry.isSymbolicLink()) fail(`Source symlinks are not allowed in the application payload: ${from}`)
      if (entry.isDirectory()) await copyPayload(from, to, extensions)
      else if (entry.isFile() && extensions.has(extname(lower)) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(lower)) await copyFile(from, to)
    }
  } else if (stat.isFile() && extensions.has(extname(source).toLowerCase())) await copyFile(source, destination)
  else fail(`Unsupported payload file: ${source}`)
}
function readPlist(path) { return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path])) }
async function writePlist(path, value, scratch) {
  const input = join(scratch, 'plist.json')
  await writeFile(input, JSON.stringify(value))
  run('/usr/bin/plutil', ['-convert', 'xml1', '-o', path, input])
  await rm(input)
}
async function walkRuntime(path, files = [], bundles = []) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) continue // Preserve Electron's framework links; never follow them twice.
    if (entry.isDirectory()) {
      if (entry.name.endsWith('.app') || entry.name.endsWith('.framework')) bundles.push(child)
      await walkRuntime(child, files, bundles)
    } else if (entry.isFile()) files.push(child)
  }
  return { files, bundles }
}
async function isMachO(path) {
  const file = await open(path, 'r')
  try {
    const header = Buffer.alloc(4), { bytesRead } = await file.read(header, 0, 4, 0)
    return bytesRead === 4 && ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))
  } finally { await file.close() }
}
async function sha256(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}

export function sourceProvenance(directory = ROOT) {
  const git = args => {
    const result = spawnSync('git', ['-C', directory, ...args], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    return !result.error && result.status === 0 ? result.stdout.trim() : null
  }
  const commit = git(['rev-parse', '--verify', 'HEAD'])
  const tree = git(['rev-parse', '--verify', 'HEAD^{tree}'])
  const status = git(['status', '--porcelain=v1', '--untracked-files=normal'])
  // Exported source archives may have no Git metadata. Unknown is distinct from
  // clean, and the commit tree describes the baseline when dirty is true.
  return { commit, tree, dirty: status === null ? null : status.length > 0 }
}

export async function createIcns(source, destination, scratch) {
  // ICNS stores PNG representations in typed, big-endian length-prefixed
  // chunks. Write that standard container directly: iconutil's image service
  // is not available in every build environment.
  const layers = [
    ['icp4', 16], ['icp5', 32], ['icp6', 64], ['ic07', 128],
    ['ic08', 256], ['ic09', 512], ['ic10', 1024],
    ['ic11', 32], ['ic12', 64], ['ic13', 256], ['ic14', 512],
  ]
  const representations = new Map(), chunks = []
  for (const [type, size] of layers) {
    if (!representations.has(size)) {
      const path = join(scratch, `astaria-icon-${size}.png`)
      run('/usr/bin/sips', ['-s', 'format', 'png', '-z', String(size), String(size), source, '--out', path])
      const png = await readFile(path)
      if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
        || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== size || png.readUInt32BE(20) !== size) {
        fail(`Invalid ${size}px PNG representation for application icon`)
      }
      representations.set(size, png)
    }
    const png = representations.get(size), header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(png.length + 8, 4)
    chunks.push(header, png)
  }
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.length, 0), 4)
  await writeFile(destination, Buffer.concat([header, ...chunks]))
}

async function main() {
  const args = argumentsFor(process.argv.slice(2))
  if (!args) { console.log(USAGE); return }
  if (process.platform !== 'darwin' || process.arch !== ARCH) fail('This packager requires an Apple Silicon Mac and an arm64 Node runtime.')
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  if (typeof pkg.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(pkg.version)) fail('package.json must contain a valid, path-safe semantic version.')
  const version = pkg.version, numericVersion = version.split(/[+-]/u)[0], bundleVersion = bundleVersionFor(version)
  const stem = `${NAME}-${version}-mac-${ARCH}`, release = join(args.out, stem)
  // Refuse an existing version before doing any work; failed partial builds
  // remain separately named and are never silently removed or overwritten.
  for (const candidate of [release, join(args.out, `${stem}.zip`), join(args.out, `${stem}.sha256`), join(args.out, `${stem}.manifest.json`)]) {
    if (await exists(candidate)) fail(`Version output already exists; use a new version or output directory: ${candidate}`)
  }
  await requirePath(args.runtime, 'directory')
  const runtime = await realpath(args.runtime)
  if (!runtime.endsWith('.app')) fail('--runtime must name Electron.app.')
  const runtimePlist = join(runtime, 'Contents', 'Info.plist'), runtimeInfo = readPlist(runtimePlist)
  const executable = runtimeInfo.CFBundleExecutable
  if (typeof executable !== 'string' || !/^[A-Za-z0-9 _.-]+$/u.test(executable)) fail('Unsupported Electron executable name.')
  const runtimeBinary = join(runtime, 'Contents', 'MacOS', executable)
  if (run('/usr/bin/lipo', ['-archs', runtimeBinary]) !== ARCH) fail('The Electron runtime must contain only the arm64 architecture.')
  const electronVersion = runtimeInfo.CFBundleShortVersionString
  if (typeof electronVersion !== 'string') fail('Electron runtime version is missing from Info.plist.')
  const buildInfo = { schemaVersion: 1, name: NAME, version, bundleId: BUNDLE_ID, platform: 'darwin', arch: ARCH,
    electronVersion, buildNodeVersion: process.versions.node, builtAt: new Date().toISOString(),
    source: sourceProvenance(), packagerSha256: await sha256(fileURLToPath(import.meta.url)),
    packageLockSha256: await exists(join(ROOT, 'package-lock.json')) ? await sha256(join(ROOT, 'package-lock.json')) : null }
  for (const path of ['desktop/main.cjs', 'desktop/server.mjs', 'server/native/keychain.m', 'dist/index.html', 'public/astaria-icon-1024.png', 'LICENSE', 'NOTICE', 'THIRD_PARTY_NOTICES.txt']) await requirePath(join(ROOT, path), 'file')
  const notices = await generateNotices(ROOT)
  if (notices.missing.length || notices.review.length || await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8') !== notices.text) fail('Third-party notices are incomplete or stale; verify and regenerate before packaging.')
  for (const path of ['desktop', 'server', 'src', 'dist']) await requirePath(join(ROOT, path), 'directory')
  for (const path of ['LICENSE', 'LICENSES.chromium.html']) await requirePath(join(dirname(runtime), path), 'file')
  const prompts = await exists(join(ROOT, 'prompts')) ? join(ROOT, 'prompts') : join(ROOT, 'server/prompts')
  await requirePath(prompts, 'directory')
  for (const path of ['/usr/bin/ditto', '/usr/bin/clang', '/usr/bin/sips', '/usr/bin/codesign']) await requirePath(path, 'file')
  await mkdir(args.out, { recursive: true })
  const out = await realpath(args.out)
  if (inside(out, runtime) || inside(runtime, out) || ['desktop', 'server', 'src', 'dist', 'public', 'prompts'].some(path => inside(out, join(ROOT, path)))) fail('Output must be separate from the Electron runtime and copied source directories.')
  const staging = await mkdtemp(join(out, `.astaria-build-${version}-`))
  let published = false
  try {
    const app = join(staging, `${NAME}.app`), contents = join(app, 'Contents'), resources = join(contents, 'Resources')
    const payload = join(resources, 'app'), scratch = join(staging, '.build')
    console.log(`Packaging ${NAME} ${version} with Electron ${electronVersion} (${ARCH})`)
    await copyMacBundle(runtime, app)
    await mkdir(scratch)
    if (await exists(payload) || await exists(join(resources, 'app.asar'))) fail('The supplied Electron runtime already contains Resources/app or app.asar; use a clean runtime.')
    await mkdir(payload)
    for (const path of ['desktop', 'server', 'src']) await copyPayload(join(ROOT, path), join(payload, path), SOURCE_EXTENSIONS)
    buildInfo.serverDependencies = await copyServerDependencies(ROOT, payload)
    await copyPayload(join(ROOT, 'dist'), join(payload, 'dist'), ASSET_EXTENSIONS)
    await copyPayload(prompts, join(payload, 'prompts'), SOURCE_EXTENSIONS)
    await writeFile(join(payload, 'package.json'), `${JSON.stringify({ name: 'astaria', productName: NAME, version, license: 'Apache-2.0', private: true, type: 'module', main: 'desktop/main.cjs' }, null, 2)}\n`)
    await writeFile(join(payload, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
    for (const name of ['LICENSE', 'LICENSES.chromium.html']) await copyFile(join(dirname(runtime), name), join(resources, name))
    await copyFile(join(ROOT, 'LICENSE'), join(resources, 'ASTARIA-LICENSE.txt'))
    await copyFile(join(ROOT, 'NOTICE'), join(resources, 'ASTARIA-NOTICE.txt'))
    await copyFile(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), join(resources, 'THIRD_PARTY_NOTICES.txt'))
    await copyFile(join(ROOT, 'third-party/gsap-3.15.0-LICENSE.txt'), join(resources, 'GSAP-LICENSE.txt'))
    buildInfo.gsapLicenseSha256 = await sha256(join(resources, 'GSAP-LICENSE.txt'))
    const defaultApp = join(resources, 'default_app.asar')
    if (await exists(defaultApp)) await rm(defaultApp) // Only this copied runtime fixture, never an input path.

    const helper = join(payload, 'bin', 'astaria-keychain')
    await mkdir(dirname(helper))
    run('/usr/bin/clang', ['-arch', ARCH, '-mmacosx-version-min=13.0', '-O2', '-fobjc-arc', '-framework', 'Foundation', '-framework', 'Security', join(ROOT, 'server/native/keychain.m'), '-o', helper])
    await chmod(helper, 0o755)
    // Filled after signing below: codesign changes the executable bytes.
    const reminderApp = join(payload, 'bin', 'ASTariaReminders.app')
    const reminderBinary = join(reminderApp, 'Contents', 'MacOS', 'astaria-reminders')
    await mkdir(dirname(reminderBinary), { recursive: true })
    run('/usr/bin/clang', ['-arch', ARCH, '-mmacosx-version-min=13.0', '-O2', '-fobjc-arc', '-framework', 'AppKit', '-framework', 'UserNotifications', '-framework', 'CoreServices', join(ROOT, 'desktop/native/reminders.m'), '-o', reminderBinary])
    await chmod(reminderBinary, 0o755)
    await writePlist(join(reminderApp, 'Contents', 'Info.plist'), { CFBundleIdentifier: `${BUNDLE_ID}.reminders`,
      CFBundleExecutable: 'astaria-reminders', CFBundleName: 'ASTaria 提醒', CFBundleDisplayName: 'ASTaria 提醒',
      CFBundleIconFile: 'ASTaria.icns',
      CFBundlePackageType: 'APPL', CFBundleVersion: bundleVersion, CFBundleShortVersionString: numericVersion,
      LSUIElement: true, LSMinimumSystemVersion: '13.0' }, scratch)


    await createIcns(join(ROOT, 'public/astaria-icon-1024.png'), join(resources, 'ASTaria.icns'), scratch)
    await mkdir(join(reminderApp, 'Contents', 'Resources'))
    await copyFile(join(resources, 'ASTaria.icns'), join(reminderApp, 'Contents', 'Resources', 'ASTaria.icns'))
    const info = { ...runtimeInfo, CFBundleName: NAME, CFBundleDisplayName: NAME, CFBundleIdentifier: BUNDLE_ID,
      CFBundleShortVersionString: numericVersion, CFBundleVersion: bundleVersion, CFBundleIconFile: 'ASTaria.icns', LSApplicationCategoryType: 'public.app-category.productivity' }
    delete info.ElectronAsarIntegrity
    await writePlist(join(contents, 'Info.plist'), info, scratch)

    const { files, bundles } = await walkRuntime(app)
    for (const bundle of bundles.filter(path => path.endsWith('.app') && path !== reminderApp)) {
      const path = join(bundle, 'Contents', 'Info.plist'), child = readPlist(path)
      const variant = /\((Renderer|GPU|Plugin)\)\.app$/u.exec(bundle)?.[1]
      child.CFBundleIdentifier = `${BUNDLE_ID}.helper${variant ? `.${variant}` : ''}`
      child.CFBundleName = String(child.CFBundleName ?? 'Electron Helper').replaceAll('Electron', NAME)
      child.CFBundleDisplayName = child.CFBundleName
      child.CFBundleShortVersionString = numericVersion; child.CFBundleVersion = bundleVersion
      await writePlist(path, child, scratch)
    }
    const entitlements = join(scratch, 'entitlements.plist')
    await writeFile(entitlements, `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>com.apple.security.cs.allow-jit</key><true/>\n<key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>\n<key>com.apple.security.cs.disable-library-validation</key><true/>\n</dict></plist>\n`)
    const sign = (path, jit = false) => run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime', ...(jit ? ['--entitlements', entitlements] : []), path])
    // Sign leaves first, then containing frameworks/helper apps, then the app.
    // Avoid --deep signing, which can miss helpers or assign them wrong metadata.
    for (const path of files.sort((a, b) => b.split(sep).length - a.split(sep).length)) if (await isMachO(path)) sign(path, path !== helper && path !== reminderBinary)
    for (const path of bundles.sort((a, b) => b.split(sep).length - a.split(sep).length)) sign(path, path.endsWith('.app') && path !== reminderApp)
    buildInfo.nativeHelpers = { keychainSha256: await sha256(helper) }
    await writeFile(join(payload, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`)
    sign(app, true)
    run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', app])
    if (run('/usr/bin/lipo', ['-archs', helper]) !== ARCH) fail('The compiled Keychain helper is not arm64.')

    // scratch is a fresh directory owned solely by this invocation.
    await rm(scratch, { recursive: true })
    await copyFile(join(ROOT, 'docs', 'INSTALL.md'), join(staging, 'install.txt'))
    const archiveName = `${stem}.zip`, archive = join(staging, archiveName)
    run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive])
    const digest = await sha256(archive)
    await writeFile(join(staging, `${stem}.sha256`), `${digest}  ${archiveName}\n`)
    await writeFile(join(staging, `${stem}.manifest.json`), `${JSON.stringify({ ...buildInfo, signing: 'ad-hoc', notarized: false,
      app: `${NAME}.app`, archive: archiveName, sha256: digest, instructions: 'install.txt',
      instructionsSha256: await sha256(join(staging, 'install.txt')), includesUserData: false }, null, 2)}\n`)
    if (await exists(release)) fail(`Another build created the same version output: ${release}`)
    await rename(staging, release); published = true
    console.log(`Built: ${join(release, `${NAME}.app`)}\nArchive: ${join(release, archiveName)}\nSHA-256: ${digest}`)
  } finally {
    if (!published) console.error(`Build did not publish. Its isolated staging files remain for inspection: ${staging}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`ASTaria packaging failed: ${error.message}`); process.exitCode = 1 })
}
