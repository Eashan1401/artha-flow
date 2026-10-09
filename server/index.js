// ARTHA FLOW server. Boot, wiring, and static files.
//
// Start it with:  node server/index.js
// Port 7717 on 127.0.0.1. Override the port with AFLOW_PORT.
//
// Three things live in here:
//   1. the HTTP server, which sends /api/* to the REST layer and everything else to ui/
//   2. the websocket upgrade on /ws
//   3. the bridge that takes engine events and broadcasts them
//
// The engine and the database belong to another agent. We load them by path so this
// file is the only place that knows where they are, and so tests can point at a stub
// with AFLOW_DB_MODULE, AFLOW_ENGINE_MODULE and AFLOW_NODES_MODULE.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createApi, startPromptReaper, sendError } from './api.js';
import { createWsHub } from './ws.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');          
const UI_DIR = path.join(ROOT, 'ui');

const HOST = '127.0.0.1';                              // local only, never 0.0.0.0
const PORT = Number(process.env.AFLOW_PORT || 7717);
const STARTED_AT = Date.now();

const VERSION = readVersion();

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

// Content types we serve. Anything else is sent as a plain download, never as HTML.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2'
};

// Hostnames we answer to. This stops a page on the wider internet pointing a name at
// 127.0.0.1 and then talking to us through the browser (DNS rebinding).
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ALLOWED_ORIGINS = [
  'http://127.0.0.1:' + PORT,
  'http://localhost:' + PORT,
  'http://[::1]:' + PORT
];

/** Import a module, using an override path when one is set. */
async function loadModule(envName, relativePath) {
  const override = process.env[envName];
  const target = override
    ? pathToFileURL(path.resolve(override)).href
    : pathToFileURL(path.join(HERE, relativePath)).href;
  return import(target);
}

async function loadOptional(envName, relativePath, label) {
  try {
    return await loadModule(envName, relativePath);
  } catch (err) {
    console.warn('[boot] ' + label + ' is not loaded yet: ' + (err && err.message ? err.message : err));
    return null;
  }
}

// ------------------------------------------------------------------ static

function hostAllowed(req) {
  const host = req.headers.host;
  if (!host) return true;                    // HTTP/1.0 clients send none
  const name = host.replace(/:\d+$/, '');
  return ALLOWED_HOSTS.has(name);
}

function safeUiPath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;                             // broken percent encoding
  }
  if (decoded.includes('\0')) return null;
  if (decoded === '/' || decoded === '') decoded = '/index.html';
  // Resolve, then prove the result is still inside ui/. This is the only check that counts,
  // because it catches .., encoded .., and symlink style tricks after resolution.
  const resolved = path.resolve(UI_DIR, '.' + decoded);
  if (resolved !== UI_DIR && !resolved.startsWith(UI_DIR + path.sep)) return null;
  return resolved;
}

