import type { ReactNode, Ref } from 'react'
import './workspace-heading.css'

type Props = {
  title: string
  description?: ReactNode
  children?: ReactNode
  className?: string
  copyClassName?: string
  titleId?: string
  headingRef?: Ref<HTMLHeadingElement>
}

/** Shared page heading; each workspace keeps its own controls and navigation. */
export function WorkspaceHeading({ title, description, children, className = '', copyClassName = '', titleId, headingRef }: Props) {
  return <header className={`workspace-heading ${className}`}>
    <div className={`workspace-heading-copy ${copyClassName}`}>
      <h2 className="workspace-heading-title" id={titleId} ref={headingRef} tabIndex={-1}>{title}</h2>
      {description && <p className="workspace-heading-description">{description}</p>}
    </div>
    {children}
  </header>
}
