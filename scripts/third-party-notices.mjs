#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_LICENSE_BYTES = 200_000
const LICENSE_NAME = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/iu
const LICENSE_TEXT_NAME = /^(?:licen[cs]e|copying)(?:$|[._-])/iu
const GSAP_DECLARATION = "Standard 'no charge' license: https://gsap.com/standard-license."
const GSAP_TEXT_SHA256 = '2fc7250ab79c308ac071bdc16911cb1de3a11f8fbd656aa819bc2888a8b54546'
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0
const posix = path => path.split(sep).join('/')
const label = value => String(value ?? '').replace(/[\r\n\u0000-\u001f\u007f]/gu, ' ').trim()

function inside(path, parent) {
  const rel = relative(parent, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function declaration(value) {
  if (typeof value === 'string') return label(value)
  if (Array.isArray(value)) return value.map(declaration).filter(Boolean).sort(compare).join(' OR ')
  if (value && typeof value === 'object') return declaration(value.type)
  return ''
}

async function licenseFiles(directory, base = directory, files = [], skipped = []) {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => compare(a.name, b.name))) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    const path = join(directory, entry.name), name = posix(relative(base, path))
    if (entry.isSymbolicLink()) {
      if (LICENSE_NAME.test(entry.name)) skipped.push(`${name}: symbolic link not followed`)
      continue
    }
    if (entry.isDirectory()) { await licenseFiles(path, base, files, skipped); continue }
    if (!entry.isFile() || !LICENSE_NAME.test(entry.name)) continue
    const info = await lstat(path)
    if (info.size > MAX_LICENSE_BYTES) { skipped.push(`${name}: exceeds ${MAX_LICENSE_BYTES} bytes`); continue }
    const bytes = await readFile(path)
    if (bytes.length > MAX_LICENSE_BYTES) { skipped.push(`${name}: exceeds ${MAX_LICENSE_BYTES} bytes`); continue }
    let text
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
    catch { skipped.push(`${name}: not valid UTF-8 text`); continue }
    if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text)) {
      skipped.push(`${name}: contains binary control characters`); continue
    }
    text = text.replace(/^\uFEFF/u, '').replace(/\r\n?/gu, '\n').trimEnd()
    if (!text.trim()) { skipped.push(`${name}: empty license file`); continue }
    files.push({ name, text })
  }
  return { files, skipped }
}

