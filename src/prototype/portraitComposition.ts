/** Offset in visible viewport fractions. The portrait shader compresses its
 * raw centerX by .34, so convert once before sharing the camera with all layers. */
export function portraitCameraOffset(width: number, height: number, zoom: number) {
  if (!(width > 0 && height > 0) || width / height >= .8) return 0
  const expanded = Math.max(0, Math.min(1, (zoom - .7) / 1.35))
  return (.27 + .42 * expanded) / .34
}
