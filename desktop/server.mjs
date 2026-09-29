import { handleReminderRequest } from './reminders.mjs'
import { createServer } from 'node:http'
import { readFile, stat, realpath } from 'node:fs/promises'
import { resolve, sep } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { handleUpdateRequest } from './updates.mjs'

const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

export function assetPath(root, requestUrl) {
  if (!requestUrl.startsWith('/') || requestUrl.startsWith('//')) return null
  const pathname = requestUrl.split('?')[0]
  let decoded
  try { decoded = decodeURIComponent(pathname) } catch { return null }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').some(part => part.startsWith('.'))) return null
  const base = resolve(root)
  const target = resolve(base, `.${decoded === '/' ? '/index.html' : decoded}`)
  return target.startsWith(`${base}${sep}`) ? target : null
}

function send(res, status, body) {
  res.statusCode = status
  res.setHeader('Content-Type', 'text/plain; charset=utf-8')
  res.end(body)
}

export function authorizedRequest(req, token) {
  const supplied = req.headers['x-astaria-desktop']
  return req.socket.remoteAddress === '127.0.0.1'
    && req.headers.host === `127.0.0.1:${req.socket.localPort}`
    && (!req.headers.origin || req.headers.origin === `http://${req.headers.host}`)
    && (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']))
    && typeof supplied === 'string'
    && Buffer.byteLength(supplied) === Buffer.byteLength(token)
    && timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
}

export function createDesktopHandler({ root, service, token, updates, reminders }) {
  if (typeof token !== 'string' || token.length < 32) throw new Error('Desktop session token required')
  const base = resolve(root)
  return async (req, res) => {
    if (!authorizedRequest(req, token)) {
      send(res, 403, 'Forbidden')
      return
    }
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    res.setHeader('Referrer-Policy', 'no-referrer')
    if (updates && await handleUpdateRequest(updates, req, res)) return
    if (reminders && await handleReminderRequest(reminders, req, res)) return
    if (req.url === '/api' || req.url?.startsWith('/api/')) {
      service.middleware(req, res, () => send(res, 404, 'Not found'))
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, 'Method not allowed')
      return
    }
    const path = assetPath(root, req.url ?? '/')
    if (!path) { send(res, 404, 'Not found'); return }
    try {
      // Packaged assets are trusted, but never follow a stray symlink out of dist.
      if (!(await realpath(path)).startsWith(`${await realpath(base)}${sep}`)) { send(res, 404, 'Not found'); return }
      const file = await stat(path)
      if (!file.isFile()) { send(res, 404, 'Not found'); return }
      const extension = path.slice(path.lastIndexOf('.'))
      if (!types[extension]) { send(res, 404, 'Not found'); return }
      res.setHeader('Content-Type', types[extension])
      res.setHeader('Cache-Control', 'no-store')
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
      if (req.method === 'HEAD') { res.end(); return }
      res.end(await readFile(path))
    } catch { send(res, 404, 'Not found') }
  }
}

export function createDesktopServer({ root, service, token, updates, reminders, port = 5199 }) {
  const server = createServer(createDesktopHandler({ root, service, token, updates, reminders }))
  server.headersTimeout = 10_000
  server.requestTimeout = 120_000
  let closing
  return {
    server,
    listen: () => new Promise((resolveListen, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject)
        resolveListen(`http://127.0.0.1:${server.address().port}/`)
      })
    }),
    close: () => closing ??= (async () => {
      updates?.close()
      // Stop accepting new work before draining model/tool operations. A model
      // request may continue durably even after its browser connection closes.
      const stopped = new Promise(resolveClose => server.close(resolveClose))
      server.closeAllConnections()
      await stopped
      await service.whenIdle?.()
      await reminders?.flush()
      reminders?.close()
      service.close()
    })(),
  }
}
