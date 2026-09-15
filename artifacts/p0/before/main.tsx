import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import BlackHolePrototype from './prototype/BlackHolePrototype'
import './index.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Root container #root not found')
}

const Root = window.location.hash === '#/black-hole' ? BlackHolePrototype : App

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
