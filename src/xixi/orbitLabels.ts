type Point = { x: number; y: number }

/** Separate persistent names without moving their orbit anchors. */
export function orbitLabelPositions(anchors: ReadonlyMap<string, Point>, width: number, height: number, options: { labelWidth?: number; labelHeight?: number; aboveOnly?: boolean } = {}) {
  const labelWidth = options.labelWidth ?? (width < 650 ? 120 : 158), labelHeight = options.labelHeight ?? 34, margin = 14
  const minY = Math.min(150, height * .22), maxY = Math.max(minY, height - 116)
  const result = new Map<string, Point>()
  const boxes: Array<{ x: number; y: number }> = []
  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
  // Stable angular/model order avoids labels swapping lanes as the material flows.
  for (const [id, point] of anchors) {
    const x = clamp(point.x, margin + labelWidth / 2, Math.max(margin + labelWidth / 2, width - margin - labelWidth / 2))
    const preferred = clamp(point.y + 29, minY, maxY)
    const candidates: Point[] = []
    for (let row = 0; row < 14; row++) for (const shift of [0, -1, 1, -2, 2]) {
      const candidateX = clamp(x + shift * (labelWidth + 12), margin + labelWidth / 2, Math.max(margin + labelWidth / 2, width - margin - labelWidth / 2))
      const candidateY = clamp(preferred + (options.aboveOnly ? -row : (row % 2 ? -1 : 1) * Math.ceil(row / 2)) * (labelHeight + 7), minY, maxY)
      candidates.push({ x: candidateX, y: candidateY })
    }
    candidates.sort((a, b) => Math.hypot(a.x - x, (a.y - preferred) * 1.4) - Math.hypot(b.x - x, (b.y - preferred) * 1.4))
    const chosen = candidates.find(candidate => !boxes.some(box => Math.abs(box.x - candidate.x) < labelWidth + 6 && Math.abs(box.y - candidate.y) < labelHeight + 5))
    if (!chosen) {
      // Crowded/very flat custom projections get a compact, complete label grid.
      // Assign nearby anchors to separate cells rather than silently overlap names.
      const columns = Math.max(1, Math.floor((width - 2 * margin) / (labelWidth + 8)))
      const rows = Math.ceil(anchors.size / columns), cells: Point[] = []
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) cells.push({
        x: (width - columns * (labelWidth + 8)) / 2 + column * (labelWidth + 8) + (labelWidth + 8) / 2,
        y: minY + (rows === 1 ? 0 : row * Math.max(labelHeight + 5, (maxY - minY) / (rows - 1))),
      })
      result.clear()
      for (const [anchorId, anchor] of anchors) {
        cells.sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y))
        result.set(anchorId, cells.shift()!)
      }
      return result
    }
    boxes.push(chosen); result.set(id, chosen)
  }
  return result
}
