import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { inspectMobileBuild, parseCapacitorConfig, parseDoctorArgs } from './mobile-doctor.mjs'

const ROOT = '/synthetic/ASTaria'
const XCODE = '/synthetic/Xcode Test.app/Contents/Developer'
const JAVA_HOME = '/synthetic/JDK 21'
const SDK = '/synthetic/Android SDK'
const CAP_NAMES = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android']
const CONFIG = `import type { CapacitorConfig } from '@capacitor/cli'
const config: CapacitorConfig = {
  appId: 'dev.wason.ASTaria', webDir: 'dist-mobile',
  ios: { path: 'mobile/ios' },
  android: { path: 'mobile/android', allowMixedContent: false },
  server: { androidScheme: 'https' },
}
export default config`

function fixture({ missingTools = false, changes = {}, env = {}, platform = 'darwin', javaVersion = 21, javacVersion = javaVersion,
  buildToolsVersion = '35.0.0' } = {}) {
  const dependencies = Object.fromEntries(CAP_NAMES.map((name) => [name, '8.5.3']))
  const packages = { '': { dependencies }, ...Object.fromEntries(CAP_NAMES.map((name) =>
    ['node_modules/' + name, { version: '8.5.3', integrity: 'sha512-synthetic-fixture' }])) }
  const content = new Map(Object.entries({
    'package.json': JSON.stringify({ version: '0.1.0-beta.12.1', dependencies }),
    'package-lock.json': JSON.stringify({ lockfileVersion: 3, packages }),
    ...Object.fromEntries(CAP_NAMES.map((name) => ['node_modules/' + name + '/package.json', JSON.stringify({ version: '8.5.3' })])),
    'capacitor.config.ts': CONFIG,
    'mobile/ios/App/App.xcodeproj/project.pbxproj': `MARKETING_VERSION = 1.0;
CURRENT_PROJECT_VERSION = 1; PRODUCT_BUNDLE_IDENTIFIER = dev.wason.ASTaria;
MARKETING_VERSION = 1.0; CURRENT_PROJECT_VERSION = 1; PRODUCT_BUNDLE_IDENTIFIER = dev.wason.ASTaria;`,
    'mobile/ios/App/App/Info.plist': '<key>CFBundleShortVersionString</key><string>$(MARKETING_VERSION)</string><key>CFBundleVersion</key><string>$(CURRENT_PROJECT_VERSION)</string>',
    'mobile/android/app/build.gradle': `namespace = "dev.wason.ASTaria"
applicationId "dev.wason.ASTaria"
versionName "1.0"
versionCode 1`,
    'mobile/ios/App/App/ASTariaSecretsPlugin.swift': `private let service = "dev.wason.ASTaria.cloud-api"
kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly
kSecAttrSynchronizable as String: false`,
    'mobile/android/app/src/main/java/dev/wason/ASTaria/ASTariaSecretsPlugin.java': `KEY_ALIAS = "dev.wason.ASTaria.cloud-api";
"AndroidKeyStore"; "AES/GCM/NoPadding"; .setKeySize(256); .setRandomizedEncryptionRequired(true); getNoBackupFilesDir();`,
    'mobile/android/app/src/main/AndroidManifest.xml': '<application android:allowBackup="false" android:fullBackupContent="false"></application>',
    'mobile/ios/App/CapApp-SPM/Package.swift': '.package(url: "https://github.com/ionic-team/capacitor-swift-pm.git", from: "8.0.0")',
    'mobile/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved': JSON.stringify({ version: 2,
      pins: [{ identity: 'capacitor-swift-pm', state: { version: '8.5.3', revision: 'a'.repeat(40) } }] }),
    'mobile/android/variables.gradle': 'compileSdkVersion = 36',
    'mobile/android/build.gradle': "classpath 'com.android.tools.build:gradle:8.13.0'",
    'mobile/android/gradle/wrapper/gradle-wrapper.properties': 'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-all.zip',
    'mobile/android/app/capacitor.build.gradle': 'sourceCompatibility JavaVersion.VERSION_21',
    'mobile/android/capacitor.settings.gradle': 'include ":capacitor-android"',
    'mobile/android/gradle/wrapper/gradle-wrapper.jar': 'synthetic-fixture-not-a-jar',
    ...changes,
  }))
  const tools = new Set(missingTools ? [] : [
    '/synthetic/bin/xcode-select', '/synthetic/bin/xcrun', `${XCODE}/usr/bin/xcodebuild`, `${XCODE}/usr/bin/simctl`,
    `${JAVA_HOME}/bin/java`, `${JAVA_HOME}/bin/javac`, `${SDK}/platform-tools/adb`,
    `${SDK}/build-tools/${buildToolsVersion}/aapt2`, `${SDK}/build-tools/${buildToolsVersion}/zipalign`, `${SDK}/build-tools/${buildToolsVersion}/d8`,
  ])
  const directories = new Set(missingTools ? [] : [
    `${XCODE}/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk`,
    `${XCODE}/Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk`,
  ])
  const files = new Set(missingTools ? [] : [`${SDK}/platforms/android-36/android.jar`])
  const reads = [], probes = []
  const options = {
    root: ROOT, platform, env: { PATH: '/synthetic/bin', ASTARIA_MOBILE_JAVA_HOME: JAVA_HOME,
      ASTARIA_MOBILE_ANDROID_SDK_ROOT: SDK, ...env },
    readText(file) {
      assert.ok(file.startsWith(ROOT + '/'), 'only explicit public project inputs')
      const relative = path.relative(ROOT, file)
      assert.doesNotMatch(relative, /PROJECT_ROADMAP|backup|\.bak|keychain|profiles|\.keystore|local\.properties/i)
      reads.push(relative)
      if (!content.has(relative) || content.get(relative) === null) throw new Error('fixture missing')
      return content.get(relative)
    },
    isFile: (file) => files.has(file) || (file.startsWith(ROOT + '/') && content.get(path.relative(ROOT, file)) != null),
    isDirectory: (file) => directories.has(file), isExecutable: (file) => tools.has(file),
    listDirectories(file) {
      assert.equal(file, `${SDK}/build-tools`)
      return missingTools ? [] : [buildToolsVersion]
    },
    run(command, args, selectedEnv) {
      probes.push({ command, args, env: selectedEnv })
      if (command.endsWith('xcode-select')) return { ok: true, output: XCODE }
      if (command.endsWith('xcodebuild')) return { ok: true, output: 'Xcode 26.0\nBuild version SYNTHETIC' }
      if (command.endsWith('xcrun')) return { ok: true, output: `${XCODE}/usr/bin/simctl` }
      if (command.endsWith('/java')) return { ok: true, output: `openjdk version "${javaVersion}.0.1"` }
      if (command.endsWith('/javac')) return { ok: true, output: `javac ${javacVersion}.0.1` }
      throw new Error('Unexpected process')
    },
  }
  return { options, content, tools, directories, files, reads, probes, report: () => inspectMobileBuild(options) }
}

