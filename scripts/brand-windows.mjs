import { NtExecutable, NtExecutableResource, Data, Resource } from 'resedit'
import { isCanonicalVersion, versionParts } from '../desktop/version.mjs'

/** A copied runtime's branding does not lend Electron's vendor signature to
 * ASTaria. The result is deliberately unsigned; code sections stay intact. */
export function brandWindowsExecutable(binary, icon, version) {
  const parts = versionParts(version)
  if (!isCanonicalVersion(version) || parts.core.some(value => value > 65535n)) throw new Error('Invalid Windows resource version')
  const core = parts.core.map(Number), exe = NtExecutable.from(binary, { ignoreCert: true })
  if (exe.is32bit() || exe.newHeader.fileHeader.machine !== 0x8664) throw new Error('Branding requires an x64 Windows executable')
  const entryPoint = exe.newHeader.optionalHeader.addressOfEntryPoint, imageBase = exe.getImageBase()
  const resource = NtExecutableResource.from(exe)
  const icons = Data.IconFile.from(icon).icons.map(value => value.data)
  if (!icons.length) throw new Error('The ASTaria icon contains no representations')
  const groups = Resource.IconGroupEntry.fromEntries(resource.entries)
  for (const group of groups.length ? groups : [{ id: 1, lang: 1033 }]) {
    Resource.IconGroupEntry.replaceIconsForResource(resource.entries, group.id, group.lang, icons)
  }
  const versions = Resource.VersionInfo.fromEntries(resource.entries)
  for (const info of versions.length ? versions : [Resource.VersionInfo.createEmpty()]) {
    const languages = info.getAllLanguagesForStringValues()
    for (const language of languages.length ? languages : [{ lang: 1033, codepage: 1200 }]) {
      info.setFileVersion(...core, 0, language.lang)
      info.setProductVersion(...core, 0, language.lang)
      info.setStringValues(language, { ProductName: 'ASTaria', FileDescription: 'ASTaria', CompanyName: 'Wason-dev',
        OriginalFilename: 'ASTaria.exe', InternalName: 'ASTaria', ProductVersion: version })
    }
    info.outputToResourceEntries(resource.entries)
  }
  const code = exe.getAllSections().filter(section => section.info.name !== '.rsrc')
    .map(section => ({ name: section.info.name, address: section.info.virtualAddress, data: section.data ? Buffer.from(section.data) : null }))
  resource.outputResource(exe)
  const result = Buffer.from(exe.generate()), checked = NtExecutable.from(result)
  if (checked.newHeader.optionalHeader.addressOfEntryPoint !== entryPoint || checked.getImageBase() !== imageBase) throw new Error('Windows branding changed the runtime entry point')
  for (const before of code) {
    const after = checked.getAllSections().find(section => section.info.name === before.name)
    // The relocation directory follows .rsrc and can move when the icon grows.
    // The PE writer updates that directory; its fixup bytes must stay intact.
    const movedRelocations = before.name === '.reloc' && after && (after.info.characteristics & 0x20000000) === 0
    if (movedRelocations && checked.newHeader.optionalHeaderDataDirectory.get(5).virtualAddress !== after.info.virtualAddress) {
      throw new Error('Windows relocation directory no longer matches its section')
    }
    if (!after || (!movedRelocations && after.info.virtualAddress !== before.address) || (before.data && (!after.data || !before.data.equals(Buffer.from(after.data))))) {
      throw new Error('Windows branding changed a non-resource runtime section')
    }
  }
  return result
}
