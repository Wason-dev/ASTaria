import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { brandWindowsExecutable } from './brand-windows.mjs'

const icon = await readFile(new URL('../public/astaria.ico', import.meta.url))
function fixture(is32bit = false) {
  const exe = NtExecutable.createEmpty(is32bit, false)
  exe.setSectionByEntry(1, { info: { name: '.text', virtualSize: 8, virtualAddress: 4096, sizeOfRawData: 512,
    pointerToRawData: 512, pointerToRelocations: 0, pointerToLineNumbers: 0, numberOfRelocations: 0, numberOfLineNumbers: 0, characteristics: 0x60000020 }, data: new Uint8Array([0x90, 0x90, 0x90, 0x90, 0xc3, 1, 2, 3]).buffer })
  exe.newHeader.optionalHeader.addressOfEntryPoint = 4096
  const res = NtExecutableResource.from(exe)
  const info = Resource.VersionInfo.createEmpty()
  for (const lang of [1033, 2052]) info.setStringValues({ lang, codepage: 1200 }, { ProductName: 'Electron', FileDescription: 'Electron', ProductVersion: '44.1.0' })
  info.outputToResourceEntries(res.entries); res.outputResource(exe)
  return Buffer.from(exe.generate())
}
test('Windows resources use the full candidate version and ASTaria icon in every language', () => {
  const source = fixture(), before = source.slice()
  const exe = NtExecutable.from(brandWindowsExecutable(source, icon, '1.0.0-rc.1'))
  const res = NtExecutableResource.from(exe), versions = Resource.VersionInfo.fromEntries(res.entries)
  assert.deepEqual(source, before, 'the input runtime remains unchanged')
  assert.equal(exe.newHeader.optionalHeader.addressOfEntryPoint, 4096)
  const original = NtExecutable.from(source).getAllSections().find(section => section.info.name === '.text')
  const code = exe.getAllSections().find(section => section.info.name === '.text')
  assert.equal(code.info.virtualAddress, original.info.virtualAddress); assert.deepEqual(code.data, original.data)
  for (const version of versions) for (const language of version.getAllLanguagesForStringValues()) {
    const strings = version.getStringValues(language)
    assert.equal(strings.ProductName, 'ASTaria'); assert.equal(strings.FileDescription, 'ASTaria')
    assert.equal(strings.ProductVersion, '1.0.0-rc.1'); assert.equal(strings.OriginalFilename, 'ASTaria.exe')
    assert.equal(version.fixedInfo.fileVersionMS, 65536)
  }
  assert.ok(Resource.IconGroupEntry.fromEntries(res.entries).every(group => group.icons.length > 0))
  assert.equal(exe.newHeader.optionalHeaderDataDirectory.get(4).size, 0, 'no Authenticode is manufactured')
})
test('resource branding refuses non-x64 binaries, invalid icons and noncanonical versions', () => {
  assert.throws(() => brandWindowsExecutable(fixture(true), icon, '1.0.0'), /x64/u)
  for (const version of ['v1.0', '1.0', '01.0.0', '65536.0.0', '1.0.0-rc.01']) assert.throws(() => brandWindowsExecutable(fixture(), icon, version), /version/u)
  assert.throws(() => brandWindowsExecutable(fixture(), Buffer.from('no icon'), '1.0.0'))
})
