import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

/** A background and deterministic Finder metadata in a writable staging DMG.
 * App bytes/signature stay untouched. Only the resulting DMG is distributed. */
export async function prepareDmgPresentation({ imageRoot, staging, dmg, files, command }) {
  const background = fileURLToPath(new URL('../design/dmg/background.png', import.meta.url))
  const layout = fileURLToPath(new URL('./dmg-layout.py', import.meta.url))
  const notesSource = fileURLToPath(new URL('./dmg-notes-icon.m', import.meta.url))
  await files.mkdir(join(imageRoot, '.background'))
  await files.writeFile(join(imageRoot, '.background/install.png'), await files.readFile(background))
  const writable = join(staging, 'presentation-rw.dmg'), mount = join(staging, 'presentation-mount')
  const notesIcon = join(staging, 'notes-icon')
  await command('prepare-notes-label', '/usr/bin/clang', ['-fobjc-arc', '-framework', 'Foundation', '-framework', 'AppKit', notesSource, '-o', notesIcon])
  await files.mkdir(mount)
  await command('create-layout-image', '/usr/bin/hdiutil', ['create', '-volname', 'ASTaria', '-srcfolder', imageRoot, '-format', 'UDRW', writable])
  let attached = false
  try {
    await command('attach-layout-image', '/usr/bin/hdiutil', ['attach', '-nobrowse', '-mountpoint', mount, writable])
    attached = true
    await command('write-finder-layout', process.env.ASTARIA_DMG_PYTHON ?? 'python3', [layout, mount])
    await command('style-notes-label', notesIcon, [mount])
  } finally {
    if (attached) await command('detach-layout-image', '/usr/bin/hdiutil', ['detach', mount])
  }
  await command('create-dmg', '/usr/bin/hdiutil', ['convert', writable, '-format', 'UDZO', '-o', dmg])
  return { window: [900,560], background: '.background/install.png', layout: '.DS_Store' }
}
