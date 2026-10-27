#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { lstat, readFile, readdir, readlink, realpath } from 'node:fs/promises'
import { isBuiltin } from 'node:module'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from '@babel/parser'
import { parseDocument } from 'htmlparser2'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VERSION = '1.0.0'
const USAGE = 'node scripts/verify-local-candidate.mjs --app <ASTaria.app> | --windows <portable-directory>'
const MAX_FILES = 40_000, MAX_ISSUES = 40, MAX_TEXT = 16 * 1024 * 1024
// Electron 44's Chromium notices exceed 19 MiB; keep the larger allowance
// scoped to the two vendor licence files, not application source or metadata.
const MAX_RUNTIME_LEGAL = 32 * 1024 * 1024
// Match package-desktop.copyPayload; published dependency source/maps are a
// separate allowlist, because copyServerDependencies preserves those files.
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.jsx', '.ts', '.tsx', '.css', '.md', '.m', '.h', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.woff', '.woff2', '.wasm'])
const ASSET_EXTENSIONS = new Set([...SOURCE_EXTENSIONS, '.ttf', '.pfb', '.bcmap', '.json', '.html', '.txt', '.webmanifest', '.ico', '.icns', '.gif', '.mp3', '.mp4', '.mov', '.ogg', '.wav'])
// PDF.js 6.4.299 has a fallback worker import and a fallback decoder import.
// documentReader preloads the worker and supplies package-local binary assets.
// These reviewed browser bundles are pinned byte-for-byte, not trusted by
// filename or import shape. Any rebuilt/modified bundle requires review again.
const REVIEWED_PDF_IMPORTS = new Map([
  ['dist/assets/pdf-DwPcVHfU.js', { sha256: 'f927f07ffbd3d18faca2791b6ac5a4c4979bad84f7376620185ae32d9d3c9f00', lines: [46] }],
  ['dist/assets/pdf.worker-uQTas6ku.js', { sha256: '7dc319253be7d55f59593191bf79f9b4efb10f521ae2c5baee7f765ec9b586c7', lines: [6] }],
])
const EXCLUDED_NAMES = new Set(['node_modules', 'data', 'userdata', 'user-data', 'logs', 'backups', 'coverage', 'cache', 'caches', 'tmp', 'temp', 'test-results', 'playwright-report'])
const LEGAL = [
  ['LICENSE', 'ASTARIA-LICENSE.txt'], ['NOTICE', 'ASTARIA-NOTICE.txt'],
  ['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'], ['third-party/gsap-3.15.0-LICENSE.txt', 'GSAP-LICENSE.txt'],
]
const MAC_BIN = ['bin/astaria-keychain', 'bin/ASTariaReminders.app/Contents/MacOS/astaria-reminders',
  'bin/ASTariaReminders.app/Contents/Info.plist', 'bin/ASTariaReminders.app/Contents/Resources/ASTaria.icns']
const CODE = /\.[cm]?[jt]sx?$/u
const posix = path => path.split(sep).join('/')
const label = value => String(value ?? '').replace(/[\x00-\x1f\x7f]/gu, '?').slice(0, 200)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inside = (path, base) => { const rel = relative(base, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }
const iso = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/u.test(value) && Number.isFinite(Date.parse(value))
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)

function prohibited(name) {
  const lower = name.normalize('NFKC').toLowerCase()
  return lower.startsWith('.') || /project[._-]?roadmap/u.test(lower)
    || EXCLUDED_NAMES.has(lower) && lower !== 'node_modules'
    || /^(?:__)?(?:fixtures?|tests?|specs?|snapshots?|mocks?|demos?|examples?|artifacts?|build|scripts|docs|mobile|android|ios|git|claude|dsh)(?:__)?$/u.test(lower)
    || /(?:^|[._-])(?:credentials?|secrets?|tokens?|api[-_]?keys?|private[-_]?keys?)(?:[._-]|$)/u.test(lower)
    || /(?:^|[._-])(?:backup|recovery|dump)(?:[._-]|$)/u.test(lower) && !/^backup\.[cm]?[jt]s$/u.test(lower)
    || /\.(?:db|sqlite\d*|db3)(?:[-.](?:wal|shm|journal))?$|(?:-wal|-shm|-journal)$|\.(?:env|pem|key|p12|pfx|keystore|log|bak|old|orig|zip|dmg|tgz|tar|gz)$/u.test(lower)
    || /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|[._-])(?:tsconfig|vite\.config|playwright|eslint|package-lock|pnpm-lock|yarn\.lock)(?:[._-]|$)/u.test(lower)
}