const item = (report, id) => report.checks.find((check) => check.id === id)

test('literal config parsing preserves strings, ignores comments and rejects evaluation', () => {
  const config = parseCapacitorConfig(CONFIG.replace("appId: 'dev.wason.ASTaria',", "/* server.url='comment' */ appId: 'dev.wason.ASTaria', appName: 'https://example.invalid',"))
  assert.equal(config.appId, 'dev.wason.ASTaria')
  assert.equal(config.appName, 'https://example.invalid')
  for (const change of [
    CONFIG.replace("webDir: 'dist-mobile'", 'webDir: process.env.DIR'),
    CONFIG.replace("appId: 'dev.wason.ASTaria'", "...other, appId: 'dev.wason.ASTaria'"),
    CONFIG + '\nfetch("https://example.invalid")',
    CONFIG.replace("appId: 'dev.wason.ASTaria'", "appId: 'one', appId: 'two'"),
  ]) assert.throws(() => parseCapacitorConfig(change))
})

test('ready means local prerequisites only, never built/signed/uploaded', () => {
  const f = fixture(), report = f.report()
  assert.equal(report.schemaVersion, 1)
  assert.equal(report.status, 'ready')
  assert.deepEqual(report.platforms, { ios: 'ready', android: 'ready' })
  assert.ok(report.checks.every((check) => check.status === 'ready' && check.remediation.length === 0))
  for (const key of ['nativeBuildExecuted', 'dependencyResolutionExecuted', 'networkAccessPerformed', 'signingIdentityInspected', 'testFlightUploadExecuted']) {
    assert.equal(report.verification[key], false)
  }
  assert.equal(JSON.stringify(f.report()), JSON.stringify(report), 'same inputs produce the same JSON')
})