/** Collect installed packages and the pinned official GSAP terms; never fetch during a build. */
export async function generateNotices(root = ROOT) {
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error('A package-lock.json version 3 with package records is required')
  }
  const modules = await realpath(join(root, 'node_modules'))
  const packages = []
  for (const [location, record] of Object.entries(lock.packages)) {
    if (!location || record.dev) continue
    if (!location.startsWith('node_modules/') || location.includes('\\')
      || location.split('/').some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsupported production package location in package-lock.json')
    }
    const fallback = location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length)
    const item = { name: label(record.name || fallback), version: label(record.version || 'unknown'),
      location, lockLicense: declaration(record.license), installedLicense: '', files: [], skipped: [], issues: [] }
    packages.push(item)
    let directory
    try { directory = await realpath(join(root, location)) }
    catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Cannot inspect ${label(location)} (${label(error.code || 'read error')})`)
      item.issues.push('Package is not installed; license text requires verification')
      continue
    }
    if (!inside(directory, modules)) {
      item.issues.push('Package resolves outside node_modules; not read, requires verification')
      continue
    }
    const manifestPath = join(directory, 'package.json')
    try {
      if (!(await lstat(manifestPath)).isFile()) throw new Error('not a regular file')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      item.installedLicense = declaration(manifest.license ?? manifest.licenses)
      if (manifest.name && manifest.name !== item.name) item.issues.push('Installed package name does not match lockfile; requires verification')
      if (manifest.version !== record.version) item.issues.push('Installed package version does not match lockfile; requires verification')
    } catch { item.issues.push('Installed package.json could not be read; requires verification') }
    const result = await licenseFiles(directory)
    item.files = result.files
    item.skipped = result.skipped
    if (item.name === 'gsap' && !item.files.some(file => LICENSE_TEXT_NAME.test(basename(file.name)))) {
      if (item.version !== '3.15.0' || item.lockLicense !== GSAP_DECLARATION || item.installedLicense !== GSAP_DECLARATION) {
        item.issues.push('Bundled GSAP terms do not match this package version and license declaration')
      } else {
        const source = join(root, 'third-party', 'gsap-3.15.0-LICENSE.txt')
        const stat = await lstat(source).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error))
        if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_LICENSE_BYTES) {
          item.issues.push('Bundled GSAP license text is missing or invalid')
        } else {
          const bytes = await readFile(source)
          if (createHash('sha256').update(bytes).digest('hex') !== GSAP_TEXT_SHA256) {
            item.issues.push('Bundled GSAP license text checksum differs; verify against the official source')
          } else item.files.push({ name: 'LICENSE-gsap-3.15.0 (official terms bundled with ASTaria)', text: bytes.toString('utf8').trimEnd() })
        }
      }
    }
    if (!item.lockLicense && !item.installedLicense) item.issues.push('No license declaration found; requires verification')
    if (item.lockLicense && item.installedLicense && item.lockLicense !== item.installedLicense) {
      item.issues.push('Lockfile and installed license declarations differ; requires verification')
    }
  }
  packages.sort((a, b) => compare(a.name, b.name) || compare(a.version, b.version) || compare(a.location, b.location))
  const hasLicenseText = item => item.files.some(file => LICENSE_TEXT_NAME.test(basename(file.name)))
  const missing = packages.filter(item => !hasLicenseText(item)).map(item => `${item.name}@${item.version} (${item.location})`)
  const review = packages.filter(item => item.issues.length || item.skipped.length).map(item => `${item.name}@${item.version} (${item.location})`)
  const lines = [
    'ASTaria — Third-party notices',
    '=============================',
    '',
    'Generated offline by scripts/third-party-notices.mjs from package-lock.json v3',
    'and installed node_modules. Includes every non-root package not marked dev,',
    'including transitive dependencies. Inclusion does not imply every listed',
    'package is shipped in the final application. ASTaria itself is licensed under Apache-2.0; see LICENSE and NOTICE.',
    '',
    'License declarations and most license texts are reproduced from installed packages.',
    'GSAP 3.15.0 terms are bundled from the official GSAP license page and checksum-pinned.',
    `Only regular UTF-8 LICENSE, LICENCE, COPYING and NOTICE files up to ${MAX_LICENSE_BYTES} bytes are included.`,
    'Nested node_modules and symbolic links are not traversed during text collection.',
    'Missing or skipped material requires verification before public distribution.',
    '',
    'Electron runtime notices are supplied separately with the runtime/application:',
    'retain the Electron LICENSE and Chromium LICENSES.chromium.html (or LICENSES)',
    'alongside these dependency notices. This file does not replace those notices.',
    '',
    `Production package records: ${packages.length}`,
    `Packages without collected license text: ${missing.length}`,
    `Packages with additional verification notes: ${review.length}`,
    '',
    'Missing license text — requires verification:',
    ...(missing.length ? missing.map(item => `- ${item}`) : ['None']),
    '',
  ]
  for (const item of packages) {
    lines.push('='.repeat(78), `${item.name}@${item.version}`, `Package location: ${item.location}`,
      `Lockfile license: ${item.lockLicense || 'not declared'}`,
      `Installed license: ${item.installedLicense || 'not declared'}`)
    if (!hasLicenseText(item)) lines.push('MISSING LICENSE TEXT — requires verification before public distribution')
    for (const issue of item.issues) lines.push(`Verification: ${issue}`)
    for (const skipped of item.skipped) lines.push(`Skipped: ${skipped} — requires verification`)
    for (const file of item.files) lines.push('', `--- ${file.name} ---`, file.text)
    lines.push('')
  }
  return { text: `${lines.join('\n').replace(/^[ \t]+$/gmu, '').trimEnd()}\n`, packages: packages.length, missing, review }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== '--check')) throw new Error('Unsupported argument')
    const result = await generateNotices()
    const output = join(ROOT, 'THIRD_PARTY_NOTICES.txt')
    if (process.argv[2] === '--check') {
      if (await readFile(output, 'utf8') !== result.text) throw new Error('Third-party notices are stale')
      console.log(`Verified THIRD_PARTY_NOTICES.txt: ${result.packages} production package records`)
    } else {
      await writeFile(output, result.text, 'utf8')
      console.log(`Generated THIRD_PARTY_NOTICES.txt: ${result.packages} production package records`)
    }
    console.log(`Missing license text: ${result.missing.length}`)
    for (const item of result.missing) console.log(`REQUIRES VERIFICATION: ${item}`)
    console.log(`Additional verification notes: ${result.review.length}`)
    for (const item of result.review) console.log(`CHECK NOTES: ${item}`)
    if (result.missing.length || result.review.length) process.exitCode = 1
  } catch (error) {
    // Filesystem errors can include a user's absolute path; do not echo them.
    console.error(`Third-party notice generation failed (${label(error.code || error.name || 'error')}); check package-lock.json and installed node_modules`)
    process.exitCode = 1
  }
}
