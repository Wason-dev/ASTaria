import type { Task, TaskStatus } from '../domain/task'

export type InformationDensity = 'immersive' | 'work' | 'analysis'
export type SceneCamera = {
  zoom: number; roll: number; inclination: number; centerX: number; centerY: number
  cameraTransition: boolean; reducedMotion: boolean; paused: boolean; simulationTime: number
}
export type TaskNode = {
  id: string; title: string; status: 'todo' | 'doing'; radius: number; angle: number; due?: string
}
export type BlackHoleSceneState = {
  camera: SceneCamera
  time: number
  nodes: TaskNode[]
  selectedId: string | null
  density: InformationDensity
  activeCount: number
  completedCount: number
}
export type SpatialEvent =
  | { type: 'create' }
  | { type: 'select'; id: string }
  | { type: 'density'; density: InformationDensity }
  | { type: 'index' }
  | { type: 'history' }

export const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待开始', doing: '进行中', done: '已完成', dropped: '已搁置',
}
export const ORBIT_RADII = { todo: 4.6, doing: 3.6 } as const
const SLOTS = [130, 230, 165, 200, 100, 260]

/** A readable spatial index in the image plane, not a physical orbit simulation. */
export function createScene(tasks: Task[], camera: SceneCamera, density: InformationDensity, selectedId: string | null): BlackHoleSceneState {
  const living = tasks.filter(task => !task.deletedAt)
  const nodes: TaskNode[] = []
  for (const status of ['todo', 'doing'] as const) {
    const group = living.filter(task => task.status === status).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    const visible = group.slice(0, SLOTS.length)
    const selected = group.find(task => task.id === selectedId)
    if (selected && !visible.includes(selected)) visible[visible.length - 1] = selected
    visible.forEach((task, index) => nodes.push({
      id: task.id, title: task.title, status, radius: ORBIT_RADII[status],
      angle: SLOTS[index] * Math.PI / 180, due: task.due,
    }))
  }
  return {
    camera, time: camera.simulationTime, nodes, density, selectedId,
    activeCount: living.filter(task => task.status === 'todo' || task.status === 'doing').length,
    completedCount: living.filter(task => task.status === 'done').length,
  }
}

/** Inverse of the frozen P0 image-plane mapping; uses CSS pixels, never DPR. */
export function sceneProjection(camera: SceneCamera, width: number, height: number) {
  const mobile = width / height < .8
  const cx = (mobile ? .5 + (camera.centerX - .5) * .2 : camera.centerX) * width
  const cy = (1 - (mobile ? .5 + (camera.centerY - .5) * 6 : camera.centerY)) * height
  const unit = height * camera.zoom / (mobile ? 13.8 : 10.2)
  const roll = camera.roll * Math.PI / 180
  return {
    cx, cy, unit,
    point: (radius: number, angle: number) => ({
      x: cx + Math.cos(angle + roll) * radius * unit,
      y: cy - Math.sin(angle + roll) * radius * unit,
    }),
  }
}

export function readableDate(value?: string) {
  if (!value) return '未设截止时间'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '截止时间待确认' : new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date)
}
