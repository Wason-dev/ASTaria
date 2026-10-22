/** Stable, loopback-only preview. Building dist-mobile never removes a tab's
 * currently loaded chunks; the preview directory is advanced deliberately. */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat, realpath } from 'node:fs/promises'
import { resolve, join, extname, relative, isAbsolute } from 'node:path'

const args = process.argv.slice(2)
if (args.length !== 2) throw Error('Usage: node scripts/serve-mobile-preview.mjs <preview-directory> <port>')
const root = await realpath(resolve(args[0])), port = Number(args[1])
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid preview port')
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.woff': 'font/woff', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' }
const server = createServer(async (request, response) => {
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return }
  try {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    const path = decodeURIComponent(url.pathname)
    if (path.includes('\0') || path.split('/').some(part => part.startsWith('.') || part.includes('\\')) || path.startsWith('/api/')) {
      response.writeHead(404); response.end(); return
    }
    const file = await realpath(join(root, path === '/' ? 'index.html' : path))
    const rel = relative(root, file)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || !(await stat(file)).isFile()) { response.writeHead(404); response.end(); return }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    if (request.method === 'HEAD') response.end()
    else createReadStream(file).on('error', () => response.destroy()).pipe(response)
  } catch { response.writeHead(404); response.end() }
})
server.listen(port, '127.0.0.1', () => process.stdout.write(`Mobile preview: http://127.0.0.1:${port}/\n`))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))