test('absent native tools are honestly blocked while source contracts remain ready', () => {
  const f = fixture({ missingTools: true }), report = f.report()
  assert.equal(report.status, 'blocked')
  for (const id of ['tools.xcode', 'tools.simctl', 'tools.jdk', 'tools.android-sdk']) {
    assert.equal(item(report, id).status, 'blocked')
    assert.ok(item(report, id).remediation[0])
  }
  assert.ok(report.checks.filter((check) => check.area === 'source').every((check) => check.status === 'ready'))
  assert.deepEqual(f.probes, [])
})

test('CommandLineTools and xcodebuild shims do not count as complete Xcode', () => {
  const f = fixture({ env: { DEVELOPER_DIR: '/synthetic/CommandLineTools' } })
  f.tools.add('/synthetic/bin/xcodebuild')
  const report = f.report()
  assert.equal(item(report, 'tools.xcode').status, 'blocked')
  assert.equal(item(report, 'tools.simctl').status, 'blocked')
  assert.ok(!f.probes.some((probe) => /xcodebuild|xcrun/.test(probe.command)))
})

test('explicit Xcode/JDK/SDK paths win and paths with spaces remain individual process arguments', () => {
  const f = fixture({ env: { DEVELOPER_DIR: '/wrong', JAVA_HOME: '/wrong', ANDROID_HOME: '/wrong' } })
  Object.assign(f.options, { xcodeDeveloperDir: XCODE, javaHome: JAVA_HOME, androidSdk: SDK })
  const report = f.report()
  assert.equal(report.status, 'ready')
  assert.ok(!f.probes.some((probe) => probe.command.endsWith('xcode-select')))
  assert.deepEqual(f.probes.find((probe) => probe.command.endsWith('xcodebuild')).args, ['-version'])
  assert.equal(f.probes.find((probe) => probe.command.endsWith('xcodebuild')).env.DEVELOPER_DIR, XCODE)
})

test('probes cannot receive credentials, shell startup options, or Java option injection', () => {
  const f = fixture({ env: { API_KEY: 'SYNTHETIC_FORBIDDEN', JAVA_TOOL_OPTIONS: 'SYNTHETIC_FORBIDDEN',
    JDK_JAVA_OPTIONS: 'SYNTHETIC_FORBIDDEN', _JAVA_OPTIONS: 'SYNTHETIC_FORBIDDEN', BASH_ENV: 'SYNTHETIC_FORBIDDEN' } })
  const report = f.report()
  for (const probe of f.probes) {
    assert.ok(!JSON.stringify(probe.env).includes('SYNTHETIC_FORBIDDEN'))
    assert.ok(['-p', '-version', '--no-cache'].includes(probe.args[0]))
    assert.ok(!probe.args.includes('list'))
  }
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_FORBIDDEN'))
})

test('unsupported JDK 25, old JDK, mismatched java/javac and failed probes block Android', () => {
  for (const settings of [{ javaVersion: 25 }, { javaVersion: 17 }, { javaVersion: 21, javacVersion: 24 }]) {
    assert.equal(item(fixture(settings).report(), 'tools.jdk').status, 'blocked')
  }
  const f = fixture()
  f.options.run = () => ({ ok: false, output: 'SYNTHETIC_PRIVATE_PROCESS_ERROR' })
  const report = f.report()
  assert.equal(item(report, 'tools.jdk').status, 'blocked')
  assert.ok(!JSON.stringify(report).includes('SYNTHETIC_PRIVATE_PROCESS_ERROR'))
})

