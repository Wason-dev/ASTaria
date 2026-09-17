import { useEffect, useState } from 'react'

export const DEFAULT_APPEARANCE = {
  columns: 2, width: 900, font: 12, row: 96, gap: 8, top: 108,
  transmission: 80, blur: 0, radius: 24, rim: 0, shadow: 11, background: 15,
  progress: true, metadata: true, completed: true,
}
export type Appearance = typeof DEFAULT_APPEARANCE
export const ADJUSTMENTS = [
  ['width', '内容宽度', 660, 1100, 20, 'px'], ['font', '字号', 11, 16, 1, 'px'],
  ['row', '事项高度', 80, 128, 4, 'px'], ['gap', '间距', 4, 24, 2, 'px'],
  ['top', '位置', 88, 200, 4, 'px'], ['transmission', '通透度', 40, 100, 1, '%'],
  ['blur', '磨砂', 0, 16, 1, 'px'], ['radius', '圆角', 8, 32, 1, 'px'],
  ['rim', '边缘亮度', 0, 50, 1, '%'], ['shadow', '阴影', 0, 60, 1, '%'],
  ['background', '背景', 0, 50, 1, '%'],
] as const
const STORAGE_KEY = 'astaria-workbench-appearance-v1'

export function useAppearance() {
  const [value, setValue] = useState<Appearance>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')
      const next = { ...DEFAULT_APPEARANCE }
      if (!saved || typeof saved !== 'object') return next
      const record = saved as Record<string, unknown>
      for (const [key, , min, max] of ADJUSTMENTS) {
        const n = record[key]
        if (typeof n === 'number' && Number.isFinite(n)) next[key] = Math.max(min, Math.min(max, n))
      }
      if (record.columns === 1 || record.columns === 2) next.columns = record.columns
      for (const key of ['progress', 'metadata', 'completed'] as const) if (typeof record[key] === 'boolean') next[key] = record[key]
      return next
    } catch { return { ...DEFAULT_APPEARANCE } }
  })
  const [warning, setWarning] = useState('')
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); setWarning('') }
    catch { setWarning('参数暂未保存，可以复制后保留') }
  }, [value])
  return { value, setValue, warning }
}

export function appearanceSummary(value: Appearance) {
  return `排列 ${value.columns === 2 ? '双列' : '单列'} · 内容宽度 ${value.width}px · 字号 ${value.font}px · 事项高度 ${value.row}px · 间距 ${value.gap}px · 位置 ${value.top}px\n通透度 ${value.transmission}% · 磨砂 ${value.blur}px · 圆角 ${value.radius}px · 边缘亮度 ${value.rim}% · 阴影 ${value.shadow}% · 背景 ${value.background}%\n进度 ${value.progress ? '显示' : '隐藏'} · 时间与分类 ${value.metadata ? '显示' : '隐藏'} · 已完成 ${value.completed ? '保留' : '隐藏'}`
}
