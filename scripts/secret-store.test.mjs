import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSecretStore } from '../desktop/secretStore.mjs'

test('secret store fails closed without system encryption and persists only provider ciphertext', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'astaria-vault-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  let available = false
  const safeStorage = { isEncryptionAvailable: () => available, encryptString: value => Buffer.from(value).reverse(), decryptString: value => Buffer.from(value).reverse().toString() }
  const store = createSecretStore({ directory, safeStorage, platform: 'win32' })
  assert.throws(() => store.write('sync-key', 'secret'), /不可用/)
  available = true
  await store.apiVault.save('test-api-key-only')
  assert.equal(await store.apiVault.read(), 'test-api-key-only')
  assert.notEqual(readFileSync(join(directory, 'api-key.sealed')).toString(), 'test-api-key-only')
  store.write('sync-key', 'a'.repeat(64))
  assert.equal(store.read('sync-key'), 'a'.repeat(64))
  assert.throws(() => store.write('../outside', 'key'), /名称/)
  store.remove('sync-key')
  assert.equal(store.read('sync-key'), null)
  await store.apiVault.remove()
  assert.equal(await store.apiVault.status(), false)
})
