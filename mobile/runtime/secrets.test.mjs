// Static native contracts + the TS facade with a mock bridge and synthetic tokens only.
// This does not build native targets or access a device/Keychain/Keystore.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import vm from 'node:vm'

const project = new URL('../../', import.meta.url)
const source = (path) => readFileSync(new URL(path, project), 'utf8')
const ts = source('mobile/runtime/secrets.ts')
const swift = source('mobile/ios/App/App/ASTariaSecretsPlugin.swift')
const controller = source('mobile/ios/App/App/ViewController.swift')
const scene = source('mobile/ios/App/App/SceneDelegate.swift')
const storyboard = source('mobile/ios/App/App/Base.lproj/Main.storyboard')
const xcode = source('mobile/ios/App/App.xcodeproj/project.pbxproj')
const java = source('mobile/android/app/src/main/java/dev/wason/ASTaria/ASTariaSecretsPlugin.java')
const activity = source('mobile/android/app/src/main/java/dev/wason/ASTaria/MainActivity.java')
const manifest = source('mobile/android/app/src/main/AndroidManifest.xml')

function facade({ native = true, platform = 'ios', available = true, implementation = {} } = {}) {
  const calls = []
  const defaults = {
    status: async () => ({ configured: false }),
    read: async () => ({ key: null }),
    write: async () => {},
    remove: async () => {},
  }
  const plugin = Object.fromEntries(Object.keys(defaults).map((method) => [method, async (...args) => {
    calls.push({ method, args })
    return (implementation[method] || defaults[method])(...args)
  }]))
  let registrations = 0
  const capacitor = {
    Capacitor: {
      isNativePlatform: () => native,
      getPlatform: () => platform,
      isPluginAvailable(name) { assert.equal(name, 'ASTariaSecrets'); return available },
    },
    registerPlugin(name, options) {
      assert.equal(name, 'ASTariaSecrets')
      assert.equal(options, undefined)
      registrations++
      return plugin
    },
  }
  const compiled = stripTypeScriptTypes(ts, { mode: 'strip' })
    .replace(/import\s*\{\s*Capacitor,\s*registerPlugin\s*\}\s*from\s*'@capacitor\/core'/, 'const { Capacitor, registerPlugin } = __capacitor')
    .replace(/^export /gm, '')
  const storageTrap = new Proxy({}, { get() { throw new Error('Web storage is forbidden') } })
  const context = vm.createContext({ __capacitor: capacitor, localStorage: storageTrap,
    sessionStorage: storageTrap, indexedDB: storageTrap,
    console: new Proxy({}, { get() { throw new Error('Logging is forbidden') } }) })
  const factory = vm.runInContext(`(() => { ${compiled}\nreturn nativeSecrets })()`, context)
  assert.equal(typeof factory, 'function')
  const secrets = factory()
  assert.deepEqual(Object.keys(secrets).sort(), ['read', 'remove', 'status', 'write'])
  assert.equal(registrations, 1)
  return { secrets, calls }
}

const hasCode = (code) => (error) => error.code === code && error.name === 'ASTariaSecretsError'
const plain = (value) => JSON.parse(JSON.stringify(value))

test('namespace and exactly four native promise methods agree with the facade', () => {
  assert.match(ts, /registerPlugin<NativeSecretsPlugin>\('ASTariaSecrets'\)/)
  assert.match(swift, /jsName = "ASTariaSecrets"/)
  assert.match(java, /@CapacitorPlugin\(name = "ASTariaSecrets"\)/)
  assert.deepEqual([...swift.matchAll(/CAPPluginMethod\(name: "(\w+)", returnType: CAPPluginReturnPromise\)/g)].map((m) => m[1]),
    ['status', 'read', 'write', 'remove'])
  assert.deepEqual([...java.matchAll(/@PluginMethod\s+public synchronized void (\w+)\(PluginCall call\)/g)].map((m) => m[1]),
    ['status', 'read', 'write', 'remove'])
})

