import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { inflateSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Static resource contracts only. No SDK, devices, signing stores, Sharp, or ignored input PNG is required.
// Mobile/web expectations use the SVG masters; desktop uses approved RGBA reference hashes,
// independently converted from the supplied PNG rather than from generator internals.
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const RES = 'mobile/android/app/src/main/res'
const DENSITIES = [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]
const OPAQUE_MASTER = 'design/icon/new/astaria-icon.svg'
const TRANSPARENT_MASTER = 'design/icon/new/astaria-icon-transparent.svg'
const APP_BACKGROUND = '#282828'
// Approved astaria-icon-transparent-2048.png SHA-256:
// c037755c2c375372b6c201a9ffa43351d79ca54b9e36f0322670bf0a1353b846
// Reference: artifacts/v1-transparent-icon/prepare-icons.mjs, Sharp 0.35.5 / libvips 8.18.7.
// For each size: Lanczos3 to round(size * 1.1), crop size x size at floor((enlarged - size) / 2).
// These hash every decoded RGBA byte (including interior alpha), not PNG compression or just corners.
const DESKTOP_RGBA_SHA256 = {
  16: '0fee55d6d2ccff94421be071bc302b7b870b505868d5bbe74df6a58f7302d6ac',
  24: '9605ea992e382bc4e787e6c8cad2aa4ecb1b809fbf995c508f78d244439e85ea',
  32: '490cb06fc4748d188b5cdaf03c508b1190048cc9492ac6b8d55d399174467824',
  48: 'bc7b379b686cfa8999cebe50fbf0696cbfcce567007a9519fbf9a72736789db3',
  64: 'b935ddc03e81f6462580db0d7ebe01be8bf21c220aa157ec9317e0e74792ef3c',
  128: '0d6491a3109d9664051187fb32b36836671276198d311a3da577f5e97a9670a9',
  256: 'e3b9d6c1315d82b1b81ea8865f8cade8e338a1c4ce8c7fa240b27dd6cf047c6d',
  1024: 'afca5f4778c5addf5b858db77d6df4629ef5446664848e3e94a23c0edd5ab58c',
}
// Platform grids: launcher icons are 48dp, adaptive art is 60/108 of the 108dp canvas,
// status-bar icons are 90% of the 24dp grid.
const LAUNCHER_DP = 48
const ADAPTIVE_DP = 108
const ADAPTIVE_ART = 60 / 108
const NOTIFICATION_DP = 24
const NOTIFICATION_ART = 0.9
const text = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const bytes = (file) => readFileSync(path.join(ROOT, file))
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(data) {
  let crc = 0xffffffff
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}
function png(input) {
  assert.deepEqual(input.subarray(0, 8), signature, 'PNG signature')
  let offset = 8, header, ended = false
  const chunks = []
  while (offset < input.length) {
    assert.ok(offset + 12 <= input.length, 'complete chunk header')
    const length = input.readUInt32BE(offset), end = offset + 12 + length
    assert.ok(end <= input.length, 'complete chunk payload')
    const type = input.toString('ascii', offset + 4, offset + 8)
    const data = input.subarray(offset + 8, offset + 8 + length)
    assert.equal(crc32(input.subarray(offset + 4, offset + 8 + length)), input.readUInt32BE(end - 4), 'CRC ' + type)
    if (type === 'IHDR') { assert.ok(!header); assert.equal(length, 13); header = data }
    if (type === 'IDAT') chunks.push(data)
    offset = end
    if (type === 'IEND') { assert.equal(length, 0); ended = true; break }
  }
  assert.ok(header && chunks.length && ended, 'complete PNG')
  assert.equal(offset, input.length, 'no trailing data')
  const width = header.readUInt32BE(0), height = header.readUInt32BE(4), colorType = header[9]
  assert.ok(width > 0 && height > 0 && width <= 4096 && height <= 4096)
  assert.equal(header[8], 8, '8 bit channels')
  assert.ok(colorType === 2 || colorType === 6, 'RGB or RGBA')
  assert.deepEqual([...header.subarray(10)], [0, 0, 0], 'standard compression/filter, non-interlaced')
  const channels = colorType === 2 ? 3 : 4, stride = width * channels
  const raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: (stride + 1) * height })
  assert.equal(raw.length, (stride + 1) * height)
  const decoded = Buffer.alloc(stride * height)
  // Unfilter whole pixels at a time: for these icons the stride is always a multiple of the channel
  // count, so the left and diagonal neighbours are exact buffer offsets rather than per-byte lookups.
  const pixel = channels >= 3
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = raw[start]
    assert.ok(filter <= 4, 'known PNG filter')
    const line = start + 1
    if (channels === 4 && pixel) {
      const row = decoded.subarray(y * stride, (y + 1) * stride)
      const above = y ? decoded.subarray((y - 1) * stride, y * stride) : null
      const source = raw.subarray(line, line + stride)
      for (let i = 0; i < stride; i += 4) {
        const left = i >= 4 ? row[i - 4] : 0, left1 = i >= 4 ? row[i - 3] : 0
        const left2 = i >= 4 ? row[i - 2] : 0, left3 = i >= 4 ? row[i - 1] : 0
        const up = above ? above[i] : 0, up1 = above ? above[i + 1] : 0
        const up2 = above ? above[i + 2] : 0, up3 = above ? above[i + 3] : 0
        const diagonal = above && i >= 4 ? above[i - 4] : 0, diagonal1 = above && i >= 4 ? above[i - 3] : 0
        const diagonal2 = above && i >= 4 ? above[i - 2] : 0, diagonal3 = above && i >= 4 ? above[i - 1] : 0
        const predicted = filter === 0 ? [0, 0, 0, 0]
          : filter === 1 ? [left, left1, left2, left3]
            : filter === 2 ? [up, up1, up2, up3]
              : filter === 3 ? [Math.floor((left + up) / 2), Math.floor((left1 + up1) / 2), Math.floor((left2 + up2) / 2), Math.floor((left3 + up3) / 2)]
                : [paeth(left, up, diagonal), paeth(left1, up1, diagonal1), paeth(left2, up2, diagonal2), paeth(left3, up3, diagonal3)]
        row[i] = (source[i] + predicted[0]) & 255
        row[i + 1] = (source[i + 1] + predicted[1]) & 255
        row[i + 2] = (source[i + 2] + predicted[2]) & 255
        row[i + 3] = (source[i + 3] + predicted[3]) & 255
      }
      continue
    }
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x
      const left = x >= channels ? decoded[i - channels] : 0
      const up = y ? decoded[i - stride] : 0
      const diagonal = y && x >= channels ? decoded[i - stride - channels] : 0
      const predictor = [0, left, up, Math.floor((left + up) / 2), paeth(left, up, diagonal)][filter]
      decoded[i] = (raw[line + x] + predictor) & 255
    }
  }
  return {
    width, height, colorType, data: decoded, channels,
    pixel(x, y) {
      const i = (y * width + x) * channels
      return [...decoded.subarray(i, i + 3), channels === 4 ? decoded[i + 3] : 255]
    },
  }
}
const imageCache = new Map()
const decoded = new Set()
function load(file) {
  if (imageCache.has(file)) return imageCache.get(file)
  let image
  try { image = png(bytes(file)) } catch (error) {
    if (error?.code === 'ENOENT') assert.fail('generated icon asset missing: ' + file)
    throw error
  }
  imageCache.set(file, image)
  decoded.add(file)
  return image
}
function square(image, size) { assert.deepEqual([image.width, image.height], [size, size]) }
function expectDesktopPixels(image, size) {
  square(image, size)
  assert.equal(image.colorType, 6, 'desktop output retains RGBA')
  assert.equal(createHash('sha256').update(image.data).digest('hex'), DESKTOP_RGBA_SHA256[size],
    size + 'px desktop output exactly matches the approved PNG enlarged 1.1x, with no added background or recolouring')
}
/** Non-greyscale pixels, found with a straight buffer scan (no per-pixel allocation). */
function nonGreyPixels(image, step = 1) {
  const found = []
  const { data, channels, width } = image
  for (let y = 0; y < image.height; y += step) {
    let index = (y * width) * channels
    for (let x = 0; x < width; x += step, index += channels * step) {
      const r = data[index], g = data[index + 1], b = data[index + 2]
      if (r !== g || g !== b) found.push([x, y, r, g, b])
    }
  }
  return found
}

