import { useEffect, useRef, useState } from 'react'
import type { TaskStatus } from '../domain/task'
import { createScene, sceneProjection, STATUS_LABELS } from './scene'
import type { InformationDensity, SceneCamera, SpatialEvent, TaskNode } from './scene'
import { SpatialUI } from './SpatialUI'
import { ReadablePanels } from './ReadablePanels'
import type { PanelState } from './ReadablePanels'
import { useSpatialTasks } from './useSpatialTasks'
import { useSceneCamera } from './useSceneCamera'
import './spatial.css'

type Props = { readCamera: () => SceneCamera | undefined; cameraRevision: string; onOpenPanel: () => void }

export function TaskWorkspace({ readCamera, cameraRevision, onOpenPanel }: Props) {
  const data = useSpatialTasks()
  const camera = useSceneCamera(readCamera, cameraRevision)
  const [density, setDensity] = useState<InformationDensity>('immersive')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [panel, setPanel] = useState<PanelState | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [completion, setCompletion] = useState<TaskNode | null>(null)
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight })
  const root = useRef<HTMLDivElement>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const scene = createScene(data.tasks, camera, density, selectedId)

  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }))
    if (root.current) observer.observe(root.current)
    return () => observer.disconnect()
  }, [])

  const close = (focusTask?: string) => {
    setPanel(null)
    requestAnimationFrame(() => {
      const node = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[data-task-id]') ?? []).find(item => item.dataset.taskId === focusTask)
      const previous = returnFocus.current
      const fallback = root.current?.querySelector<HTMLButtonElement>('.spatial-index-link button')
      ;(node ?? (previous?.isConnected ? previous : fallback))?.focus()
    })
  }
  const open = (next: PanelState) => {
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    onOpenPanel()
    setPanel(next)
  }
  const event = (action: SpatialEvent) => {
    if (action.type === 'density') { setDensity(action.density); return }
    if (action.type === 'select') { setSelectedId(action.id); open({ kind: 'task', id: action.id }); return }
    open({ kind: action.type })
  }
  const create = async (input: { title: string; notes: string }) => {
    const task = await data.create(input)
    setSelectedId(task.id)
    setDensity('work')
    setAnnouncement(`已创建「${task.title}」，待开始，位于外轨。`)
    close(task.id)
  }
  const status = async (id: string, next: TaskStatus) => {
    const node = scene.nodes.find(item => item.id === id)
    const task = await data.setStatus(id, next)
    if (next === 'done' && node && !matchMedia('(prefers-reduced-motion: reduce)').matches) setCompletion(node)
    setAnnouncement(`「${task.title}」已保存为${STATUS_LABELS[next]}。${next === 'done' ? '可在回望中找回。' : ''}`)
  }

  return <div ref={root} className="spatial-workspace">
    <SpatialUI scene={scene} {...size} loading={data.loading} onEvent={event} />
    {data.loadError && <div className="spatial-load-error" data-spatial-ui role="alert"><p>{data.loadError}</p><button onClick={data.retry}>重新读取</button></div>}
    <p className="p0-sr-only" role="status" aria-live="polite">{announcement}</p>
    {completion && <Completion key={completion.id} node={completion} camera={camera} {...size} onFinish={() => setCompletion(null)} />}
    {panel && <ReadablePanels panel={panel} tasks={data.tasks} saving={data.saving} onClose={() => close(panel.kind === 'task' ? panel.id : undefined)}
      onSelect={id => { setSelectedId(id); setPanel({ kind: 'task', id }) }} onCreate={create} onStatus={status} />}
  </div>
}

function Completion({ node, camera, width, height, onFinish }: { node: TaskNode; camera: SceneCamera; width: number; height: number; onFinish: () => void }) {
  const [elapsed, setElapsed] = useState(0)
  const finish = useRef(onFinish)
  finish.current = onFinish
  useEffect(() => {
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const t = (now - start) / 1000
      if (t >= 1.6 || document.hidden || matchMedia('(prefers-reduced-motion: reduce)').matches) { finish.current(); return }
      setElapsed(t)
      frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [])
  const radius = node.radius * (1 + 3.8 * elapsed) * Math.exp(-3.8 * elapsed)
  const point = sceneProjection(camera, width, height).point(radius, node.angle + elapsed + 2.8 * elapsed * elapsed)
  // Fade at the geometric horizon; completed tasks themselves remain in storage.
  return <span aria-hidden="true" className="spatial-completion" style={{ left: point.x, top: point.y, opacity: Math.max(0, Math.min(1, (radius - 2.5) / .5)) }} />
}
