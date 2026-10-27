import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { copyWindowsRuntime } from './package-windows.mjs'

test('Windows runtime copying preserves binaries but excludes Finder metadata at every depth', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'astaria-runtime-copy-'))
  try {
    const source = join(scratch, 'runtime'), destination = join(scratch, 'portable')
    await mkdir(join(source, 'resources'), { recursive: true })
    const binary = Buffer.from([0x4d, 0x5a, 0, 255, 1, 2])
    await writeFile(join(source, 'electron.exe'), binary)
    await writeFile(join(source, 'resources', 'default_app.asar'), binary)
    await writeFile(join(source, 'LICENSE'), 'runtime license')
    for (const name of ['.DS_Store', '._electron.exe', 'resources/.DS_Store', 'resources/._default_app.asar']) {
      await writeFile(join(source, name), 'local Finder metadata')
    }
    await copyWindowsRuntime(source, destination)
    assert.deepEqual((await readdir(destination)).sort(), ['LICENSE', 'electron.exe', 'resources'])
    assert.deepEqual(await readdir(join(destination, 'resources')), ['default_app.asar'])
    assert.deepEqual(await readFile(join(destination, 'electron.exe')), binary)
    assert.deepEqual(await readFile(join(destination, 'resources', 'default_app.asar')), binary)
    assert.equal(await readFile(join(destination, 'LICENSE'), 'utf8'), 'runtime license')
    assert.equal(await readFile(join(source, '.DS_Store'), 'utf8'), 'local Finder metadata', 'the shared cache stays untouched')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
