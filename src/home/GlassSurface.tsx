import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { glassDisplacement, HOME_GLASS } from './glass'

export type GlassMaterial = { transmission: number; blur: number; rim: number; shadow: number }
type Props = { width: number; height: number; radius: number; progress?: number; material?: GlassMaterial }

export function MeasuredGlassSurface({ radius, progress = 0, material }: Pick<Props, 'radius' | 'progress' | 'material'>) {
  const host = useRef<HTMLSpanElement>(null)
  const [size, setSize] = useState({ width: 1, height: 1 })
  useEffect(() => {
    const element = host.current
    if (!element) return
    const measure = () => {
      const box = element.getBoundingClientRect()
      const next = { width: Math.max(1, Math.round(box.width)), height: Math.max(1, Math.round(box.height)) }
      setSize(current => current.width === next.width && current.height === next.height ? current : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  return <span ref={host} className="home-glass-measure" aria-hidden="true">
    <GlassSurface width={size.width} height={size.height} radius={radius} progress={progress} material={material} />
  </span>
}

/** Optics belong to the UI layer; P0's render targets and shaders stay independent. */
export function GlassSurface({ width, height, radius, progress = 0, material }: Props) {
  const id = `home-glass-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  const image = useRef<SVGFEImageElement>(null)
  const [ready, setReady] = useState(false)
  // Chromium composites SVG backdrop filters over the existing WebGL canvas.
  // Other engines keep the same transparent material with a 2px blur fallback.
  const svgBackdrop = /Chrome|Chromium|Edg\//.test(navigator.userAgent)
  useEffect(() => {
    if (!svgBackdrop) return
    const map = glassDisplacement(width, height, radius)
    image.current?.setAttribute('href', map)
    setReady(Boolean(map))
  }, [width, height, radius, svgBackdrop])
  const transmission = material?.transmission ?? HOME_GLASS.pillTransmission + (HOME_GLASS.chatTransmission - HOME_GLASS.pillTransmission) * progress
  const blur = material?.blur ?? HOME_GLASS.blur
  const style = {
    '--glass-tint': 1 - transmission / 100,
    '--glass-rim': (material?.rim ?? HOME_GLASS.rim) / 100,
    '--glass-reflection': HOME_GLASS.reflection / 100,
    '--glass-shadow': (material?.shadow ?? HOME_GLASS.shadow) / 100,
    backdropFilter: ready ? `url("#${id}")` : `blur(${blur}px)`,
    WebkitBackdropFilter: ready ? `url("#${id}")` : `blur(${blur}px)`,
  } as CSSProperties
  return <>
    <svg className="home-glass-definitions" aria-hidden="true" width={width} height={height}>
      <defs><filter id={id} x="0" y="0" width={width} height={height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={blur} result="soft" />
        <feImage ref={image} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result="edge" />
        <feDisplacementMap in="soft" in2="edge" scale={HOME_GLASS.refraction * 2} xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>
    <span className="home-glass-surface" style={style} aria-hidden="true" />
  </>
}
