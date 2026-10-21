import { app, protocol } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

/**
 * Serves the built renderer from dist/renderer over `app://renderer/...`.
 * A real origin (rather than file://) keeps module workers, fetch and
 * localStorage behaving the same way they do in the browser.
 */
export function registerAppProtocol(): void {
  const rendererRoot = path.join(app.getAppPath(), 'dist', 'renderer')

  protocol.handle('app', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host && url.host !== 'renderer') {
        return new Response('Not found', { status: 404 })
      }

      let pathname = decodeURIComponent(url.pathname || '/')
      if (pathname === '/' || pathname === '') pathname = '/index.html'

      const relative = path.normalize(pathname).replace(/^[/\\]+/, '')
      let file = path.join(rendererRoot, relative)

      if (file !== rendererRoot && !file.startsWith(rendererRoot + path.sep)) {
        return new Response('Forbidden', { status: 403 })
      }

      let isFile = false
      try {
        const stat = await fs.stat(file)
        isFile = stat.isFile()
        if (stat.isDirectory()) {
          file = path.join(file, 'index.html')
          isFile = (await fs.stat(file)).isFile()
        }
      } catch {
        isFile = false
      }

      if (!isFile) {
        // SPA-style fallback for extension-less routes.
        if (!path.extname(relative)) {
          file = path.join(rendererRoot, 'index.html')
        } else {
          return new Response('Not found', { status: 404 })
        }
      }

      const data = await fs.readFile(file)
      const mime = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
      return new Response(data, {
        headers: { 'content-type': mime, 'cache-control': 'no-cache' },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}
