export const STRING_STYLES = [
  { id: 'ribbon', name: '绸光', description: '流动的金色绸带', number: '01' },
  { id: 'filament', name: '复弦', description: '交织的立体丝束', number: '02' },
  { id: 'current', name: '光河', description: '连续涌动的微光', number: '03' },
  { id: 'orbit', name: '引力轨', description: '向深处弯曲的弧线', number: '04' },
] as const

export type StringStyle = typeof STRING_STYLES[number]['id']
const STORAGE_KEY = 'astaria.string-style.v1'
export function readStringStyle(): StringStyle {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return STRING_STYLES.find(style => style.id === saved)?.id ?? 'ribbon'
  } catch { return 'ribbon' }
}
export function saveStringStyle(style: StringStyle) {
  try { localStorage.setItem(STORAGE_KEY, style) } catch { /* The preview still works without persistence. */ }
}

/** Shared anchors keep task names and drag targets on the rendered strands. */
export function stringRowY(height: number, row: number) {
  return height * (row === 0 ? .37 : .65)
}
