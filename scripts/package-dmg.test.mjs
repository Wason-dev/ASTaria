import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { argumentsFor, packageDmg, validateDmgSigningInput, verifyDmgDeveloperSignature } from './package-dmg.mjs'
import { createMacSigningPlan, reviewMacSigningPlan } from './macos-signing.mjs'

const TEAM = 'AB12CD34EF'
const IDENTITY = `Developer ID Application: Example Software (${TEAM})`
const CD_HASH = 'c'.repeat(40)
const SECRET = 'DO_NOT_PRINT_AUTHENTICATION_MATERIAL'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const targets = [
  { path: 'Contents/MacOS/Electron', kind: 'macho' },
  { path: 'Contents/Resources/app/bin/astaria-keychain', kind: 'macho' },
  { path: 'Contents/Frameworks/Electron.framework', kind: 'framework' },
  { path: 'Contents/Frameworks/Electron.framework/Versions/A/Electron', kind: 'macho' },
]
function signature({ identity = IDENTITY, team = TEAM, flags = '10000', timestamp = 'Oct 12, 2026 at 10:00:00 AM', cdHash = CD_HASH } = {}) {
  return `Authority=${identity}\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=${team}\nCodeDirectory v=20500 size=100 flags=0x${flags}(runtime) hashes=10\nTimestamp=${timestamp}\nCDHash=${cdHash}\n`
}

