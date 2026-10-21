import type { ReactNode } from 'react'
import { FloatingGlassDialog } from '../ui/FloatingGlassDialog'

export function ContextUsagePanel({ anchor, id, onClose, children }: { anchor: HTMLButtonElement; id: string; onClose: () => void; children: ReactNode }) {
  return <FloatingGlassDialog anchor={anchor} id={id} title="上下文" label="上下文用量" className="xixi-context-dialog" contentClassName="xixi-context-content" onClose={onClose}>{children}</FloatingGlassDialog>
}
