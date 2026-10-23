import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ClientServerConfig {
  port?: number;
  apiBaseUrl?: string;
}

// Whitelist of allowed static assets to strictly forbid filesystem traversal
const ALLOWED_STATIC_FILES: Record<string, { fileName: string; contentType: string }> = {
  '/': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/index.html': { fileName: 'index.html', contentType: 'text/html; charset=utf-8' },
  '/style.css': { fileName: 'style.css', contentType: 'text/css; charset=utf-8' },
  '/app.js': { fileName: 'app.js', contentType: 'application/javascript; charset=utf-8' },
};

export function createClientServer(config?: ClientServerConfig): http.Server {
  const targetApiBase = (config?.apiBaseUrl || process.env.API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const parsedBase = new URL(targetApiBase);

  const server = http.createServer((req, res) => {
    const rawUrl = req.url || '/';
    const [pathname, search] = rawUrl.split('?');
    const queryString = search ? `?${search}` : '';

    // 1. Reverse-proxy /api/* requests strictly bound to backend origin
    if (pathname === '/api' || pathname.startsWith('/api/')) {
      // Strip leading '/api', strip any redundant slashes to prevent authority confusion (e.g. /api//evil.com)
      const subPath = pathname.substring(4);
      const sanitizedPath = '/' + subPath.replace(/^\/+/, '');
      const fullTarget = new URL(`${sanitizedPath}${queryString}`, parsedBase.origin);

      const proxyHeaders: Record<string, string | string[] | undefined> = {
        ...req.headers,
        host: fullTarget.host,
      };

      const proxyReq = http.request(
        fullTarget,
        {
          method: req.method,
          headers: proxyHeaders,
        },
        (proxyRes) => {
          res.writeHead(proxyRes.statusCode || 500, proxyRes.headers);
          proxyRes.pipe(res);
        }
      );

      proxyReq.on('error', (err) => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Proxy error: ' + err.message }));
      });

      req.pipe(proxyReq);
      return;
    }

    // 2. Strict static file delivery from explicit whitelist
    const staticEntry = ALLOWED_STATIC_FILES[pathname];
    if (!staticEntry) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found');
      return;
    }

    const filePath = path.join(__dirname, staticEntry.fileName);
    fs.readFile(filePath, (err, content) => {
      if (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Internal Server Error');
        return;
      }
      res.writeHead(200, { 'Content-Type': staticEntry.contentType });
      res.end(content);
    });
  });

  return server;
}

// Start standalone server when executed directly
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const port = parseInt(process.env.PORT || '4000', 10);
  const server = createClientServer();
  server.listen(port, '0.0.0.0', () => {
    console.log(`[client] Web console running on http://localhost:${port}`);
    console.log(`[client] Proxying /api/* requests strictly to ${process.env.API_BASE_URL || 'http://localhost:3000'}`);
  });
}
