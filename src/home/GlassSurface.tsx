import { useEffect, useId, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { glassDisplacement, HOME_GLASS } from './glass'

type Props = { width: number; height: number; radius: number; progress?: number }

export function MeasuredGlassSurface({ radius, progress = 0 }: Pick<Props, 'radius' | 'progress'>) {
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
    <GlassSurface width={size.width} height={size.height} radius={radius} progress={progress} />
  </span>
}

/** Optics belong to the UI layer; P0's render targets and shaders stay independent. */
export function GlassSurface({ width, height, radius, progress = 0 }: Props) {
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
  const transmission = HOME_GLASS.pillTransmission + (HOME_GLASS.chatTransmission - HOME_GLASS.pillTransmission) * progress
  const style = {
    '--glass-tint': 1 - transmission / 100,
    '--glass-rim': HOME_GLASS.rim / 100,
    '--glass-reflection': HOME_GLASS.reflection / 100,
    '--glass-shadow': HOME_GLASS.shadow / 100,
    backdropFilter: ready ? `url("#${id}")` : `blur(${HOME_GLASS.blur}px)`,
    WebkitBackdropFilter: ready ? `url("#${id}")` : `blur(${HOME_GLASS.blur}px)`,
  } as CSSProperties
  return <>
    <svg className="home-glass-definitions" aria-hidden="true" width={width} height={height}>
      <defs><filter id={id} x="0" y="0" width={width} height={height} filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" colorInterpolationFilters="sRGB">
        <feGaussianBlur in="SourceGraphic" stdDeviation={HOME_GLASS.blur} result="soft" />
        <feImage ref={image} x="0" y="0" width={width} height={height} preserveAspectRatio="none" result="edge" />
        <feDisplacementMap in="soft" in2="edge" scale={HOME_GLASS.refraction * 2} xChannelSelector="R" yChannelSelector="G" />
      </filter></defs>
    </svg>
    <span className="home-glass-surface" style={style} aria-hidden="true" />
  </>
}