function fixture({ developerId = true, arch = 'arm64', version = '1.0.0', withBuildInfo = true } = {}) {
  const app = '/release/input/ASTaria.app', out = '/release/output', optionsFile = '/release/public-options.json'
  const args = { app, out, instructions: '/release/INSTALL.md', ...(developerId ? { signingOptionsFile: optionsFile } : {}) }
  const options = { app, arch, version, identity: IDENTITY, teamId: TEAM, keychainProfile: 'ASTaria-Notary-Existing',
    scratch: '/release/fresh-app-signing', artifact: `${out}/ASTaria-${version}-mac-${arch}-signed.dmg`, targets }
  const build = { schemaVersion: 1, name: 'ASTaria', version, bundleId: 'dev.wason.ASTaria', platform: 'darwin', arch,
    source: { commit: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false }, electronVersion: '40.0.0',
    nativeHelpers: { keychainSha256: sha('already signed helper') } }
  const plist = { CFBundleIdentifier: 'dev.wason.ASTaria', CFBundleExecutable: 'Electron' }
  const nodes = new Map(), actions = [], state = { report: () => developerId ? signature() : `Signature=adhoc\nCDHash=${CD_HASH}\n`, architectures: new Map() }
  const missing = () => Object.assign(new Error('Fixture path does not exist'), { code: 'ENOENT' })
  function directory(path) {
    if (nodes.has(path)) return
    if (path !== '/') directory(dirname(path))
    nodes.set(path, { kind: 'directory' })
  }
  function put(path, data) { directory(dirname(path)); nodes.set(path, { kind: 'file', bytes: Buffer.from(data) }) }
  function updateBuild() { put(join(app, 'Contents/Resources/app/build-info.json'), JSON.stringify(build)) }
  directory(app)
  directory(out)
  put(join(app, 'Contents/Resources/app/package.json'), JSON.stringify({ name: 'astaria', version }))
  if (withBuildInfo) updateBuild()
  for (const target of targets) {
    if (target.kind === 'framework') directory(join(app, target.path))
    else put(join(app, target.path), target.path.endsWith('astaria-keychain') ? 'already signed helper' : 'already signed Mach-O')
  }
  put(args.instructions, 'ASTaria installation instructions\n')
  put(optionsFile, JSON.stringify(options))
  put(fileURLToPath(new URL('./package-dmg.mjs', import.meta.url)), 'public packager source fixture')
  const files = {
    lstat: async path => {
      const node = nodes.get(path)
      if (!node) throw missing()
      return { isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file', isSymbolicLink: () => node.kind === 'symlink', size: node.bytes?.length }
    },
    realpath: async path => { if (!nodes.has(path)) throw missing(); return path },
    readFile: async (path, encoding) => {
      actions.push({ operation: 'read', path })
      const bytes = nodes.get(path)?.bytes
      if (!bytes) throw missing()
      return encoding ? bytes.toString(encoding) : Buffer.from(bytes)
    },
    mkdir: async path => { actions.push({ operation: 'mkdir', path }); directory(path) },
    mkdtemp: async prefix => { const path = `${prefix}fixture`; directory(path); actions.push({ operation: 'staging', path }); return path },
    symlink: async (target, path) => { nodes.set(path, { kind: 'symlink', target }); actions.push({ operation: 'symlink', path, target }) },
    writeFile: async (path, bytes) => { actions.push({ operation: 'write', path }); put(path, bytes) },
    rename: async (source, path) => { actions.push({ operation: 'rename', path }); nodes.set(path, nodes.get(source)); nodes.delete(source) },
    rm: async path => { actions.push({ operation: 'remove', path }); for (const key of nodes.keys()) if (key === path || key.startsWith(`${path}/`)) nodes.delete(key) },
  }
  const dependencies = { platform: 'darwin', files, now: () => '2026-10-12T00:00:00.000Z',
    preparePresentation: async ({ imageRoot, dmg, command }) => {
      directory(join(imageRoot, '.background')); put(join(imageRoot, '.background/install.png'), 'background'); put(join(imageRoot, '.DS_Store'), 'Finder metadata');
      await command('create-dmg', '/usr/bin/hdiutil', ['create', '-volname', 'ASTaria', '-srcfolder', imageRoot, '-format', 'UDZO', dmg]);
      return { window: [900,560], background: '.background/install.png', layout: '.DS_Store' }
    },
    discover: async () => state.inventory ?? targets.map(target => ({ ...target })),
    copyBundle: async (source, destination) => {
      actions.push({ operation: 'copy', source, destination })
      for (const [path, node] of [...nodes]) if (path === source || path.startsWith(`${source}/`)) {
        nodes.set(`${destination}${path.slice(source.length)}`, { ...node, ...(node.bytes ? { bytes: Buffer.from(node.bytes) } : {}) })
      }
      state.copiedApp = destination
      state.afterCopy?.(destination)
    },
    hashAsset: async path => {
      actions.push({ operation: 'hash', path })
      const bytes = nodes.get(path)?.bytes
      if (!bytes) throw missing()
      return { sha256: sha(bytes), sizeBytes: bytes.length }
    },
    signManifest: async manifest => {
      actions.push({ operation: 'sign-manifest' })
      return { ...manifest, signature: { algorithm: 'Ed25519', keyId: 'fixture', value: 'pure-test-signature' } }
    },
    onStep: event => actions.push({ operation: 'step', ...event }),
    run: async (tool, argv) => {
      actions.push({ operation: 'command', tool, args: [...argv] })
      const fault = state.fault?.(tool, argv)
      if (fault) return fault
      const reply = { status: 0, stdout: '', stderr: '' }, path = argv.at(-1)
      if (tool === '/usr/bin/plutil') reply.stdout = JSON.stringify(plist)
      else if (tool === '/usr/bin/lipo') reply.stdout = state.architectures.get(path) ?? (arch === 'x64' ? 'x86_64' : 'arm64')
      else if (tool === '/usr/bin/codesign' && argv.includes('--display')) reply.stderr = path.endsWith('.dmg') ? (state.dmgReport ?? signature({ flags: '0' })) : state.report(path)
      else if (tool === '/usr/bin/hdiutil' && argv[0] === 'create') put(path, 'created DMG bytes')
      else if (tool === '/usr/bin/codesign' && argv.includes('--sign')) {
        assert.ok(path.endsWith('.dmg'), '打包入口不能重签 App')
        put(path, Buffer.concat([nodes.get(path).bytes, Buffer.from(developerId ? ' + Developer ID timestamp signature' : ' + ad-hoc signature')]))
      }
      return reply
    } }
  const validation = () => ({ options, app, out, version, buildInfo: build, plist })
  return { args, options, build, plist, nodes, actions, state, dependencies, validation, put, updateBuild }
}
const commands = fake => fake.actions.filter(action => action.operation === 'command')
const signed = fake => commands(fake).filter(action => action.args.includes('--sign'))
const created = fake => commands(fake).filter(action => action.tool === '/usr/bin/hdiutil' && action.args[0] === 'create')

test('CLI 保留原参数形状，Developer ID 必须显式选择公开 options 文件', () => {
  const argv = ['--app', '/release/ASTaria.app', '--out', '/release/output', '--instructions', '/release/INSTALL.md']
  assert.deepEqual(argumentsFor(argv), { app: argv[1], out: argv[3], instructions: argv[5], signingKey: undefined })
  assert.equal(argumentsFor([...argv, '--signing-options', '/release/public-options.json']).signingOptionsFile, '/release/public-options.json')
  assert.equal(argumentsFor(['--help']), null)
  for (const extra of [['--signing-options'], ['--signing-options', '/release/a', '--signing-options', '/release/b'], ['--password', SECRET]]) {
    assert.throws(() => argumentsFor([...argv, ...extra]), error => !error.message.includes(SECRET))
  }
})

test('无 signing-options 保持 arm64 ad-hoc 文件名、内容、checksum 和可选构建信息', async () => {
  for (const withBuildInfo of [true, false]) {
    const fake = fixture({ developerId: false, version: '0.1.0-beta.12.1', withBuildInfo })
    if (withBuildInfo) { fake.build.source.dirty = true; fake.updateBuild() }
    const result = await packageDmg(fake.args, fake.dependencies)
    assert.equal(result.artifact, '/release/output/ASTaria-0.1.0-beta.12.1-mac-arm64-adhoc.dmg')
    assert.equal(result.manifest.signing, 'ad-hoc')
    assert.equal(result.manifest.arch, 'arm64')
    assert.equal(result.manifest.notarized, false)
    assert.equal(result.manifest.buildInfo?.source.dirty ?? null, withBuildInfo ? true : null)
    const bytes = fake.nodes.get(result.artifact).bytes
    assert.equal(result.manifest.sha256, sha(bytes))
    assert.equal(result.manifest.sizeBytes, bytes.length)
    assert.equal(fake.nodes.get(`${result.artifact}.sha256`).bytes.toString(), result.checksum)
    assert.deepEqual(signed(fake)[0].args.slice(0, -1), ['--force', '--sign', '-', '--timestamp=none'])
    assert.equal(fake.nodes.get('/release/output/install.txt').bytes.toString(), 'ASTaria installation instructions\n')
    assert.deepEqual(result.manifest.contents, ['ASTaria.app', 'Applications', '安装与打开说明.txt', '.background', '.DS_Store'])
    assert.deepEqual(result.manifest.presentation.window, [900,560])
  }
})

for (const [arch, version] of [['arm64', '1.0.0'], ['x64', '1.0.0-rc.1'], ['arm64', '1.0.0-beta.12.1']]) {
  test(`Developer ID ${arch}/${version} 核验原 App 与拷贝，仅签 DMG，最终字节 hash/size 不虚标公证`, async () => {
    const fake = fixture({ arch, version })
    fake.build.notarized = true // An inherited flag cannot certify the new DMG.
    fake.updateBuild()
    const original = new Map([...fake.nodes].filter(([path]) => path.startsWith(fake.args.app)).map(([path, node]) => [path, node.bytes ? Buffer.from(node.bytes) : null]))
    const result = await packageDmg(fake.args, fake.dependencies)
    assert.equal(result.artifact, fake.options.artifact)
    assert.equal(result.manifest.signing, 'developer-id')
    assert.equal(result.manifest.notarized, false)
    assert.equal(result.manifest.arch, arch)
    assert.equal(result.manifest.appCDHash, CD_HASH)
    assert.equal(result.manifest.buildInfo.nativeHelpers.keychainSha256, fake.build.nativeHelpers.keychainSha256)
    const bytes = fake.nodes.get(result.artifact).bytes
    assert.equal(result.manifest.sha256, sha(bytes))
    assert.equal(result.manifest.sizeBytes, bytes.length)
    assert.equal(result.checksum, `${sha(bytes)}  ${result.manifest.dmg}\n`)
    assert.equal(signed(fake).length, 1)
    assert.deepEqual(signed(fake)[0].args.slice(0, -1), ['--force', '--sign', IDENTITY, '--timestamp'])
    assert.ok(!commands(fake).some(action => ['/usr/bin/security', '/usr/bin/xcrun', '/usr/sbin/spctl'].includes(action.tool)))
    const probed = commands(fake).filter(action => action.tool === '/usr/bin/lipo')
    assert.equal(probed.length, targets.filter(target => target.kind === 'macho').length * 2)
    for (const [path, bytes] of original) if (bytes) assert.deepEqual(fake.nodes.get(path).bytes, bytes)
    assert.ok(!fake.actions.some(action => ['write', 'rename', 'remove'].includes(action.operation) && action.path.startsWith(fake.args.app)))
    assert.ok(!fake.actions.some(action => action.operation === 'read' && /keychain|private|password/u.test(action.path)))
    assert.ok(!JSON.stringify(result).includes(fake.options.keychainProfile))
  })
}

test('Ed25519 清单签名与 checksum 写入排在最后一次 DMG 修改、验签和哈希之后', async () => {
  const fake = fixture()
  fake.args.signingKey = '/not-read/update-ed25519.pem'
  const result = await packageDmg(fake.args, fake.dependencies)
  const signIndex = fake.actions.findIndex(action => action.operation === 'sign-manifest')
  const hashIndex = fake.actions.findIndex(action => action.operation === 'hash' && action.path.endsWith('.dmg'))
  assert.ok(signIndex > hashIndex)
  assert.ok(fake.actions.every((action, index) => action.operation !== 'command' || index < hashIndex))
  assert.ok(fake.actions.filter(action => action.operation === 'write' && /(?:\.sha256|\.manifest\.json)$/u.test(action.path)).every(action => fake.actions.indexOf(action) > signIndex))
  assert.ok(!fake.actions.some(action => action.operation === 'read' && action.path === fake.args.signingKey))
  const saved = JSON.parse(fake.nodes.get(result.artifact.replace(/\.dmg$/u, '.manifest.json')).bytes.toString())
  assert.deepEqual(saved.signature, result.manifest.signature)
  assert.equal(saved.sha256, sha(fake.nodes.get(result.artifact).bytes))
})

test('公开参数严格绑定 app、版本、arch、identity、team 与 dirty:false 构建来源', () => {
  for (const patch of [{ app: '/other/ASTaria.app' }, { version: 'v1.0' }, { version: '1.0.0-rc.01' },
    { version: '1.0.1', artifact: '/release/output/ASTaria-1.0.1-mac-arm64-signed.dmg' },
    { arch: 'x64', artifact: '/release/output/ASTaria-1.0.0-mac-x64-signed.dmg' },
    { artifact: '/elsewhere/ASTaria-1.0.0-mac-arm64-signed.dmg' },
    { identity: 'Developer ID Installer: Example Software (AB12CD34EF)' }, { teamId: 'ZZ12CD34EF' }, { password: SECRET }]) {
    const fake = fixture()
    assert.throws(() => validateDmgSigningInput({ ...fake.validation(), options: { ...fake.options, ...patch } }), error => !error.message.includes(SECRET))
  }
  for (const patch of [{ version: '0.9.0' }, { arch: 'x64' }, { name: 'other' }, { platform: 'win32' },
    { source: { commit: 'a'.repeat(40), dirty: true } }, { source: { commit: 'not-a-commit', dirty: false } }]) {
    const fake = fixture()
    assert.throws(() => validateDmgSigningInput({ ...fake.validation(), buildInfo: { ...fake.build, ...patch } }))
  }
})

test('App 身份报告必须唯一、匹配且带 runtime/timestamp；签名有效不代表公证', () => {
  const fake = fixture()
  const result = verifyDmgDeveloperSignature(signature(), fake.options, { verified: true })
  assert.equal(result.status, 'developer-id')
  assert.equal(result.notarized, false)
  assert.throws(() => verifyDmgDeveloperSignature(signature(), fake.options))
  for (const report of [signature({ identity: 'Developer ID Application: Another (AB12CD34EF)' }),
    signature({ team: 'ZZ12CD34EF' }), signature({ flags: '0' }), signature({ timestamp: 'none' }),
    `${signature()}Authority=${IDENTITY}\n`, `${signature()}TeamIdentifier=ZZ12CD34EF\n`,
    `${signature()}CDHash=${'d'.repeat(40)}\n`, `Signature=adhoc\nCDHash=${CD_HASH}\n`]) {
    assert.throws(() => verifyDmgDeveloperSignature(report, fake.options, { verified: true }))
  }
  assert.equal(verifyDmgDeveloperSignature(signature({ flags: '0' }), fake.options, { verified: true, hardenedRuntime: false }).status, 'developer-id')
})

test('执行时拒绝不符版本、缺失或脏构建信息、其他身份和旧默认模式中的 Developer ID App', async () => {
  for (const reason of ['version', 'dirty', 'missing-build', 'identity', 'implicit-developer-id']) {
    const fake = fixture({ withBuildInfo: reason !== 'missing-build' })
    if (reason === 'version') fake.put(join(fake.args.app, 'Contents/Resources/app/package.json'), JSON.stringify({ name: 'astaria', version: '1.0.1' }))
    if (reason === 'dirty') { fake.build.source.dirty = true; fake.updateBuild() }
    if (reason === 'identity') fake.state.report = () => signature({ team: 'ZZ12CD34EF' })
    if (reason === 'implicit-developer-id') delete fake.args.signingOptionsFile
    await assert.rejects(packageDmg(fake.args, fake.dependencies), /stopped at/u, reason)
    assert.equal(created(fake).length, 0, reason)
    assert.equal(signed(fake).length, 0, reason)
  }
})

test('lipo 验证每个实际 Mach-O：arm64 helper 或声明 x64 的 arm64 包都不能混入', async () => {
  for (const arch of ['arm64', 'x64']) {
    const fake = fixture({ arch })
    fake.state.architectures.set(join(fake.args.app, 'Contents/Resources/app/bin/astaria-keychain'), arch === 'arm64' ? 'x86_64' : 'arm64')
    await assert.rejects(packageDmg(fake.args, fake.dependencies), /source-app-architecture/u)
    assert.equal(created(fake).length, 0)
  }
})

test('拷贝后的根或嵌套 CDHash、metadata、inventory 变化在创建 DMG 前停止', async () => {
  for (const reason of ['root-hash', 'nested-hash', 'metadata', 'inventory']) {
    const fake = fixture()
    fake.state.afterCopy = copied => {
      if (reason === 'metadata') fake.put(join(copied, 'Contents/Resources/app/build-info.json'), JSON.stringify({ ...fake.build, version: '1.0.1' }))
      if (reason === 'inventory') fake.state.inventory = targets.slice(1)
      if (reason === 'root-hash' || reason === 'nested-hash') fake.state.report = path => signature({
        cdHash: path === copied && reason === 'root-hash' || path.startsWith(copied) && path.endsWith('astaria-keychain') && reason === 'nested-hash' ? 'd'.repeat(40) : CD_HASH })
    }
    await assert.rejects(packageDmg(fake.args, fake.dependencies), /copied-app/u, reason)
    assert.equal(created(fake).length, 0, reason)
  }
})

test('签名、验签、镜像验证失败立即停止，不计算成品或签清单，不输出工具认证内容', async () => {
  for (const reason of ['source-verify', 'sign-dmg', 'verify-dmg', 'verify-image', 'throw']) {
    const fake = fixture()
    fake.args.signingKey = '/not-read/release-signing.pem'
    fake.state.fault = (tool, args) => {
      const hit = reason === 'source-verify' && tool === '/usr/bin/codesign' && args.includes('--verify') && args.at(-1) === fake.args.app
        || reason === 'sign-dmg' && args.includes('--sign')
        || reason === 'verify-dmg' && args.includes('--verify') && args.at(-1).endsWith('.dmg')
        || reason === 'verify-image' && tool === '/usr/bin/hdiutil' && args[0] === 'verify'
      if (reason === 'throw' && args.includes('--sign')) throw new Error(SECRET)
      return hit ? { status: 1, stdout: SECRET, stderr: SECRET } : null
    }
    await assert.rejects(packageDmg(fake.args, fake.dependencies), error => /stopped at/u.test(error.message) && !error.message.includes(SECRET), reason)
    assert.ok(!fake.actions.some(action => ['hash', 'sign-manifest', 'rename'].includes(action.operation)), reason)
    if (reason === 'source-verify') assert.equal(created(fake).length, 0)
    else assert.ok(fake.nodes.has(`${fake.args.out}/.astaria-dmg-1.0.0-fixture`), '失败仅保留本轮隔离 staging')
  }
})

test('DMG 实际签名身份错误、清单签名失败和输出冲突不写可分发文件', async () => {
  for (const reason of ['dmg-identity', 'manifest-signing', 'collision']) {
    const fake = fixture()
    if (reason === 'dmg-identity') fake.state.dmgReport = signature({ identity: 'Developer ID Application: Other (AB12CD34EF)', flags: '0' })
    if (reason === 'manifest-signing') { fake.args.signingKey = '/not-read/key.pem'; fake.dependencies.signManifest = async () => { throw new Error(SECRET) } }
    if (reason === 'collision') fake.put(fake.options.artifact, 'existing output')
    await assert.rejects(packageDmg(fake.args, fake.dependencies), error => /stopped at/u.test(error.message) && !error.message.includes(SECRET))
    assert.ok(!fake.actions.some(action => action.operation === 'rename'))
    assert.ok(!fake.actions.some(action => action.operation === 'write' && /(?:\.sha256|\.manifest\.json)$/u.test(action.path)))
    if (reason === 'collision') assert.equal(fake.nodes.get(fake.options.artifact).bytes.toString(), 'existing output')
  }
})

test('签名计划使用实际 DMG 命令，输出仍未公证，staple 后才最终刷新并签署清单', () => {
  const fake = fixture(), plan = createMacSigningPlan(fake.options)
  const ids = plan.later.map(step => step.id), packageStep = plan.later.find(step => step.id === 'package-signed-dmg')
  assert.equal(packageStep.kind, 'command')
  assert.equal(packageStep.tool, process.execPath)
  assert.equal(packageStep.args[0], fileURLToPath(new URL('./package-dmg.mjs', import.meta.url)))
  assert.equal(packageStep.args[packageStep.args.indexOf('--app') + 1], fake.options.app)
  assert.equal(packageStep.args[packageStep.args.indexOf('--out') + 1], fake.args.out)
  assert.equal(packageStep.args[packageStep.args.indexOf('--signing-options') + 1], plan.later.find(step => step.id === 'write-dmg-options').path)
  assert.equal(packageStep.notarized, false)
  assert.equal(packageStep.producesStatus, 'developer-id')
  assert.ok(!ids.includes('sign-dmg'), 'DMG 命令已完成签名，不重复签名')
  assert.ok(ids.indexOf('assess-app') < ids.indexOf('package-signed-dmg'))
  assert.ok(ids.indexOf('package-signed-dmg') < ids.indexOf('submit-dmg'))
  assert.ok(ids.indexOf('staple-dmg') < ids.indexOf('verify-final-dmg'))
  assert.equal(plan.later.at(-1).id, 'refresh-manifest')
  assert.match(plan.later.at(-1).requires, /after final stapling/u)
  assert.ok(!JSON.stringify(reviewMacSigningPlan(plan)).includes(fake.options.keychainProfile))
})
