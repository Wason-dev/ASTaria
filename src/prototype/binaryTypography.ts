import * as THREE from 'three'

// One small system-font atlas, with four focal planes. It is created once
// and sampled by the existing black-hole shader without another render pass.
export function createBinaryTypography() {
  const cell = 256
  const canvas = document.createElement('canvas')
  canvas.width = cell * 2
  canvas.height = cell * 4
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建数字字形')
  context.font = '500 224px Menlo, "SF Mono", monospace'
  context.textAlign = 'center'
  context.fillStyle = '#fff'
  for (let row = 0; row < 4; row++) {
    context.filter = row ? `blur(${[0, 1.5, 4.5, 10][row]}px)` : 'none'
    for (let digit = 0; digit < 2; digit++) {
      const metrics = context.measureText(String(digit))
      const baseline = row * cell + cell / 2
        + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2
      context.fillText(String(digit), (digit + .5) * cell, baseline)
    }
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.minFilter = THREE.LinearMipmapLinearFilter
  texture.magFilter = THREE.LinearFilter
  texture.generateMipmaps = true
  texture.colorSpace = THREE.NoColorSpace
  return texture
}
