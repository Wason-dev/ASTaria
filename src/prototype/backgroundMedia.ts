import type { SceneCamera } from '../spatial/scene'

export type BackgroundMode = 'realtime' | 'video' | 'image'
export type MediaResolution = '4k' | '1080p' | '720p'
export type MediaQuality = 'high' | 'standard'
export const MEDIA_DIMENSIONS = { '4k': [3840, 2160], '1080p': [1920, 1080], '720p': [1280, 720] } as const
export const MEDIA_BITRATES = { '4k': { high: 45, standard: 30 }, '1080p': { high: 20, standard: 12 }, '720p': { high: 10, standard: 6 } } as const

export function backgroundAsset(shape: 'portrait' | 'landscape', night: boolean, resolution: MediaResolution, quality: MediaQuality, kind: 'image' | 'video') {
  return `/backgrounds/${shape}-${night ? 'dark' : 'light'}-${resolution}-${quality}.${kind === 'video' ? 'mp4' : 'webp'}`
}

export const MEDIA_CAMERA_VIEWS = {
  panorama: { zoom: .7, roll: 18, inclination: 83, centerX: .65, centerY: .51 },
  interstellar: { zoom: 2.05, roll: 7, inclination: 84, centerX: .98, centerY: .51 },
} as const

/** Same critically damped camera as the live scene, without a WebGL context or
 * a permanent RAF. The caller schedules frames only while these springs move. */
export class MediaSceneCamera {
  private value = { ...MEDIA_CAMERA_VIEWS.panorama } as { -readonly [K in keyof typeof MEDIA_CAMERA_VIEWS.panorama]: number }
  private velocity = { zoom: 0, roll: 0, inclination: 0, centerX: 0, centerY: 0 }
  private target = { ...this.value }
  private moving = false

  setView(view: keyof typeof MEDIA_CAMERA_VIEWS) {
    this.target = { ...MEDIA_CAMERA_VIEWS[view] }
    this.moving = true
  }

  advance(seconds: number, reduced = false) {
    if (!this.moving) return
    const omega = 3.5, dt = Math.max(0, seconds), decay = Math.exp(-omega * dt)
    this.moving = false
    for (const key of Object.keys(this.value) as (keyof typeof this.value)[]) {
      const tolerance = key === 'zoom' ? .0005 : key === 'centerX' || key === 'centerY' ? .0001 : .01
      const displacement = this.value[key] - this.target[key]
      const term = this.velocity[key] + omega * displacement
      this.value[key] = reduced ? this.target[key] : this.target[key] + (displacement + term * dt) * decay
      this.velocity[key] = reduced ? 0 : (this.velocity[key] - omega * term * dt) * decay
      if (Math.abs(this.value[key] - this.target[key]) <= tolerance && Math.abs(this.velocity[key]) <= tolerance * 4) {
        this.value[key] = this.target[key]; this.velocity[key] = 0
      } else this.moving = true
    }
  }

  snapshot(reducedMotion = false): SceneCamera {
    return { ...this.value, cameraTransition: this.moving, reducedMotion, paused: false, simulationTime: 0 }
  }
}
