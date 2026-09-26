#!/usr/bin/env node
// Optional build-time tool: pass --sharp /absolute/path/to/sharp/index.mjs
// when Sharp is provided by a separate graphics environment.
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const options = {}
for (let i = 0; i < args.length; i += 2) {
  if (!['--source', '--out', '--macos-svg', '--sharp'].includes(args[i]) || !args[i + 1]) {
    throw new Error('Usage: node scripts/generate-icons.mjs [--source SVG] [--out DIR] [--macos-svg SVG] [--sharp MODULE]')
  }
  options[args[i]] = args[i + 1]
}
const sharp = (await import(options['--sharp'] ? pathToFileURL(resolve(options['--sharp'])).href : 'sharp')).default
const source = resolve(options['--source'] ?? join(root, 'design/icon-vector/astaria-icon-layered.svg'))
const out = resolve(options['--out'] ?? join(root, 'public'))
const macosPath = resolve(options['--macos-svg'] ?? join(root, 'design/icon-vector/astaria-icon-macos.svg'))
const artwork = (await readFile(source, 'utf8')).replace(/<svg\b[^>]*>/u, '').replace(/<\/svg>\s*$/u, '')
if (/<(?:image|foreignObject)\b/iu.test(artwork)) throw new Error('Icon master must remain vector-only')
const logo = (x, y, size) => `<svg x="${x}" y="${y}" width="${size}" height="${size}" viewBox="0 0 1600 1600">${artwork}</svg>`
const svg = (body) => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>\n`
// ICNS does not receive automatic macOS rounding. Keep the white tile and
// transparent outer margin in the actual source, independent of the web icons.
const tile = 'M 342 100 H 682 C 770 100 814 100 852 128 C 887 150 910 185 920 226 C 924 249 924 286 924 342 V 682 C 924 770 924 814 896 852 C 874 887 839 910 798 920 C 775 924 738 924 682 924 H 342 C 254 924 210 924 172 896 C 137 874 114 839 104 798 C 100 775 100 738 100 682 V 342 C 100 254 100 210 128 172 C 150 137 185 114 226 104 C 249 100 286 100 342 100 Z'
const macos = svg(`<defs><filter id="tile-shadow" x="-15%" y="-15%" width="130%" height="140%"><feGaussianBlur stdDeviation="9"/></filter></defs><path d="${tile}" transform="translate(0 10)" fill="#000" opacity=".16" filter="url(#tile-shadow)"/><path d="${tile}" fill="#fff" stroke="#c8cad2" stroke-width="1"/>${logo(100, 100, 824)}`)
const web = svg(`<rect width="1024" height="1024" fill="#fff"/>${logo(0, 0, 1024)}`)
// Maskable icons can be cropped to a circle: keep every petal inside the
// central 80%-diameter safe circle rather than reuse the macOS tile.
const maskable = svg(`<rect width="1024" height="1024" fill="#fff"/>${logo(112.64, 112.64, 798.72)}`)
await mkdir(out, { recursive: true })
await mkdir(dirname(macosPath), { recursive: true })
await writeFile(macosPath, macos)
for (const [name, size, input] of [
  ['astaria-icon-1024.png', 1024, macos],
  ['favicon.png', 48, web],
  ['apple-touch-icon.png', 180, web],
  ['pwa-192x192.png', 192, web],
  ['pwa-512x512.png', 512, web],
  ['maskable-512x512.png', 512, maskable],
]) {
  await sharp(Buffer.from(input), { density: 288 }).resize(size, size).png().toFile(join(out, name))
  console.log(`${name}: ${size} × ${size}`)
}
