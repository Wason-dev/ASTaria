import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copyServerDependencies } from './desktop-dependencies.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const forbiddenDirectories = new Set(['node_modules', 'test', 'tests', '__fixtures__', '__snapshots__'])
const testFile = name => name.toLowerCase().includes('.test.') || name.toLowerCase().includes('.spec.')
async function put(root, name, bytes) { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes) }
async function filesIn(root, prefix = '', result = []) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name
    assert.equal(entry.isSymbolicLink(), false, name)
    if (entry.isDirectory()) await filesIn(root, name, result)
    else result.push(name)
  }
  return result.sort()
}
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'astaria-dependency-filter-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

async function synthetic(t) {
  const root = await temporary(t), source = join(root, 'source'), payload = join(root, 'payload')
  const packages = {
    htmlparser2: { name: 'htmlparser2', version: '10.0.0', type: 'module', main: './dist/commonjs/index.cjs',
      exports: { import: './dist/esm/index.js', require: './dist/commonjs/index.cjs' }, types: './dist/esm/index.d.ts',
      dependencies: { 'parser-runtime': '1.2.3' } },
    'parser-runtime': { name: 'parser-runtime', version: '1.2.3', type: 'module', exports: { import: './index.js', require: './index.cjs' } },
    '@noble/hashes': { name: '@noble/hashes', version: '2.4.0', type: 'module', exports: { './sha2.js': './sha2.js' } },
  }
  const records = { '': {} }
  for (const [name, pkg] of Object.entries(packages)) {
    records[`node_modules/${name}`] = { version: pkg.version }
    await put(source, `node_modules/${name}/package.json`, JSON.stringify(pkg))
    await put(source, `node_modules/${name}/LICENSE`, `Complete synthetic license for ${name}\nPermission and warranty text.\n`)
  }
  await put(source, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: records }))
  await put(source, 'node_modules/htmlparser2/dist/esm/index.js', "export { value } from 'parser-runtime'\n")
  await put(source, 'node_modules/htmlparser2/dist/commonjs/index.cjs', "exports.value = require('parser-runtime').value\n")
  await put(source, 'node_modules/parser-runtime/index.js', 'export const value = 42\n')
  await put(source, 'node_modules/parser-runtime/index.cjs', 'exports.value = 42\n')
  await put(source, 'node_modules/@noble/hashes/sha2.js', 'export const sha256 = () => new Uint8Array(32)\n')
  return { root, source, payload, packages }
}

test('exclude test directories and file markers at every depth without deleting production names', async t => {
  const { source, payload, packages } = await synthetic(t)
  const rejected = ['test/index.js', 'tests/nested/data.json', '__fixtures__/sample.html', '__snapshots__/result.snap',
    'src/__fixtures__/sample.ts', 'dist/esm/__snapshots__/parser.snap', 'dist/tests/production.js',
    'src/TEST/nested.ts', 'dist/__FIXTURES__/sample.json', 'src/parser.test.ts', 'dist/esm/parser.spec.js',
    'dist/commonjs/parser.test.cjs', 'src/parser.spec.ts.snap', 'dist/parser.test.js.map', 'parser.test.json',
    'README.spec.md', 'parser.TEST.wasm', 'parser.SPEC.txt', '.hidden/config.json', 'node_modules/extra/index.js']
  const retained = ['src/Parser.ts', 'src/testing/production.ts', 'src/testSupport.ts', 'src/testable/source.ts',
    'dist/esm/index.d.ts', 'dist/esm/index.d.ts.map', 'dist/test.js', 'dist/tests.js', 'dist/spec.js',
    'dist/test-parser.js', 'dist/parser-spec.js', 'dist/test.production/entry.js', 'dist/parser.test.assets/entry.js', 'dist/prospect.js',
    'dist/parser.specimen.js', 'dist/parser.testing.js', 'dist/contest.cjs', 'dist/runtime.js.map',
    'dist/runtime.wasm', 'dist/esm/package.json', 'README.md', 'NOTICE', 'licenses/MIT.txt']
  for (const name of Object.keys(packages)) {
    for (const path of rejected) await put(source, `node_modules/${name}/${path}`, 'synthetic test material')
    for (const path of retained) await put(source, `node_modules/${name}/${path}`, `production fixture: ${path}\n`)
  }
  const original = new Map()
  for (const name of Object.keys(packages)) original.set(name, await filesIn(join(source, 'node_modules', name)))
  const copied = await copyServerDependencies(source, payload)
  assert.deepEqual(copied, Object.keys(packages).sort())
  for (const name of copied) {
    const directory = join(payload, 'node_modules', name), actual = await filesIn(directory)
    const expected = original.get(name).filter(path => !rejected.includes(path))
    assert.deepEqual(actual, expected, name)
    for (const path of actual) assert.deepEqual(await readFile(join(directory, path)), await readFile(join(source, 'node_modules', name, path)), `${name}/${path}`)
  }
})