test('Android SDK can be found from PATH adb without running adb or sdkmanager', () => {
  const f = fixture({ env: { ASTARIA_MOBILE_ANDROID_SDK_ROOT: '', PATH: `/synthetic/bin:${SDK}/platform-tools` } })
  assert.equal(item(f.report(), 'tools.android-sdk').status, 'ready')
  assert.ok(!f.probes.some((probe) => /adb|sdkmanager|gradle|npm|security/.test(probe.command)))
  f.files.delete(`${SDK}/platforms/android-36/android.jar`)
  assert.equal(item(f.report(), 'tools.android-sdk').status, 'blocked')
})

test('installed Build Tools 36 and JDK 21 pass local prerequisites without claiming a Gradle build', () => {
  const report = fixture({ buildToolsVersion: '36.0.0' }).report()
  assert.equal(report.platforms.android, 'ready')
  const sdk = item(report, 'tools.android-sdk')
  assert.equal(sdk.details.buildToolsVersion, '36.0.0')
  assert.equal(sdk.details.buildToolsSource, 'installed-sdk')
  assert.equal(sdk.details.gradleBuildToolsSelectionVerified, false)
  assert.equal(report.verification.nativeBuildExecuted, false)
})

test('SDK inspection honors a pinned build-tools version and rejects incomplete or old tools', () => {
  const pinned = fixture({ buildToolsVersion: '36.0.0' })
  pinned.content.set('mobile/android/app/build.gradle', pinned.content.get('mobile/android/app/build.gradle') + '\nbuildToolsVersion "35.0.0"')
  assert.equal(item(pinned.report(), 'tools.android-sdk').status, 'blocked')
  assert.equal(item(pinned.report(), 'tools.android-sdk').details.buildToolsVersion, '35.0.0')
  const incomplete = fixture({ buildToolsVersion: '36.0.0' })
  incomplete.tools.delete(`${SDK}/build-tools/36.0.0/d8`)
  assert.equal(item(incomplete.report(), 'tools.android-sdk').status, 'blocked')
  assert.equal(item(fixture({ buildToolsVersion: '34.0.0' }).report(), 'tools.android-sdk').status, 'blocked')
})

test('exact Capacitor declarations, root lock, installed versions and integrity all must agree', () => {
  for (const edit of ['range', 'root', 'locked', 'installed', 'integrity']) {
    const f = fixture()
    const pkg = JSON.parse(f.content.get('package.json')), lock = JSON.parse(f.content.get('package-lock.json'))
    if (edit === 'range') pkg.dependencies['@capacitor/ios'] = '^8.5.3'
    if (edit === 'root') lock.packages[''].dependencies['@capacitor/ios'] = '8.5.2'
    if (edit === 'locked') lock.packages['node_modules/@capacitor/ios'].version = '8.5.2'
    if (edit === 'integrity') delete lock.packages['node_modules/@capacitor/ios'].integrity
    if (edit === 'installed') f.content.set('node_modules/@capacitor/ios/package.json', '{"version":"8.5.2"}')
    f.content.set('package.json', JSON.stringify(pkg)); f.content.set('package-lock.json', JSON.stringify(lock))
    assert.equal(item(f.report(), 'dependencies.capacitor').status, 'blocked', edit)
  }
})

test('mobile versions/build codes are separate from desktop package version and checked in both iOS configurations', () => {
  const f = fixture()
  assert.equal(item(f.report(), 'native.ios-version').status, 'ready')
  f.content.set('mobile/ios/App/App.xcodeproj/project.pbxproj', f.content.get('mobile/ios/App/App.xcodeproj/project.pbxproj').replace('CURRENT_PROJECT_VERSION = 1;', 'CURRENT_PROJECT_VERSION = 2;'))
  assert.equal(item(f.report(), 'native.ios-version').status, 'blocked')
  f.content.set('mobile/android/app/build.gradle', f.content.get('mobile/android/app/build.gradle').replace('versionCode 1', 'versionCode 0'))
  assert.equal(item(f.report(), 'native.android-version').status, 'blocked')
})

