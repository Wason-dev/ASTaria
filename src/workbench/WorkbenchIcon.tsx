import type { ReactNode } from 'react'

export type WorkbenchIconName = 'calendar' | 'hourglass' | 'timer' | 'book' | 'info' | 'settings' | 'back' | 'chevron' | 'check' | 'arrow' | 'undo' | 'xixi'

const paths: Record<WorkbenchIconName, ReactNode> = {
  calendar: <><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M7 3v4m10-4v4M3 10h18m-13 4h2m4 0h2m-8 3h2" /></>,
  hourglass: <><path d="M6 3h12M6 21h12M7 3v4c0 3 3 4 5 5-2 1-5 2-5 5v4m10-18v4c0 3-3 4-5 5 2 1 5 2 5 5v4" /><path d="M9 18h6" /></>,
  timer: <><circle cx="12" cy="14" r="8" /><path d="M12 6V3m-3 0h6m4 5 2-2m-9 4v5l3 2" /></>,
  book: <><path d="M12 6C9 4 5 4 3 5v15c3-1 6-1 9 1 3-2 6-2 9-1V5c-2-1-6-1-9 1v15" /></>,
  info: <><path d="M4 5h16M4 12h16M4 19h16M8 3v4m8 3v4m-6 3v4" /></>,
  settings: <><path d="M3 6h4m4 0h10M3 12h10m4 0h4M3 18h4m4 0h10" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
  back: <path d="m10 5-7 7 7 7M3 12h18" />,
  undo: <path d="m9 4-5 5 5 5M4 9h9a6 6 0 0 1 0 12h-3" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  check: <path d="m5 12 4 4L19 6" />,
  arrow: <path d="M6 18 18 6M7 6h11v11" />,
  xixi: <><ellipse cx="12" cy="12" rx="10" ry="5.5" transform="rotate(-32 12 12)" /><circle cx="12" cy="12" r="3.5" /><circle cx="20" cy="6.5" r="1.5" /></>,
}

export function WorkbenchIcon({ name, className = '' }: { name: WorkbenchIconName; className?: string }) {
  return <svg className={`wb-icon ${className}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>
}
