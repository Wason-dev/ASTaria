import test from 'node:test'
import assert from 'node:assert/strict'
import { randomFillSync } from 'node:crypto'
import { DataUtils } from 'three'
import { toHalfFloatArray } from '../src/prototype/halfFloat.ts'

const previous = data => Uint16Array.from(data, value => DataUtils.toHalfFloat(value))
function check(data) {
  const before = new Uint8Array(data.buffer).slice()
  const actual = toHalfFloatArray(data)
  assert.deepEqual(actual, previous(data))
  assert.equal(actual.length, data.length)
  assert.equal(actual.byteOffset, 0)
  assert.notEqual(actual.buffer, data.buffer)
  assert.deepEqual(new Uint8Array(data.buffer), before, 'input bytes and backing storage stay intact')
}

test('indexed half conversion matches every old result for zeros, NaNs, infinities and boundaries', t => {
  t.mock.method(console, 'warn', () => {}) // Three warns when it clamps out-of-range inputs, including infinities.
  check(new Float32Array([0, -0, NaN, Infinity, -Infinity, 1, -1, 65504, -65504, 65520, -65520,
    2 ** -14, -(2 ** -14), 2 ** -24, -(2 ** -24), 2 ** -25, -(2 ** -25),
    2 ** -126, -(2 ** -126), 2 ** -149, -(2 ** -149), 3.4028234663852886e38, -3.4028234663852886e38]))
  // Include distinct NaN payloads and signs without losing their original bits.
  check(new Float32Array(new Uint32Array([0x7fc00001, 0x7fffffff, 0xffc00001, 0x7f800001, 0xff800001]).buffer))
})

test('indexed half conversion matches the old loop for all 65536 half-float bit patterns', t => {
  t.mock.method(console, 'warn', () => {})
  const data = new Float32Array(65536)
  for (let bits = 0; bits < data.length; bits++) data[bits] = DataUtils.fromHalfFloat(bits)
  check(data)
})

test('indexed half conversion preserves empty, single-element and random offset views', t => {
  t.mock.method(console, 'warn', () => {})
  check(new Float32Array())
  check(new Float32Array([-0]))
  const backing = randomFillSync(new Uint32Array(32768))
  check(new Float32Array(backing.buffer, 28, backing.length - 19))
})