// Small parser for the project's literal resource XML; validates nesting and duplicate attributes.
function xml(source) {
  source = source.replace(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g, '')
  const root = { name: '#document', children: [] }, stack = [root]
  for (const match of source.matchAll(/<(\/?)([\w:.-]+)([^>]*?)>/g)) {
    const [, closing, name, tail] = match
    if (closing) { assert.equal(stack.pop()?.name, name, 'matching XML end tag'); continue }
    const attrs = Object.create(null)
    for (const attr of tail.matchAll(/([\w:.-]+)\s*=\s*(["'])(.*?)\2/g)) {
      assert.ok(!Object.hasOwn(attrs, attr[1]), 'no duplicate XML attribute')
      attrs[attr[1]] = attr[3]
    }
    const node = { name, attrs, children: [] }
    stack.at(-1).children.push(node)
    if (!/\/\s*$/.test(tail)) stack.push(node)
  }
  assert.equal(stack.length, 1, 'closed XML')
  assert.equal(root.children.length, 1, 'one document root')
  return root.children[0]
}
const child = (node, name) => node.children.filter((entry) => entry.name === name)
const items = (style) => Object.fromEntries(style.children.map((item) => [item.attrs.name, item]))
const filesIn = (directory) => readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap((entry) =>
  entry.isDirectory() ? filesIn(directory + '/' + entry.name) : [directory + '/' + entry.name])
function descendants(node, name, found = []) {
  for (const entry of node.children) { if (entry.name === name) found.push(entry); descendants(entry, name, found) }
  return found
}

// --- geometry and colour extracted from the supplied masters -------------------------------------------------

const maskableEdgePixels = (size) => {
  const edge = [0, 1, 2, 3, 4, size - 5, size - 4, size - 3, size - 2, size - 1]
  return [...edge.flatMap((x) => Array.from({ length: size }, (_, y) => [x, y])),
    ...edge.flatMap((y) => Array.from({ length: size }, (_, x) => [x, y]))]
}
const hexToRgb = (value) => [1, 3, 5].map((at) => parseInt(value.slice(at, at + 2), 16))
const rgbToHex = (rgb) => '#' + rgb.map((channel) => channel.toString(16).padStart(2, '0')).join('')
const luminance = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
const flatten = (d, steps = 24) => {
  const tokens = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? []
  const points = []
  let at = [0, 0], start = null, command = null, index = 0
  const number = () => Number(tokens[index++])
  const cubic = (from, [c1, c2, to]) => {
    for (let step = 1; step <= steps; step++) {
      const t = step / steps, u = 1 - t
      points.push([
        u * u * u * from[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * to[0],
        u * u * u * from[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * to[1],
      ])
    }
  }
  while (index < tokens.length) {
    if (/[a-zA-Z]/.test(tokens[index])) command = tokens[index++]
    if (command === 'Z' || command === 'z') { if (start) { points.push([...start]); at = [...start] } continue }
    if (command === 'M' || command === 'm') {
      const next = command === 'm' ? [at[0] + number(), at[1] + number()] : [number(), number()]
      at = next; start = [...next]; points.push([...next]); command = command === 'm' ? 'l' : 'L'; continue
    }
    if (command === 'L' || command === 'l') {
      at = command === 'l' ? [at[0] + number(), at[1] + number()] : [number(), number()]
      points.push([...at]); continue
    }
    if (command === 'H' || command === 'h') { at = [command === 'h' ? at[0] + number() : number(), at[1]]; points.push([...at]); continue }
    if (command === 'V' || command === 'v') { at = [at[0], command === 'v' ? at[1] + number() : number()]; points.push([...at]); continue }
    if (command === 'C' || command === 'c') {
      const raw = [number(), number(), number(), number(), number(), number()]
      const control = command === 'c'
        ? [[at[0] + raw[0], at[1] + raw[1]], [at[0] + raw[2], at[1] + raw[3]], [at[0] + raw[4], at[1] + raw[5]]]
        : [[raw[0], raw[1]], [raw[2], raw[3]], [raw[4], raw[5]]]
      cubic(at, control); at = control[2]; continue
    }
    throw new Error('unsupported path command ' + command + ' in ' + d.slice(0, 40))
  }
  return points
}
const bounds = (points) => points.reduce((box, [x, y]) => [
  Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y),
], [Infinity, Infinity, -Infinity, -Infinity])
function inside(polygon, [x, y], evenOdd = false) {
  let crossings = 0, winding = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j]
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) crossings++
    if (yi <= y) { if (yj > y && (xj - xi) * (y - yi) - (yj - yi) * (x - xi) > 0) winding++ }
    else if (yj <= y && (xj - xi) * (y - yi) - (yj - yi) * (x - xi) < 0) winding--
  }
  return evenOdd ? crossings % 2 === 1 : winding !== 0
}
const SVG_HEAD = /<svg\b[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*viewBox="([^"]+)"/u
/**
 * Reads a supplied master. Group clip paths are inherited by their child shapes, so every shape is
 * recorded with the clip that actually applies to it rather than only its own attributes.
 */
