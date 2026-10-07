import type { SceneCamera } from '../spatial/scene'

export const CHAT_READY_PROGRESS = .99
export const CHAT_COLLAPSED_PROGRESS = .01

export function chatCameraProgress(camera: Pick<SceneCamera, 'zoom'>): number {
  return Math.max(0, Math.min(1, (camera.zoom - .7) / (2.05 - .7)))
}

/** Publish interaction boundaries without re-rendering the tree every frame. */
export function chatInteractionPhase(camera: SceneCamera): number {
  const progress = chatCameraProgress(camera)
  return progress >= CHAT_READY_PROGRESS ? 2 : progress <= CHAT_COLLAPSED_PROGRESS ? 0 : 1
}
