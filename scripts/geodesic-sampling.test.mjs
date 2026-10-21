import test from 'node:test'
import assert from 'node:assert/strict'
import * as THREE from 'three'
import {createGeodesicTexture} from '../src/prototype/geodesicSampling.ts'

test('geodesic upload retains distinct Float32 radii that collapse in half precision', () => {
  const data=new Float32Array([.33330,.33331,.33332,.33333,.33334,.33335,.33336,.33337])
  assert(new Set(Array.from(data,THREE.DataUtils.toHalfFloat)).size < data.length)
  const texture=createGeodesicTexture(data,4,2,THREE.RedFormat)
  assert.equal(texture.image.data,data,'upload the original integration data without conversion or another allocation')
  assert.equal(new Set(texture.image.data).size,data.length)
  assert.equal(texture.type,THREE.FloatType)
  assert.equal(texture.internalFormat,'R32F')
  assert.equal(texture.minFilter,THREE.NearestFilter)
  assert.equal(texture.magFilter,THREE.NearestFilter)
  assert.equal(texture.wrapS,THREE.ClampToEdgeWrapping)
  assert.equal(texture.wrapT,THREE.ClampToEdgeWrapping)
  assert.equal(texture.generateMipmaps,false)
  texture.dispose()
})

test('termination data retains all four Float32 channels with the same no-extension sampling contract', () => {
  const data=new Float32Array([1.234567,1,1,.000000003,3.123456,0,3.333333,.000000004])
  const texture=createGeodesicTexture(data,2,1,THREE.RGBAFormat)
  assert.equal(texture.image.data,data)
  assert.equal(texture.internalFormat,'RGBA32F')
  assert.equal(texture.type,THREE.FloatType)
  assert.equal(texture.minFilter,THREE.NearestFilter)
  assert.equal(texture.magFilter,THREE.NearestFilter)
  assert.equal(texture.flipY,false)
  assert.equal(texture.generateMipmaps,false)
  assert.equal(texture.unpackAlignment,1)
  texture.dispose()
})
