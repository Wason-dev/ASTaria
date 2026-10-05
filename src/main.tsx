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
const nativeDesktop = import.meta.env.MODE === 'desktop' && /Macintosh|Windows/.test(navigator.userAgent)

createRoot(container).render(
  <StrictMode>
    <RenderErrorBoundary><Root /></RenderErrorBoundary>
    {nativeDesktop && <div className="desktop-drag-region" data-platform={navigator.userAgent.includes('Windows') ? 'windows' : 'mac'} aria-hidden="true" />}
  </StrictMode>,
)
