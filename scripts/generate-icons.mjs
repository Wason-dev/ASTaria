#!/usr/bin/env node
/** Convert the approved desktop PNG and mobile/web SVG masters without redrawing or recolouring. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseDocument } from 'htmlparser2'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const REPO = {
  source: join(ROOT, 'design/icon/new/astaria-icon-transparent.svg'),
  opaqueSource: join(ROOT, 'design/icon/new/astaria-icon.svg'),
  desktopSource: join(ROOT, 'design/icon/new/astaria-icon-transparent-2048.png'),
  out: join(ROOT, 'public'),
  androidRes: join(ROOT, 'mobile/android/app/src/main/res'),
  iosAssets: join(ROOT, 'mobile/ios/App/App/Assets.xcassets'),
}
// The supplied lower-right petal extends slightly beyond the viewBox's
// inscribed circle. A 78% glyph leaves its whole contour inside PWA's 80% safe circle.
export const LAYOUT = { desktop: 1.1, web: 1, maskable: .78, ios: 1, splash: .24, adaptiveGlyphDp: 60, adaptiveCanvasDp: 108, notification: .9 }
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]
const PNG_OPTIONS = { compressionLevel: 9, adaptiveFiltering: false, palette: false }
export const USAGE = `node scripts/generate-icons.mjs [--source transparent.svg] [--opaque-source opaque.svg]
  [--desktop-source approved-transparent-2048.png]
  [--out public] [--android-res res] [--ios-assets Assets.xcassets] [--sharp /absolute/path/to/sharp/index.mjs]
Defaults use design/icon/new. All input masters are read-only.
Desktop PNG/ICO use astaria-icon-transparent-2048.png (2048-square RGBA), enlarged 1.1x and centred.
The desktop PNG must be available locally; there is no SVG or black-background fallback.
Mobile/web icons retain the supplied black-background SVG policy.
Main images retain the supplied colours, paths, strokes and clipping.
Only Android notification/themed monochrome masks use white RGB.
Sharp is a build tool and must already be available; this command installs nothing.`

export function parseArgs(argv) {
  const options = {}, flags = ['--source', '--opaque-source', '--desktop-source', '--out', '--android-res', '--ios-assets', '--sharp']
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i], value = argv[i + 1]
    if (!flags.includes(flag) || !value || value.startsWith('--') || options[flag]) throw new Error(`Invalid or duplicate option: ${flag}\n${USAGE}`)
    options[flag] = resolve(value)
  }
  return { options }
}
const children = node => (node.children ?? []).filter(child => child.type === 'tag')
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
const attributes = node => Object.entries(node.attribs ?? {})
const tags = new Set(['svg', 'title', 'desc', 'defs', 'clipPath', 'g', 'path', 'rect'])
const allowed = new Set(['xmlns', 'width', 'height', 'viewBox', 'shape-rendering', 'role', 'aria-labelledby', 'id', 'd', 'fill', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linejoin', 'stroke-linecap', 'clip-path'])

export function parseCanonicalSource(text, sourcePath = '<memory>', opaque = false) {
  if (/<!DOCTYPE|<!ENTITY|<\?/iu.test(text)) throw new Error('The icon master must be self-contained SVG')
  const document = parseDocument(text, { xmlMode: true, decodeEntities: true })
  const roots = children(document)
  if (roots.length !== 1 || roots[0].name !== 'svg') throw new Error('Expected a single SVG root')
  const tree = roots[0], ids = new Map(), paths = [], clips = new Map(), references = []
  if (tree.attribs.viewBox !== '0 0 1600 1600') throw new Error('Expected the supplied 1600-square viewBox')
  function inspect(node, inDefs = false) {
    if (!tags.has(node.name)) throw new Error(`Unsupported icon element: ${node.name}`)
    for (const [key, value] of attributes(node)) {
      if (!allowed.has(key)) throw new Error(`Unsupported icon attribute: ${key}`)
      if (['fill', 'stroke'].includes(key) && !/^#[0-9a-f]{6}$/iu.test(value)) throw new Error('Main artwork must retain literal solid colours')
    }
    if (node.attribs.id) {
      if (ids.has(node.attribs.id)) throw new Error('Duplicate SVG id')
      ids.set(node.attribs.id, node)
    }
    if (node.attribs['clip-path']) {
      const reference = /^url\(#([\w-]+)\)$/u.exec(node.attribs['clip-path'])
      if (!reference) throw new Error('Only a local clip-path is supported')
      references.push(reference[1])
    }
    if (node.name === 'clipPath') {
      if (!inDefs || !node.attribs.id || children(node).length !== 1 || children(node)[0].name !== 'path') throw new Error('Expected a single path in each clip definition')
      clips.set(node.attribs.id, children(node)[0])
    }
    if (node.name === 'rect' && (!opaque || node.attribs.id !== 'background' || node.attribs.width !== '100%' || node.attribs.height !== '100%')) throw new Error('Only the supplied opaque master may contain its background rectangle')
    if (node.name === 'path') {
      if (!node.attribs.d || /[^MLCZmlcz\d\s,.+\-]/u.test(node.attribs.d)) throw new Error('Unexpected path data; do not approximate unsupported geometry')
      if (!inDefs) paths.push(node)
    }
    for (const child of children(node)) inspect(child, inDefs || node.name === 'defs')
  }
  inspect(tree)
  for (const id of references) if (!clips.has(id)) throw new Error(`Missing clip definition: ${id}`)
  if (!paths.length) throw new Error('No visible icon paths')
  const body = text.slice(text.indexOf('>') + 1, text.lastIndexOf('</svg>'))
  return { text, body, tree, paths, clips, sourcePath }
}
const sized = (master, size) => master.text.replace(/<svg\b[^>]*>/u, match => match.replace(/\s(?:width|height)="[^"]*"/gu, '') .replace('>', ` width="${size}" height="${size}">`))
const canvas = (size, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">${body}</svg>`
export function composeGlyph(master, { x = 0, y = 0, size }) {
  return `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 1600 1600" shape-rendering="geometricPrecision">${master.body}</svg>`
}
const centred = (master, size, ratio) => composeGlyph(master, { x: size * (1 - ratio) / 2, y: size * (1 - ratio) / 2, size: size * ratio })
const transparent = (master, size, ratio) => canvas(size, centred(master, size, ratio))
const opaque = (master, size, ratio, background) => canvas(size, `<rect width="100%" height="100%" fill="${background}"/>${centred(master, size, ratio)}`)
async function readDesktopSource(sharp, source) {
  const input = await readFile(source).catch(error => {
    throw new Error(`Cannot read desktop PNG: ${source}. Supply the approved local PNG with --desktop-source; no fallback is allowed.`, { cause: error })
  })
  const metadata = await sharp(input).metadata()
  if (metadata.format !== 'png' || metadata.width !== 2048 || metadata.height !== 2048 || metadata.channels !== 4 || !metadata.hasAlpha) {
    throw new Error('Desktop source must be a 2048x2048 RGBA PNG')
  }
  const { channels } = await sharp(input).stats()
  const alpha = channels[3]
  if (alpha.min !== 0 || alpha.max === 0) throw new Error('Desktop source must contain transparent pixels and visible artwork')
  return input
}
function desktopPng(sharp, input, size) {
  // Preserve the approved conversion in artifacts/v1-transparent-icon/prepare-icons.mjs.
  // Each ICO size is sampled directly from the PNG master, never from the 1024 export.
  const enlarged = Math.round(size * LAYOUT.desktop), inset = Math.floor((enlarged - size) / 2)
  return sharp(input).resize(enlarged, enlarged, { kernel: 'lanczos3' })
    .extract({ left: inset, top: inset, width: size, height: size }).ensureAlpha()
    .png(PNG_OPTIONS).toBuffer()
}

/** Android's local clip groups have the same scope and order as the supplied SVG. */
export function createSplashVector(master) {
  const lines = []
  function visit(node, indent) {
    if (['defs', 'title', 'desc'].includes(node.name)) return
    if (node.name === 'g') {
      lines.push(`${indent}<group${node.attribs.id ? ` android:name="${escape(node.attribs.id)}"` : ''}>`)
      const clip = node.attribs['clip-path']
      if (clip) lines.push(`${indent}    <clip-path android:pathData="${escape(master.clips.get(/^url\(#([\w-]+)\)$/u.exec(clip)[1]).attribs.d)}"/>`)
      for (const child of children(node)) visit(child, indent + '    ')
      lines.push(`${indent}</group>`)
    } else if (node.name === 'path') {
      const a = node.attribs, values = [`android:name="${escape(a.id)}"`, `android:pathData="${escape(a.d)}"`, `android:fillColor="${a.fill ?? '#000000'}"`]
      if (a['fill-rule'] === 'evenodd') values.push('android:fillType="evenOdd"')
      for (const [source, target] of [['stroke', 'strokeColor'], ['stroke-width', 'strokeWidth'], ['stroke-linejoin', 'strokeLineJoin'], ['stroke-linecap', 'strokeLineCap']]) {
        if (a[source]) values.push(`android:${target}="${escape(a[source])}"`)
      }
      lines.push(`${indent}<path ${values.join(' ')}/>`)
    } else throw new Error(`Unsupported Android artwork: ${node.name}`)
  }
  for (const node of children(master.tree)) visit(node, '        ')
  return `<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated directly from design/icon/new; do not redraw. -->\n<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="192dp" android:height="192dp" android:viewportWidth="1600" android:viewportHeight="1600">\n    <group android:scaleX="0.6" android:scaleY="0.6" android:translateX="320" android:translateY="320">\n${lines.join('\n')}\n    </group>\n</vector>\n`
}
export function whiteAlphaFromRgba(input, size) {
  if (input.length !== size * size * 4) throw new Error('Invalid RGBA mask input')
  const result = Buffer.from(input)
  for (let i = 0; i < result.length; i += 4) result.fill(255, i, i + 3)
  return result
}
export function buildIco(entries) {
  const header = Buffer.alloc(6), directory = Buffer.alloc(entries.length * 16)
  header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4)
  let offset = 6 + directory.length
  for (const [index, { size, png }] of entries.entries()) {
    const at = index * 16
    directory[at] = directory[at + 1] = size === 256 ? 0 : size
    directory.writeUInt16LE(1, at + 4); directory.writeUInt16LE(32, at + 6)
    directory.writeUInt32LE(png.length, at + 8); directory.writeUInt32LE(offset, at + 12)
    offset += png.length
  }
  return Buffer.concat([header, directory, ...entries.map(entry => entry.png)])
}