function readMaster(file) {
  const source = readFileSync(path.join(ROOT, file), 'utf8')
  const head = source.match(SVG_HEAD)
  assert.ok(head, file + ' declares width, height and viewBox')
  const [, width, height, viewBox] = head
  const [, , boxWidth, boxHeight] = viewBox.split(/[\s,]+/).map(Number)
  const clips = {}
  for (const match of source.matchAll(/<clipPath id="([^"]+)"[^>]*>\s*<path d="([^"]+)"/gu)) clips[match[1]] = flatten(match[2])
  const body = source.replace(/<defs\b[\s\S]*?<\/defs>/gu, '')
  const paths = []
  const stack = [{ clip: null }]
  for (const match of body.matchAll(/<(\/?)(g|path)\b([^>]*?)(\/?)>/gu)) {
    const [, closing, name, tail, selfClosing] = match
    const attrs = {}
    for (const attr of tail.matchAll(/([\w:-]+)="([^"]*)"/gu)) attrs[attr[1]] = attr[2]
    if (closing) { if (name === 'g') stack.pop(); continue }
    const own = attrs['clip-path']?.match(/url\(#([^)]+)\)/u)?.[1] ?? null
    if (name === 'g') {
      if (!selfClosing) stack.push({ clip: own ?? stack.at(-1).clip })
      continue
    }
    if (!attrs.d) continue
    const clip = own ?? stack.at(-1).clip
    paths.push({
      id: attrs.id ?? null, attrs, fill: attrs.fill ?? null, stroke: attrs.stroke ?? null,
      strokeWidth: attrs['stroke-width'] ? Number(attrs['stroke-width']) : 0,
      strokeJoin: attrs['stroke-linejoin'] ?? null,
      evenOdd: attrs['fill-rule'] === 'evenodd',
      polygon: flatten(attrs.d), clip: clip ? clips[clip] : null, clipId: clip,
      painted: Boolean(attrs.fill || attrs.stroke),
    })
  }
  const fills = paths.map((entry) => entry.fill).filter(Boolean)
  const palette = [...new Set(fills.map((value) => value.toLowerCase()))].sort()
  const painted = paths.filter((entry) => entry.painted)
  const boxes = painted.map((entry) => bounds(entry.polygon))
  const artwork = [Math.min(...boxes.map((box) => box[0])), Math.min(...boxes.map((box) => box[1])),
    Math.max(...boxes.map((box) => box[2])), Math.max(...boxes.map((box) => box[3]))]
  /** The colour the master paints at a point: the last painted shape wins, clipped shapes respect their clip. */
  const colourAt = ([x, y]) => {
    let colour = null
    for (const entry of painted) {
      if (entry.clip && !inside(entry.clip, [x, y])) continue
      if (!inside(entry.polygon, [x, y], entry.evenOdd)) continue
      colour = entry.fill ?? entry.stroke
    }
    return colour
  }
  return {
    source, file, paths, painted, clips, palette, artwork, colourAt, boxWidth, boxHeight,
    size: { width: Number(width), height: Number(height) },
    /** Where a master point lands when the whole 1600x1600 box is fitted into a size x size output. */
    map: (point, size) => [point[0] / boxWidth * size, point[1] / boxHeight * size],
  }
}

const master = readMaster(TRANSPARENT_MASTER)
const opaque = readMaster(OPAQUE_MASTER)
const OPAQUE_RGB = hexToRgb(APP_BACKGROUND)
/** Area centroid of a polygon, falling back to its first point when the area vanishes. */
const centroid = (polygon) => {
  let area = 0, x = 0, y = 0
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const cross = polygon[j][0] * polygon[i][1] - polygon[i][0] * polygon[j][1]
    area += cross
    x += (polygon[j][0] + polygon[i][0]) * cross
    y += (polygon[j][1] + polygon[i][1]) * cross
  }
  return area ? [x / (3 * area), y / (3 * area)] : polygon[0]
}
const distance = (a, b) => (!a || !b ? 255 : Math.max(...a.slice(0, 3).map((value, index) => Math.abs(value - b[index]))))
const uniqueRgb = (image) => {
  const found = new Set()
  for (let i = 0; i < image.data.length; i += image.channels) found.add(rgbToHex([...image.data.subarray(i, i + 3)]))
  return [...found].sort()
}
const greys = (image) => uniqueRgb(image).filter((value) => value[1] === value[3] && value[3] === value[5])
const whiteOf = (image) => {
  const copy = Buffer.from(image.data)
  for (let i = 0; i < copy.length; i += 4) copy[i] = copy[i + 1] = copy[i + 2] = 255
  return copy
}
function boundsOfPixels(image, predicate) {
  let box = null
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const pixel = image.pixel(x, y)
    if (pixel[3] < 8 || !predicate(pixel)) continue
    box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]
  }
  return box
}
const compareBox = (seen, expected, tolerance, label) => {
  assert.ok(seen, label + ' paints artwork')
  const rounded = expected.map((value) => Math.round(value))
  assert.ok(seen.every((value, index) => Math.abs(value - rounded[index]) <= tolerance),
    label + ' artwork box ' + seen.join(',') + ' should match ' + rounded.join(','))
}
/** The master box scaled and centred inside a canvas. */
const centred = (canvas, scale) => {
  const inset = canvas * (1 - scale) / 2
  return (point) => [inset + point[0] / master.boxWidth * canvas * scale, inset + point[1] / master.boxHeight * canvas * scale]
}
/** Flat [left, top, right, bottom] of the master artwork projected into the output space. */
const artworkBox = (project) => {
  const [left, top, right, bottom] = master.artwork
  const [x0, y0] = project([left, top]), [x1, y1] = project([right, bottom])
  return [x0, y0, x1, y1]
}

