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

const displacementCache = new Map<string, string>()

/** The channels of a displacement pixel that leaves the sampled scene in place. */
const NEUTRAL_CHANNEL = 128
const NEUTRAL_ALPHA = 255
/**
 * One neutral pixel packed as RGBA bytes, resolved once for the host byte order
 * so the whole texture can be primed with a single 32-bit typed-array fill.
 */
const NEUTRAL_WORD = (() => {
  const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
  const word = littleEndian
    ? NEUTRAL_CHANNEL | (NEUTRAL_CHANNEL << 8) | (NEUTRAL_CHANNEL << 16) | (NEUTRAL_ALPHA << 24)
    : (NEUTRAL_CHANNEL << 24) | (NEUTRAL_CHANNEL << 16) | (NEUTRAL_CHANNEL << 8) | NEUTRAL_ALPHA
  return word >>> 0
})()

/** Primes every pixel with the neutral displacement, four bytes at a time. */
function fillNeutral(data: Uint8ClampedArray) {
  if ((data.byteOffset & 3) === 0 && (data.byteLength & 3) === 0) {
    new Uint32Array(data.buffer, data.byteOffset, data.byteLength >>> 2).fill(NEUTRAL_WORD)
    return
  }
  for (let i = 0; i < data.length; i += 4) {
    data[i] = NEUTRAL_CHANNEL
    data[i + 1] = NEUTRAL_CHANNEL
    data[i + 2] = NEUTRAL_CHANNEL
    data[i + 3] = NEUTRAL_ALPHA
  }
}

/**
 * The unchanged distance/normal/edge formula, evaluated over the half-open
 * pixel range `[x0, x1) x [y0, y1)`. Where `edge` reaches zero this formula
 * writes exactly the neutral pixel, so skipped pixels keep the neutral fill.
 */
function shadeEdgeBand(
  data: Uint8ClampedArray, w: number, h: number, r: number, band: number,
  x0: number, x1: number, y0: number, y1: number,
) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
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
    data[i] = Math.round(127.5 - nx * edge * edge * 127.5)
    data[i + 1] = Math.round(127.5 - ny * edge * edge * 127.5)
    data[i + 2] = 128
    data[i + 3] = 255
  }
}

/** A static displacement texture for the rounded edge, never reads the scene canvas. */
export function glassDisplacement(width: number, height: number, radius: number) {
  const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height))
  const key = `${w}:${h}:${radius}`
  const cached = displacementCache.get(key)
  if (cached) return cached
  const canvas = document.createElement('canvas')
  canvas.width = w; canvas.height = h
  const context = canvas.getContext('2d')
  if (!context) return ''
  const pixels = context.createImageData(w, h)
  const r = Math.min(radius, w / 2, h / 2)
  const band = Math.min(HOME_GLASS.edgeWidth, h / 2)
  fillNeutral(pixels.data)
  // The formula stays neutral for every sample further than `band` inside the
  // rounded outline, so only a frame of max(r, band) can carry a displacement:
  // rows and columns outside that frame are shaded, its core keeps the fill.
  // The frame is measured on the sample centres px/py, hence the half-pixel of
  // slack that keeps the retained core provably neutral in floating point too.
  const frame = Math.max(r, band)
  if (Number.isFinite(frame) && r >= 0 && band > 0) {
    const top = Math.min(Math.max(Math.ceil(frame), 0), h)
    const bottom = Math.min(Math.max(Math.floor(h - frame), top), h)
    const left = Math.min(Math.max(Math.ceil(frame), 0), w)
    const right = Math.min(Math.max(Math.floor(w - frame), left), w)
    shadeEdgeBand(pixels.data, w, h, r, band, 0, w, 0, top)
    shadeEdgeBand(pixels.data, w, h, r, band, 0, w, bottom, h)
    shadeEdgeBand(pixels.data, w, h, r, band, 0, left, top, bottom)
    shadeEdgeBand(pixels.data, w, h, r, band, right, w, top, bottom)
  } else {
    // A negative or non-finite radius inverts the shape and lights up the whole
    // texture, so that corner keeps the plain per-pixel pass.
    shadeEdgeBand(pixels.data, w, h, r, band, 0, w, 0, h)
  }
  context.putImageData(pixels, 0, 0)
  const map = canvas.toDataURL('image/png')
  displacementCache.set(key, map)
  if (displacementCache.size > 48) displacementCache.delete(displacementCache.keys().next().value!)
  return map
}
