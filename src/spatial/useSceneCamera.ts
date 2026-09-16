import { useEffect, useState } from 'react'
import type { SceneCamera } from './scene'

const INITIAL_CAMERA: SceneCamera = {
  zoom: .7, roll: 18, inclination: 83, centerX: .65, centerY: .51,
  cameraTransition: false, reducedMotion: false, paused: false, simulationTime: 0,
}

/** Sample only during camera changes. Business changes never drive the renderer. */
export function useSceneCamera(readCamera: () => SceneCamera | undefined, revision: string) {
  const [camera, setCamera] = useState(INITIAL_CAMERA)
  useEffect(() => {
    let frame = 0
    const sample = () => {
      frame = 0
      if (document.hidden) return
      const next = readCamera()
      if (!next) return
      setCamera(next)
      if (next.cameraTransition) frame = requestAnimationFrame(sample)
    }
    const refresh = () => {
      cancelAnimationFrame(frame)
      frame = document.hidden ? 0 : requestAnimationFrame(sample)
    }
    const motion = matchMedia('(prefers-reduced-motion: reduce)')
    document.addEventListener('visibilitychange', refresh)
    motion.addEventListener('change', refresh)
    frame = requestAnimationFrame(sample)
    return () => {
      cancelAnimationFrame(frame)
      document.removeEventListener('visibilitychange', refresh)
      motion.removeEventListener('change', refresh)
    }
  }, [readCamera, revision])
  return camera
}