async function bytesAt(path, limit = MAX_TEXT) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit) throw new Error('regular bounded file required')
  const bytes = await readFile(path)
  if (bytes.length !== info.size || bytes.length > limit) throw new Error('file changed while reading')
  return bytes
}
async function hashFile(path) {
  const info = await lstat(path)
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('regular file required')
  const hash = createHash('sha256'); let size = 0
  for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length }
  if (size !== info.size) throw new Error('file changed while hashing')
  return hash.digest('hex')
}
async function jsonAt(path) { return JSON.parse((await bytesAt(path, 2 * 1024 * 1024)).toString('utf8')) }

/** Read only named, public source roots; excluded/private entries are never opened. */
async function referenceFiles(directory, extensions, dependency = false, prefix = '', files = new Set()) {
  if (!(await lstat(directory)).isDirectory()) throw new Error('source directory required')
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = entry.name, lower = name.toLowerCase(), rel = prefix ? `${prefix}/${name}` : name
    if (dependency ? name.startsWith('.') || ['node_modules', 'test', 'tests'].includes(name)
      : name.startsWith('.') || EXCLUDED_NAMES.has(lower) || /(?:^|[._-])(?:credentials?|secrets?|tokens?|api[-_]?keys?)(?:[._-]|$)/iu.test(name)) continue
    if (prohibited(name)) continue
    if (entry.isSymbolicLink()) throw new Error('source symlink forbidden')
    if (entry.isDirectory()) await referenceFiles(join(directory, name), extensions, dependency, rel, files)
    else if (entry.isFile() && (dependency || extensions.has(extname(lower)))) files.add(rel)
    if (files.size > MAX_FILES) throw new Error('source inventory limit')
  }
  return files
}

async function referenceInventory(root, platform) {
  const expected = new Set(['package.json', 'build-info.json']), dependencyNames = new Set(), manifests = new Map()
  const add = async (directory, prefix, extensions, dep = false) => {
    for (const path of await referenceFiles(directory, extensions, dep)) expected.add(`${prefix}/${path}`)
  }
  for (const directory of ['desktop', 'server', 'src']) await add(join(root, directory), directory, SOURCE_EXTENSIONS)
  await add(join(root, 'dist'), 'dist', ASSET_EXTENSIONS)
  if (platform === 'darwin') {
    const prompts = await lstat(join(root, 'prompts')).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
    await add(join(root, prompts ? 'prompts' : 'server/prompts'), 'prompts', SOURCE_EXTENSIONS)
    MAC_BIN.forEach(path => expected.add(path))
  }
  const lock = await jsonAt(join(root, 'package-lock.json')), modules = await realpath(join(root, 'node_modules'))
  async function dependency(name) {
    if (dependencyNames.has(name)) return
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/iu.test(name)) throw new Error('invalid dependency')
    dependencyNames.add(name)
    const directory = join(modules, name), actual = await realpath(directory)
    if (!inside(actual, modules)) throw new Error('dependency escaped node_modules')
    const pkg = await jsonAt(join(directory, 'package.json'))
    if (pkg.name !== name || pkg.version !== lock.packages?.[`node_modules/${name}`]?.version) throw new Error('source dependency differs from lock')
    manifests.set(name, pkg)
    await add(directory, `node_modules/${name}`, null, true)
    for (const child of Object.keys(pkg.dependencies ?? {})) await dependency(child)
  }
  await dependency('htmlparser2'); await dependency('@noble/hashes')
  return { expected, manifests, dependencies: [...dependencyNames].sort() }
}

// Framework symlinks are Electron's version aliases. No payload symlink is
// accepted, and even framework links must remain in their own framework.
async function frameworkLink(root, name) {
  const match = /^(Contents\/Frameworks\/(?:[^/]+\/)*[^/]+\.framework)(?:\/|$)/u.exec(name)
  if (!match) return false
  const path = join(root, name), target = await readlink(path), framework = join(root, match[1])
  return !isAbsolute(target) && inside(resolve(dirname(path), target), framework)
    && inside(await realpath(path), await realpath(framework))
}