// Main images keep the source palette; only the platform masks become white.
// Exact SVG-to-PNG fidelity is checked separately by directly rasterising the
// supplied master, without a second hand-written SVG renderer.
function expectMasterColours(image, label) {
  const counts = new Map()
  const { data, channels } = image
  for (let i = 0; i < data.length; i += channels) {
    if (channels === 4 && data[i + 3] === 0) continue
    assert.equal(data[i], data[i + 1], label + ' remains greyscale')
    assert.equal(data[i + 1], data[i + 2], label + ' remains greyscale')
    if (channels === 4 && data[i + 3] < 255) continue
    counts.set(data[i], (counts.get(data[i]) ?? 0) + 1)
  }
  const present = master.palette.filter(colour => (counts.get(hexToRgb(colour)[0]) ?? 0) >= 2)
  assert.ok(present.length >= (image.width >= 256 ? 20 : 8), label + ' retains several solid silver levels')
  assert.ok(present.some(colour => hexToRgb(colour)[0] > 128 && hexToRgb(colour)[0] < 253), label + ' retains the light silver faces')
  assert.ok(present.some(colour => hexToRgb(colour)[0] >= 74 && hexToRgb(colour)[0] < 128), label + ' retains the charcoal folds')
}
function expectCentre(image, project, label) {
  const centre = master.painted.find(entry => entry.id === 'white-center')
  const [x, y] = project(centroid(centre.polygon)).map(Math.floor)
  assert.deepEqual(image.pixel(x, y), [...hexToRgb(centre.fill), 255], label + ' preserves the off-white centre at the source position')
}