const PLACEHOLDER = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ARTHA FLOW</title>
<style>body{background:#0b0d10;color:#e6edf3;font-family:system-ui,-apple-system,sans-serif;
padding:40px;line-height:1.6}code{background:#14181d;border:1px solid #232a31;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>ARTHA FLOW is running</h1>
<p>The server is up, but <code>ui/index.html</code> is not there yet.</p>
<p>The API is live at <code>/api/health</code> and the websocket is at <code>/ws</code>.</p>
</body></html>`;

function serveStatic(req, res, url) {
  const file = safeUiPath(url.pathname);
  if (!file) {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Bad path.');
  }

  let stat = null;
  try {
    stat = fs.statSync(file);
  } catch {
    stat = null;
  }

  if (stat && stat.isDirectory()) {
    const indexFile = path.join(file, 'index.html');
    try {
      if (fs.statSync(indexFile).isFile()) return sendFile(req, res, indexFile);
    } catch { /* fall through to the 404 below */ }
    stat = null;
  }

  if (!stat || !stat.isFile()) {
    // Until agent A3 lands ui/index.html we still want a page at /.
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(PLACEHOLDER),
        'Cache-Control': 'no-store'
      });
      return res.end(req.method === 'HEAD' ? undefined : PLACEHOLDER);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Not found.');
  }

  return sendFile(req, res, file);
}

function sendFile(req, res, file) {
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file);
  stream.on('error', () => { try { res.destroy(); } catch { /* gone */ } });
  stream.pipe(res);
}

// --------------------------------------------------------- workflow loader

/**
 * Read every workflows/*.json file and put it in the database.
 *
 * The contract gives nobody this job, but without it a fresh data/flow.db holds no
 * workflows at all and every run request answers 404. The folder is the source of
 * truth, the database is the working copy, so we sync one into the other at boot.
 * PUT /api/workflows/:slug writes the file back, which keeps the two in step.
 */
function loadWorkflowsFromDisk(db) {
  const dir = path.join(ROOT, 'workflows');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return { loaded: 0, skipped: 0 };
  }
  if (typeof db.upsertWorkflow !== 'function') return { loaded: 0, skipped: files.length };

  let loaded = 0;
  let skipped = 0;
  for (const file of files) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      const slug = def.slug || path.basename(file, '.json');
      if (!Array.isArray(def.nodes)) throw new Error('no nodes array');
      def.slug = slug;
      db.upsertWorkflow({
        slug,
        name: def.name || slug,
        description: def.description || '',
        definition: def,
        enabled: def.enabled === false ? false : true
      });
      loaded++;
    } catch (err) {
      skipped++;
      console.warn('[boot] skipped workflows/' + file + ': ' + (err && err.message ? err.message : err));
    }
  }
  return { loaded, skipped };
}

// ------------------------------------------------------------------- boot

export async function main() {
  const db = await loadModule('AFLOW_DB_MODULE', './db.js');
  const engine = await loadModule('AFLOW_ENGINE_MODULE', './engine.js');
  const nodes = await loadOptional('AFLOW_NODES_MODULE', './nodes/index.js', 'the node registry');

  // Open the database before anything can ask it a question.
  let dbHandle = null;
  if (typeof db.openDb === 'function') {
    dbHandle = await db.openDb();
  }

  const sync = loadWorkflowsFromDisk(db);
  if (sync.loaded || sync.skipped) {
    console.log('[boot] workflows loaded from disk: ' + sync.loaded + ' ok, ' + sync.skipped + ' skipped');
  }

  const ws = createWsHub({
    version: VERSION,
    getWaitingPrompts: () => api.waitingPrompts(),
    allowedOrigins: ALLOWED_ORIGINS
  });

  const api = createApi({ db, dbHandle, engine, nodes, ws, version: VERSION, startedAt: STARTED_AT, root: ROOT });

  // Engine events go straight out to every subscribed socket.
  if (typeof engine.onEvent === 'function') {
    engine.onEvent((event) => {
      try {
        ws.broadcast(event);
      } catch (err) {
        console.error('[ws] broadcast failed: ' + (err && err.message ? err.message : err));
      }
    });
  } else {
    console.warn('[boot] the engine has no onEvent, so the live feed will be quiet.');
  }

  const stopReaper = startPromptReaper(api, { everyMs: 60_000 });

  const server = http.createServer((req, res) => {
    if (!hostAllowed(req)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('This server only answers to localhost.');
    }
    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1:' + PORT);
    } catch {
      return sendError(res, 400, 'bad_url', 'That URL could not be read.');
    }

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      return api.handleApi(req, res, url);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      return res.end('Only GET and HEAD outside the API.');
    }
    return serveStatic(req, res, url);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!hostAllowed(req)) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); } catch { /* gone */ }
      return;
    }
    let pathname = '/';
    try {
      pathname = new URL(req.url, 'http://127.0.0.1:' + PORT).pathname;
    } catch {
      pathname = '/';
    }
    if (pathname !== '/ws') {
      try { socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); socket.destroy(); } catch { /* gone */ }
      return;
    }
    ws.handleUpgrade(req, socket, head);
  });

  // A socket that connects and then says nothing must not be held for ever.
  server.headersTimeout = 20_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  // A client that hangs up mid request should never take the process with it.
  server.on('clientError', (err, socket) => {
    try {
      if (socket.writable && !socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else socket.destroy();
    } catch { /* already gone */ }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, resolve);
  });

  console.log('ARTHA FLOW v' + VERSION + ' listening on http://' + HOST + ':' + PORT);
  console.log('  UI        http://' + HOST + ':' + PORT + '/');
  console.log('  API       http://' + HOST + ':' + PORT + '/api/health');
  console.log('  Websocket ws://' + HOST + ':' + PORT + '/ws');

  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[shutdown] ' + signal + ', closing.');
    stopReaper();
    ws.close();
    server.close(() => process.exit(0));
    // Do not hang for ever on a socket that will not close.
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // One bad promise somewhere must be loud, not silent, but must not kill the server.
  process.on('unhandledRejection', (err) => {
    console.error('[unhandled] ' + (err && err.stack ? err.stack : err));
  });

  return { server, ws, api };
}

// Only boot when this file is the one that was run.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[boot] failed: ' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
