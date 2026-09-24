#!/usr/bin/env node
// Local-only web UI for MCP server configs. No auth: binds to 127.0.0.1 and
// rejects foreign Host/Origin headers (DNS-rebinding / CSRF guard), because
// writing these configs effectively means running arbitrary commands.
//
//   mcp-manager            start in the background (or just open the page if running)
//   mcp-manager --stop     stop the running instance
//   mcp-manager --serve    run in this terminal
//   --no-open              don't open the browser

const http = require('http');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Backups, disabled servers, logs: outside the code, so they survive updates and npx caches.
process.env.MCP_MANAGER_DATA ||= path.join(os.homedir(), '.mcp-manager');
const DATA_DIR = process.env.MCP_MANAGER_DATA;

const { probe } = require('./lib/probe');
const apps = require('./lib/apps');
const { snapshot, getSource, getSources, toNeutral, comparable, saveUnified, getRaw, saveRaw } = require('./lib/sources');

const PORT = Number(process.env.PORT) || 4717;
const HOST = '127.0.0.1';
const INDEX = path.join(__dirname, 'public/index.html');
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const URL_ = `http://localhost:${PORT}`;
const ARGS = process.argv.slice(2);
const OPEN = !ARGS.includes('--no-open');
// Stops by itself after this long without requests (IDLE_MINUTES=0 disables).
const IDLE_MS = Number(process.env.IDLE_MINUTES ?? 10) * 60_000;
let lastRequest = Date.now();

const openBrowser = () => OPEN && execFile('open', [URL_]);

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function validateNeutral(n) {
  if (!n || typeof n !== 'object') throw new Error('Missing settings');
  if (n.transport === 'stdio' && !n.command?.trim()) throw new Error('Command is required');
  if (n.transport !== 'stdio' && !/^https?:\/\//.test(n.url || '')) throw new Error('URL is required (http:// or https://)');
}

const actions = {
  // Sources plus every server with its neutral form and a sync key.
  list: () => ({
    sources: snapshot().map(s => ({
      ...s,
      servers: s.servers.map(x => {
        const neutral = toNeutral(s.format, x.config);
        return { ...x, neutral, key: comparable(neutral) };
      }),
    })),
  }),

  // { name, oldName?, neutral, targets: [sourceId] }
  saveUnified: ({ name, oldName, neutral, targets }) => {
    name = name?.trim();
    if (!name) throw new Error('Name is required');
    if (!/^[\w.@-]+$/.test(name)) throw new Error('Name may contain only latin letters, digits and . _ - @');
    if (!targets?.length) throw new Error('Select at least one client');
    validateNeutral(neutral);
    return { warnings: saveUnified({ name, oldName, neutral, targets }) };
  },

  // { source, name }
  raw: ({ source, name }) => getRaw(getSource(source), name),

  // { source, name, text }
  saveRaw: ({ source, name, text }) => saveRaw(getSource(source), name, text),

  // { source, name }
  remove: ({ source, name }) => getSource(source).remove(name),

  // { name } -> removes from every client
  removeAll: ({ name }) => { for (const s of getSources()) if (s.list().some(x => x.name === name)) s.remove(name); },

  // { source, name, force? } -> launches the server as that client would and does the MCP handshake
  probe: async ({ source, name, force }) => {
    const src = getSource(source);
    const item = src.list().find(x => x.name === name);
    if (!item) throw new Error(`"${name}" not found in ${src.label}`);
    return { result: await probe(src.format, item.config, { force }) };
  },

  // Apps that are running with an older config than the one on disk.
  restartStatus: async () => ({ apps: await apps.status() }),

  // { client: 'desktop' | 'codex' }
  restartApp: async ({ client }) => { await apps.restart(client); return { apps: await apps.status() }; },

  // { source, name, enabled }
  toggle: ({ source, name, enabled }) => getSource(source).setEnabled(name, !!enabled),
};

function serve() {
  const server = http.createServer(async (req, res) => {
    const prevRequest = lastRequest;
    lastRequest = Date.now();
    if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 403, { error: 'bad host' });
    if (req.headers.origin && !ALLOWED_HOSTS.has(req.headers.origin.replace(/^https?:\/\//, ''))) {
      return send(res, 403, { error: 'bad origin' });
    }

    try {
      // Lets the CLI find a running instance; doesn't count as activity.
      if (req.method === 'GET' && req.url === '/health') {
        lastRequest = prevRequest;
        return send(res, 200, { app: 'mcp-manager', pid: process.pid, dir: __dirname, port: PORT });
      }
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        return send(res, 200, fs.readFileSync(INDEX), 'text/html; charset=utf-8');
      }
      if (req.method === 'POST' && req.url.startsWith('/api/')) {
        if (!String(req.headers['content-type']).startsWith('application/json')) {
          return send(res, 415, { error: 'application/json required' });
        }
        const fn = actions[req.url.slice(5)];
        if (!fn) return send(res, 404, { error: 'unknown action' });
        const result = await fn(await readBody(req));
        return send(res, 200, { ok: true, ...(result || {}) });
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
  });

  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use` : e.message);
    process.exit(1);
  });

  server.listen(PORT, HOST, () => {
    console.log(`${new Date().toISOString()} mcp-manager listening on ${URL_}`);
  });

  if (IDLE_MS) {
    setInterval(() => {
      if (Date.now() - lastRequest < IDLE_MS) return;
      console.log(`${new Date().toISOString()} no requests for ${IDLE_MS / 60_000} min, shutting down`);
      server.close();
      process.exit(0);
    }, Math.min(30_000, IDLE_MS)).unref();
  }
}

// ---------- CLI ----------

function health() {
  return new Promise((resolve) => {
    const req = http.get({ host: HOST, port: PORT, path: '/health', headers: { host: `localhost:${PORT}` }, timeout: 1000 }, (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => { try { const h = JSON.parse(body); resolve(h.app === 'mcp-manager' ? h : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// How the user should stop it, in the same terms they started it.
function stopHint() {
  if (process.env.npm_command === 'exec') return 'npx -y github:iceer101/mcp-manager --stop';
  if (process.env.npm_lifecycle_event) return 'npm stop';
  return `node ${path.relative(process.cwd(), __filename) || 'server.js'} --stop`;
}

async function start() {
  const running = await health();
  if (running) {
    console.log(`mcp-manager is already running: ${URL_}`);
    return openBrowser();
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const log = fs.openSync(path.join(DATA_DIR, 'server.log'), 'a');
  spawn(process.execPath, [__filename, '--serve'], { detached: true, stdio: ['ignore', log, log], env: process.env }).unref();

  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100));
    if (await health()) {
      console.log(`mcp-manager is running in the background: ${URL_}`);
      console.log(IDLE_MS
        ? `It stops by itself after ${IDLE_MS / 60_000} idle minutes. To stop it now: ${stopHint()}`
        : `To stop it: ${stopHint()}`);
      return openBrowser();
    }
  }
  console.error(`mcp-manager failed to start, see ${path.join(DATA_DIR, 'server.log')}`);
  process.exit(1);
}

async function stop() {
  const running = await health();
  if (!running) return console.log('mcp-manager is not running.');
  process.kill(running.pid, 'SIGTERM');
  console.log('mcp-manager stopped.');
}

if (ARGS.includes('--stop')) stop();
else if (ARGS.includes('--serve')) serve();
else start();
