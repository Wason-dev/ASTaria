import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Data } from 'resedit'
import { decodeIconPng, rgbaToIconDib, toNsisIcon } from './nsis-icon.mjs'

test('DIB stores coloured corners bottom-up in BGRA and retains partial alpha', () => {
  const rgba = Buffer.from([10,20,30,255, 40,50,60,128, 70,80,90,0, 100,110,120,255])
  const dib = rgbaToIconDib({ width: 2, height: 2, rgba })
  assert.equal(dib.readInt32LE(8), 4)
  assert.deepEqual([...dib.subarray(40, 56)], [90,80,70,0, 120,110,100,255, 30,20,10,255, 60,50,40,128])
  assert.deepEqual([...dib.subarray(56)], [128,0,0,0, 0,0,0,0])
})

test('NSIS ICO retains all original size, RGB and alpha values through independent DIB parsing', async () => {
  const input = await readFile(new URL('../public/astaria.ico', import.meta.url)), before = Buffer.from(input)
  const source = Data.IconFile.from(input), converted = Data.IconFile.from(toNsisIcon(input))
  assert.deepEqual(input, before)
  assert.deepEqual(converted.icons.map(x => x.data.bitmapInfo.width), [16,24,32,48,64,128,256])
  for (let index = 0; index < source.icons.length; index++) {
    const expected = decodeIconPng(source.icons[index].data.bin), actual = converted.icons[index].data
    assert.equal(actual.bitmapInfo.bitCount, 32)
    const width = expected.width, pixels = Buffer.from(actual.pixels)
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
      const at = ((width - 1 - y) * width + x) * 4, sourceAt = (y * width + x) * 4
      assert.deepEqual([pixels[at + 2], pixels[at + 1], pixels[at], pixels[at + 3]], [...expected.rgba.subarray(sourceAt, sourceAt + 4)])
    }
  }
})

test('icon conversion rejects malformed, unsupported or oversized data', () => {
  assert.throws(() => decodeIconPng(Buffer.from('not a png')))
  assert.throws(() => toNsisIcon(Buffer.alloc(6)))
  for (const width of [0, 257, 1.5]) assert.throws(() => rgbaToIconDib({ width, height: width, rgba: Buffer.alloc(0) }))
})