test('the supplied masters keep the approved silver palette, clip groups and solid geometry', () => {
  assert.match(master.source, /viewBox="0 0 1600 1600"/u, 'master canvas is the full artwork box')
  assert.deepEqual(master.size, { width: 2048, height: 2048 })
  assert.equal(master.palette.length, 25, 'every distinct silver/grey level is preserved')
  assert.ok(master.palette.every((value) => value[1] === value[3] && value[3] === value[5]), 'palette is greyscale')
  assert.ok(master.palette.filter((value) => luminance(hexToRgb(value)) > 128).length >= 4, 'several light silver levels')
  assert.ok(!master.palette.includes('#ffffff'), 'the centre is off-white, not pure white')
  assert.equal(master.painted.length, 31, '31 painted shapes')
  assert.deepEqual(Object.keys(master.clips).sort(), ['left-bounds', 'right-bounds', 'upper-bounds'])
  assert.equal([...master.source.matchAll(/<path\b/gu)].length - master.paths.length, 3, 'the only unpainted paths are the three clip bounds')
  assert.ok(master.paths.filter((entry) => !entry.painted).every((entry) => entry.clipId === null), 'clip bounds carry no clip')
  assert.equal(master.painted.filter((entry) => entry.evenOdd).length, 3, 'even-odd faces preserved')
  assert.equal(master.painted.filter((entry) => entry.stroke).length, 18, 'stroked folds preserved')
  assert.equal(master.painted.filter((entry) => !entry.stroke).length, 13, 'flat faces carry no stroke')
  const stroked = master.painted.filter((candidate) => candidate.stroke)
  assert.deepEqual([...new Set(stroked.filter((entry) => entry.id !== 'right-inset-groove').map((entry) => entry.strokeWidth))], [1.4],
    'the fold shapes keep their 1.4 stroke width')
  assert.equal(master.painted.find((entry) => entry.id === 'right-inset-groove').strokeWidth, 2, 'the groove keeps its 2 stroke width')
  for (const entry of stroked) {
    assert.ok(entry.strokeWidth > 0, entry.id + ' declares its own stroke width')
    assert.equal(entry.stroke.toLowerCase(), entry.fill.toLowerCase(), entry.id + ' strokes in its own colour')
  }
  assert.equal(stroked.filter((entry) => entry.strokeJoin === 'round').length, 18, 'every stroked fold keeps its round join')
  const clipped = master.painted.filter((entry) => entry.clipId)
  assert.equal(clipped.length, 30, 'the 30 petal shapes inherit their group clip path')
  assert.equal(master.painted.filter((entry) => !entry.clipId).length, 1, 'only the centre is unclipped')
  assert.equal(master.painted.find((entry) => !entry.clipId).id, 'white-center')
  for (const entry of clipped) assert.ok(entry.clip, entry.id + ' resolves its inherited clip polygon')
  for (const forbidden of [/linearGradient|radialGradient/u, /<image\b|data:|file:/iu, /transform=/u, /<filter\b|blur\(/u]) {
    assert.doesNotMatch(master.source, forbidden, 'no gradients, bitmaps, transforms or filters')
  }
  assert.equal(opaque.source.replace(/\n\s*<rect id="background"[^>]*>\n/u, '\n'), master.source,
    'the opaque master differs from the transparent master only by the opaque background rect')
  assert.match(opaque.source, new RegExp('<rect id="background"[^>]*fill="' + APP_BACKGROUND + '"', 'u'))
  assert.deepEqual(opaque.palette, master.palette, 'the background rect does not alter the artwork palette')
})

test('public/astaria-logo.svg is a byte-identical copy of the selected black-background master', () => {
  const copy = text('public/astaria-logo.svg')
  assert.deepEqual(Buffer.from(copy, 'utf8'), Buffer.from(opaque.source, 'utf8'), 'byte-identical opaque master copy')
})

test('public/astaria-logo.png is the full-viewBox black-background master with the real silver levels', () => {
  const image = load('public/astaria-logo.png')
  square(image, 1024)
  assert.equal(image.colorType, 2, 'opaque RGB master')
  assert.deepEqual(image.pixel(0, 0), [...OPAQUE_RGB, 255], 'selected master background')
  assert.deepEqual(image.pixel(1023, 1023), [...OPAQUE_RGB, 255], 'selected master background')
  const levels = greys(image)
  assert.ok(levels.length >= 25, 'every silver level survives rasterising, saw ' + levels.length)
  assert.ok(levels.filter((value) => luminance(hexToRgb(value)) > 128).length >= 12, 'light silver levels survive')
  expectMasterColours(image, 'astaria-logo.png')
  expectCentre(image, (point) => master.map(point, 1024), 'astaria-logo.png')
  // Antialiasing blends between the two real colours either side of an edge, so the whole image
  // must still be greyscale: no new hue may appear anywhere.
  const tinted = nonGreyPixels(image, 3)
  assert.deepEqual(tinted.slice(0, 4), [], 'greyscale only, saw ' + tinted.slice(0, 4).map(([x, y, r, g, b]) => rgbToHex([r, g, b]) + '@' + x + ',' + y).join(' '))
})

test('desktop 1024 PNG matches every approved 1.1x transparent reference pixel', () => {
  expectDesktopPixels(load('public/astaria-icon-1024.png'), 1024)
})

test('web and store icons use the opaque master at full viewBox without shrinking the artwork', () => {
  for (const [name, size] of [['favicon.png', 48], ['apple-touch-icon.png', 180], ['pwa-192x192.png', 192], ['pwa-512x512.png', 512]]) {
    const image = load('public/' + name)
    square(image, size)
    assert.equal(image.colorType, 2, name + ' renders the opaque master, so it has no alpha channel')
    assert.deepEqual(image.pixel(0, 0), [...OPAQUE_RGB, 255], name + ' opaque background corner')
    assert.deepEqual(image.pixel(size - 1, size - 1), [...OPAQUE_RGB, 255], name + ' opaque background corner')
    expectMasterColours(image, name)
    expectCentre(image, (point) => master.map(point, size), name)
    compareBox(boundsOfPixels(image, (rgb) => distance(rgb, OPAQUE_RGB) > 12), artworkBox((point) => master.map(point, size)), 2, name)
  }
})

test('maskable 512 fits the entire supplied contour inside the 80% safe circle', () => {
  const image = load('public/maskable-512x512.png')
  square(image, 512)
  assert.equal(image.colorType, 2, 'maskable output is opaque RGB')
  const project = centred(512, 0.78)
  assert.deepEqual(image.pixel(0, 0), [...OPAQUE_RGB, 255], 'corners use the brand background')
  assert.deepEqual(image.pixel(511, 511), [...OPAQUE_RGB, 255], 'corners use the brand background')
  compareBox(boundsOfPixels(image, (rgb) => distance(rgb, OPAQUE_RGB) > 12), artworkBox(project), 3, 'maskable')
  expectMasterColours(image, 'maskable')
  expectCentre(image, project, 'maskable')
  for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) {
    // Check pixels wholly outside the circle; a boundary pixel can contain
    // valid antialiasing from the part of its area that lies inside it.
    if (Math.hypot(Math.max(0, Math.abs(x + .5 - 256) - .5), Math.max(0, Math.abs(y + .5 - 256) - .5)) > 512 * .4) {
      assert.deepEqual(image.pixel(x, y), [...OPAQUE_RGB, 255], 'artwork remains inside the maskable safe circle')
    }
  }
  // Maskable safety: art may be cropped to a circle, so nothing may reach the canvas edge or corners.
  for (const [x, y] of maskableEdgePixels(512)) {
    assert.ok(distance(image.pixel(x, y), OPAQUE_RGB) <= 12, 'maskable edge stays background at ' + x + ',' + y)
  }
})

