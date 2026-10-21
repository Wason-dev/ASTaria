#!/usr/bin/env node
// Read-only prerequisite inspection. Never builds, resolves dependencies, or inspects signing stores.
import { accessSync, constants, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url))
const APP_ID = 'dev.wason.ASTaria'
const MOBILE_VERSION = '1.0'
const CAPACITOR_PACKAGES = ['@capacitor/core', '@capacitor/cli', '@capacitor/ios', '@capacitor/android']
const SPM_LOCK = 'mobile/ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved'

function withoutComments(text) {
  return text.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g,
    (token) => token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\r\n]/g, ' ') : token)
}

/** Accept a literal config only; importing/evaluating arbitrary project TS would not be read-only. */
export function parseCapacitorConfig(source) {
  const text = withoutComments(source)
  const prefix = text.match(/^\s*import\s+type\s*\{\s*CapacitorConfig\s*\}\s*from\s*(['"])@capacitor\/cli\1\s*;?\s*const\s+config\s*:\s*CapacitorConfig\s*=\s*/)
  if (!prefix) throw new Error('Unsupported config syntax')
  let offset = prefix[0].length
  const skip = () => { while (/\s/.test(text[offset] ?? '') && offset < text.length) offset++ }
  function string() {
    const quote = text[offset++]
    let result = ''
    while (offset < text.length) {
      const char = text[offset++]
      if (char === quote) return result
      if (char === '\n' || char === '\r') throw new Error('Invalid string')
      if (char !== '\\') { result += char; continue }
      const escape = text[offset++]
      const escapes = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '\\': '\\', "'": "'", '"': '"', '/': '/' }
      if (Object.hasOwn(escapes, escape)) result += escapes[escape]
      else if (escape === 'u' && /^[\da-f]{4}$/i.test(text.slice(offset, offset + 4))) {
        result += String.fromCharCode(parseInt(text.slice(offset, offset + 4), 16)); offset += 4
      } else throw new Error('Unsupported escape')
    }
    throw new Error('Unterminated string')
  }
  function value(depth = 0) {
    if (depth > 20) throw new Error('Config is too deeply nested')
    skip()
    if (text[offset] === '"' || text[offset] === "'") return string()
    if (text[offset] === '{' || text[offset] === '[') {
      const object = text[offset++] === '{'
      const result = object ? Object.create(null) : []
      const end = object ? '}' : ']'
      skip()
      while (text[offset] !== end) {
        let key
        if (object) {
          if (text[offset] === '"' || text[offset] === "'") key = string()
          else {
            const match = text.slice(offset).match(/^[a-z_$][\w$]*/i)
            if (!match) throw new Error('Unsupported key')
            key = match[0]; offset += key.length
          }
          skip()
          if (text[offset++] !== ':' || Object.hasOwn(result, key)) throw new Error('Duplicate or invalid key')
        }
        const item = value(depth + 1)
        if (object) result[key] = item
        else result.push(item)
        skip()
        if (text[offset] === end) break
        if (text[offset++] !== ',') throw new Error('Expected comma')
        skip()
      }
      offset++
      return result
    }
    const match = text.slice(offset).match(/^(true|false|null|-?\d+(?:\.\d+)?)(?![\w$])/)
    if (!match) throw new Error('Dynamic config is not inspected')
    offset += match[0].length
    return JSON.parse(match[0])
  }
  const config = value()
  if (!/^\s*;?\s*export\s+default\s+config\s*;?\s*$/.test(text.slice(offset))) throw new Error('Unsupported trailing code')
  if (!config || Array.isArray(config) || typeof config !== 'object') throw new Error('Expected config object')
  return config
}

function executable(file) {
  try { accessSync(file, constants.X_OK); return statSync(file).isFile() } catch { return false }
}
function directory(file) {
  try { return statSync(file).isDirectory() } catch { return false }
}
function fileExists(file) {
  try { return statSync(file).isFile() } catch { return false }
}
function directoriesIn(file) {
  try { return readdirSync(file, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name) } catch { return [] }
}
function compareVersions(left, right) {
  const a = left.split('.').map(Number), b = right.split('.').map(Number)
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}
function findExecutable(name, env, isExecutable, platform) {
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : ['']
  for (const entry of (env.PATH || '').split(platform === 'win32' ? ';' : ':')) {
    if (!entry || !path.isAbsolute(entry)) continue
    for (const suffix of suffixes) {
      const file = path.join(entry, name + suffix)
      if (isExecutable(file)) return file
    }
  }
  return null
}
function probe(command, args, selectedEnv) {
  // No shell, Java option injection, credential environment, or unbounded process output.
  const result = spawnSync(command, args, { encoding: 'utf8', env: selectedEnv,
    timeout: 5000, maxBuffer: 64 * 1024, shell: false, windowsHide: true })
  return { ok: !result.error && result.status === 0, output: `${result.stdout || ''}\n${result.stderr || ''}` }
}
function buildProbeEnv(env, overrides = {}) {
  const selected = { PATH: env.PATH || '', LANG: 'C', LC_ALL: 'C', ...overrides }
  for (const name of ['SystemRoot', 'WINDIR', 'TMPDIR', 'TMP', 'TEMP']) {
    if (env[name]) selected[name] = env[name]
  }
  return selected
}
const unique = (values) => [...new Set(values)]
const capture = (text, expression) => [...text.matchAll(expression)].map((match) => match[1])

export function inspectMobileBuild(options = {}) {
  const root = options.root || PROJECT_ROOT
  const env = options.env || process.env
  const platform = options.platform || process.platform
  const readText = options.readText || ((file) => readFileSync(file, 'utf8'))
  const isExecutable = options.isExecutable || executable
  const isDirectory = options.isDirectory || directory
  const isFile = options.isFile || fileExists
  const listDirectories = options.listDirectories || directoriesIn
  const run = options.run || probe
  const read = (relative) => { try { return readText(path.join(root, relative)) } catch { return '' } }
  const json = (relative) => { try { return JSON.parse(read(relative)) } catch { return null } }
  const checks = []
  function check(id, area, ready, details, remediation) {
    checks.push({ id, area, status: ready ? 'ready' : 'blocked', details, remediation: ready ? [] : [remediation] })
  }

  const pkg = json('package.json')
  const lock = json('package-lock.json')
  const packages = CAPACITOR_PACKAGES.map((name) => {
    const declared = pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]
    const lockRoot = lock?.packages?.['']?.dependencies?.[name] ?? lock?.packages?.['']?.devDependencies?.[name]
    const pinned = lock?.packages?.[`node_modules/${name}`]
    const installed = json(`node_modules/${name}/package.json`)?.version
    return { name, declared: declared ?? null, lockRoot: lockRoot ?? null,
      locked: pinned?.version ?? null, installed: installed ?? null, integrity: Boolean(pinned?.integrity) }
  })
  const capacitorVersion = packages[0].locked
  const capReady = packages.every((entry) => /^8\.\d+\.\d+$/.test(entry.declared || '')
    && entry.declared === capacitorVersion && entry.lockRoot === capacitorVersion
    && entry.locked === capacitorVersion && entry.installed === capacitorVersion && entry.integrity)
  check('dependencies.capacitor', 'source', capReady, { packages },
    '由依赖负责者核对四个 Capacitor 包的精确版本、lock 根声明、解析版本、integrity 与已安装版本；doctor 不安装或重写 lock。')

  const pbx = withoutComments(read('mobile/ios/App/App.xcodeproj/project.pbxproj'))
  const appGradle = withoutComments(read('mobile/android/app/build.gradle'))
  const iosVersionSettings = capture(pbx, /MARKETING_VERSION\s*=\s*"?([\d.]+)"?\s*;/g)
  const iosBuildSettings = capture(pbx, /CURRENT_PROJECT_VERSION\s*=\s*"?(\d+)"?\s*;/g)
  const iosVersions = unique(iosVersionSettings)
  const iosBuilds = unique(iosBuildSettings)
  const iosIds = unique(capture(pbx, /PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([\w.]+)"?\s*;/g))
  const info = read('mobile/ios/App/App/Info.plist')
  const iosVersionReady = iosVersionSettings.length === 2 && iosBuildSettings.length === 2
    && iosVersions.length === 1 && iosVersions[0] === MOBILE_VERSION
    && iosBuilds.length === 1 && /^[1-9]\d*$/.test(iosBuilds[0])
    && /<key>CFBundleShortVersionString<\/key>\s*<string>\$\(MARKETING_VERSION\)<\/string>/.test(info)
    && /<key>CFBundleVersion<\/key>\s*<string>\$\(CURRENT_PROJECT_VERSION\)<\/string>/.test(info)
  check('native.ios-version', 'source', iosVersionReady,
    { nativeVersions: iosVersions, buildCodes: iosBuilds, expectedNativeVersion: MOBILE_VERSION },
    '核对 iOS Debug/Release 的 MARKETING_VERSION=1.0、正整数 CURRENT_PROJECT_VERSION 与 Info.plist 引用；上传新包前使用新的 build number。')
  const androidVersions = capture(appGradle, /\bversionName\s+['"]([^'"]+)['"][ \t]*;?[ \t]*\r?$/gm)
  const androidBuilds = capture(appGradle, /\bversionCode\s+(\d+)[ \t]*;?[ \t]*\r?$/gm)
  check('native.android-version', 'source', androidVersions.length === 1 && androidVersions[0] === MOBILE_VERSION
    && androidBuilds.length === 1 && /^[1-9]\d*$/.test(androidBuilds[0]),
  { nativeVersions: androidVersions, buildCodes: androidBuilds, expectedNativeVersion: MOBILE_VERSION },
  '核对 Android versionName=1.0 与正整数 versionCode；版本负责人处理修改，doctor 不改版本。')

  let config
  try { config = parseCapacitorConfig(read('capacitor.config.ts')) } catch { config = null }
  const configReady = Boolean(config && config.webDir === 'dist-mobile' && config.ios?.path === 'mobile/ios'
    && config.android?.path === 'mobile/android' && config.android.allowMixedContent === false
    && config.allowMixedContent !== true && config.server?.androidScheme === 'https'
    && !Object.hasOwn(config.server, 'url') && config.server.cleartext !== true
    && (!config.server.allowNavigation || (Array.isArray(config.server.allowNavigation) && config.server.allowNavigation.length === 0)))
  check('config.local-content', 'source', configReady,
    { literalConfigInspected: Boolean(config), remoteServerUrlAbsent: Boolean(config?.server && !Object.hasOwn(config.server, 'url')),
      mixedContentDisabled: config?.android?.allowMixedContent === false },
  '保留 literal Capacitor config、dist-mobile、本地原生路径、HTTPS scheme、无 server.url 且 allowMixedContent=false；动态配置按 blocked 处理，不执行配置代码。')
  const androidIds = capture(appGradle, /\bapplicationId\s+['"]([^'"]+)['"]/g)
  const namespaces = capture(appGradle, /\bnamespace\s*=\s*['"]([^'"]+)['"]/g)
  check('native.app-id', 'source', config?.appId === APP_ID && iosIds.length === 1 && iosIds[0] === APP_ID
    && androidIds.length === 1 && androidIds[0] === APP_ID && namespaces.length === 1 && namespaces[0] === APP_ID,
  { expectedAppId: APP_ID, iosBundleIds: iosIds, androidApplicationIds: androidIds, androidNamespaces: namespaces },
  '保持 Capacitor appId、iOS Bundle ID、Android applicationId/namespace 为 dev.wason.ASTaria；App Store Connect 记录须使用同一 Bundle ID。')

  const swift = withoutComments(read('mobile/ios/App/App/ASTariaSecretsPlugin.swift'))
  const nativeJava = withoutComments(read('mobile/android/app/src/main/java/dev/wason/ASTaria/ASTariaSecretsPlugin.java'))
  const manifest = read('mobile/android/app/src/main/AndroidManifest.xml').replace(/<!--[\s\S]*?-->/g, '')
  const application = manifest.match(/<application\b([^>]+)>/)?.[1] || ''
  const iosExcluded = /service\s*=\s*"dev\.wason\.ASTaria\.cloud-api"/.test(swift)
    && /kSecAttrAccessible as String:\s*kSecAttrAccessibleWhenUnlockedThisDeviceOnly/.test(swift)
    && /kSecAttrSynchronizable as String:\s*false/.test(swift) && !/\b(?:UserDefaults|NSUserDefaults)\b/.test(swift)
  const androidExcluded = /android:allowBackup=['"]false['"]/.test(application)
    && /android:fullBackupContent=['"]false['"]/.test(application) && /getNoBackupFilesDir\(\)/.test(nativeJava)
    && /KEY_ALIAS\s*=\s*"dev\.wason\.ASTaria\.cloud-api"/.test(nativeJava)
    && /"AndroidKeyStore"/.test(nativeJava) && /"AES\/GCM\/NoPadding"/.test(nativeJava)
    && /\.setKeySize\(256\)/.test(nativeJava) && /\.setRandomizedEncryptionRequired\(true\)/.test(nativeJava)
  check('secrets.backup-exclusion', 'source', iosExcluded && androidExcluded,
    { iosDeviceOnlyNonSynchronizable: iosExcluded, androidBackupDisabledAndCiphertextInNoBackupDirectory: androidExcluded,
      inspection: 'source-contract-only' },
  '恢复固定用途 secrets 的 ThisDeviceOnly/非同步 Keychain 与 Android Keystore 加密/noBackupFilesDir/allowBackup=false 契约，并运行 secrets.test.mjs；该静态检查不代替真机备份恢复验证。')

  const spm = withoutComments(read('mobile/ios/App/CapApp-SPM/Package.swift'))
  // A standalone package's lock cannot pin the Xcode project's complete dependency graph.
  const spmLock = json(SPM_LOCK)
  const pins = spmLock?.pins ?? spmLock?.object?.pins ?? []
  const pin = Array.isArray(pins) ? pins.find((entry) => entry.identity === 'capacitor-swift-pm'
    || entry.package === 'capacitor-swift-pm' || entry.repositoryURL === 'https://github.com/ionic-team/capacitor-swift-pm.git') : null
  const spmVersion = pin?.state?.version ?? null
  const spmRevision = pin?.state?.revision ?? null
  check('dependencies.ios-spm', 'ios', /capacitor-swift-pm\.git/.test(spm) && Boolean(capacitorVersion)
    && spmVersion === capacitorVersion && /^[a-f\d]{40}$/i.test(spmRevision || ''),
  { lockFile: spmLock ? SPM_LOCK : null, resolvedCapacitorVersion: spmVersion, matchesNpmLock: spmVersion === capacitorVersion },
  '具备 Xcode 后由原生依赖负责人解析 SPM，核对 Capacitor 解析版本与 npm lock 相同并提交项目 Package.resolved；仅 from: 范围不足以固定解析结果。doctor 不联网解析。')

  const variables = withoutComments(read('mobile/android/variables.gradle'))
  const compileSdk = Number(variables.match(/compileSdkVersion\s*=\s*(\d+)/)?.[1])
  const defaultBuildTools = '35.0.0' // Default/minimum for the existing AGP 8.13; newer SDK tools may be installed.
  const buildToolsSettings = capture(appGradle, /\bbuildToolsVersion\s*(?:=\s*)?['"](\d+\.\d+\.\d+)['"][ \t]*;?[ \t]*\r?$/gm)
  const hasBuildToolsSetting = /\bbuildToolsVersion\b/.test(appGradle)
  const buildToolsSettingValid = !hasBuildToolsSetting || buildToolsSettings.length === 1
  const configuredBuildTools = hasBuildToolsSetting && buildToolsSettingValid ? buildToolsSettings[0] : null
  const gradle = read('mobile/android/gradle/wrapper/gradle-wrapper.properties')
  const gradleVersion = gradle.match(/distributionUrl=https\\?:\/\/services\.gradle\.org\/distributions\/gradle-([\d.]+)-(?:all|bin)\.zip/)?.[1]
  const agp = read('mobile/android/build.gradle').match(/com\.android\.tools\.build:gradle:([\d.]+)/)?.[1]
  const generated = read('mobile/android/app/capacitor.build.gradle')
  check('dependencies.android-build-system', 'android', gradleVersion === '8.14.3' && agp === '8.13.0'
    && compileSdk === 36 && /JavaVersion\.VERSION_21/.test(generated) && buildToolsSettingValid
    && isFile(path.join(root, 'mobile/android/gradle/wrapper/gradle-wrapper.jar'))
    && isFile(path.join(root, 'mobile/android/capacitor.settings.gradle')),
  { gradleVersion: gradleVersion ?? null, androidGradlePluginVersion: agp ?? null, compileSdk: Number.isFinite(compileSdk) ? compileSdk : null,
    defaultBuildTools, configuredBuildTools, javaSourceLevel: 21 },
  '由原生工程负责人核对既有 Gradle 8.14.3 / AGP 8.13.0 / SDK 36 / Java 21 与生成的 Capacitor Gradle 文件；doctor 不运行 wrapper 或修改版本。')

  const toolEnv = buildProbeEnv(env)
  const find = (name) => findExecutable(name, env, isExecutable, platform)
  let developerDir = options.xcodeDeveloperDir || env.ASTARIA_MOBILE_XCODE_DEVELOPER_DIR || env.DEVELOPER_DIR || null
  if (!developerDir && platform === 'darwin') {
    const select = find('xcode-select')
    const result = select ? run(select, ['-p'], toolEnv) : null
    if (result?.ok) developerDir = result.output.trim()
  }
  const fullXcode = platform === 'darwin' && Boolean(developerDir && path.isAbsolute(developerDir)
    && isExecutable(path.join(developerDir, 'usr/bin/xcodebuild'))
    && isDirectory(path.join(developerDir, 'Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk'))
    && isDirectory(path.join(developerDir, 'Platforms/iPhoneSimulator.platform/Developer/SDKs/iPhoneSimulator.sdk')))
  const xcodeEnv = buildProbeEnv(env, developerDir ? { DEVELOPER_DIR: developerDir } : {})
  const xcodeProbe = fullXcode ? run(path.join(developerDir, 'usr/bin/xcodebuild'), ['-version'], xcodeEnv) : null
  const xcodeVersion = xcodeProbe?.ok ? xcodeProbe.output.match(/^Xcode\s+(\d+(?:\.\d+)*)/m)?.[1] : null
  check('tools.xcode', 'ios', fullXcode && Number(xcodeVersion?.split('.')[0]) >= 26,
    { selectedDeveloperDirectory: developerDir, completeXcodeDetected: fullXcode, version: xcodeVersion ?? null, minimumMajor: 26 },
  '需要完整 Xcode 26+ 与 iPhoneOS/iPhoneSimulator SDK；CommandLineTools 和 /usr/bin/xcodebuild shim 不算完整 Xcode。可用 --xcode-developer-dir 或 ASTARIA_MOBILE_XCODE_DEVELOPER_DIR 指定已配置路径。')
  const xcrun = find('xcrun')
  const simctlProbe = fullXcode && xcrun ? run(xcrun, ['--no-cache', '--find', 'simctl'], xcodeEnv) : null
  const simctl = simctlProbe?.ok ? simctlProbe.output.trim() : null
  check('tools.simctl', 'ios', Boolean(simctl && isExecutable(simctl) && simctl.startsWith(developerDir + path.sep)),
    { executable: simctl, simulatorDevicesInspected: false },
    '确认所选完整 Xcode 的 xcrun 能找到 simctl；doctor 不列举、启动或读取用户模拟器。')

  const javaHome = options.javaHome || env.ASTARIA_MOBILE_JAVA_HOME || env.JAVA_HOME || null
  const java = javaHome ? path.join(javaHome, 'bin', platform === 'win32' ? 'java.exe' : 'java') : find('java')
  const javac = javaHome ? path.join(javaHome, 'bin', platform === 'win32' ? 'javac.exe' : 'javac') : find('javac')
  const javaEnv = buildProbeEnv(env, javaHome ? { JAVA_HOME: javaHome } : {})
  const javaProbe = java && isExecutable(java) ? run(java, ['-version'], javaEnv) : null
  const javacProbe = javac && isExecutable(javac) ? run(javac, ['-version'], javaEnv) : null
  const javaMajor = javaProbe?.ok ? Number(javaProbe.output.match(/(?:openjdk|java) version "(\d+)/)?.[1]) : NaN
  const javacMajor = javacProbe?.ok ? Number(javacProbe.output.match(/javac\s+(\d+)/)?.[1]) : NaN
  check('tools.jdk', 'android', javaMajor === javacMajor && javaMajor >= 21 && javaMajor <= 24,
    { selectedJavaHome: javaHome, javaExecutable: java, javacExecutable: javac,
      javaMajor: Number.isFinite(javaMajor) ? javaMajor : null, javacMajor: Number.isFinite(javacMajor) ? javacMajor : null,
      recommendedMajor: 21, supportedMajorsForCurrentGradle: [21, 22, 23, 24] },
  '此工程源级别要求 JDK 21，既有 Gradle 8.14.3 不支持用 JDK 25 启动。优先指定已配置的 JDK 21：--java-home 或 ASTARIA_MOBILE_JAVA_HOME；java/javac 必须来自兼容 JDK。')

  let sdkRoot = options.androidSdk || env.ASTARIA_MOBILE_ANDROID_SDK_ROOT || env.ANDROID_SDK_ROOT || env.ANDROID_HOME || null
  if (!sdkRoot) {
    const adb = find('adb')
    if (adb && path.basename(path.dirname(adb)) === 'platform-tools') sdkRoot = path.dirname(path.dirname(adb))
  }
  const suffix = platform === 'win32' ? '.exe' : ''
  const sdkRootValid = Boolean(sdkRoot && path.isAbsolute(sdkRoot))
  const availableBuildToolsVersions = sdkRootValid ? listDirectories(path.join(sdkRoot, 'build-tools'))
    .filter((version) => /^\d+\.\d+\.\d+$/.test(version)).sort((a, b) => compareVersions(b, a)) : []
  const compatibleVersions = availableBuildToolsVersions.filter((version) => compareVersions(version, defaultBuildTools) >= 0)
  const candidateVersions = configuredBuildTools ? [configuredBuildTools]
    : [defaultBuildTools, ...compatibleVersions.filter((version) => version !== defaultBuildTools)]
  const hasToolFiles = (version) => sdkRootValid && ['aapt2' + suffix, 'zipalign' + suffix, platform === 'win32' ? 'd8.bat' : 'd8']
    .every((name) => isExecutable(path.join(sdkRoot, 'build-tools', version, name)))
  const buildTools = candidateVersions.find(hasToolFiles) ?? configuredBuildTools ?? compatibleVersions[0] ?? null
  const buildToolsCompatible = buildToolsSettingValid && Boolean(buildTools && compareVersions(buildTools, defaultBuildTools) >= 0)
  const sdkPaths = sdkRoot && path.isAbsolute(sdkRoot) ? {
    platformJar: path.join(sdkRoot, 'platforms', `android-${compileSdk}`, 'android.jar'),
    adb: path.join(sdkRoot, 'platform-tools', 'adb' + suffix),
    aapt2: buildTools ? path.join(sdkRoot, 'build-tools', buildTools, 'aapt2' + suffix) : null,
    zipalign: buildTools ? path.join(sdkRoot, 'build-tools', buildTools, 'zipalign' + suffix) : null,
    d8: buildTools ? path.join(sdkRoot, 'build-tools', buildTools, platform === 'win32' ? 'd8.bat' : 'd8') : null,
  } : null
  const sdkFiles = sdkPaths ? Object.fromEntries(Object.entries(sdkPaths).map(([name, file]) =>
    [name, Boolean(file && (name === 'platformJar' ? isFile(file) : isExecutable(file)))])) : {}
  check('tools.android-sdk', 'android', Boolean(sdkPaths && buildToolsCompatible && Object.values(sdkFiles).every(Boolean)),
    { selectedSdkRoot: sdkRoot, compileSdk: Number.isFinite(compileSdk) ? compileSdk : null, buildToolsVersion: buildTools,
      buildToolsSource: configuredBuildTools ? 'project-setting' : buildTools === defaultBuildTools ? 'agp-default' : 'installed-sdk',
      availableBuildToolsVersions, minimumBuildToolsVersion: defaultBuildTools, agpDefaultBuildToolsVersion: defaultBuildTools,
      gradleBuildToolsSelectionVerified: false, files: sdkFiles },
    '指向含 Android 平台 36、platform-tools 和兼容 Build Tools（最低 35.0.0，例如已安装的 36.0.0）的 SDK；使用 --android-sdk 或 ASTARIA_MOBILE_ANDROID_SDK_ROOT。显式工程 buildToolsVersion 必须满足；未指定时按已安装文件检测，Gradle 的最终选择由真实构建确认。doctor 不安装工具或运行 Gradle/adb。')

  const statusOf = (areas) => checks.filter((item) => areas.includes(item.area)).every((item) => item.status === 'ready') ? 'ready' : 'blocked'
  return {
    schemaVersion: 1, scope: 'local-native-build-prerequisites', status: statusOf(['source', 'ios', 'android']),
    platforms: { ios: statusOf(['source', 'ios']), android: statusOf(['source', 'android']) }, checks,
    verification: { nativeBuildExecuted: false, dependencyResolutionExecuted: false, networkAccessPerformed: false,
      signingIdentityInspected: false, testFlightUploadExecuted: false,
      meaningOfReady: '仅表示被检测的本地前置条件满足，不证明原生构建、签名、会员资格或发布成功。' },
  }
}

export function parseDoctorArgs(args) {
  const options = {}
  const names = { '--xcode-developer-dir': 'xcodeDeveloperDir', '--android-sdk': 'androidSdk', '--java-home': 'javaHome' }
  for (let i = 0; i < args.length; i++) {
    const argument = args[i]
    if (argument === '--json') continue
    if (argument === '--help') return { help: true }
    const name = names[argument]
    if (!name || !args[i + 1] || args[i + 1].startsWith('--') || !path.isAbsolute(args[i + 1])) throw new Error('Invalid arguments')
    if (Object.hasOwn(options, name)) throw new Error('Duplicate option')
    options[name] = args[++i]
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseDoctorArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write('Usage: node scripts/mobile-doctor.mjs [--json] [--xcode-developer-dir ABSOLUTE_PATH] [--android-sdk ABSOLUTE_PATH] [--java-home ABSOLUTE_PATH]\nRead-only. Exit 0: inspected prerequisites ready; 1: blocked; 2: invalid arguments.\n')
    } else {
      const report = inspectMobileBuild(options)
      process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      process.exitCode = report.status === 'ready' ? 0 : 1
    }
  } catch {
    process.stdout.write(JSON.stringify({ schemaVersion: 1, status: 'blocked', error: 'INVALID_ARGUMENTS',
      remediation: ['使用 --help 查看参数；工具链路径必须为绝对路径。'] }) + '\n')
    process.exitCode = 2
  }
}
