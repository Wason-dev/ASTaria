import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { copyPayload } from './package-desktop.mjs'
import { copyServerDependencies } from './desktop-dependencies.mjs'
import { candidateCli, verifyLocalCandidate } from './verify-local-candidate.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLI = join(ROOT, 'scripts/verify-local-candidate.mjs')
const VERSION = '1.0.0-rc.1'
const hash = value => createHash('sha256').update(value).digest('hex')
const exists = async path => lstat(path).then(() => true, error => error.code === 'ENOENT' ? false : Promise.reject(error))
const codes = report => report.issues.map(issue => issue.code)
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const plist = object => `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>${Object.entries(object).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict></plist>`

async function put(root, name, value) { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }

// This is a newly generated inert PE resource fixture, never a real executable
// from the user and never launched. It tests the same read-only parser as CLI.
function windowsPe(productName = 'ASTaria', version = VERSION) {
  const exe = NtExecutable.createEmpty(false, false), resource = NtExecutableResource.from(exe)
  const info = Resource.VersionInfo.createEmpty()
  for (const lang of [1033, 2052]) {
    info.setFileVersion(1, 0, 0, 0, lang); info.setProductVersion(1, 0, 0, 0, lang)
    info.setStringValues({ lang, codepage: 1200 }, { ProductName: productName, FileDescription: productName,
      ProductVersion: version, OriginalFilename: 'ASTaria.exe' })
  }
  info.outputToResourceEntries(resource.entries); resource.outputResource(exe)
  return Buffer.from(exe.generate())
}

async function fixture(base, platform) {
  const app = platform === 'darwin', root = join(base, app ? 'ASTaria.app' : 'ASTaria-portable')
  const prefix = app ? 'Contents/Resources/app' : 'resources/app', payload = join(root, prefix)
  await mkdir(payload, { recursive: true })
  // Use the existing safe copy helpers, without calling a packaging entry point.
  for (const directory of ['desktop', 'server', 'src']) await copyPayload(join(ROOT, directory), join(payload, directory))
  await cp(join(ROOT, 'dist'), join(payload, 'dist'), { recursive: true })
  const dependencies = await copyServerDependencies(ROOT, payload)
  await put(payload, 'package.json', JSON.stringify({ name: 'astaria', productName: 'ASTaria', version: VERSION,
    type: 'module', main: 'desktop/main.cjs', license: 'Apache-2.0' }))
  const legal = app ? join(root, 'Contents/Resources') : root
  for (const [source, target] of [['LICENSE', 'ASTARIA-LICENSE.txt'], ['NOTICE', 'ASTARIA-NOTICE.txt'],
    ['THIRD_PARTY_NOTICES.txt', 'THIRD_PARTY_NOTICES.txt'], ['third-party/gsap-3.15.0-LICENSE.txt', 'GSAP-LICENSE.txt']]) {
    await copyFile(join(ROOT, source), join(legal, target))
  }
  await put(legal, 'LICENSE', 'Synthetic Electron runtime license fixture\n')
  await put(legal, 'LICENSES.chromium.html', '<html><body>Synthetic Chromium license fixture</body></html>\n')
  const build = { schemaVersion: 1, name: 'ASTaria', version: VERSION, platform, arch: app ? 'arm64' : 'x64',
    builtAt: '2026-10-12T10:00:00.000Z', serverDependencies: dependencies,
    gsapLicenseSha256: hash(await readFile(join(legal, 'GSAP-LICENSE.txt'))) }
  if (app) {
    const prompts = await exists(join(ROOT, 'prompts')) ? 'prompts' : 'server/prompts'
    await copyPayload(join(ROOT, prompts), join(payload, 'prompts'))
    const binary = Buffer.from('synthetic static Mach-O placeholder, never launched')
    await put(payload, 'bin/astaria-keychain', binary)
    await put(payload, 'bin/ASTariaReminders.app/Contents/MacOS/astaria-reminders', binary)
    await put(payload, 'bin/ASTariaReminders.app/Contents/Resources/ASTaria.icns', 'synthetic icon')
    await put(payload, 'bin/ASTariaReminders.app/Contents/Info.plist', plist({ CFBundleIdentifier: 'dev.wason.ASTaria.reminders',
      CFBundleShortVersionString: '1.0.0', CFBundleVersion: '3.0.0fc1', CFBundleExecutable: 'astaria-reminders' }))
    await put(root, 'Contents/Info.plist', plist({ CFBundleName: 'ASTaria', CFBundleDisplayName: 'ASTaria',
      CFBundleIdentifier: 'dev.wason.ASTaria', CFBundleShortVersionString: '1.0.0', CFBundleVersion: '3.0.0fc1', CFBundleExecutable: 'Electron' }))
    await put(root, 'Contents/MacOS/Electron', binary)
    await put(root, 'Contents/Resources/ASTaria.icns', 'synthetic icon')
    Object.assign(build, { bundleId: 'dev.wason.ASTaria', nativeHelpers: { keychainSha256: hash(binary) },
      packagerSha256: hash(await readFile(join(ROOT, 'scripts/package-desktop.mjs'))),
      packageLockSha256: hash(await readFile(join(ROOT, 'package-lock.json'))) })
  } else {
    const binary = windowsPe()
    await put(root, 'ASTaria.exe', binary); await put(root, 'install.txt', 'Synthetic installation instructions\n')
    Object.assign(build, { branded: true, brandingTool: 'resedit-3.1.0', executableSha256: hash(binary) })
  }
  await put(payload, 'build-info.json', JSON.stringify(build))
  return { root, payload, legal, build, options: app ? { app: root } : { windows: root } }
}

