import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RenderErrorBoundary } from './RenderErrorBoundary'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root container #root not found')
}

const nativeDesktop = import.meta.env.MODE === 'desktop' && /Macintosh|Windows/.test(navigator.userAgent)

async function start() {
  let Root
  if (import.meta.env.MODE === 'mobile') {
    // Mobile shares the durable service and ASTaria visual components.
    // Phone composition and IME geometry are adapted within those components.
    const { startMobileRuntime } = await import('../mobile/runtime/bootstrap')
    await startMobileRuntime()
    // Preserve ASTaria's actual navigation, typography, scene transitions and
    // horizon. Mobile changes composition inside these shared components.
    await import('./index.css')
    Root = (await import('./prototype/BlackHolePrototype')).default
  } else {
    await import('./index.css')
    Root = window.location.hash === '#/app' ? (await import('./App')).default : (await import('./prototype/BlackHolePrototype')).default
    if (import.meta.env.MODE === 'desktop' && window.location.hash !== '#/app') {
      const { prepareSceneGeodesics } = await import('./prototype/geodesicLoader')
      void prepareSceneGeodesics().catch(() => {})
    }
  }
  createRoot(container!).render(
  <StrictMode>
    <RenderErrorBoundary><Root /></RenderErrorBoundary>
    {nativeDesktop && <div className="desktop-drag-region" data-platform={navigator.userAgent.includes('Windows') ? 'windows' : 'mac'} aria-hidden="true" />}
  </StrictMode>,
)
}

void start().catch(() => {
  const message = document.createElement('div')
  message.className = 'mobile-startup-error'
  const title = document.createElement('h1'); title.textContent = '本机数据暂未就绪'
  const detail = document.createElement('p'); detail.textContent = '原数据已保留，请检查存储空间后重新打开 ASTaria。'
  const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新打开'; retry.onclick = () => location.reload()
  message.append(title, detail, retry); container.replaceChildren(message)
})
