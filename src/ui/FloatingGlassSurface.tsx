import { MeasuredGlassSurface } from '../home/GlassSurface'
import type { GlassMaterial } from '../home/GlassSurface'
import './floating-glass.css'

/** One optical plane and one inset outline for every floating shell. */
export function FloatingGlassSurface({ material, radius }: { material: GlassMaterial; radius: number }) {
  return <>
    <MeasuredGlassSurface radius={radius} material={{ ...material, rim: 0 }} />
    <span className="floating-glass-outline" aria-hidden="true" />
  </>
}
