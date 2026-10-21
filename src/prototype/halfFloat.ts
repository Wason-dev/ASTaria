import { DataUtils } from 'three'

export function toHalfFloatArray(data: Float32Array): Uint16Array {
  const pixels = new Uint16Array(data.length)
  for (let index = 0; index < data.length; index++) pixels[index] = DataUtils.toHalfFloat(data[index])
  return pixels
}