test('missing/mismatched SPM resolution blocks reproducible iOS dependencies', () => {
  const lock = 'mobile/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'
  for (const content of [null, '{bad json}', JSON.stringify({ pins: [{ identity: 'capacitor-swift-pm', state: { version: '8.5.2', revision: 'a'.repeat(40) } }] })]) {
    const report = fixture({ changes: { [lock]: content } }).report()
    assert.equal(item(report, 'dependencies.ios-spm').status, 'blocked')
    assert.equal(report.platforms.ios, 'blocked')
  }
  const standalone = fixture({ changes: { [lock]: null } })
  standalone.content.set('mobile/ios/App/CapApp-SPM/Package.resolved', JSON.stringify({ pins: [
    { identity: 'capacitor-swift-pm', state: { version: '8.5.3', revision: 'a'.repeat(40) } },
  ] }))
  assert.equal(item(standalone.report(), 'dependencies.ios-spm').status, 'blocked')
})

test('partial iOS version settings and dynamic Android version expressions fail closed', () => {
  const f = fixture()
  f.content.set('mobile/ios/App/App.xcodeproj/project.pbxproj', 'MARKETING_VERSION = 1.0; CURRENT_PROJECT_VERSION = 1; PRODUCT_BUNDLE_IDENTIFIER = dev.wason.ASTaria;')
  assert.equal(item(f.report(), 'native.ios-version').status, 'blocked')
  f.content.set('mobile/android/app/build.gradle', f.content.get('mobile/android/app/build.gradle').replace('versionName "1.0"', 'versionName "1.0" + suffix'))
  assert.equal(item(f.report(), 'native.android-version').status, 'blocked')
  const crlf = fixture()
  crlf.content.set('mobile/android/app/build.gradle', crlf.content.get('mobile/android/app/build.gradle').replaceAll('\n', '\r\n'))
  assert.equal(item(crlf.report(), 'native.android-version').status, 'ready')
})

test('server.url, mixed content, remote navigation, dynamic config and wrong app IDs block source gates', () => {
  for (const config of [
    CONFIG.replace("androidScheme: 'https'", "androidScheme: 'https', url: 'https://example.invalid'"),
    CONFIG.replace('allowMixedContent: false', 'allowMixedContent: true'),
    CONFIG.replace("androidScheme: 'https'", "androidScheme: 'https', allowNavigation: ['example.invalid']"),
    CONFIG.replace("webDir: 'dist-mobile'", 'webDir: process.env.DIR'),
  ]) assert.equal(item(fixture({ changes: { 'capacitor.config.ts': config } }).report(), 'config.local-content').status, 'blocked')
  assert.equal(item(fixture({ changes: { 'capacitor.config.ts': CONFIG.replace('dev.wason.ASTaria', 'dev.other.App') } }).report(), 'native.app-id').status, 'blocked')
})

test('backup inclusion or missing native secret contracts blocks without reading actual storage', () => {
  for (const changes of [
    { 'mobile/android/app/src/main/AndroidManifest.xml': '<application android:allowBackup="true" android:fullBackupContent="false">' },
    { 'mobile/ios/App/App/ASTariaSecretsPlugin.swift': '/* kSecAttrAccessibleWhenUnlockedThisDeviceOnly */' },
    { 'mobile/android/app/src/main/java/dev/wason/ASTaria/ASTariaSecretsPlugin.java': '/* getNoBackupFilesDir() */' },
  ]) {
    const f = fixture({ changes })
    assert.equal(item(f.report(), 'secrets.backup-exclusion').status, 'blocked')
  }
})

test('non-macOS cannot report Xcode readiness and no device/personal-data tools run', () => {
  const f = fixture({ platform: 'linux' }), report = f.report()
  assert.equal(report.platforms.ios, 'blocked')
  assert.equal(report.platforms.android, 'ready')
  assert.ok(!f.probes.some((probe) => /xcode|xcrun/.test(probe.command)))
})

test('CLI rejects relative paths, unknown arguments, missing values and duplicate options', () => {
  assert.deepEqual(parseDoctorArgs(['--json', '--java-home', JAVA_HOME]), { javaHome: JAVA_HOME })
  for (const args of [['--install'], ['--android-sdk'], ['--java-home', 'relative'], ['--java-home', JAVA_HOME, '--java-home', JAVA_HOME]]) {
    assert.throws(() => parseDoctorArgs(args))
  }
  assert.deepEqual(parseDoctorArgs(['--help']), { help: true })
})