function outsidePayloadAllowed(name, directory, platform) {
  if (platform === 'win32') {
    if (['resources', 'locales'].includes(name)) return directory
    if (/^locales\/[^/]+\.pak$/u.test(name)) return !directory
    return !directory && new Set(['ASTaria.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
      'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'resources.pak', 'snapshot_blob.bin',
      'v8_context_snapshot.bin', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll',
      'LICENSE', 'LICENSES.chromium.html', 'version', 'install.txt', ...LEGAL.map(([, target]) => target)]).has(name)
  }
  if (['Contents', 'Contents/Resources', 'Contents/MacOS', 'Contents/Frameworks', 'Contents/_CodeSignature'].includes(name)) return directory
  if (['Contents/Info.plist', 'Contents/PkgInfo', 'Contents/_CodeSignature/CodeResources', 'Contents/embedded.provisionprofile'].includes(name)) return !directory
  if (/^Contents\/MacOS\/[^/]+$/u.test(name)) return !directory
  if (/^Contents\/Frameworks\/[^/]+\.(?:framework|app)(?:\/|$)/u.test(name)) return true
  if (/^Contents\/Resources\/[^/]+\.lproj(?:\/|$)/u.test(name)) return directory || /\.(?:strings|nib|plist|pak)$/u.test(name)
  return !directory && new Set(['Contents/Resources/ASTaria.icns', 'Contents/Resources/electron.icns',
    'Contents/Resources/electron.asar', 'Contents/Resources/LICENSE', 'Contents/Resources/LICENSES.chromium.html',
    ...LEGAL.map(([, target]) => `Contents/Resources/${target}`)]).has(name)
}

async function inventory(root, payloadPrefix, expected, platform, issue) {
  const files = new Map(), folders = new Set(), payloadFiles = new Map(), payloadFolders = new Set([''])
  for (const name of expected) for (let folder = posix(dirname(name)); folder !== '.'; folder = posix(dirname(folder))) payloadFolders.add(folder)
  const optional = new Set(platform === 'darwin' ? ['bin/ASTariaReminders.app/Contents/_CodeSignature/CodeResources'] : [])
  for (const name of optional) payloadFolders.add(posix(dirname(name)))
  let entries = 0
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (++entries > MAX_FILES) throw new Error('candidate inventory limit')
      const name = prefix ? `${prefix}/${entry.name}` : entry.name, path = join(directory, entry.name)
      // Reject names before any file content access, including private plans.
      if (prohibited(entry.name) || entry.name.includes('\\')) { issue('FORBIDDEN_PATH', name, 'Private, user, credential or development payload is forbidden.'); continue }
      const payloadName = name.startsWith(`${payloadPrefix}/`) ? name.slice(payloadPrefix.length + 1) : name === payloadPrefix ? '' : null
      if (entry.isSymbolicLink()) {
        if (payloadName !== null || platform !== 'darwin' || !await frameworkLink(root, name).catch(() => false)) issue('SYMLINK', name, 'Only internal Electron framework aliases are allowed.')
        continue
      }
      const directoryEntry = entry.isDirectory()
      if (payloadName !== null) {
        if (!(directoryEntry ? payloadFolders.has(payloadName) : expected.has(payloadName) || optional.has(payloadName))) {
          issue('UNEXPECTED_PAYLOAD', name, 'Path is outside the public copyPayload/dependency allowlist.'); continue
        }
      } else if (!outsidePayloadAllowed(name, directoryEntry, platform)) {
        issue('UNEXPECTED_RUNTIME', name, 'Path is outside the Electron/runtime layout.'); continue
      }
      if (directoryEntry) { folders.add(name); await walk(path, name); continue }
      if (!entry.isFile()) { issue('FILE_TYPE', name, 'A regular file or directory is required.'); continue }
      const info = await lstat(path)
      if (payloadName !== null && CODE.test(name) && !info.size) issue('EMPTY_MODULE', name, 'Production/source modules must be nonempty.')
      files.set(name, { path, size: info.size })
      if (payloadName !== null) payloadFiles.set(payloadName, { path, size: info.size })
    }
  }
  await walk(root)
  for (const name of expected) if (!payloadFiles.has(name)) issue('MISSING_PAYLOAD', `${payloadPrefix}/${name}`, 'Required public payload file is missing.')
  return { files, folders, payloadFiles }
}

