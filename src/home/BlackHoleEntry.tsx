import type { CSSProperties } from 'react'
import type { SceneCamera } from '../spatial/scene'
import { blackHoleEntryGeometry } from './blackHoleEntryGeometry'

type Props = {
  camera: SceneCamera
  width: number
  height: number
  visible: boolean
  onEnter: () => void
}

/**
 * A small, transparent hit target for the rendered shadow.  The WebGL scene
 * owns the pixels, so this control only tracks the same frozen camera mapping
 * and never paints a second black-hole surface over it.
 */
export function BlackHoleEntry({ camera, width, height, visible, onEnter }: Props) {
  const { cx, cy, radius } = blackHoleEntryGeometry(camera, width, height)
  const size = radius * 2
  const style = {
    left: cx - radius,
    top: cy - radius,
    width: size,
    height: size,
  } satisfies CSSProperties

  return <button
    type="button"
    className="home-black-hole-entry"
    style={style}
    aria-label="进入弦轨"
    aria-hidden={!visible}
    data-visible={visible}
    tabIndex={visible ? 0 : -1}
    onPointerDown={event => { event.stopPropagation(); event.currentTarget.focus({ preventScroll: true }) }}
    onClick={event => { event.stopPropagation(); if (visible) onEnter() }}
  />
}
