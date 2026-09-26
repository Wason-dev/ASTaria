import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
// @ts-expect-error Local Node middleware intentionally stays outside the browser TS project
import { localServicePlugin } from './server/index.mjs'

export default defineConfig(({ mode }) => ({
  plugins: [
    localServicePlugin(),
    react(),
    tailwindcss(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'autoUpdate',
      // Design previews must not reopen an older cached build. Publish the
      // retirement worker for existing registrations without registering anew.
      injectRegister: ['design-preview', 'desktop'].includes(mode) ? false : 'auto',
      selfDestroying: ['design-preview', 'desktop'].includes(mode),
      includeAssets: ['favicon.png', 'apple-touch-icon.png', 'astaria-icon-1024.png'],
      manifest: {
        name: 'ASTaria',
        short_name: 'ASTaria',
        description: 'ASTaria',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f5f9ff',
        theme_color: '#0b3d91',
        icons: [
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
        cleanupOutdatedCaches: true,
      },
    }),
  ],
}))
