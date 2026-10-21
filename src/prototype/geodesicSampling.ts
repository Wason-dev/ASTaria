import * as THREE from 'three'

/** Float32 nearest sampling is core WebGL2. Do not quantize the path table to
 * half floats or depend on optional (sometimes misreported) linear filtering. */
export function createGeodesicTexture(data: Float32Array, width: number, height: number, format: typeof THREE.RedFormat | typeof THREE.RGBAFormat) {
  const texture = new THREE.DataTexture(data, width, height, format, THREE.FloatType)
  texture.internalFormat = format === THREE.RedFormat ? 'R32F' : 'RGBA32F'
  texture.minFilter = THREE.NearestFilter
  texture.magFilter = THREE.NearestFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.unpackAlignment = 1
  texture.needsUpdate = true
  return texture
}

// Match normalized LINEAR + CLAMP_TO_EDGE coordinates, including the half
// texel offset. Highp sampler declarations in the host shader retain Float32
// values before mixing. Hardware interpolation can have different rounding.
export const geodesicSamplingGLSL = /* glsl */ `
float sampleGeodesics(vec2 uv) {
  vec2 p = clamp(uv,vec2(0.0),vec2(1.0))*uLutSize-.5;
  ivec2 base = ivec2(floor(p));
  ivec2 hi = ivec2(uLutSize)-1;
  vec2 f = fract(p);
  float a = texelFetch(uGeodesics,clamp(base,ivec2(0),hi),0).r;
  float b = texelFetch(uGeodesics,clamp(base+ivec2(1,0),ivec2(0),hi),0).r;
  float c = texelFetch(uGeodesics,clamp(base+ivec2(0,1),ivec2(0),hi),0).r;
  float d = texelFetch(uGeodesics,clamp(base+ivec2(1,1),ivec2(0),hi),0).r;
  return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
}

vec4 sampleTermination(float u) {
  float p = clamp(u,0.0,1.0)*uLutSize.x-.5;
  int base = int(floor(p));
  int hi = int(uLutSize.x)-1;
  vec4 a = texelFetch(uTermination,ivec2(clamp(base,0,hi),0),0);
  vec4 b = texelFetch(uTermination,ivec2(clamp(base+1,0,hi),0),0);
  return mix(a,b,fract(p));
}
`
