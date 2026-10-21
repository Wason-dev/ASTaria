import { useRef, useState } from 'react'
import type { Task } from '../../src/domain/task'
import { usePlanner } from '../../src/planner/usePlanner'
import { GlassSamplingContext, MeasuredGlassSurface } from '../../src/home/GlassSurface'
import { TimetableImport } from '../../src/planner/TimetableImport'
import { IcsTimetableImport } from '../../src/planner/IcsTimetableImport'
import { MobileCalendar } from './MobileCalendar'
import type { Preferences } from '../../src/xixi/preferences'
import './mobile-workspaces.css'

/** Recompose the schedule only; original scene/navigation/chat/horizon stay owned by HomeWorkspace. */
export function MobileScheduleWorkspace({ active, tasks, now, preferences, onRefresh, onChat }: { active: boolean; tasks: Task[]; now: Date; preferences: Preferences; onRefresh: () => void; onChat: (text: string) => void }) {
  const planner = usePlanner(active)
  const [importing, setImporting] = useState<'screenshot' | 'ics' | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const root = useRef<HTMLElement>(null)
  const closeImport = () => {
    setImporting(null)
    // The menu that launched import has unmounted; return to its stable entry.
    requestAnimationFrame(() => root.current?.querySelector<HTMLElement>('[aria-label="打开日程菜单"]')?.focus({ preventScroll: true }))
  }
  return <GlassSamplingContext.Provider value={active && !importing}><section ref={root} className="mobile-schedule-workspace" data-active={active} data-modal-open={Boolean(importing) || sheetOpen} data-sheet-open={sheetOpen} aria-hidden={!active} inert={!active}>
    <div className="mobile-schedule-panel" data-import-underlay="" data-import-covered={Boolean(importing)} inert={Boolean(importing)}>
      <MobileCalendar planner={planner} tasks={tasks} now={now} onChat={onChat} onImport={setImporting} onSheetChange={setSheetOpen}
        surface={<GlassSamplingContext.Provider value={active && !importing && !sheetOpen}><MeasuredGlassSurface radius={20} material={{ transmission: preferences.theme === 'light' ? 70 : 25, blur: preferences.glass === 'soft' ? 6 : 0, rim: 40, shadow: 30 }} /></GlassSamplingContext.Provider>} />
    </div>
    {importing === 'screenshot' && <TimetableImport onClose={closeImport} onSaved={() => { void planner.refresh(); onRefresh() }} />}
    {importing === 'ics' && <IcsTimetableImport onClose={closeImport} onSaved={() => { void planner.refresh(); onRefresh() }} />}
  </section></GlassSamplingContext.Provider>
}