async function plistAt(path) {
  const bytes = await bytesAt(path, 512 * 1024)
  if (bytes.subarray(0, 6).toString() === 'bplist') {
    if (process.platform !== 'darwin') throw new Error('binary plist requires local plutil')
    return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1024 * 1024, timeout: 5000 }))
  }
  const document = parseDocument(bytes.toString('utf8'), { xmlMode: true, decodeEntities: true })
  const elements = node => (node.children ?? []).filter(child => child.type === 'tag')
  const text = node => (node.children ?? []).map(child => child.type === 'text' ? child.data : '').join('')
  const plist = elements(document).find(node => node.name === 'plist'), dict = plist && elements(plist)[0]
  if (dict?.name !== 'dict') throw new Error('plist dictionary required')
  const result = Object.create(null), children = elements(dict)
  for (let index = 0; index < children.length; index += 2) {
    const key = children[index], value = children[index + 1]
    if (key.name !== 'key' || !value || Object.hasOwn(result, text(key))) throw new Error('invalid plist key')
    result[text(key)] = value.name === 'string' ? text(value) : null
  }
  return result
}

function staticImports(source, filename) {
  const ast = parse(source, { sourceType: 'unambiguous', createImportExpressions: true,
    plugins: [...(/\.[cm]?tsx?$/u.test(filename) ? ['typescript'] : []), ...(/\.[jt]sx$/u.test(filename) ? ['jsx'] : [])] })
  const imports = [], unknown = []
  const literal = node => node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && !node.expressions.length ? node.quasis[0].value.cooked : null
  const member = (node, object, property) => node?.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.object.name === object && node.property.name === property
  const resourceRoot = ast.program.body.some(node => node.type === 'VariableDeclaration' && node.declarations.some(declaration =>
    declaration.id.name === 'resourceRoot' && member(declaration.init?.callee, 'path', 'join')
    && member(declaration.init.arguments[0], 'process', 'resourcesPath') && literal(declaration.init.arguments[1]) === 'app'))
  function add(node, kind) {
    const value = literal(node)
    if (value !== null) { imports.push({ value, kind }); return }
    // main.cjs uses this exact, statically bounded Electron payload URL form.
    const call = node?.type === 'MemberExpression' && !node.computed && node.property.name === 'href' ? node.object : null
    const path = call?.type === 'CallExpression' && call.callee.name === 'pathToFileURL' && call.arguments.length === 1 ? call.arguments[0] : null
    if (filename === 'desktop/main.cjs' && resourceRoot && path?.type === 'CallExpression' && member(path.callee, 'path', 'join')
      && path.arguments.length === 2 && path.arguments[0].name === 'resourceRoot' && literal(path.arguments[1]) !== null) {
      const target = literal(path.arguments[1])
      if (!target.includes('\\') && !isAbsolute(target) && target.split('/').every(part => part && part !== '..' && part !== '.')) {
        imports.push({ value: `./${target}`, kind, payloadRoot: true }); return
      }
    }
    unknown.push(node?.loc?.start.line ?? 0)
  }
  function visit(node) {
    if (!node || typeof node !== 'object') return
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type) && node.source
      && node.importKind !== 'type' && node.exportKind !== 'type'
      && !(node.specifiers?.length && node.specifiers.every(item => item.importKind === 'type' || item.exportKind === 'type'))) add(node.source, 'import')
    if (node.type === 'ImportExpression') add(node.source, 'import')
    if (node.type === 'CallExpression' && (node.callee.type === 'Import' || node.callee.type === 'Identifier' && node.callee.name === 'require')) {
      if (node.arguments.length === 1) add(node.arguments[0], node.callee.type === 'Import' ? 'import' : 'require')
      else unknown.push(node.loc?.start.line ?? 0)
    }
    for (const [key, value] of Object.entries(node)) {
      if (['loc', 'start', 'end', 'extra', 'comments', 'tokens'].includes(key)) continue
      if (Array.isArray(value)) value.forEach(child => { if (child?.type) visit(child) })
      else if (value?.type) visit(value)
    }
  }
  visit(ast.program)
  return { imports, unknown }
}