test('Windows ICO has seven valid RGBA entries matching every approved 1.1x transparent reference pixel', () => {
  let ico
  try { ico = bytes('public/astaria.ico') } catch (error) {
    if (error?.code === 'ENOENT') assert.fail('generated icon asset missing: public/astaria.ico')
    throw error
  }
  assert.equal(ico.readUInt16LE(0), 0)
  assert.equal(ico.readUInt16LE(2), 1)
  const count = ico.readUInt16LE(4), sizes = []
  assert.equal(count, 7)
  let expectedOffset = 6 + count * 16
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16, size = ico[entry] || 256
    assert.equal(ico[entry + 1] || 256, size)
    assert.equal(ico.readUInt16LE(entry + 4), 1)
    assert.equal(ico.readUInt16LE(entry + 6), 32)
    const length = ico.readUInt32LE(entry + 8), offset = ico.readUInt32LE(entry + 12)
    assert.equal(offset, expectedOffset)
    const image = png(ico.subarray(offset, offset + length))
    expectDesktopPixels(image, size)
    expectedOffset += length
    sizes.push(size)
  }
  assert.equal(expectedOffset, ico.length)
  assert.deepEqual(sizes, [16, 24, 32, 48, 64, 128, 256])
})

for (const [density, ratio] of DENSITIES) {
  test(density + ' adaptive foreground and monochrome keep the real silver RGBA or the white system mask', () => {
    const foreground = load(RES + '/mipmap-' + density + '/ic_launcher_foreground.png')
    const monochrome = load(RES + '/drawable-' + density + '/ic_launcher_monochrome.png')
    const canvas = ADAPTIVE_DP * ratio
    square(foreground, canvas); square(monochrome, canvas)
    assert.equal(foreground.colorType, 6); assert.equal(monochrome.colorType, 6)
    // Transparent pixels may carry any RGB, including black; only the covered art is silver.
    assert.equal(foreground.pixel(0, 0)[3], 0, 'foreground background stays transparent')
    const levels = greys(foreground).filter((value) => value !== '#000000')
    assert.ok(levels.length >= 20, density + ' foreground keeps real silver levels, saw ' + levels.length)
    assert.ok(levels.filter((value) => luminance(hexToRgb(value)) > 128).length >= 10, density + ' keeps light silver levels')
    const project = centred(canvas, ADAPTIVE_ART)
    compareBox(boundsOfPixels(foreground, (rgb) => rgb[3] > 8 && distance(rgb, [0, 0, 0]) > 6), artworkBox(project), 3, density + ' adaptive foreground')
    expectMasterColours(foreground, density + ' adaptive foreground')
    expectCentre(foreground, project, density + ' adaptive foreground')
    assert.deepEqual(monochrome.data, whiteOf(foreground), density + ' monochrome is the same alpha with white RGB')
  })
  test(density + ' notification icon is the white system mask at 90% of the grid', () => {
    const notification = load(RES + '/drawable-' + density + '/ic_stat_astaria.png')
    const canvas = NOTIFICATION_DP * ratio
    square(notification, canvas)
    assert.equal(notification.colorType, 6)
    for (let i = 0; i < notification.data.length; i += 4) {
      if (!notification.data[i + 3]) continue
      assert.deepEqual([...notification.data.subarray(i, i + 3)], [255, 255, 255], 'status bar artwork is white')
    }
    compareBox(boundsOfPixels(notification, () => true), artworkBox(centred(canvas, NOTIFICATION_ART)), 2, density + ' notification')
  })
  test(density + ' legacy icon is the opaque master and round only adds a circular alpha mask', () => {
    const normal = load(RES + '/mipmap-' + density + '/ic_launcher.png')
    const round = load(RES + '/mipmap-' + density + '/ic_launcher_round.png')
    const size = LAUNCHER_DP * ratio
    square(normal, size); square(round, size)
    assert.equal(normal.colorType, 6); assert.equal(round.colorType, 6)
    assert.deepEqual(normal.pixel(0, 0), [...OPAQUE_RGB, 255], 'legacy background is the brand colour')
    assert.deepEqual(normal.pixel(size - 1, size - 1), [...OPAQUE_RGB, 255], 'legacy background is the brand colour')
    const levels = greys(normal)
    assert.ok(levels.length >= 20, density + ' legacy keeps the silver levels, saw ' + levels.length)
    expectMasterColours(normal, density + ' legacy')
    expectCentre(normal, (point) => master.map(point, size), density + ' legacy')
    for (const point of [[0, 0], [size - 1, 0], [0, size - 1], [size - 1, size - 1]]) assert.equal(round.pixel(...point)[3], 0)
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      const a = normal.pixel(x, y), b = round.pixel(x, y)
      assert.ok(b[3] <= a[3], 'round only removes coverage')
      if (b[3]) assert.deepEqual(b.slice(0, 3), a.slice(0, 3), 'round mask does not recolour artwork')
      const radius = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)
      if (radius <= size * 0.45) assert.deepEqual(b, a, 'central 90% circle untouched')
      if (radius > size / 2 + 1) assert.equal(b[3], 0, 'round boundary')
    }
  })
}