async function changed(path, contents, action) {
  const original = await readFile(path)
  try { if (contents === null) await rm(path); else await writeFile(path, contents); await action() }
  finally { await writeFile(path, original) }
}

// Deliberately clean only our temporary positive fixture. The packaging scripts
// remain read-only; a separate test exposes their current upstream-test leakage.
async function removeUpstreamTests(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (/^__(?:fixtures|snapshots|tests)__$/u.test(entry.name) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(entry.name)) await rm(path, { recursive: true })
    else if (entry.isDirectory()) await removeUpstreamTests(path)
  }
}

test('static local candidate payload acceptance for both copy layouts', async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'astaria-candidate-payload-'))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  for (const platform of ['darwin', 'win32']) {
    await t.test(platform, async t => {
      const candidate = await fixture(temporary, platform)
      const verify = () => verifyLocalCandidate(candidate.options)
      await t.test('dependency fixtures/specs are refused, including those retained by the copier', async () => {
        await put(candidate.payload, 'node_modules/htmlparser2/src/__fixtures__/qa-demo.json', '{"synthetic":true}')
        const result = await verify()
        assert.equal(result.ok, false)
        assert.ok(result.issues.some(issue => issue.code === 'FORBIDDEN_PATH' && /node_modules\/htmlparser2\/src\/__fixtures__/u.test(issue.path)))
        await removeUpstreamTests(join(candidate.payload, 'node_modules'))
      })
      await t.test('complete public payload, business src, locked dependencies and legal SHA pass', async () => {
        const result = await verify()
        assert.equal(result.ok, true, JSON.stringify(result.issues))
        assert.equal(result.checks.legal.length, 4)
        assert.ok(result.checks.legal.every(item => item.sha256 === item.sourceSha256))
        assert.ok(result.checks.dependencies.some(item => item.name === '@noble/hashes' && item.version === '2.4.0'))
        assert.ok(result.checks.imports.builtins.includes('node:sqlite'))
        assert.equal(result.checks.imports.electron, true)
        assert.ok(result.checks.imports.modules > 100)
        assert.ok(result.checks.imports.imports > 100)
        const cli = spawnSync(process.execPath, [CLI, platform === 'darwin' ? '--app' : '--windows', candidate.root], { encoding: 'utf8', maxBuffer: 64 * 1024 })
        assert.equal(cli.status, 0, cli.stdout + cli.stderr)
        assert.equal(cli.stderr, '')
        assert.equal(JSON.parse(cli.stdout).ok, true)
      })
      await t.test('does not execute any candidate module or touch a profile/database', async () => {
        const path = join(candidate.payload, 'server/index.mjs'), source = await readFile(path, 'utf8')
        const sentinel = join(temporary, `must-not-run-${platform}`)
        await changed(path, `import { writeFileSync as qaWrite } from 'node:fs'; qaWrite(${JSON.stringify(sentinel)}, 'executed');\n${source}`, async () => {
          const result = await verify()
          assert.equal(result.ok, true, JSON.stringify(result.issues))
          assert.equal(await exists(sentinel), false)
        })
      })
      for (const path of ['server/database.mjs', 'server/databaseCore.mjs', 'src/planner/model.ts',
        'node_modules/@noble/hashes/sha2.js', 'node_modules/htmlparser2/dist/esm/Parser.js', 'dist/index.html']) {
        await t.test(`missing ${path} is rejected`, async () => {
          await changed(join(candidate.payload, path), null, async () => {
            const result = await verify()
            assert.equal(result.ok, false)
            assert.ok(codes(result).includes('MISSING_PAYLOAD'))
          })
        })
      }
      await t.test('package/build-info/platform/version mismatches and dependency versions fail', async () => {
        for (const [name, patch, expected] of [['package.json', { productName: 'Electron' }, 'PACKAGE_IDENTITY'],
          ['package.json', { version: '1.0.0' }, 'PACKAGE_IDENTITY'], ['build-info.json', { version: '1.0.0' }, 'BUILD_IDENTITY'],
          ['build-info.json', { platform: 'other' }, 'BUILD_IDENTITY'], ['build-info.json', { serverDependencies: [] }, 'DEPENDENCY_MANIFEST'],
          ['node_modules/@noble/hashes/package.json', { version: '0.0.0' }, 'DEPENDENCY_VERSION']]) {
          const path = join(candidate.payload, name), original = JSON.parse(await readFile(path, 'utf8'))
          await changed(path, JSON.stringify({ ...original, ...patch }), async () => {
            assert.ok(codes(await verify()).includes(expected), `${name} ${expected}`)
          })
        }
      })
      await t.test('ESM reexports, require, dynamic literal imports and exports conditions are resolved', async () => {
        const path = join(candidate.payload, 'server/index.mjs'), original = await readFile(path, 'utf8')
        for (const prefix of ["export * from './absent-qa.mjs';\n", "import('./absent-qa.mjs');\n",
          "require('./absent-qa.cjs');\n", "import { qa } from '@noble/hashes/not-exported.js';\n",
          "import { qa } from 'react';\n", "import('../../outside-candidate.mjs');\n"]) {
          await changed(path, prefix + original, async () => { assert.ok(codes(await verify()).includes('IMPORT_UNRESOLVED')) })
        }
        await changed(path, "require('htmlparser2'); import('htmlparser2'); import('@noble/hashes/sha2.js');\n" + original,
          async () => { const result = await verify(); assert.equal(result.ok, true, JSON.stringify(result.issues)) })
      })
      await t.test('unknown dynamic target fails instead of being silently ignored', async () => {
        const path = join(candidate.payload, 'server/index.mjs'), original = await readFile(path, 'utf8')
        await changed(path, "import(globalThis.unknownCandidateModule);\n" + original, async () => {
          assert.ok(codes(await verify()).includes('DYNAMIC_IMPORT'))
        })
      })
      await t.test('all four nonempty legal texts and GSAP build hash are enforced', async () => {
        for (const name of ['ASTARIA-LICENSE.txt', 'ASTARIA-NOTICE.txt', 'THIRD_PARTY_NOTICES.txt', 'GSAP-LICENSE.txt']) {
          await changed(join(candidate.legal, name), ' \n', async () => { assert.ok(codes(await verify()).includes('LEGAL_TEXT'), name) })
          await changed(join(candidate.legal, name), 'different legal text\n', async () => { assert.ok(codes(await verify()).includes('LEGAL_SHA256'), name) })
        }
        await changed(join(candidate.payload, 'build-info.json'), JSON.stringify({ ...candidate.build, gsapLicenseSha256: '0'.repeat(64) }),
          async () => { assert.ok(codes(await verify()).includes('GSAP_BUILD_SHA256')) })
      })
      await t.test('private/development data is rejected by name without opening its contents', async () => {
        const paths = ['PROJECT_ROADMAP.md', 'PROJECT_ROADMAP.md.bak', '.env', 'local.sqlite', 'local.sqlite-wal',
          'local.sqlite-shm', 'update-private-key.pem', '.claude/settings.json', '.dsh-dispatch/audit.json',
          '.git/config', 'backups/snapshot.json', 'fixtures/demo.json', 'server/__fixtures__/sample.ts',
          'dist/fixtures/demo.json', 'dist/assets/index.js.map', 'src/private-plan.md', 'scripts/dev.mjs']
        const sentinel = 'PRIVATE_FIXTURE_CONTENT_MUST_NOT_APPEAR'
        for (const name of paths) await put(candidate.payload, name, sentinel)
        const privateFile = join(candidate.payload, 'PROJECT_ROADMAP.md')
        await chmod(privateFile, 0)
        try {
          const result = await verify()
          assert.equal(result.ok, false)
          assert.ok(codes(result).includes('FORBIDDEN_PATH'))
          assert.ok(codes(result).includes('UNEXPECTED_PAYLOAD'))
          assert.equal(JSON.stringify(result).includes(sentinel), false)
          assert.equal(result.issues.some(issue => issue.code === 'MODULE_PARSE' && /ROADMAP/u.test(issue.path)), false)
        } finally {
          await chmod(privateFile, 0o600)
          for (const name of paths) await rm(join(candidate.payload, name), { force: true })
          for (const name of ['.claude', '.dsh-dispatch', '.git', 'backups', 'fixtures', 'server/__fixtures__', 'dist/fixtures', 'scripts']) await rm(join(candidate.payload, name), { recursive: true, force: true })
        }
      })
      await t.test('payload symlinks and directory links are rejected without following them', async () => {
        const path = join(candidate.payload, 'server/index.mjs'), outside = join(temporary, `outside-${platform}`)
        await put(temporary, `outside-${platform}`, 'PRIVATE_LINK_TARGET')
        const original = await readFile(path)
        await rm(path); await symlink(outside, path)
        try { const result = await verify(); assert.ok(codes(result).includes('SYMLINK')); assert.equal(JSON.stringify(result).includes('PRIVATE_LINK_TARGET'), false) }
        finally { await rm(path); await writeFile(path, original) }
        const backup = join(temporary, `public-payload-${platform}`)
        await cp(candidate.payload, backup, { recursive: true })
        await rm(candidate.payload, { recursive: true }); await symlink(backup, candidate.payload)
        try { assert.ok(codes(await verify()).includes('SYMLINK')) }
        finally { await rm(candidate.payload); await cp(backup, candidate.payload, { recursive: true }); await rm(backup, { recursive: true }) }
      })
      await t.test('runtime-level pollution and default_app/app.asar are rejected', async () => {
        const path = platform === 'darwin' ? 'Contents/Resources/app.asar' : 'resources/app.asar'
        await put(candidate.root, path, 'unexpected payload')
        await put(candidate.root, platform === 'darwin' ? 'Contents/Resources/PROJECT_ROADMAP.md' : '.env', 'PRIVATE_OUTER_CONTENT')
        try {
          const result = await verify()
          assert.ok(codes(result).includes('UNEXPECTED_RUNTIME')); assert.ok(codes(result).includes('FORBIDDEN_PATH'))
          assert.equal(JSON.stringify(result).includes('PRIVATE_OUTER_CONTENT'), false)
        } finally {
          await rm(join(candidate.root, path))
          await rm(join(candidate.root, platform === 'darwin' ? 'Contents/Resources/PROJECT_ROADMAP.md' : '.env'))
        }
      })
      if (platform === 'darwin') {
        await t.test('plist product/version and native helper SHA mismatch are rejected', async () => {
          const path = join(candidate.root, 'Contents/Info.plist'), original = await readFile(path, 'utf8')
          await changed(path, original.replace('<string>ASTaria</string>', '<string>Electron</string>'), async () => { assert.ok(codes(await verify()).includes('PLATFORM_IDENTITY')) })
          await changed(join(candidate.payload, 'bin/astaria-keychain'), 'tampered helper', async () => { assert.ok(codes(await verify()).includes('NATIVE_HELPER_SHA256')) })
        })
        await t.test('framework version aliases pass, external framework links fail', async () => {
          const framework = join(candidate.root, 'Contents/Frameworks/Electron Framework.framework')
          await put(framework, 'Versions/A/Electron Framework', 'synthetic framework')
          await symlink('A', join(framework, 'Versions/Current'))
          await symlink('Versions/Current/Electron Framework', join(framework, 'Electron Framework'))
          try {
            const result = await verify(); assert.equal(result.ok, true, JSON.stringify(result.issues))
            await rm(join(framework, 'Electron Framework')); await symlink(temporary, join(framework, 'Electron Framework'))
            assert.ok(codes(await verify()).includes('SYMLINK'))
          } finally { await rm(join(candidate.root, 'Contents/Frameworks'), { recursive: true }) }
        })
      } else {
        await t.test('real PE resources and executable hash must agree, not just build-info branded flag', async () => {
          await changed(join(candidate.root, 'ASTaria.exe'), windowsPe('Electron'), async () => { assert.ok(codes(await verify()).includes('WINDOWS_PE')) })
          await changed(join(candidate.root, 'ASTaria.exe'), windowsPe('ASTaria', '1.0.0'), async () => { assert.ok(codes(await verify()).includes('WINDOWS_PE')) })
          await changed(join(candidate.payload, 'build-info.json'), JSON.stringify({ ...candidate.build, executableSha256: '0'.repeat(64) }), async () => { assert.ok(codes(await verify()).includes('EXECUTABLE_SHA256')) })
        })
      }
      await t.test('bounded JSON, rejected candidate exit code and no raw private content', async () => {
        for (let i = 0; i < 80; i++) await put(candidate.payload, `private-${i}.txt`, 'DO_NOT_OUTPUT_QA_CONTENT')
        try {
          const cli = spawnSync(process.execPath, [CLI, platform === 'darwin' ? '--app' : '--windows', candidate.root], { encoding: 'utf8', maxBuffer: 64 * 1024 })
          assert.equal(cli.status, 1, cli.stderr)
          const report = JSON.parse(cli.stdout)
          assert.equal(report.ok, false); assert.equal(report.truncated, true)
          assert.ok(report.issueCount >= 80); assert.equal(report.issues.length, 40)
          assert.ok(Buffer.byteLength(cli.stdout) < 32 * 1024)
          assert.equal(cli.stdout.includes('DO_NOT_OUTPUT_QA_CONTENT'), false)
        } finally { for (let i = 0; i < 80; i++) await rm(join(candidate.payload, `private-${i}.txt`)) }
      })
    })
  }
})

test('CLI rejects ambiguous/unknown arguments and missing directories as bounded JSON', async () => {
  for (const argv of [[], ['--app', '/tmp/a.app', '--windows', '/tmp/b'], ['--source', '/tmp/a'], ['--windows', '--app']]) {
    const { report, exitCode } = await candidateCli(argv)
    assert.equal(exitCode, 2); assert.equal(report.ok, false)
  }
  assert.equal((await candidateCli(['--help'])).exitCode, 0)
  const missing = spawnSync(process.execPath, [CLI, '--app', join(tmpdir(), `absent-astaria-${process.pid}.app`)], { encoding: 'utf8' })
  assert.equal(missing.status, 1)
  assert.equal(JSON.parse(missing.stdout).ok, false)
})
