import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createMacSigningPlan, discoverMacSigningTargets, electronEntitlements, executeLocalMacSigning,
  macSigningArguments, refreshMacSigningManifest, reviewMacSigningPlan, validateMacSigningOptions,
  verifyMacSignature } from './macos-signing.mjs'

const TEAM = 'AB12CD34EF'
const IDENTITY = `Developer ID Application: Example Software (${TEAM})`
const CD_HASH = 'c'.repeat(40)
const FINGERPRINT = 'b'.repeat(40)
const SECRET = 'DO_NOT_PRINT_AUTHENTICATION_MATERIAL'
const targets = [
  { path: 'Contents/MacOS/Electron', kind: 'macho' },
  { path: 'Contents/Frameworks/Electron Framework.framework', kind: 'framework' },
  { path: 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', kind: 'macho' },
  { path: 'Contents/Frameworks/ASTaria Helper (Renderer).app', kind: 'app' },
  { path: 'Contents/Frameworks/ASTaria Helper (Renderer).app/Contents/MacOS/ASTaria Helper (Renderer)', kind: 'macho' },
  { path: 'Contents/Resources/app/bin/astaria-keychain', kind: 'macho' },
  { path: 'Contents/Resources/app/bin/ASTariaReminders.app', kind: 'app' },
  { path: 'Contents/Resources/app/bin/ASTariaReminders.app/Contents/MacOS/astaria-reminders', kind: 'macho' },
]
function options(patch = {}) {
  return { app: '/release/ASTaria.app', scratch: '/release/.signing-work', artifact: '/release/ASTaria-1.0.0-mac-arm64-signed.dmg',
    arch: 'arm64', version: '1.0.0', identity: IDENTITY, teamId: TEAM, keychainProfile: 'ASTaria-Notary-Existing',
    targets: targets.map(target => ({ ...target })), ...patch }
}
function report(patch = {}) {
  const values = { identity: IDENTITY, team: TEAM, flags: '10000', timestamp: 'Oct 12, 2026 at 10:00:00 AM', ...patch }
  return `Authority=${values.identity}\nAuthority=Developer ID Certification Authority\nTeamIdentifier=${values.team}\nCodeDirectory v=20500 size=100 flags=0x${values.flags}(runtime) hashes=10\nTimestamp=${values.timestamp}\nCDHash=${CD_HASH}\n`
}
function fakeExecution(input = options(), fail = () => false) {
  const actions = [], events = []
  const build = { name: 'ASTaria', version: input.version, bundleId: 'dev.wason.ASTaria', platform: 'darwin', arch: input.arch,
    source: { commit: 'a'.repeat(40), dirty: false }, nativeHelpers: { keychainSha256: '0'.repeat(64) } }
  const files = {
    realpath: async file => file,
    readFile: async file => file.endsWith('build-info.json') ? JSON.stringify(build) : Buffer.from('signed keychain helper bytes'),
    mkdir: async (...args) => actions.push({ operation: 'mkdir', args }),
    writeFile: async (...args) => actions.push({ operation: 'write', args }),
    rm: async (...args) => actions.push({ operation: 'remove', args }),
  }
  const dependencies = { confirmLocalSigning: true, platform: 'darwin', files, discover: async () => input.targets,
    onStep: event => events.push(event), run: async (tool, args) => {
      actions.push({ operation: 'command', tool, args })
      if (fail(tool, args)) return { status: 1, stdout: SECRET, stderr: SECRET }
      if (tool === '/usr/bin/security') return { status: 0, stdout: `  1) ${FINGERPRINT.toUpperCase()} "${input.identity}"\n  1 valid identities found`, stderr: '' }
      if (tool === '/usr/bin/lipo') return { status: 0, stdout: input.arch === 'x64' ? 'x86_64' : 'arm64', stderr: '' }
      return { status: 0, stdout: '', stderr: args.includes('--display') ? report({ identity: input.identity, team: input.teamId }) : '' }
    } }
  return { actions, events, dependencies, build }
}

test('计划只处于 prepared 状态，保留精确身份和已有 profile 引用，输出不暴露 profile', () => {
  const plan = createMacSigningPlan(options())
  assert.equal(plan.status, 'prepared')
  assert.equal(plan.notarized, false)
  assert.equal(plan.options.identity, IDENTITY)
  assert.ok(Object.isFrozen(plan.local))
  assert.ok(Object.isFrozen(plan.options.targets))
  const reviewed = JSON.stringify(reviewMacSigningPlan(plan))
  assert.ok(!reviewed.includes(options().keychainProfile))
  assert.ok(reviewed.includes('<existing-keychain-profile>'))
  assert.ok(!reviewed.includes('--password'))
  assert.ok(!reviewed.includes('--apple-id'))
})

test('参数拒绝 Installer 身份、team 不一致、非 canonical 版本和路径逃逸', () => {
  for (const patch of [
    { identity: `Developer ID Installer: Example (${TEAM})` }, { identity: `Developer ID Application: Example (ZZ12CD34EF)` },
    { identity: `${IDENTITY}\n` }, { teamId: `${TEAM}\n` }, { teamId: 'short' },
    { keychainProfile: '--password' }, { keychainProfile: 'profile\n--password' },
    { version: 'v1.0' }, { version: '01.0.0' }, { version: '1.0.0-rc.01' }, { version: '1.0.0\n' },
    { arch: 'universal' }, { app: 'ASTaria.app' }, { scratch: '/' }, { scratch: '/release' },
    { scratch: '/release/ASTaria.app/work' }, { artifact: '/release/ASTaria.app/output.dmg' },
    { targets: [{ path: 'Contents/../../private/key', kind: 'macho' }] }, { targets: [...targets, targets[0]] },
    { targets: targets.filter(target => !target.path.startsWith('Contents/MacOS/')) },
  ]) assert.throws(() => validateMacSigningOptions(options(patch)), undefined, JSON.stringify(patch))
  for (const version of ['0.1.0-beta.12.1', '1.0.0-rc.1', '1.0.0']) {
    assert.equal(validateMacSigningOptions(options({ version, artifact: `/release/ASTaria-${version}-mac-arm64-signed.dmg` })).version, version)
  }
})

test('认证参数完全不接收，拒绝错误不回显密码或私钥内容', () => {
  for (const key of ['password', 'privateKey', 'appleId', 'apiKey', 'credentials', 'keychainPassword']) {
    assert.throws(() => createMacSigningPlan(options({ [key]: SECRET })), error => !error.message.includes(SECRET))
  }
  assert.throws(() => macSigningArguments(['--password', SECRET]), error => !error.message.includes(SECRET))
})

test('Electron 默认仅启用 JIT；兼容权限必须显式选择，原生 helper 不继承 Electron 权限', () => {
  const xml = electronEntitlements()
  assert.ok(xml.includes('com.apple.security.cs.allow-jit'))
  for (const key of ['allow-unsigned-executable-memory', 'disable-library-validation', 'get-task-allow', 'app-sandbox']) assert.ok(!xml.includes(key))
  const compatibility = electronEntitlements({ allowUnsignedExecutableMemory: true, disableLibraryValidation: true })
  assert.ok(compatibility.includes('allow-unsigned-executable-memory'))
  assert.ok(compatibility.includes('disable-library-validation'))
  const plan = createMacSigningPlan(options())
  for (const step of plan.local.filter(step => step.args?.includes('--sign'))) {
    const target = step.args.at(-1)
    assert.ok(step.args.includes('--timestamp'))
    assert.ok(step.args.includes('runtime'))
    if (target.includes('astaria-keychain') || target.includes('ASTariaReminders.app')) assert.ok(!step.args.includes('--entitlements'))
  }
})

test('签名由内向外、根 App 最后；--deep 仅用于 verify；更新 helper 哈希在外层密封之前', () => {
  const plan = createMacSigningPlan(options())
  const signed = plan.local.filter(step => step.args?.includes('--sign'))
  const positions = new Map(signed.map((step, index) => [step.args.at(-1), index]))
  assert.equal(signed.at(-1).args.at(-1), options().app)
  for (const target of targets) for (const parent of targets.filter(value => value.kind !== 'macho')) {
    if (target.path.startsWith(`${parent.path}/`)) assert.ok(positions.get(`${options().app}/${target.path}`) < positions.get(`${options().app}/${parent.path}`))
  }
  for (const step of plan.local) if (step.args?.includes('--deep')) assert.ok(step.args.includes('--verify'))
  for (const target of targets) {
    const verification = plan.local.find(step => step.args?.includes('--verify') && step.args.at(-1) === `${options().app}/${target.path}`)
    assert.ok(verification, '非标准 Resources/app/bin 位置也必须逐一验签')
  }
  assert.ok(plan.local.findIndex(step => step.id === 'refresh-native-hashes') < plan.local.findIndex(step => step.id === 'sign-app'))
})

test('notarization 只构建未来命令，要求 --wait/Accepted、stapler validate、spctl 和最终重算', () => {
  const plan = createMacSigningPlan(options())
  assert.equal(plan.later.at(-1).id, 'refresh-manifest')
  for (const phase of ['app', 'dmg']) {
    const submit = plan.later.find(step => step.id === `submit-${phase}`)
    assert.equal(submit.network, true)
    assert.equal(submit.requiresStatus, 'Accepted')
    assert.ok(submit.args.includes('--wait'))
    assert.equal(submit.args[submit.args.indexOf('--keychain-profile') + 1], options().keychainProfile)
    const ids = plan.later.map(step => step.id)
    assert.ok(ids.indexOf(`submit-${phase}`) < ids.indexOf(`staple-${phase}`))
    assert.ok(ids.indexOf(`staple-${phase}`) < ids.indexOf(`validate-${phase}-ticket`))
    assert.ok(ids.indexOf(`validate-${phase}-ticket`) < ids.indexOf(`assess-${phase}`))
  }
  assert.ok(plan.later.find(step => step.id === 'assess-dmg').args.includes('context:primary-signature'))
  assert.ok(!plan.local.some(step => step.tool === '/usr/bin/xcrun'))
})

test('显式开关或 macOS 平台缺失时不执行任何步骤', async () => {
  const fake = fakeExecution()
  for (const patch of [{ confirmLocalSigning: false }, { platform: 'linux' }]) {
    await assert.rejects(executeLocalMacSigning(options(), { ...fake.dependencies, ...patch }), /Explicit local signing/u)
  }
  assert.equal(fake.actions.length, 0)
})

for (const arch of ['arm64', 'x64']) test(`本机执行验证 ${arch}、唯一证书身份、每个代码签名，完成只报告 developer-id`, async () => {
  const input = options({ arch, artifact: `/release/ASTaria-1.0.0-mac-${arch}-signed.dmg` })
  const fake = fakeExecution(input)
  const result = await executeLocalMacSigning(input, fake.dependencies)
  assert.equal(result.status, 'developer-id')
  assert.equal(result.notarized, false)
  assert.equal(result.appCDHash, CD_HASH)
  assert.ok(fake.actions.filter(action => action.args?.includes('--sign')).every(action => action.args[action.args.indexOf('--sign') + 1] === FINGERPRINT.toUpperCase()))
  assert.ok(!fake.actions.some(action => action.tool === '/usr/bin/xcrun' || action.tool === '/usr/sbin/spctl'))
  const helperWrite = fake.actions.find(action => action.operation === 'write' && action.args[0].endsWith('build-info.json'))
  assert.equal(JSON.parse(helperWrite.args[1]).nativeHelpers.keychainSha256, createHash('sha256').update('signed keychain helper bytes').digest('hex'))
  const rootSign = fake.actions.findIndex(action => action.args?.includes('--sign') && action.args.at(-1) === input.app)
  assert.ok(fake.actions.indexOf(helperWrite) < rootSign)
  assert.equal(fake.actions.at(-1).operation, 'remove')
  assert.ok(!JSON.stringify({ result, events: fake.events }).includes(SECRET))
})

test('执行失败立即停止、不执行公证、保留错误阶段而不输出子进程认证内容', async () => {
  const fake = fakeExecution(options(), (tool, args) => tool === '/usr/bin/codesign' && args.includes('--sign'))
  await assert.rejects(executeLocalMacSigning(options(), fake.dependencies), error => /stopped at sign-/u.test(error.message) && !error.message.includes(SECRET))
  assert.equal(fake.actions.filter(action => action.args?.includes('--sign')).length, 1)
  assert.ok(!fake.actions.some(action => action.args?.includes('--verify') || action.tool === '/usr/bin/xcrun'))
  assert.equal(fake.actions.at(-1).operation, 'remove')
})

test('子项 verify 或签名身份报告失败也停止，throw 的认证内容不会进入错误', async () => {
  for (const failure of ['verify', 'display', 'throw']) {
    const fake = fakeExecution()
    const run = fake.dependencies.run
    fake.dependencies.run = async (tool, args) => {
      const result = await run(tool, args)
      if (failure === 'verify' && args.includes('--verify') && args.at(-1).endsWith('astaria-keychain')) result.status = 1
      if (failure === 'display' && args.includes('--display')) result.stderr = report({ team: 'ZZ12CD34EF' })
      if (failure === 'throw' && tool === '/usr/bin/security') throw new Error(SECRET)
      return result
    }
    await assert.rejects(executeLocalMacSigning(options(), fake.dependencies), error => /stopped at/u.test(error.message) && !error.message.includes(SECRET))
    assert.ok(!fake.events.some(event => event.id === 'display-app' && event.status === 'complete'))
  }
})

test('清单不完整、架构错误、重复证书或脏来源都在签名前停止', async () => {
  for (const reason of ['inventory', 'architecture', 'identity', 'provenance', 'commit', 'credential-field', 'scratch-symlink']) {
    const fake = fakeExecution()
    if (reason === 'inventory') fake.dependencies.discover = async () => targets.slice(1)
    if (reason === 'provenance') fake.build.source.dirty = true
    if (reason === 'commit') fake.build.source.commit += '\n'
    if (reason === 'credential-field') fake.build.password = SECRET
    if (reason === 'scratch-symlink') fake.dependencies.files.realpath = async () => '/release/ASTaria.app'
    const run = fake.dependencies.run
    fake.dependencies.run = async (tool, args) => {
      const result = await run(tool, args)
      if (reason === 'architecture' && tool === '/usr/bin/lipo') result.stdout = 'x86_64'
      if (reason === 'identity' && tool === '/usr/bin/security') result.stdout += `\n  2) ${'d'.repeat(40)} "${IDENTITY}"`
      return result
    }
    await assert.rejects(executeLocalMacSigning(options(), fake.dependencies), /stopped at/u, reason)
    assert.ok(!fake.actions.some(action => action.args?.includes('--sign')), reason)
  }
})

test('prepared、adhoc 与 Developer ID 明确区分；错身份、team、timestamp 或 runtime 不能宣称已签名', () => {
  assert.equal(createMacSigningPlan(options()).status, 'prepared')
  const adhoc = `Signature=adhoc\nCDHash=${CD_HASH}\n`
  assert.equal(verifyMacSignature(adhoc, options(), { verified: true }).status, 'adhoc')
  assert.equal(verifyMacSignature(report(), options(), { verified: true }).status, 'developer-id')
  assert.throws(() => verifyMacSignature(report(), options()), /verification/u)
  for (const patch of [{ identity: 'Apple Development: Example' }, { team: 'ZZ12CD34EF' }, { timestamp: 'none' }, { flags: '0' }]) {
    assert.throws(() => verifyMacSignature(report(patch), options(), { verified: true }), /verification failed/u)
  }
})

function manifestFixture() {
  return { schemaVersion: 1, name: 'ASTaria', bundleId: 'dev.wason.ASTaria', version: '1.0.0', platform: 'darwin', arch: 'arm64',
    signing: 'ad-hoc', notarized: false, dmg: 'old-adhoc.dmg', sha256: '0'.repeat(64), sizeBytes: 1,
    signature: { algorithm: 'Ed25519', keyId: 'old-key', value: 'stale-signature' },
    buildInfo: { version: '1.0.0', source: { commit: 'a'.repeat(40), dirty: false } } }
}
const finalBytes = Buffer.from('final signed and stapled DMG fixture')
const finalHash = createHash('sha256').update(finalBytes).digest('hex')
const hashAsset = async () => ({ sha256: finalHash, sizeBytes: finalBytes.length })
function refreshInput(patch = {}) {
  return { manifest: manifestFixture(), options: options(), appSignatureReport: report(), dmgSignatureReport: report({ flags: '0' }),
    appVerified: true, dmgVerified: true, ...patch }
}
function receipts(patch = {}) {
  const accepted = { status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' }
  return { appSubmission: accepted, dmgSubmission: { ...accepted, id: '87654321-1234-1234-1234-123456789abc' }, appStaplerExitCode: 0, dmgStaplerExitCode: 0,
    appGatekeeperExitCode: 0, dmgGatekeeperExitCode: 0, artifact: options().artifact, finalSha256: finalHash,
    appCDHash: CD_HASH, teamId: TEAM, ...patch }
}

test('签名后重新读取最终资产哈希和大小，清除旧发布签名，未公证时不虚标', async () => {
  const calls = []
  const result = await refreshMacSigningManifest(refreshInput(), { hashAsset: async file => { calls.push(file); return hashAsset() } })
  assert.deepEqual(calls, [options().artifact])
  assert.equal(result.status, 'developer-id')
  assert.equal(result.manifest.notarized, false)
  assert.equal(result.manifest.sha256, finalHash)
  assert.equal(result.manifest.sizeBytes, finalBytes.length)
  assert.equal(result.manifest.appCDHash, CD_HASH)
  assert.equal(result.manifest.dmg, 'ASTaria-1.0.0-mac-arm64-signed.dmg')
  assert.equal(result.manifest.signature, undefined)
  assert.equal(result.needsReleaseManifestSignature, true)
  assert.equal(result.checksum, `${finalHash}  ${result.manifest.dmg}\n`)
})

test('刷新不会携带原 DMG/ZIP 的旧资产哈希、旧公证或未重新检查的验证标志', async () => {
  const manifest = { ...manifestFixture(), assets: [{ name: 'old.zip', sha256: '0'.repeat(64) }],
    archive: 'old.zip', imageVerified: true, notarization: { status: 'Accepted' }, signingStatus: 'notarized', notarized: true }
  const { manifest: refreshed } = await refreshMacSigningManifest(refreshInput({ manifest }), { hashAsset })
  for (const key of ['signature', 'assets', 'archive', 'imageVerified', 'notarization', 'signingStatus']) assert.equal(refreshed[key], undefined, key)
  assert.equal(refreshed.notarized, false)
  assert.equal(refreshed.includesUserData, undefined, '没有新检查不能添加用户数据排除声明')
})

test('只有完整 Accepted、ticket/Gatekeeper 和最终资产关联证据才得到 notarized', async () => {
  const result = await refreshMacSigningManifest(refreshInput({ notarization: receipts() }), { hashAsset })
  assert.equal(result.status, 'notarized')
  assert.equal(result.manifest.notarized, true)
  for (const patch of [{ appSubmission: { status: 'In Progress' } }, { dmgSubmission: { status: 'Invalid' } },
    { appStaplerExitCode: 1 }, { dmgStaplerExitCode: 1 }, { appGatekeeperExitCode: 1 }, { dmgGatekeeperExitCode: 1 },
    { artifact: '/release/other.dmg' }, { finalSha256: '0'.repeat(64) }, { appCDHash: '0'.repeat(40) }, { teamId: 'ZZ12CD34EF' }]) {
    await assert.rejects(refreshMacSigningManifest(refreshInput({ notarization: receipts(patch) }), { hashAsset }), /Accepted notarization/u)
  }
  await assert.rejects(refreshMacSigningManifest(refreshInput({ notarization: receipts({ dmgSubmission: receipts().appSubmission }) }), { hashAsset }), /Accepted notarization/u)
  for (const notarization of [true, null, 'notarized']) {
    await assert.rejects(refreshMacSigningManifest(refreshInput({ notarization }), { hashAsset }), /Accepted notarization/u)
  }
})

test('刷新拒绝未验证签名、旧来源和认证字段，且错误不泄露内容', async () => {
  for (const patch of [{ appVerified: false }, { dmgVerified: false },
    { manifest: { ...manifestFixture(), password: SECRET } },
    { manifest: { ...manifestFixture(), buildInfo: { version: '1.0.0', source: { commit: 'a'.repeat(40), dirty: true } } } }]) {
    await assert.rejects(refreshMacSigningManifest(refreshInput(patch), { hashAsset }), error => !error.message.includes(SECRET))
  }
  await assert.rejects(refreshMacSigningManifest(refreshInput(), { hashAsset: async () => { throw new Error(SECRET) } }),
    error => /hashing failed/u.test(error.message) && !error.message.includes(SECRET))
  for (const digest of [undefined, { sha256: 'short', sizeBytes: 10 }, { sha256: finalHash, sizeBytes: 0 }]) {
    await assert.rejects(refreshMacSigningManifest(refreshInput(), { hashAsset: async () => digest }), /hash or size/u)
  }
})

test('扫描只在指定 App 内识别 Mach-O 和 bundle，不遍历 framework symlink，拒绝外部链接', async () => {
  const entry = (name, kind) => ({ name, isDirectory: () => kind === 'dir', isFile: () => kind === 'file', isSymbolicLink: () => kind === 'link' })
  const directories = new Map([
    ['/release/ASTaria.app', [entry('Contents', 'dir')]],
    ['/release/ASTaria.app/Contents', [entry('MacOS', 'dir'), entry('Frameworks', 'dir')]],
    ['/release/ASTaria.app/Contents/MacOS', [entry('Electron', 'file')]],
    ['/release/ASTaria.app/Contents/Frameworks', [entry('Electron.framework', 'dir')]],
    ['/release/ASTaria.app/Contents/Frameworks/Electron.framework', [entry('Current', 'link')]],
  ])
  const opened = []
  const files = {
    lstat: async () => ({ isDirectory: () => true, isSymbolicLink: () => false }),
    realpath: async file => file.endsWith('Current') ? '/release/ASTaria.app/Contents/Frameworks/Electron.framework/A' : file,
    readdir: async file => directories.get(file),
    open: async file => { opened.push(file); return { read: async bytes => { Buffer.from('cffaedfe', 'hex').copy(bytes); return { bytesRead: 4 } }, close: async () => {} } },
  }
  assert.deepEqual(await discoverMacSigningTargets(options().app, files), [
    { path: 'Contents/MacOS/Electron', kind: 'macho' }, { path: 'Contents/Frameworks/Electron.framework', kind: 'framework' },
  ])
  assert.equal(opened.length, 1)
  files.realpath = async file => file.endsWith('Current') ? '/private/elsewhere' : file
  await assert.rejects(discoverMacSigningTargets(options().app, files), /External code bundle symlink/u)
})
