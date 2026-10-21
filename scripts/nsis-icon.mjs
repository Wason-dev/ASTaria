import { inflateSync } from 'node:zlib'
import { Data } from 'resedit'

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')
const paeth = (a, b, c) => {
  const p = a + b - c, x = Math.abs(p - a), y = Math.abs(p - b), z = Math.abs(p - c)
  return x <= y && x <= z ? a : y <= z ? b : c
}

/** Decode only the bounded, 8-bit RGBA PNG representations generated for ASTaria. */
export function decodeIconPng(input) {
  const png = Buffer.from(input)
  if (png.length > 2 * 1024 * 1024 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('Expected a bounded icon PNG')
  const chunks = []
  let offset = 8, width, height, ended = false
  while (offset < png.length) {
    if (offset + 12 > png.length) throw new Error('Truncated PNG chunk')
    const length = png.readUInt32BE(offset), end = offset + length + 12
    if (end > png.length) throw new Error('Truncated PNG payload')
    const type = png.toString('ascii', offset + 4, offset + 8), data = png.subarray(offset + 8, end - 4)
    if (type === 'IHDR') {
      if (width || length !== 13) throw new Error('Invalid PNG header')
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      if (!width || width > 256 || width !== height || data[8] !== 8 || data[9] !== 6 || data[10] || data[11] || data[12]) throw new Error('Expected square, noninterlaced 8-bit RGBA icon')
    } else if (type === 'IDAT') chunks.push(data)
    else if (type === 'IEND') { if (length) throw new Error('Invalid PNG end'); ended = true }
    offset = end
    if (ended) break
  }
  if (!width || !chunks.length || !ended || offset !== png.length) throw new Error('Incomplete icon PNG')
  const stride = width * 4, expected = (stride + 1) * height
  const filtered = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected })
  if (filtered.length !== expected) throw new Error('Invalid PNG pixel length')
  const rgba = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1), filter = filtered[row]
    if (filter > 4) throw new Error('Invalid PNG filter')
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x, left = x >= 4 ? rgba[i - 4] : 0, up = y ? rgba[i - stride] : 0, diagonal = y && x >= 4 ? rgba[i - stride - 4] : 0
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : paeth(left, up, diagonal)
      rgba[i] = (filtered[row + 1 + x] + predictor) & 255
    }
  }
  return { width, height, rgba }
}

/** Use DIB representations for NSIS compatibility. Preserve RGBA; only row/channel order changes. */
export function rgbaToIconDib({ width, height, rgba }) {
  if (!Number.isInteger(width) || width < 1 || width > 256 || width !== height || rgba.length !== width * height * 4) throw new Error('Invalid icon pixels')
  const maskStride = Math.ceil(width / 32) * 4, xorBytes = width * height * 4
  const dib = Buffer.alloc(40 + xorBytes + maskStride * height)
  dib.writeUInt32LE(40); dib.writeInt32LE(width, 4); dib.writeInt32LE(height * 2, 8)
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14); dib.writeUInt32LE(xorBytes + maskStride * height, 20)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (y * width + x) * 4, row = height - y - 1, target = 40 + (row * width + x) * 4
    dib[target] = rgba[source + 2]; dib[target + 1] = rgba[source + 1]; dib[target + 2] = rgba[source]; dib[target + 3] = rgba[source + 3]
    if (!rgba[source + 3]) dib[40 + xorBytes + row * maskStride + (x >> 3)] |= 0x80 >> (x & 7)
  }
  return dib
}

export function toNsisIcon(input) {
  const representations = Data.IconFile.from(input).icons.map(entry => {
    const original = Buffer.from(entry.data.bin ?? entry.data.generate())
    if (!original.subarray(0, 8).equals(SIGNATURE)) throw new Error('Expected generated PNG ICO entries')
    const image = decodeIconPng(original)
    return { size: image.width, data: rgbaToIconDib(image) }
  })
  if (representations.length !== 7 || representations.map(x => x.size).join(',') !== '16,24,32,48,64,128,256') throw new Error('Expected all seven ASTaria icon sizes')
  const head = Buffer.alloc(6 + representations.length * 16)
  head.writeUInt16LE(1, 2); head.writeUInt16LE(representations.length, 4)
  let offset = head.length
  for (const [index, { size, data }] of representations.entries()) {
    const at = 6 + index * 16
    head[at] = head[at + 1] = size === 256 ? 0 : size
    head.writeUInt16LE(1, at + 4); head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(data.length, at + 8); head.writeUInt32LE(offset, at + 12); offset += data.length
  }
  return Buffer.concat([head, ...representations.map(entry => entry.data)])
}