function exportTarget(exports, key, kind) {
  const conditions = new Set(['node', 'node-addons', 'module-sync', kind, 'default'])
  function choose(value) {
    if (typeof value === 'string' || value === null) return value
    if (Array.isArray(value)) { for (const item of value) { const target = choose(item); if (target !== undefined) return target } return undefined }
    if (value && typeof value === 'object') for (const [condition, target] of Object.entries(value)) if (conditions.has(condition)) { const found = choose(target); if (found !== undefined) return found }
    return undefined
  }
  if (exports && typeof exports === 'object' && !Array.isArray(exports) && Object.keys(exports).some(name => name.startsWith('.'))) {
    if (Object.hasOwn(exports, key)) return choose(exports[key])
    for (const pattern of Object.keys(exports).filter(name => name.includes('*')).sort((a, b) => b.indexOf('*') - a.indexOf('*') || b.length - a.length)) {
      const [prefix, suffix] = pattern.split('*')
      if (key.startsWith(prefix) && key.endsWith(suffix)) {
        const target = choose(exports[pattern])
        return typeof target === 'string' ? target.replaceAll('*', key.slice(prefix.length, key.length - suffix.length)) : target
      }
    }
    return undefined
  }
  return key === '.' ? choose(exports) : undefined
}

async function verifyImports(payload, files, dependencies, issue) {
  const manifests = new Map(), builtin = new Set(), queue = [], visited = new Set()
  const stats = { modules: 0, imports: 0, dynamicImportsRejected: 0, reviewedVendorImports: 0, builtins: [], electron: false }
  const manifest = async name => {
    if (!files.has(name)) throw new Error('manifest outside accepted inventory')
    if (!manifests.has(name)) manifests.set(name, await jsonAt(files.get(name).path))
    return manifests.get(name)
  }
  function fileName(path) {
    if (!inside(path, payload)) throw new Error('import escaped payload')
    return posix(relative(payload, path))
  }
  async function legacy(path, depth = 0) {
    if (depth > 8) throw new Error('recursive package main')
    for (const candidate of [path, `${path}.js`, `${path}.json`, `${path}.node`]) if (files.has(fileName(candidate))) return fileName(candidate)
    const packageName = fileName(join(path, 'package.json'))
    if (files.has(packageName)) {
      const pkg = await manifest(packageName)
      if (typeof pkg.main === 'string') { const target = await legacy(resolve(path, pkg.main), depth + 1); if (target) return target }
    }
    for (const extension of ['js', 'json', 'node']) { const candidate = fileName(join(path, `index.${extension}`)); if (files.has(candidate)) return candidate }
    return null
  }
  async function resolveImport(reference, from) {
    const { value, kind } = reference
    if (isBuiltin(value)) { builtin.add(value); return null }
    if (value === 'electron' && from.startsWith('desktop/')) { stats.electron = true; return null }
    if (/^\.{1,2}\//u.test(value)) {
      const parent = reference.payloadRoot ? pathToFileURL(`${payload}${sep}`) : pathToFileURL(join(payload, from))
      const url = new URL(value, parent)
      if (url.search || url.hash) throw new Error('unexpected import URL')
      const target = fileURLToPath(url)
      if (kind === 'require') return await legacy(target)
      const name = fileName(target)
      return files.has(name) ? name : undefined
    }
    if (!/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+(?:\/[^\\]*)?$/iu.test(value)) throw new Error('unsupported import scheme')
    const parts = value.split('/'), name = parts.slice(0, value.startsWith('@') ? 2 : 1).join('/')
    if (!dependencies.includes(name)) throw new Error('dependency is outside locked runtime closure')
    const directory = join(payload, 'node_modules', name), pkg = await manifest(`node_modules/${name}/package.json`)
    const key = parts.length === name.split('/').length ? '.' : `./${parts.slice(name.split('/').length).join('/')}`
    if (Object.hasOwn(pkg, 'exports')) {
      const target = exportTarget(pkg.exports, key, kind)
      if (typeof target !== 'string' || !target.startsWith('./') || target.split('/').some(part => part === '..' || part === 'node_modules')) throw new Error('package export unavailable')
      const path = resolve(directory, target), relativeName = fileName(path)
      return inside(path, directory) && files.has(relativeName) ? relativeName : undefined
    }
    return await legacy(resolve(directory, key === '.' ? pkg.main ?? 'index.js' : key))
  }
  // UI source is shipped by copyPayload, but its runtime is bundled in dist.
  // Follow src only where it is actually imported by the Node business graph.
  for (const name of files.keys()) if (/^(?:desktop|server|dist|node_modules)\//u.test(name) && /\.[cm]?js$/u.test(name)) queue.push(name)
  while (queue.length) {
    const name = queue.shift()
    if (visited.has(name) || !CODE.test(name) || /\.d\.[cm]?ts$/u.test(name)) continue
    visited.add(name); stats.modules++
    let references, bytes
    try { bytes = await bytesAt(files.get(name).path); references = staticImports(bytes.toString('utf8'), name) }
    catch { issue('MODULE_PARSE', name, 'Production module cannot be statically parsed.'); continue }
    const reviewed = REVIEWED_PDF_IMPORTS.get(name)
    if (reviewed && digest(bytes) === reviewed.sha256 && same(references.unknown, reviewed.lines)) stats.reviewedVendorImports += references.unknown.length
    else for (const line of references.unknown) { stats.dynamicImportsRejected++; issue('DYNAMIC_IMPORT', name, `Import target is not statically bounded (line ${line}).`) }
    for (const reference of references.imports) {
      stats.imports++
      try {
        const target = await resolveImport(reference, name)
        if (target === undefined || target === false) throw new Error('missing import')
        if (target !== null && target !== undefined) queue.push(target)
        else if (!isBuiltin(reference.value) && reference.value !== 'electron') throw new Error('missing require')
      } catch { issue('IMPORT_UNRESOLVED', name, `Unresolved ${reference.kind}: ${label(reference.value).slice(0, 120)}`) }
    }
  }
  stats.builtins = [...builtin].sort()
  return stats
}

/** sourceRoot is injectable for isolated fixtures; the CLI always uses this checkout. */
export async function verifyLocalCandidate({ app, windows, sourceRoot = ROOT } = {}) {
  const result = { schemaVersion: 1, ok: false, mode: 'static', product: 'ASTaria', expectedVersion: VERSION,
    platform: app ? 'darwin' : 'win32', checks: { files: 0, dependencies: [], imports: null, legal: [] }, issueCount: 0, issues: [], truncated: false }
  const issue = (code, path, message) => {
    result.issueCount++
    if (result.issues.length < MAX_ISSUES) result.issues.push({ code, path: label(path), message: label(message) })
    else result.truncated = true
  }
  if (Boolean(app) === Boolean(windows) || ![app ?? windows, sourceRoot].every(value => typeof value === 'string' && value && !/[\x00-\x1f\x7f]/u.test(value))) {
    issue('ARGUMENTS', '', USAGE); return result
  }
  const root = resolve(app ?? windows), platform = result.platform
  if (app && !root.endsWith('.app')) { issue('ARGUMENTS', '', '--app must name a .app directory.'); return result }
  const payloadPrefix = app ? 'Contents/Resources/app' : 'resources/app', payload = join(root, payloadPrefix)
  const legalPrefix = app ? 'Contents/Resources/' : ''
  let reference, current
  try {
    const info = await lstat(root)
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('candidate directory required')
    reference = await referenceInventory(resolve(sourceRoot), platform)
    current = await inventory(root, payloadPrefix, reference.expected, platform, issue)
    result.checks.files = current.files.size
  } catch { issue('INVENTORY', '', 'Cannot inspect candidate or trusted public source inventory.'); return result }
  const { files, payloadFiles } = current
  async function attempt(code, path, action) {
    try { return await action() } catch { issue(code, path, 'Missing, malformed, inconsistent or unreadable required file.'); return undefined }
  }
  function requireFile(name, nonempty = true) {
    const file = files.get(name)
    if (!file || nonempty && !file.size) { issue('REQUIRED_FILE', name, 'Required regular file must exist and be nonempty.'); return null }
    return file.path
  }
  const payloadPath = name => { const file = payloadFiles.get(name); if (!file) throw new Error('file outside accepted inventory'); return file.path }
  const pkg = await attempt('PACKAGE_JSON', `${payloadPrefix}/package.json`, () => jsonAt(payloadPath('package.json')))
  const build = await attempt('BUILD_INFO', `${payloadPrefix}/build-info.json`, () => jsonAt(payloadPath('build-info.json')))
  const sourcePkg = await attempt('SOURCE_PACKAGE', 'package.json', () => jsonAt(join(sourceRoot, 'package.json')))
  if (sourcePkg?.name !== 'astaria' || sourcePkg?.version !== VERSION) issue('SOURCE_VERSION', 'package.json', 'Trusted source must be astaria 1.0.0.')
  if (pkg?.name !== 'astaria' || pkg?.productName !== 'ASTaria' || pkg?.version !== VERSION
    || pkg?.type !== 'module' || pkg?.main !== 'desktop/main.cjs' || pkg?.license !== 'Apache-2.0') issue('PACKAGE_IDENTITY', `${payloadPrefix}/package.json`, 'ASTaria package identity/version/entry does not match the candidate contract.')
  if (build?.schemaVersion !== 1 || build?.name !== 'ASTaria' || build?.version !== VERSION || build?.version !== pkg?.version
    || build?.platform !== platform || build?.arch !== (app ? 'arm64' : 'x64') || !iso(build?.builtAt)
    || app && build?.bundleId !== 'dev.wason.ASTaria') issue('BUILD_IDENTITY', `${payloadPrefix}/build-info.json`, 'Build identity, platform, timestamp or version is inconsistent.')
  if (!same(build?.serverDependencies, reference.dependencies)) issue('DEPENDENCY_MANIFEST', `${payloadPrefix}/build-info.json`, 'serverDependencies must equal the locked runtime dependency closure.')
  result.checks.dependencies = reference.dependencies.map(name => ({ name, version: reference.manifests.get(name).version }))
  for (const name of reference.dependencies) {
    const path = `node_modules/${name}/package.json`
    const actual = await attempt('DEPENDENCY_PACKAGE', path, () => jsonAt(payloadPath(path))), expected = reference.manifests.get(name)
    if (actual?.name !== name || actual?.version !== expected.version
      || !same(actual?.dependencies ?? {}, expected.dependencies ?? {})) issue('DEPENDENCY_VERSION', path, 'Dependency identity/version/closure differs from the source lock.')
  }
  requireFile(`${payloadPrefix}/dist/index.html`)
  requireFile(`${payloadPrefix}/desktop/main.cjs`)
  requireFile(`${payloadPrefix}/server/database.mjs`)
  requireFile(`${payloadPrefix}/server/databaseCore.mjs`)
  for (const [source, target] of LEGAL) {
    const name = `${legalPrefix}${target}`, path = requireFile(name)
    if (!path) continue
    await attempt('LEGAL_TEXT', name, async () => {
      const sourceBytes = await bytesAt(join(sourceRoot, source)), actual = await bytesAt(path)
      const sourceSha256 = digest(sourceBytes), sha256 = digest(actual)
      if (!new TextDecoder('utf-8', { fatal: true }).decode(actual).trim() || actual.includes(0)) throw new Error('empty or binary legal text')
      result.checks.legal.push({ file: target, sha256, sourceSha256 })
      if (sha256 !== sourceSha256) issue('LEGAL_SHA256', name, 'License/notice bytes differ from trusted source SHA-256.')
      if (target === 'GSAP-LICENSE.txt' && build?.gsapLicenseSha256 !== sha256) issue('GSAP_BUILD_SHA256', name, 'GSAP license SHA-256 differs from build-info.')
    })
  }
  for (const target of ['LICENSE', 'LICENSES.chromium.html']) {
    const name = `${legalPrefix}${target}`, path = requireFile(name)
    if (path) await attempt('RUNTIME_LEGAL', name, async () => {
      if (!(await bytesAt(path, MAX_RUNTIME_LEGAL)).toString('utf8').trim()) throw new Error('empty runtime license')
    })
  }
  if (app) {
    const name = 'Contents/Info.plist'
    const plist = await attempt('PLIST', name, () => plistAt(requireFile(name)))
    if (plist?.CFBundleName !== 'ASTaria' || plist?.CFBundleDisplayName !== 'ASTaria' || plist?.CFBundleIdentifier !== 'dev.wason.ASTaria'
      || plist?.CFBundleShortVersionString !== '1.0.0' || plist?.CFBundleVersion !== '3.0.0') issue('PLATFORM_IDENTITY', name, 'macOS plist product/version does not match build-info.')
    if (typeof plist?.CFBundleExecutable !== 'string' || !/^[A-Za-z0-9 _.-]+$/u.test(plist.CFBundleExecutable)) issue('PLATFORM_EXECUTABLE', name, 'A bounded macOS executable name is required.')
    else requireFile(`Contents/MacOS/${plist.CFBundleExecutable}`)
    requireFile('Contents/Resources/ASTaria.icns')
    const helper = requireFile(`${payloadPrefix}/bin/astaria-keychain`)
    if (helper) await attempt('NATIVE_HELPER', 'bin/astaria-keychain', async () => {
      if (await hashFile(helper) !== build?.nativeHelpers?.keychainSha256) issue('NATIVE_HELPER_SHA256', 'bin/astaria-keychain', 'Native helper SHA-256 differs from build-info.')
    })
    const reminder = 'bin/ASTariaReminders.app/Contents/Info.plist'
    const reminderPlist = await attempt('REMINDER_PLIST', reminder, () => plistAt(payloadPath(reminder)))
    if (reminderPlist?.CFBundleIdentifier !== 'dev.wason.ASTaria.reminders' || reminderPlist?.CFBundleShortVersionString !== '1.0.0'
      || reminderPlist?.CFBundleVersion !== '3.0.0' || reminderPlist?.CFBundleExecutable !== 'astaria-reminders') issue('REMINDER_IDENTITY', reminder, 'Reminder helper identity/version is inconsistent.')
    for (const [field, source] of [['packagerSha256', 'scripts/package-desktop.mjs'], ['packageLockSha256', 'package-lock.json']]) {
      await attempt('SOURCE_SHA256', source, async () => { if (build?.[field] !== await hashFile(join(sourceRoot, source))) issue('SOURCE_SHA256', source, `${field} differs from the current public build source.`) })
    }
  } else {
    const path = requireFile('ASTaria.exe'); requireFile('install.txt')
    if (path) await attempt('WINDOWS_PE', 'ASTaria.exe', async () => {
      const binary = await bytesAt(path, 300 * 1024 * 1024), exe = NtExecutable.from(binary, { ignoreCert: true })
      if (exe.is32bit() || exe.newHeader.fileHeader.machine !== 0x8664) throw new Error('x64 required')
      const versions = Resource.VersionInfo.fromEntries(NtExecutableResource.from(exe).entries)
      if (!versions.length) throw new Error('version resource required')
      for (const version of versions) {
        if (version.fixedInfo.fileVersionMS !== 65536 || version.fixedInfo.fileVersionLS !== 0
          || version.fixedInfo.productVersionMS !== 65536 || version.fixedInfo.productVersionLS !== 0) throw new Error('numeric PE version mismatch')
        const languages = version.getAllLanguagesForStringValues()
        if (!languages.length) throw new Error('product strings required')
        for (const language of languages) {
          const strings = version.getStringValues(language)
          if (strings.ProductName !== 'ASTaria' || strings.FileDescription !== 'ASTaria' || strings.ProductVersion !== VERSION || strings.OriginalFilename !== 'ASTaria.exe') throw new Error('PE branding mismatch')
        }
      }
      if (build?.branded !== true || !['rcedit', 'resedit-3.1.0'].includes(build?.brandingTool)) issue('WINDOWS_BRANDING', 'build-info.json', 'Build-info must record the Windows branding step.')
      if (digest(binary) !== build?.executableSha256) issue('EXECUTABLE_SHA256', 'ASTaria.exe', 'Windows executable SHA-256 differs from build-info.')
    })
  }
  result.checks.imports = await verifyImports(payload, payloadFiles, reference.dependencies, issue)
  if (!result.checks.imports.builtins.includes('node:sqlite')) issue('SQLITE_WRAPPER', 'server/database.mjs', 'The NodeSQLite business wrapper must resolve node:sqlite.')
  result.ok = result.issueCount === 0
  return result
}

export async function candidateCli(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { exitCode: 0, report: { usage: USAGE, mode: 'static', expectedVersion: VERSION } }
  if (argv.length !== 2 || !['--app', '--windows'].includes(argv[0]) || !argv[1] || argv[1].startsWith('--')) {
    return { exitCode: 2, report: { schemaVersion: 1, ok: false, issueCount: 1, issues: [{ code: 'ARGUMENTS', message: USAGE }] } }
  }
  const report = await verifyLocalCandidate({ [argv[0].slice(2)]: argv[1] })
  return { exitCode: report.ok ? 0 : 1, report }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { report, exitCode } = await candidateCli(process.argv.slice(2))
    console.log(JSON.stringify(report)); process.exitCode = exitCode
  } catch {
    console.log(JSON.stringify({ schemaVersion: 1, ok: false, issues: [{ code: 'VERIFY_ERROR', message: 'Static candidate verification could not complete.' }] }))
    process.exitCode = 1
  }
}
