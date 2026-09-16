/** User-selected material, in CSS pixels and percent. Shared by both morph endpoints. */
export const HOME_GLASS = Object.freeze({
  pillTransmission: 80,
  chatTransmission: 80,
  blur: 2,
  refraction: 14,
  edgeWidth: 16,
  rim: 15,
  reflection: 0,
  shadow: 60,
})

/** A static displacement texture for the rounded edge, never reads the scene canvas. */
export function glassDisplacement(width: number, height: number, radius: number) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return ''
  const pixels = context.createImageData(w, h)
  const r = Math.min(radius, w / 2, h / 2)
  const band = Math.min(HOME_GLASS.edgeWidth, h / 2)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + .5 - w / 2, py = y + .5 - h / 2
    const qx = Math.abs(px) - (w / 2 - r), qy = Math.abs(py) - (h / 2 - r)
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0), length = Math.hypot(ax, ay)
    const distance = length + Math.min(Math.max(qx, qy), 0) - r
    const edge = Math.max(0, 1 - Math.max(0, -distance) / band)
    let nx = 0, ny = 0
    if (length > 0) { nx = ax / length * Math.sign(px); ny = ay / length * Math.sign(py) }
    else if (qx > qy) nx = Math.sign(px)
    else ny = Math.sign(py)
    const i = (y * w + x) * 4
    pixels.data[i] = Math.round(127.5 - nx * edge * edge * 127.5)
    pixels.data[i + 1] = Math.round(127.5 - ny * edge * edge * 127.5)
    pixels.data[i + 2] = 128
    pixels.data[i + 3] = 255
  }
  context.putImageData(pixels, 0, 0)
  return canvas.toDataURL('image/png')
}
