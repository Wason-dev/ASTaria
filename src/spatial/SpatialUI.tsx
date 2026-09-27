import type { BlackHoleSceneState, SpatialEvent } from './scene'
import { ORBIT_RADII, readableDate, sceneProjection, STATUS_LABELS } from './scene'

type Props = {
  scene: BlackHoleSceneState
  width: number
  height: number
  loading: boolean
  onEvent: (event: SpatialEvent) => void
}

export function SpatialUI({ scene, width, height, loading, onEvent }: Props) {
  const projection = sceneProjection(scene.camera, width, height)
  const occupied: Array<{ x: number; y: number }> = []
  const visible = scene.nodes.flatMap(node => {
    const point = projection.point(node.radius, node.angle)
    if (point.x < 25 || point.x > width - 25 || point.y < 145 || point.y > height - 155) return []
    if (occupied.some(other => Math.hypot(point.x - other.x, point.y - other.y) < 48)) return []
    occupied.push(point)
    return [{ node, ...point }]
  })
  const orbit = (radius: number) => Array.from({ length: 65 }, (_, index) => {
    const point = projection.point(radius, (100 + index * 160 / 64) * Math.PI / 180)
    return `${point.x},${point.y}`
  }).join(' ')

  return <div className="spatial-ui" data-spatial-ui data-density={scene.density}>
    <nav className="spatial-density" aria-label="信息密度">
      {([['immersive', '沉浸'], ['work', '工作'], ['analysis', '分析']] as const).map(([density, label]) =>
        <button key={density} aria-pressed={scene.density === density} onClick={() => onEvent({ type: 'density', density })}>{label}</button>)}
    </nav>
    <div className="spatial-index-link">
      <button onClick={() => onEvent({ type: 'index' })} disabled={loading}>星图索引 <span>{loading ? '读取中' : `${scene.activeCount} 在轨`}</span></button>
      {scene.density !== 'immersive' && <p>{scene.activeCount === 0 ? '投放一粒星辰，让一件事进入轨道。' : `当前可见 ${visible.length} / ${scene.activeCount} · 全部任务可从索引打开`}</p>}
      {scene.density === 'analysis' && <p className="spatial-legend">外轨 · 待开始　内轨 · 进行中<br/>完成后进入回望，保留时间记录。</p>}
    </div>
    {scene.activeCount > 0 && <svg className="spatial-orbits" width={width} height={height} aria-hidden="true">
      <polyline points={orbit(ORBIT_RADII.todo)} />
      <polyline points={orbit(ORBIT_RADII.doing)} />
    </svg>}
    <div className="spatial-nodes" role="group" aria-label="轨道上的任务">
      {visible.map(({ node, x, y }) => <button key={node.id} className="spatial-node" data-task-id={node.id} data-status={node.status}
        data-selected={node.id === scene.selectedId} data-label-side={x < 220 ? 'right' : 'left'}
        style={{ left: x, top: y }} aria-label={`${node.title}，${STATUS_LABELS[node.status]}，${node.status === 'doing' ? '内轨' : '外轨'}，打开详情`}
        onClick={() => onEvent({ type: 'select', id: node.id })}>
        <span className="spatial-star" aria-hidden="true" />
        <span className="spatial-node-label" aria-hidden="true"><strong>{node.title}</strong>
          <small>{STATUS_LABELS[node.status]}{scene.density === 'analysis' ? ` · ${readableDate(node.due)}` : ''}</small>
        </span>
      </button>)}
    </div>
    {scene.completedCount > 0 && <button className="spatial-memory" style={{ left: Math.max(60, Math.min(width - 60, projection.cx)), top: projection.cy }} onClick={() => onEvent({ type: 'history' })}>
      回望 <span>{scene.completedCount}</span>
    </button>}
    <button className="spatial-launch" onClick={() => onEvent({ type: 'create' })} disabled={loading} aria-haspopup="dialog">
      <span aria-hidden="true">✧</span> 投放一粒星辰 <small>创建任务</small>
    </button>
  </div>
}