export async function main(argv = process.argv.slice(2)) {
  const { help, options = {} } = parseArgs(argv)
  if (help) { console.log(USAGE); return }
  const source = options['--source'] ?? REPO.source, opaqueSource = options['--opaque-source'] ?? REPO.opaqueSource
  const desktopSource = options['--desktop-source'] ?? REPO.desktopSource
  const master = parseCanonicalSource(await readFile(source, 'utf8'), source)
  const full = parseCanonicalSource(await readFile(opaqueSource, 'utf8'), opaqueSource, true)
  const backgrounds = children(full.tree).filter(node => node.name === 'rect')
  if (backgrounds.length !== 1) throw new Error('Expected one supplied background rectangle')
  const background = backgrounds[0].attribs.fill
  // Refuse mismatched masters rather than silently composing unrelated artwork.
  if (full.body.replace(/^\s*<rect\b[^>]*id="background"[^>]*\/>(?:\r?\n)?/mu, '').trim() !== master.body.trim()) throw new Error('The supplied masters differ beyond the background')
  const splashVector = createSplashVector(master)
  const sharp = (await import(options['--sharp'] ? pathToFileURL(options['--sharp']).href : 'sharp')).default
  const desktop = await readDesktopSource(sharp, desktopSource)
  const destinations = { public: options['--out'] ?? REPO.out, android: options['--android-res'] ?? REPO.androidRes, ios: options['--ios-assets'] ?? REPO.iosAssets }
  const outputs = []
  const add = (directory, name, bytes) => outputs.push({ path: join(directory, name), bytes })
  const raw = async (svg, size) => {
    const { data, info } = await sharp(Buffer.from(svg), { density: 72 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    if (info.width !== size || info.height !== size || info.channels !== 4) throw new Error('Unexpected raster dimensions')
    return data
  }
  const png = (rgba, size, rgb = false) => {
    let image = sharp(rgba, { raw: { width: size, height: size, channels: 4 } })
    if (rgb) image = image.removeAlpha()
    return image.png(PNG_OPTIONS).toBuffer()
  }
  const render = async (svg, size, rgb = false) => png(await raw(svg, size), size, rgb)
  // Mobile/web keep the opaque SVG policy; desktop uses the approved transparent PNG.
  add(destinations.public, 'astaria-logo.svg', Buffer.from(full.text))
  add(destinations.public, 'astaria-logo.png', await render(sized(full, 1024), 1024, true))
  add(destinations.public, 'astaria-icon-1024.png', await desktopPng(sharp, desktop, 1024))
  for (const [name, size] of [['favicon.png', 48], ['apple-touch-icon.png', 180], ['pwa-192x192.png', 192], ['pwa-512x512.png', 512]]) add(destinations.public, name, await render(sized(full, size), size, true))
  add(destinations.public, 'maskable-512x512.png', await render(opaque(master, 512, LAYOUT.maskable, background), 512, true))
  const entries = []
  for (const size of ICO_SIZES) entries.push({ size, png: await desktopPng(sharp, desktop, size) })
  add(destinations.public, 'astaria.ico', buildIco(entries))
  for (const [density, ratio] of DENSITIES) {
    const size = 48 * ratio, legacy = await raw(sized(full, size), size)
    add(destinations.android, `mipmap-${density}/ic_launcher.png`, await png(legacy, size))
    const mask = await raw(canvas(size, `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/>`), size)
    const round = Buffer.from(legacy)
    for (let i = 0; i < round.length; i += 4) round[i + 3] = mask[i + 3]
    add(destinations.android, `mipmap-${density}/ic_launcher_round.png`, await png(round, size))
    const adaptiveSize = 108 * ratio, foreground = await raw(transparent(master, adaptiveSize, 60 / 108), adaptiveSize)
    add(destinations.android, `mipmap-${density}/ic_launcher_foreground.png`, await png(foreground, adaptiveSize))
    add(destinations.android, `drawable-${density}/ic_launcher_monochrome.png`, await png(whiteAlphaFromRgba(foreground, adaptiveSize), adaptiveSize))
    const notificationSize = 24 * ratio, notification = await raw(transparent(master, notificationSize, LAYOUT.notification), notificationSize)
    add(destinations.android, `drawable-${density}/ic_stat_astaria.png`, await png(whiteAlphaFromRgba(notification, notificationSize), notificationSize))
  }
  add(destinations.android, 'drawable/astaria_splash_icon.xml', Buffer.from(splashVector))
  for (const [name, colour] of [['ic_launcher_background', background], ['astaria_launch_background', background]]) {
    add(destinations.android, `values/${name === 'ic_launcher_background' ? name : 'colors'}.xml`, Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="${name}">${colour}</color>\n</resources>\n`))
  }
  add(destinations.ios, 'AppIcon.appiconset/AppIcon-512@2x.png', await render(sized(full, 1024), 1024, true))
  const splash = await render(opaque(master, 2732, LAYOUT.splash, background), 2732, true)
  for (const name of ['splash-2732x2732.png', 'splash-2732x2732-1.png', 'splash-2732x2732-2.png']) add(destinations.ios, `Splash.imageset/${name}`, splash)
  // All parsing, Android conversion and rasterisation succeed before any output is replaced.
  const inputs = [source, opaqueSource, desktopSource].map(path => resolve(path))
  if (outputs.some(({ path }) => inputs.includes(resolve(path)))) throw new Error('Output must not overwrite an input master')
  for (const { path, bytes } of outputs) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
    console.log(`${path.slice(ROOT.length + 1)} (${bytes.length} B)`)
  }
  return { written: outputs.length, background }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main() } catch (error) { console.error(error.message); process.exitCode = 1 }
}
