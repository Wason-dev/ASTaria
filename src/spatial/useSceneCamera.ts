import { useEffect, useRef, useState } from 'react'
import type { SceneCamera } from './scene'

const INITIAL_CAMERA: SceneCamera = {
  zoom: .7, roll: 18, inclination: 83, centerX: .65, centerY: .51,
  cameraTransition: false, reducedMotion: false, paused: false, simulationTime: 0,
}

/** Sample only during camera changes. Business changes never drive the renderer. */
export function useSceneCamera(readCamera: () => SceneCamera | undefined, revision: string, onFrame?: (camera: SceneCamera) => void) {
  const [camera, setCamera] = useState(INITIAL_CAMERA)
  const frameCallback = useRef(onFrame)
  frameCallback.current = onFrame
  useEffect(() => {
    let frame = 0
    let published: SceneCamera | undefined
    const sample = () => {
      frame = 0
      if (document.hidden) return
      const next = readCamera()
      if (!next) return
      frameCallback.current?.(next)
      // Imperative motion consumers need React only at transition boundaries.
      // The simulation clock belongs to WebGL, not to the application tree.
      if (!(frameCallback.current && next.cameraTransition && published?.cameraTransition)) {
        published = next
        setCamera(current => (Object.keys(INITIAL_CAMERA) as (keyof SceneCamera)[]).every(key => key === 'simulationTime' || current[key] === next[key]) ? current : next)
      }
      if (next.cameraTransition) frame = requestAnimationFrame(sample)
    }
    const refresh = () => {
      cancelAnimationFrame(frame)
      frame = document.hidden ? 0 : requestAnimationFrame(sample)
    }
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    document.addEventListener('visibilitychange', refresh)
    window.addEventListener('focus', refresh)
    motion.addEventListener('change', refresh)
    frame = requestAnimationFrame(sample)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', refresh)
      window.removeEventListener('focus', refresh)
      motion.removeEventListener('change', refresh)
    }
  }, [readCamera, revision])
  return camera
}
