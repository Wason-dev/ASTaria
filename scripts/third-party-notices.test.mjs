import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { generateNotices } from './third-party-notices.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LICENSE = "Standard 'no charge' license: https://gsap.com/standard-license."

async function fixture(t, version = '3.15.0') {
  const root = await mkdtemp(join(tmpdir(), 'astaria-notices-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'node_modules', 'gsap'), { recursive: true })
  await mkdir(join(root, 'third-party'))
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3,
    packages: { '': {}, 'node_modules/gsap': { version, license: LICENSE } } }))
  await writeFile(join(root, 'node_modules', 'gsap', 'package.json'), JSON.stringify({ name: 'gsap', version, license: LICENSE }))
  await copyFile(join(ROOT, 'third-party', 'gsap-3.15.0-LICENSE.txt'), join(root, 'third-party', 'gsap-3.15.0-LICENSE.txt'))
  return root
}

test('GSAP official terms are included with the pinned package version', async t => {
  const root = await fixture(t)
  const result = await generateNotices(root)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.review, [])
  assert.match(result.text, /gsap@3\.15\.0[\s\S]*II\. GRANT OF LICENSE[\s\S]*VI\. MISCELLANEOUS PROVISIONS/u)
  assert.match(result.text, /Source: https:\/\/gsap\.com\/community\/standard-license\//u)
})

test('missing, altered, or stale GSAP terms cannot pass verification', async t => {
  const root = await fixture(t)
  const path = join(root, 'third-party', 'gsap-3.15.0-LICENSE.txt')
  const original = await readFile(path, 'utf8')
  await writeFile(path, `${original}\nchanged\n`)
  let result = await generateNotices(root)
  assert.equal(result.missing.length, 1)
  assert.match(result.text, /checksum differs/u)
  await rm(path)
  result = await generateNotices(root)
  assert.equal(result.missing.length, 1)
  assert.match(result.text, /Bundled GSAP license text is missing/u)
  await writeFile(path, original)
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'))
  lock.packages['node_modules/gsap'].version = '3.16.0'
  await writeFile(join(root, 'package-lock.json'), JSON.stringify(lock))
  result = await generateNotices(root)
  assert.equal(result.missing.length, 1)
  assert.match(result.text, /Bundled GSAP terms do not match/u)
})

test('the checked-in notice file matches the installed production packages', async () => {
  const result = await generateNotices(ROOT)
  assert.deepEqual(result.missing, [])
  assert.deepEqual(result.review, [])
  assert.equal(await readFile(join(ROOT, 'THIRD_PARTY_NOTICES.txt'), 'utf8'), result.text)
})
