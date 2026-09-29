import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import BlackHolePrototype from './prototype/BlackHolePrototype'
import { RenderErrorBoundary } from './RenderErrorBoundary'
import './index.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root container #root not found')
}

// P0 is the default entry; the existing application remains at #/app.
const Root = window.location.hash === '#/app' ? App : BlackHolePrototype
const macDesktop = import.meta.env.MODE === 'desktop' && navigator.userAgent.includes('Macintosh')

createRoot(container).render(
  <StrictMode>
    <RenderErrorBoundary><Root /></RenderErrorBoundary>
    {macDesktop && <div className="desktop-drag-region" aria-hidden="true" />}
  </StrictMode>,
)