test('real locked dependency tree copies cleanly with complete source, types, exports and licenses', async t => {
  const root = await temporary(t), payload = join(root, 'payload'), lockBytes = await readFile(join(ROOT, 'package-lock.json'))
  const lock = JSON.parse(lockBytes), expectedNames = ['@noble/hashes', 'dom-serializer', 'domelementtype', 'domhandler', 'domutils', 'entities', 'htmlparser2']
  const expected = new Map(), excluded = []
  // Inspect public package paths first; never read excluded test/fixture bodies.
  async function sourceFiles(directory, prefix = '', files = []) {
    for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, lower = entry.name.toLowerCase()
      if (entry.name.startsWith('.') || forbiddenDirectories.has(lower) || entry.isFile() && testFile(entry.name)) { excluded.push(path); continue }
      assert.equal(entry.isSymbolicLink(), false, path)
      if (entry.isDirectory()) await sourceFiles(directory, path, files)
      else files.push(path)
    }
    return files.sort()
  }
  for (const name of expectedNames) expected.set(name, await sourceFiles(join(ROOT, 'node_modules', name)))
  const copied = await copyServerDependencies(ROOT, payload)
  assert.deepEqual(copied, expectedNames)
  let licenses = 0, fileCount = 0
  for (const name of copied) {
    const directory = join(payload, 'node_modules', name), paths = await filesIn(directory)
    assert.deepEqual(paths, expected.get(name), name)
    const pkg = await json(join(directory, 'package.json'))
    assert.equal(pkg.name, name); assert.equal(pkg.version, lock.packages[`node_modules/${name}`].version)
    for (const path of paths) {
      assert.ok(path.split('/').every(part => !forbiddenDirectories.has(part.toLowerCase()) && !part.startsWith('.')), path)
      assert.equal(testFile(path.split('/').at(-1)), false, path)
      const bytes = await readFile(join(directory, path))
      assert.equal(hash(bytes), hash(await readFile(join(ROOT, 'node_modules', name, path))), `${name}/${path}`)
      if (/^(?:licen[cs]e|copying|notice)(?:$|[._-])/iu.test(path.split('/').at(-1))) { assert.ok(bytes.toString('utf8').trim()); licenses++ }
      fileCount++
    }
  }
  for (const path of ['htmlparser2/dist/esm/index.js', 'htmlparser2/dist/commonjs/index.js', 'htmlparser2/dist/esm/Parser.d.ts',
    'htmlparser2/src/Parser.ts', '@noble/hashes/sha2.js', '@noble/hashes/sha2.d.ts', '@noble/hashes/src/sha2.ts']) {
    assert.equal((await lstat(join(payload, 'node_modules', path))).isFile(), true, path)
  }
  assert.ok(licenses >= copied.length)
  assert.deepEqual(await readFile(join(ROOT, 'package-lock.json')), lockBytes)
  t.diagnostic(`Copied ${copied.length} locked packages / ${fileCount} files; preserved ${licenses} complete license/notice files; excluded ${excluded.length} non-production paths.`)
  // The child only imports public parser/hash libraries from the temporary copy.
  // No ASTaria application module, SQLite file, server or packaging entry runs.
  const probe = String.raw`
    import assert from 'node:assert/strict'
    import { createRequire } from 'node:module'
    import { join, sep } from 'node:path'
    import { pathToFileURL, fileURLToPath } from 'node:url'
    import { parseDocument } from 'htmlparser2'
    import { WritableStream } from 'htmlparser2/WritableStream'
    import { textContent } from 'domutils'
    import { decodeHTML } from 'entities/decode'
    import { sha256 } from '@noble/hashes/sha2.js'
    import { bytesToHex } from '@noble/hashes/utils.js'
    const directory = join(process.cwd(), 'node_modules') + sep
    const require = createRequire(pathToFileURL(join(process.cwd(), 'qa-entry.mjs')))
    const esm = ['htmlparser2', 'htmlparser2/WritableStream', 'domelementtype', 'domhandler', 'domutils', 'dom-serializer', 'entities', 'entities/decode', 'entities/escape', '@noble/hashes/sha2.js', '@noble/hashes/utils.js']
    for (const specifier of esm) { assert.ok(fileURLToPath(import.meta.resolve(specifier)).startsWith(directory)); await import(specifier) }
    const cjs = esm.filter(specifier => !specifier.startsWith('@noble/'))
    for (const specifier of cjs) { assert.ok(require.resolve(specifier).startsWith(directory)); require(specifier) }
    assert.equal(textContent(parseDocument('<main><article>safe &amp; complete</article></main>')), 'safe & complete')
    assert.equal(typeof WritableStream, 'function'); assert.equal(decodeHTML('&amp;'), '&')
    assert.equal(bytesToHex(sha256(new TextEncoder().encode('abc'))), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    console.log(JSON.stringify({ esm: esm.length, cjs: cjs.length, parser: true, sha256: true }))
  `
  const imported = spawnSync(process.execPath, ['--input-type=module', '--eval', probe], {
    cwd: payload, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 15_000,
  })
  assert.equal(imported.error, undefined)
  assert.equal(imported.status, 0, imported.stdout + imported.stderr)
  assert.equal(imported.stderr, '')
  assert.deepEqual(JSON.parse(imported.stdout), { esm: 11, cjs: 9, parser: true, sha256: true })
})

test('lock version, source confinement and symlink rejection remain enforced', async t => {
  await t.test('locked version mismatch fails', async t => {
    const { source, payload } = await synthetic(t), path = join(source, 'node_modules/htmlparser2/package.json'), pkg = await json(path)
    await writeFile(path, JSON.stringify({ ...pkg, version: '10.0.1' }))
    await assert.rejects(copyServerDependencies(source, payload), /differs from package lock/u)
  })
  await t.test('an internal dependency file symlink still fails', async t => {
    const { source, payload } = await synthetic(t)
    await symlink('LICENSE', join(source, 'node_modules/htmlparser2/linked-license.txt'))
    await assert.rejects(copyServerDependencies(source, payload), /must not contain symbolic links/u)
  })
  await t.test('dependency root outside node_modules still fails', async t => {
    const { root, source, payload } = await synthetic(t), directory = join(source, 'node_modules/htmlparser2')
    await put(root, 'external/package.json', JSON.stringify({ name: 'htmlparser2', version: '10.0.0' }))
    await rm(directory, { recursive: true }); await symlink(join(root, 'external'), directory)
    await assert.rejects(copyServerDependencies(source, payload), /must resolve inside node_modules/u)
  })
})