test('adaptive icons expose monochrome only on API 33+, with the brand background colour', () => {
  for (const name of ['ic_launcher', 'ic_launcher_round']) {
    for (const api of [26, 33]) {
      const node = xml(text(RES + '/mipmap-anydpi-v' + api + '/' + name + '.xml'))
      assert.equal(node.name, 'adaptive-icon')
      assert.equal(child(node, 'background')[0].attrs['android:drawable'], '@color/ic_launcher_background')
      assert.equal(child(node, 'foreground')[0].attrs['android:drawable'], '@mipmap/ic_launcher_foreground')
      if (api === 33) assert.equal(child(node, 'monochrome')[0].attrs['android:drawable'], '@drawable/ic_launcher_monochrome')
      else assert.equal(child(node, 'monochrome').length, 0)
    }
  }
  assert.match(text(RES + '/values/ic_launcher_background.xml'),
    new RegExp('<color name="ic_launcher_background">' + APP_BACKGROUND + '</color>', 'iu'),
    'adaptive background matches the opaque master background')
})

test('system splash uses the brand vector and dark background, then restores DayNight.NoActionBar', () => {
  for (const qualifier of ['values', 'values-v31']) {
    const source = text(RES + '/' + qualifier + '/styles.xml')
    const theme = child(xml(source), 'style').find((entry) => entry.attrs.name === 'AppTheme.NoActionBarLaunch')
    assert.equal(theme.attrs.parent, 'Theme.SplashScreen')
    for (const [name, value] of [
      ['windowSplashScreenBackground', '@color/astaria_launch_background'],
      ['windowSplashScreenAnimatedIcon', '@drawable/astaria_splash_icon'],
      ['postSplashScreenTheme', '@style/AppTheme.NoActionBar'],
    ]) assert.ok(source.includes('name="' + name + '">' + value + '</item>'))
    if (qualifier === 'values-v31') {
      assert.ok(items(theme)['android:windowSplashScreenBackground'])
      assert.ok(items(theme)['android:windowSplashScreenAnimatedIcon'])
    }
    assert.doesNotMatch(source, /@drawable\/splash\b/u)
  }
  const normal = child(xml(text(RES + '/values/styles.xml')), 'style').find((entry) => entry.attrs.name === 'AppTheme.NoActionBar')
  assert.equal(normal.attrs.parent, 'Theme.AppCompat.DayNight.NoActionBar')
  const vector = xml(text(RES + '/drawable/astaria_splash_icon.xml'))
  assert.equal(vector.name, 'vector')
  assert.equal(vector.attrs['android:viewportWidth'], String(master.boxWidth))
  assert.equal(vector.attrs['android:viewportHeight'], String(master.boxHeight))
  const group = child(vector, 'group')[0]
  assert.equal(Number(group.attrs['android:scaleX']), 0.6, 'existing group scale kept')
  assert.equal(Number(group.attrs['android:scaleY']), 0.6, 'existing group scale kept')
  assert.equal(Number(group.attrs['android:translateX']), 320, 'existing group offset kept')
  assert.equal(Number(group.attrs['android:translateY']), 320, 'existing group offset kept')
  assert.match(vector.attrs['android:width'] ?? '', /^192dp$/u, 'splash icon is 192dp')
  assert.match(vector.attrs['android:height'] ?? '', /^192dp$/u, 'splash icon is 192dp')
  // Every visible shape is copied one for one: pathData, solid fill, fill rule, stroke colour, width and join.
  const drawn = new Map(descendants(vector, 'path').map((entry) => [entry.attrs['android:pathData'], entry]))
  assert.equal(drawn.size, master.painted.length, 'every visible path appears exactly once')
  const clipGroups = descendants(vector, 'clip-path')
  assert.equal(clipGroups.length, Object.keys(master.clips).length, 'every clip-path group is kept')
  for (const entry of master.painted) {
    const node = drawn.get(entry.attrs.d)
    assert.ok(node, 'splash keeps ' + entry.id + ' pathData verbatim')
    const fill = node.attrs['android:fillColor'] ?? ''
    assert.match(fill, /^#[0-9a-f]{6}$/iu, entry.id + ' fill is a plain #rrggbb colour')
    assert.equal(fill.toLowerCase(), (entry.fill ?? entry.stroke).toLowerCase(), entry.id + ' keeps its solid fill')
    assert.equal(Boolean(/evenOdd/u.test(node.attrs['android:fillType'] ?? '')), entry.evenOdd, entry.id + ' keeps its fill rule')
    if (entry.stroke) {
      assert.equal(node.attrs['android:strokeColor']?.toLowerCase(), entry.stroke.toLowerCase(), entry.id + ' keeps its stroke colour')
      assert.equal(Number(node.attrs['android:strokeWidth']), entry.strokeWidth, entry.id + ' keeps its stroke width')
      assert.equal(node.attrs['android:strokeLineJoin'], entry.strokeJoin, entry.id + ' keeps its stroke join')
    } else {
      assert.equal(node.attrs['android:strokeColor'], undefined, entry.id + ' carries no stroke')
    }
  }
  // Each android clip-path is a child of the petal group it bounds, and the shapes that inherit a
  // clip path in the master sit inside that same group.
  const clipData = new Map([...master.source.matchAll(/<clipPath id="([^"]+)"[^>]*>\s*<path d="([^"]+)"/gu)].map(match => [match[1], match[2]]))
  const groups = descendants(vector, 'group').filter((node) => child(node, 'clip-path').length)
  assert.equal(groups.length, 3, 'one clip-path group per clipped petal')
  const named = groups.map((node) => node.attrs['android:name'])
  assert.deepEqual([...named].sort(), ['left-petal', 'right-petal', 'upper-petal'])
  for (const node of groups) {
    const clip = child(node, 'clip-path')[0]
    assert.equal(clip.attrs['android:pathData'], clipData.get(node.attrs['android:name'].replace('-petal', '-bounds')), 'clip geometry copied verbatim')
    const inside = child(node, 'path').map((path) => path.attrs['android:pathData'])
    const expectedIds = master.painted.filter((entry) => entry.clipId === node.attrs['android:name'].replace('-petal', '-bounds')).length
    assert.equal(inside.length, expectedIds, node.attrs['android:name'] + ' holds its ' + expectedIds + ' clipped shapes')
    assert.deepEqual([...inside].sort(), master.painted.filter(entry => entry.clipId === node.attrs['android:name'].replace('-petal', '-bounds')).map(entry => entry.attrs.d).sort(), 'paths retain their original clip group')
  }
  const outerGroup = descendants(vector, 'group').find((node) => node.attrs['android:name'] === 'astaria-icon')
  const outside = child(outerGroup, 'path')
  assert.equal(outside.length, 1, 'only the unclipped white centre sits outside the petal groups')
  assert.equal(outside[0].attrs['android:name'], 'white-center')
})

test('iOS app icon carries no alpha and the splash uses the 24% centred master', () => {
  const assets = 'mobile/ios/App/App/Assets.xcassets'
  for (const entry of JSON.parse(text(assets + '/AppIcon.appiconset/Contents.json')).images) {
    const image = load(assets + '/AppIcon.appiconset/' + entry.filename)
    square(image, 1024)
    assert.equal(image.colorType, 2, 'iOS app icon has no alpha channel')
    assert.deepEqual(image.pixel(0, 0), [...OPAQUE_RGB, 255], 'opaque master background')
    assert.ok(greys(image).length >= 25, 'iOS app icon keeps every silver level')
    expectMasterColours(image, 'iOS app icon')
    expectCentre(image, (point) => master.map(point, 1024), 'iOS app icon')
  }
  for (const entry of JSON.parse(text(assets + '/Splash.imageset/Contents.json')).images) {
    const image = load(assets + '/Splash.imageset/' + entry.filename)
    square(image, 2732)
    assert.equal(image.colorType, 2, 'iOS splash has no alpha channel')
    assert.deepEqual(image.pixel(0, 0), [...OPAQUE_RGB, 255], 'splash background')
    const project = centred(2732, 0.24)
    compareBox(boundsOfPixels(image, (rgb) => distance(rgb, OPAQUE_RGB) > 8), artworkBox(project), 3, 'iOS splash')
    expectMasterColours(image, 'iOS splash')
    expectCentre(image, project, 'iOS splash')
  }
})

test('INTERNET precedes application and Android 12 backup/transfer deny every app domain', () => {
  const manifestText = text('mobile/android/app/src/main/AndroidManifest.xml')
  const manifest = xml(manifestText), application = child(manifest, 'application')[0]
  const permissions = child(manifest, 'uses-permission').filter((entry) => entry.attrs['android:name'] === 'android.permission.INTERNET')
  assert.equal(permissions.length, 1)
  assert.ok(manifest.children.indexOf(permissions[0]) < manifest.children.indexOf(application))
  assert.equal(application.attrs['android:allowBackup'], 'false')
  assert.equal(application.attrs['android:fullBackupContent'], 'false')
  assert.equal(application.attrs['android:dataExtractionRules'], '@xml/data_extraction_rules')
  const rules = xml(text(RES + '/xml/data_extraction_rules.xml'))
  assert.equal(rules.name, 'data-extraction-rules')
  const domains = ['root', 'file', 'database', 'sharedpref', 'external', 'device_root', 'device_file', 'device_database', 'device_sharedpref'].sort()
  assert.deepEqual(rules.children.map((entry) => entry.name).sort(), ['cloud-backup', 'device-transfer'])
  for (const section of rules.children) {
    assert.ok(section.children.every((entry) => entry.name === 'exclude' && entry.attrs.path === '.'))
    assert.deepEqual(section.children.map((entry) => entry.attrs.domain).sort(), domains)
  }
  assert.match(text('mobile/android/app/src/main/java/dev/wason/ASTaria/ASTariaSecretsPlugin.java'), /getNoBackupFilesDir\(\)/u)
})

test('local XML resource references resolve, and platform attributes stay version qualified', () => {
  const files = filesIn(RES), known = new Set()
  for (const file of files) {
    const directory = path.basename(path.dirname(file)).split('-')[0]
    if (directory === 'values' && file.endsWith('.xml')) {
      for (const entry of xml(text(file)).children) if (entry.attrs.name) known.add(entry.name + '/' + entry.attrs.name)
    } else known.add(directory + '/' + path.basename(file, path.extname(file)))
  }
  for (const file of [...files.filter((entry) => entry.endsWith('.xml')), 'mobile/android/app/src/main/AndroidManifest.xml']) {
    const source = text(file)
    xml(source)
    for (const match of source.matchAll(/@(drawable|mipmap|xml|color|string|style)\/([\w.]+)/gu)) {
      assert.ok(known.has(match[1] + '/' + match[2]), file + ' resolves ' + match[0])
    }
    if (/android:windowSplashScreen/u.test(source)) assert.ok(file.includes('/values-v31/'))
    assert.doesNotMatch(source, /#26A69A|M66\.94,46\.02/u, 'no unused Android template artwork')
  }
})
