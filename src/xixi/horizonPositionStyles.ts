import { horizonPoint } from './horizonScene'
import type { HorizonPoint, HorizonProjection } from './horizonScene'

type PositionProperty = 'visibility' | 'transform' | 'opacity' | 'width' | 'height'
type StyleTarget = { element: HTMLElement; values: Partial<Record<PositionProperty, string>> }
type ButtonStyles = { button: StyleTarget; caption?: StyleTarget | null; tether?: StyleTarget | null }
type ButtonRef = (button: HTMLButtonElement | null) => void | (() => void)

const target = (element: HTMLElement): StyleTarget => ({ element, values: {} })
const write = (target: StyleTarget, property: PositionProperty, value: string) => {
  if (target.values[property] === value) return
  target.element.style[property] = value
  target.values[property] = value
}

/** Cache only DOM targets and submitted strings; geometry and drag state stay live. */
export function createHorizonPositionStyles(buttons: Map<string, HTMLButtonElement>) {
  const styles = new WeakMap<HTMLButtonElement, ButtonStyles>()
  const refs = new Map<string, ButtonRef>()
  const dialogs = new WeakMap<HTMLElement, { browse: string; progress: string }>()

  const buttonRef = (id: string): ButtonRef => {
    const existing = refs.get(id)
    if (existing) return existing
    const ref: ButtonRef = button => {
      const previous = buttons.get(id)
      if (previous && previous !== button) styles.delete(previous)
      if (!button) { buttons.delete(id); refs.delete(id); return }
      buttons.set(id, button); refs.set(id, ref)
      // React 19 cleans up the exact node. A late cleanup must not detach its replacement.
      return () => {
        styles.delete(button)
        if (buttons.get(id) !== button) return
        buttons.delete(id); refs.delete(id)
      }
    }
    refs.set(id, ref)
    return ref
  }

  const update = (dialog: HTMLElement | null, next: ReadonlyMap<string, HorizonPoint>, projection: HorizonProjection, heldId?: string) => {
    const browseY = Math.min((projection.apexY + projection.height) / 2, projection.height - 180)
    const browse = `${Math.round(browseY)}px`
    const progressEdge = .5 - Math.min(540, projection.width - 48) / projection.width / 2
    const progressCeiling = horizonPoint(projection, progressEdge).y + 20
    const progress = `${Math.max(100, Math.min(180, projection.height - 102 - progressCeiling))}px`
    if (dialog) {
      const previous = dialogs.get(dialog)
      if (previous?.browse !== browse) dialog.style.setProperty('--horizon-browse-y', browse)
      if (previous?.progress !== progress) dialog.style.setProperty('--horizon-progress-height', progress)
      if (previous?.browse !== browse || previous?.progress !== progress) dialogs.set(dialog, { browse, progress })
    }
    const labelWidth = Math.min(158, Math.max(100, projection.width * .68 / Math.max(1, next.size) - 18))
    const held = heldId ? next.get(heldId) : undefined
    for (const [id, button] of buttons) {
      let cached = styles.get(button)
      if (!cached) {
        cached = { button: target(button) }
        styles.set(button, cached)
      }
      const p = next.get(id)
      if (!p) { write(cached.button, 'visibility', 'hidden'); continue }
      // Paging leaves room for every name. Keep each one tethered to its
      // strand during a swap instead of collision detection moving it up
      // an entire row. Neighbours quietly yield to the lifted strand.
      const name = { x: Math.max(labelWidth / 2 + 14, Math.min(projection.width - labelWidth / 2 - 14, p.x)), y: p.y - 76 }
      write(cached.button, 'visibility', 'visible')
      write(cached.button, 'transform', `translate3d(${p.x - 40}px,${p.y - 24}px,0)`)
      // Query once per mounted button, including absent children.
      if (cached.caption === undefined) {
        const caption = button.querySelector<HTMLElement>('.orbit-group-caption')
        const tether = button.querySelector<HTMLElement>('.orbit-group-tether')
        cached.caption = caption ? target(caption) : null
        cached.tether = tether ? target(tether) : null
      }
      if (cached.caption) {
        const distance = held && heldId !== id ? Math.hypot((p.x - held.x) / (labelWidth + 20), (p.y - held.y) / 70) : 1
        const separation = Math.min(1, distance)
        write(cached.caption, 'opacity', String(.18 + .82 * separation * separation * (3 - 2 * separation)))
        write(cached.caption, 'width', `${labelWidth}px`)
        write(cached.caption, 'transform', `translate3d(${name.x - p.x}px,${name.y - p.y}px,0) translateX(-50%)`)
      }
      if (cached.tether) {
        const dx = name.x - p.x, dy = name.y - p.y + 29
        write(cached.tether, 'height', `${Math.max(0, Math.hypot(dx, dy) - 13)}px`)
        write(cached.tether, 'transform', `rotate(${-Math.atan2(dx, dy)}rad)`)
      }
    }
  }
  return { buttonRef, update }
}