test('Capacitor 8 registration reaches both iOS entry paths and the Android bridge', () => {
  assert.match(controller, /override func capacitorDidLoad\(\)/)
  assert.match(controller, /bridge\?\.registerPluginInstance\(ASTariaSecretsPlugin\(\)\)/)
  assert.match(scene, /rootViewController = ViewController\(\)/)
  assert.match(storyboard, /customClass="ViewController" customModule="App" customModuleProvider="target"/)
  for (const name of ['ASTariaSecretsPlugin.swift', 'ViewController.swift']) {
    const build = [...xcode.matchAll(/([A-F0-9]{24}) \/\* ([\w.]+) in Sources \*\/ = \{isa = PBXBuildFile; fileRef = ([A-F0-9]{24})/g)]
      .find((match) => match[2] === name)
    assert.ok(build, `${name}: build reference`)
    const sources = xcode.match(/\/\* Begin PBXSourcesBuildPhase section \*\/([\s\S]*?)\/\* End PBXSourcesBuildPhase section \*\//)[1]
    assert.ok(sources.includes(build[1]), `${name}: source phase`)
    assert.ok(xcode.includes(`${build[3]} /* ${name} */ = {isa = PBXFileReference;`), `${name}: file reference`)
  }
  assert.ok(activity.indexOf('registerPlugin(ASTariaSecretsPlugin.class)') < activity.indexOf('super.onCreate(savedInstanceState)'))
})

test('Keychain identity, device-only accessibility and non-sync queries are fixed', () => {
  assert.match(swift, /private let service = "dev\.wason\.ASTaria\.cloud-api"/)
  assert.match(swift, /private let account = "cloud-api-key"/)
  assert.match(swift, /kSecClass as String: kSecClassGenericPassword/)
  assert.match(swift, /kSecAttrSynchronizable as String: false/)
  assert.match(swift, /kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly/)
  assert.match(swift, /if status == errSecItemNotFound \{ return nil \}/)
  assert.match(swift, /guard status == errSecSuccess else \{ throw StorageFailure\.unavailable \}/)
  assert.doesNotMatch(swift, /UserDefaults|NSUserDefaults|kSecAttrSynchronizableAny|kSecAttrAccessGroup/)
})

test('Android AES-256 GCM generates a fresh nonce, authenticates and persists only ciphertext', () => {
  assert.match(java, /KEY_ALIAS = "dev\.wason\.ASTaria\.cloud-api"/)
  assert.match(java, /KEYSTORE = "AndroidKeyStore"/)
  assert.match(java, /TRANSFORMATION = "AES\/GCM\/NoPadding"/)
  assert.match(java, /\.setKeySize\(256\)/)
  assert.match(java, /\.setRandomizedEncryptionRequired\(true\)/)
  assert.match(java, /cipher\.init\(Cipher\.ENCRYPT_MODE, encryptionKey\)/)
  assert.match(java, /byte\[\] nonce = cipher\.getIV\(\)/)
  assert.equal([...java.matchAll(/cipher\.updateAAD\(AAD\)/g)].length, 2)
  assert.match(java, /new GCMParameterSpec\(TAG_BITS,/)
  assert.match(java, /prefs\.write\(Base64\.encodeToString\(record, Base64\.NO_WRAP\)\)/)
  assert.match(java, /Arrays\.fill\(plaintext, \(byte\) 0\)/)
  assert.doesNotMatch(java, /\.getEncoded\(|MODE_WORLD_|getExternal|Environment\./)
})

test('backup exclusion includes the Android ciphertext preference itself', () => {
  assert.match(manifest, /android:allowBackup="false"/)
  assert.match(manifest, /android:fullBackupContent="false"/)
  assert.match(java, /File directory = getContext\(\)\.getNoBackupFilesDir\(\)/)
  assert.match(java, /directory == null \|\| !directory\.isDirectory\(\)/)
  assert.match(java, /new File\(directory, PREFERENCES\)/)
  assert.match(java, /private static final class CiphertextPreferences/)
  assert.match(java, /output\.getFD\(\)\.sync\(\)/)
  assert.match(java, /if \(!ciphertext\.equals\(read\(\)\)\) throw new IOException/)
  assert.doesNotMatch(java, /getSharedPreferences\(|getFilesDir\(|getCacheDir\(/)
})

test('lost/corrupt Android records fail, and explicit deletion discards key and ciphertext', () => {
  assert.match(java, /if \(keyStore\(\)\.containsAlias\(KEY_ALIAS\)\) throw new StorageFailure\("SECRETS_CORRUPT"\)/)
  assert.match(java, /if \(encryptionKey == null\) throw new StorageFailure\("SECRETS_KEY_LOST"\)/)
  assert.match(java, /catch \(java\.security\.GeneralSecurityException failure\) \{\s*throw new StorageFailure\("SECRETS_CORRUPT"\)/)
  assert.ok(java.indexOf('readKey(prefs);') < java.indexOf('generator.generateKey()'))
  assert.match(java, /store\.deleteEntry\(KEY_ALIAS\)/)
  assert.match(java, /preferences\(\)\.clear\(\)/)
  assert.match(java, /file\.delete\(\)/)
  assert.match(java, /"SECRETS_REMOVE_FAILED"/)
})

test('bridge logging is disabled before handling credentials and plugin errors carry no raw exceptions', () => {
  assert.match(controller, /descriptor\.loggingBehavior = \.none/)
  assert.match(activity, /public boolean isLoggingEnabled\(\) \{\s*return false;/)
  assert.ok(activity.indexOf('config = new CapConfig') < activity.indexOf('super.onCreate'))
  assert.doesNotMatch(swift, /\bprint\(|NSLog|Logger|os_log/)
  assert.doesNotMatch(java, /Logger\.|Log\.|System\.out|printStackTrace|getMessage\(/)
  assert.match(java, /call\.reject\(message, code\)/)
  assert.doesNotMatch(swift, /call\.reject\([^\n]*,\s*error/)
})

test('native mutation contracts independently enforce explicit user action and bound input', () => {
  assert.equal([...swift.matchAll(/guard hasUserAction\(call\)/g)].length, 2)
  assert.match(swift, /CFGetTypeID\(value\) == CFBooleanGetTypeID\(\)/)
  assert.equal([...java.matchAll(/Boolean\.TRUE\.equals\(call\.getBoolean\("userInitiated"\)\)/g)].length, 2)
  assert.match(swift, /maxKeyBytes = 4096/)
  assert.match(swift, /\$0 >= 0x21 && \$0 <= 0x7e/)
  assert.match(java, /MAX_KEY_BYTES = 4096/)
  assert.match(java, /key\.charAt\(i\) < 0x21 \|\| key\.charAt\(i\) > 0x7e/)
})

test('web preview status is false; read/write/remove explicitly reject without storage', async () => {
  const { secrets, calls } = facade({ native: false, platform: 'web' })
  assert.equal(await secrets.status(), false)
  await assert.rejects(secrets.read(), hasCode('SECRETS_UNSUPPORTED'))
  await assert.rejects(secrets.write('synthetic-test-token'), hasCode('SECRETS_UNSUPPORTED'))
  await assert.rejects(secrets.remove(), hasCode('SECRETS_UNSUPPORTED'))
  assert.deepEqual(calls, [])
  assert.doesNotMatch(ts, /localStorage|sessionStorage|indexedDB|Preferences|fetch\(|console\./)
})

test('native plugin missing or unsupported platform fails instead of silently reporting absence', async () => {
  for (const settings of [{ available: false }, { platform: 'desktop' }]) {
    const { secrets, calls } = facade(settings)
    await assert.rejects(secrets.status(), hasCode('SECRETS_UNAVAILABLE'))
    await assert.rejects(secrets.read(), hasCode('SECRETS_UNAVAILABLE'))
    assert.deepEqual(calls, [])
  }
})

test('bootstrap status returns boolean; read returns a string and absent keys explicitly fail', async () => {
  const { secrets } = facade({ implementation: {
    status: async () => ({ configured: true }), read: async () => ({ key: 'synthetic-test-token' }),
  } })
  assert.equal(await secrets.status(), true)
  assert.equal(await secrets.read(), 'synthetic-test-token')
  const empty = facade()
  assert.equal(await empty.secrets.status(), false)
  await assert.rejects(empty.secrets.read(), hasCode('SECRETS_NOT_CONFIGURED'))
})

test('bootstrap exposes the exact fixed vault signatures and documents explicit mutation callers', () => {
  assert.match(ts, /export function nativeSecrets\(\): SecretsVault/)
  assert.match(ts, /status\(\): Promise<boolean>/)
  assert.match(ts, /read\(\): Promise<string>/)
  assert.match(ts, /write\(key: string\): Promise<void>/)
  assert.match(ts, /remove\(\): Promise<void>/)
  assert.match(ts, /explicit Save action/)
  assert.match(ts, /explicit Delete action/)
})

test('empty, oversized, control, whitespace, Unicode and non-string keys never reach native', async () => {
  const { secrets, calls } = facade()
  for (const key of ['', 'x'.repeat(4097), ' a', 'a ', 'a\nb', 'a\tb', '\u0000', '\u007f', '中文', null, 123]) {
    await assert.rejects(secrets.write(key), hasCode('SECRETS_INVALID_INPUT'))
  }
  assert.deepEqual(calls, [])
  await secrets.write('x'.repeat(4096))
  assert.equal(calls.length, 1)
})

test('bootstrap mutations send only fixed options with an explicit action marker and return no key', async () => {
  const { secrets, calls } = facade({ platform: 'android' })
  await assert.rejects(secrets.write({ key: 'synthetic-test-token', service: 'other' }), hasCode('SECRETS_INVALID_INPUT'))
  assert.equal(await secrets.write('synthetic-test-token'), undefined)
  assert.equal(await secrets.remove(), undefined)
  assert.deepEqual(plain(calls), [
    { method: 'write', args: [{ key: 'synthetic-test-token', userInitiated: true }] },
    { method: 'remove', args: [{ userInitiated: true }] },
  ])
})

test('native failures keep their safe code, never the native message or exception details', async () => {
  for (const code of ['SECRETS_CORRUPT', 'SECRETS_KEY_LOST', 'SECRETS_UNAVAILABLE']) {
    const { secrets } = facade({ implementation: {
      status: async () => { throw { code, message: 'PRIVATE_NATIVE_DETAIL' } },
      read: async () => { throw { code, message: 'PRIVATE_NATIVE_DETAIL' } },
    } })
    for (const method of ['status', 'read']) {
      await assert.rejects(secrets[method](), (error) => hasCode(code)(error)
        && !error.message.includes('PRIVATE_NATIVE_DETAIL') && !('cause' in error))
    }
  }
  const { secrets } = facade({ implementation: {
    write: async () => { throw new Error('PRIVATE_NATIVE_DETAIL') },
    remove: async () => { throw { code: 'UNKNOWN', message: 'PRIVATE_NATIVE_DETAIL' } },
  } })
  await assert.rejects(secrets.write('synthetic-test-token'), hasCode('SECRETS_WRITE_FAILED'))
  await assert.rejects(secrets.remove(), hasCode('SECRETS_REMOVE_FAILED'))
})

test('malformed native results cannot masquerade as a valid credential or status', async () => {
  for (const value of [null, {}, { configured: 0 }, { configured: true, key: 'synthetic-test-token' }]) {
    const { secrets } = facade({ implementation: { status: async () => value } })
    await assert.rejects(secrets.status(), hasCode('SECRETS_CORRUPT'))
  }
  for (const value of [null, {}, { key: '' }, { key: 'x'.repeat(4097) }, { key: 1 }, { key: null, extra: true }]) {
    const { secrets } = facade({ implementation: { read: async () => value } })
    await assert.rejects(secrets.read(), hasCode('SECRETS_CORRUPT'))
  }
})
