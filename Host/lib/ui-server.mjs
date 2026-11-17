// Serves the desktop app's page on 127.0.0.1 and connects it to the Gateway. Only this machine reaches it,
// and only with the token in the app's shortcut: the first visit trades it for a cookie bound to 127.0.0.1,
// and the WebSocket also checks the page's origin, so other sites open in the browser can't drive it.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { acceptHTTPUpgrade } from './transport.mjs';

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};
const COOKIE = 'relevo_ui';

/** The token in the app's link, created once per data folder. */
export function uiToken(dataDir) {
  const file = path.join(dataDir, 'desktop', 'ui-token');
  try {
    const t = fs.readFileSync(file, 'utf8').trim();
    if (t.length >= 32) return t;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(file, t, { mode: 0o600 });
  return t;
}

export const appURL = (port, token) => `http://127.0.0.1:${port}/?t=${token}`;

export function startUIServer({ port, dataDir, uiDir, gateway, log = () => {} }) {
  const token = uiToken(dataDir);
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  const files = new Set(fs.readdirSync(uiDir).filter((n) => TYPES[path.extname(n)]));

  const cookieOK = (req) => (req.headers.cookie ?? '').split(';').some((c) => {
    const [k, v] = c.trim().split('=');
    return k === COOKIE && v && v.length === token.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(token));
  });

  const server = http.createServer((req, res) => {
    if (!hosts.has(req.headers.host)) { res.writeHead(421).end(); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.searchParams.get('t') === token) {
      res.writeHead(302, {
        'Set-Cookie': `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        Location: '/',
        'Cache-Control': 'no-store',
      }).end();
      return;
    }
    if (!cookieOK(req)) {
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
        .end('<!doctype html><meta charset="utf-8"><title>Relevo</title><body style="font:15px system-ui;padding:40px">'
          + 'Abre Relevo desde su acceso directo, o con <code>relevo-host app</code>.</body>');
      return;
    }
    const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (!files.has(name)) { res.writeHead(404).end(); return; }
    fs.readFile(path.join(uiDir, name), (err, body) => {
      if (err) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(name)],
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'",
      }).end(body);
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const okPath = new URL(req.url, 'http://x').pathname === '/ws';
    if (!okPath || !hosts.has(req.headers.host) || !origins.has(req.headers.origin) || !cookieOK(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const peer = acceptHTTPUpgrade(req, socket, head);
    if (peer) gateway.attach(peer);
  });
  server.on('error', (e) => log(`desktop page: ${e.message}`));
  server.listen(port, '127.0.0.1', () => log(`desktop app on http://127.0.0.1:${port}/ (open it with «relevo-host app»)`));
  return server;
}
