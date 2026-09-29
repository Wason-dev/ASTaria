import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createKeychain } from '../server/keychain.mjs'

test('bundled Keychain helper is authenticated before sending a request, including later replacements', { skip: process.platform !== 'darwin' }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'astaria-vault-integrity-')); t.after(() => rm(dir, { recursive: true, force: true }))
  const binaryPath = join(dir, 'helper'), marker = join(dir, 'invoked')
  const safe = '#!/bin/sh\ncat >/dev/null\nprintf \'{"ok":true,"configured":true}\'\n'
  await writeFile(binaryPath, safe, { mode: 0o700 })
  const vault = createKeychain(dir, { binaryPath, binarySha256: createHash('sha256').update(safe).digest('hex') })
  assert.equal(await vault.status(), true)
  await writeFile(binaryPath, `#!/bin/sh\ntouch '${marker}'\n`)
  await assert.rejects(vault.status(), /校验失败/)
  await assert.rejects(readFile(marker), { code: 'ENOENT' })
  await assert.rejects(createKeychain(dir, { binaryPath }).prepare(), /重新安装/)
})
