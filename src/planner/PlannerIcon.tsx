import type { ReactNode } from 'react'
export type PlannerIconName = 'left' | 'right' | 'plus' | 'close' | 'bag' | 'clock' | 'check' | 'calendar' | 'edit' | 'moon' | 'send' | 'undo' | 'lock' | 'sun'
const paths: Record<PlannerIconName, ReactNode> = {
  left: <path d="m14 5-7 7 7 7" />, right: <path d="m10 5 7 7-7 7" />, plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="m6 6 12 12M18 6 6 18" />, bag: <><rect x="5" y="7" width="14" height="14" rx="4" /><path d="M9 7V5a3 3 0 0 1 6 0v2M8 14h8v4H8z" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 6v6l4 2" /></>, check: <path d="m5 12 4 4L19 6" />,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 10h18m-13 4h2m4 0h2" /></>,
  edit: <><path d="m14 5 5 5M4 20l5-1L20 8a2 2 0 0 0-5-5L4 14z" /></>, moon: <path d="M20 15A9 9 0 0 1 9 3a9 9 0 1 0 11 12Z" />,
  send: <path d="m3 11 18-8-8 18-3-7-7-3Zm7 3 11-11" />, undo: <path d="m9 4-5 5 5 5M4 9h9a6 6 0 0 1 0 12h-3" />,
  lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2" /></>,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1 1m12 12 1 1M5 19l1-1M18 6l1-1" /></>,
}
export function PlannerIcon({ name }: { name: PlannerIconName }) {
  return <svg className="pl-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
