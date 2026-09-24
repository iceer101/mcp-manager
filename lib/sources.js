// Adapters for the three MCP config formats.
//
// Claude Desktop : ~/Library/Application Support/Claude/claude_desktop_config.json -> .mcpServers.{name}
// Claude Code    : ~/.claude.json -> .mcpServers.{name} (user scope)
//                                  -> .projects[path].mcpServers.{name} (local/project scope)
// Codex          : ~/.codex/config.toml -> [mcp_servers.{name}] (+ native `enabled = false`)
//
// Claude Desktop / Claude Code have no native "disabled" flag, so a disabled
// server is moved out of the config into ~/.mcp-manager/disabled.json and moved
// back when it is enabled again.

const fs = require('fs');
const os = require('os');
const path = require('path');
const TOML = require('smol-toml');
const { markChanged } = require('./apps');

const HOME = os.homedir();
// Everything the manager keeps (backups, disabled servers, log) lives in ~/.mcp-manager,
// unless MCP_MANAGER_DATA points elsewhere.
const DATA_DIR = process.env.MCP_MANAGER_DATA || path.join(os.homedir(), '.mcp-manager');
const STASH_FILE = path.join(DATA_DIR, 'disabled.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MAX_BACKUPS = 30;

// Claude Desktop reaches remote servers through mcp-remote, vendored as a single bundled file
// (version pinned in package.json "vendor:mcp-remote") and started with an absolute node path:
// `npx -y mcp-remote` races with itself when Desktop spawns the same server for several sessions.
const VENDOR_PROXY = path.join(__dirname, '..', 'vendor', 'mcp-remote.mjs');

// Claude Desktop's config keeps this path, so it must outlive the code (an npx cache, a moved
// clone): the bundle is copied into the data directory and referenced from there.
function mcpRemoteProxy() {
  const dest = path.join(DATA_DIR, 'mcp-remote.mjs');
  const src = fs.readFileSync(VENDOR_PROXY);
  if (!fs.existsSync(dest) || !fs.readFileSync(dest).equals(src)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(dest, src);
  }
  return dest;
}

const FILES = {
  desktop: path.join(HOME, 'Library/Application Support/Claude/claude_desktop_config.json'),
  code: path.join(HOME, '.claude.json'),
  codex: path.join(HOME, '.codex/config.toml'),
};

// ---------- file helpers ----------

function backup(file, tag) {
  if (!fs.existsSync(file)) return;
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(file, path.join(BACKUP_DIR, `${tag}__${ts}${path.extname(file)}`));
  const old = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(tag + '__')).sort();
  for (const f of old.slice(0, Math.max(0, old.length - MAX_BACKUPS))) fs.unlinkSync(path.join(BACKUP_DIR, f));
}

// Atomic write that keeps symlinks and file mode intact.
function writeFileSafe(file, content, tag) {
  const real = fs.existsSync(file) ? fs.realpathSync(file) : file;
  backup(real, tag);
  const mode = fs.existsSync(real) ? fs.statSync(real).mode & 0o777 : 0o600;
  const tmp = `${real}.mcp-manager-${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode });
  fs.renameSync(tmp, real);
  const client = Object.keys(FILES).find(k => FILES[k] === file);
  if (client) markChanged(client);
}

function readJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  const indent = (text.match(/\n([ \t]+)"/) || [, '  '])[1];
  return { data: JSON.parse(text), indent, trailingNl: text.endsWith('\n') };
}

function writeJson(file, { data, indent, trailingNl }, tag) {
  writeFileSafe(file, JSON.stringify(data, null, indent) + (trailingNl ? '\n' : ''), tag);
}

function loadStash() {
  try { return JSON.parse(fs.readFileSync(STASH_FILE, 'utf8')); } catch { return {}; }
}
function saveStash(stash) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const k of Object.keys(stash)) if (!Object.keys(stash[k]).length) delete stash[k];
  fs.writeFileSync(STASH_FILE, JSON.stringify(stash, null, 2) + '\n', { mode: 0o600 });
}

// ---------- JSON adapter (Claude Desktop, Claude Code user + project scopes) ----------

function jsonAdapter({ id, label, client, file, scope, containerPath }) {
  const getContainer = (data, create) => {
    let node = data;
    for (const key of containerPath) {
      if (node[key] == null) { if (!create) return null; node[key] = {}; }
      node = node[key];
    }
    return node;
  };

  const self = {
    id, label, client, file, scope, format: 'claude',

    list() {
      const { data } = readJson(file);
      const active = getContainer(data, false) || {};
      const stashed = loadStash()[id] || {};
      const out = Object.entries(active).map(([name, config]) => ({ name, enabled: true, config }));
      for (const [name, config] of Object.entries(stashed)) {
        if (!(name in active)) out.push({ name, enabled: false, config });
      }
      return out;
    },

    upsert(name, config, { oldName, enabled } = {}) {
      const doc = readJson(file);
      const container = getContainer(doc.data, true);
      const stash = loadStash();
      const stashed = stash[id] || (stash[id] = {});
      const from = oldName || name;
      const wasDisabled = from in stashed && !(from in container);
      const wantEnabled = enabled ?? !wasDisabled;

      if (oldName && oldName !== name) {
        if (name in container || name in stashed) throw new Error(`"${name}" already exists in ${label}`);
      }
      delete container[from];
      delete stashed[from];

      if (wantEnabled) container[name] = config;
      else stashed[name] = config;

      writeJson(file, doc, id.replace(/[^\w-]+/g, '_'));
      saveStash(stash);
    },

    remove(name) {
      const doc = readJson(file);
      const container = getContainer(doc.data, false);
      if (container && name in container) {
        delete container[name];
        writeJson(file, doc, id.replace(/[^\w-]+/g, '_'));
      }
      const stash = loadStash();
      if (stash[id] && name in stash[id]) { delete stash[id][name]; saveStash(stash); }
    },

    setEnabled(name, enabled) {
      const item = self.list().find(s => s.name === name);
      if (!item) throw new Error(`"${name}" not found in ${label}`);
      if (item.enabled === enabled) return;
      self.upsert(name, item.config, { enabled });
    },
  };
  return self;
}

// ---------- Codex TOML adapter ----------
// Edits are surgical: only the [mcp_servers.<name>] / [mcp_servers.<name>.*] tables
// are replaced, the rest of config.toml (comments, order) is kept byte-for-byte.

function parseKeyPath(s) {
  const parts = [];
  let cur = '', q = null;
  for (const ch of s) {
    if (q) { if (ch === q) q = null; else cur += ch; }
    else if (ch === '"' || ch === "'") q = ch;
    else if (ch === '.') { parts.push(cur.trim()); cur = ''; }
    else cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

const canon = (v) => JSON.stringify(v, (_, x) =>
  x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);

const HEADER_RE = /^\s*\[\[?\s*(.+?)\s*\]\]?\s*(#.*)?$/;

function replaceTomlServer(text, name, cfg) {
  const lines = text.split('\n');
  const keep = [];
  let insertAt = -1, lastMcpEnd = -1, inBlock = false, inMcp = false;
  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      const p = parseKeyPath(m[1]);
      inMcp = p[0] === 'mcp_servers';
      inBlock = inMcp && p[1] === name;
      if (inBlock && insertAt < 0) insertAt = keep.length;
    }
    if (!inBlock) keep.push(line);
    if (inMcp && !inBlock) lastMcpEnd = keep.length;
  }
  // New server: put it after the last existing [mcp_servers.*] table.
  if (insertAt < 0 && lastMcpEnd >= 0) {
    insertAt = lastMcpEnd;
    if (keep[insertAt - 1]?.trim() !== '') keep.splice(insertAt++, 0, '');
  }

  let snippet = [];
  if (cfg) {
    snippet = TOML.stringify({ mcp_servers: { [name]: cfg } }).trimEnd().split('\n');
    snippet.push('');
  }
  if (insertAt < 0) {
    while (keep.length && keep[keep.length - 1].trim() === '') keep.pop();
    keep.push('', ...snippet);
  } else {
    keep.splice(insertAt, 0, ...snippet);
  }
  let out = keep.join('\n');
  if (!out.endsWith('\n')) out += '\n';

  // Safety net: the result must parse, contain exactly what we meant to write,
  // and leave everything else in the document untouched.
  const before = TOML.parse(text), after = TOML.parse(out);
  const got = after.mcp_servers?.[name];
  for (const doc of [before, after]) {
    if (doc.mcp_servers) delete doc.mcp_servers[name];
    if (doc.mcp_servers && !Object.keys(doc.mcp_servers).length) delete doc.mcp_servers;
  }
  if (canon(got ?? null) !== canon(cfg ?? null) || canon(before) !== canon(after)) {
    throw new Error(`Codex: unsupported layout for "${name}" in config.toml (edit it by hand)`);
  }
  return out;
}

function codexAdapter() {
  const file = FILES.codex;
  const read = () => fs.readFileSync(file, 'utf8');
  const write = (text) => writeFileSafe(file, text, 'codex');
  const servers = (text) => TOML.parse(text).mcp_servers || {};

  const self = {
    id: 'codex', label: 'Codex', client: 'codex', file, scope: 'user', format: 'codex',

    list() {
      return Object.entries(servers(read())).map(([name, raw]) => {
        const { enabled, ...config } = raw;
        return { name, enabled: enabled !== false, config };
      });
    },

    upsert(name, config, { oldName, enabled } = {}) {
      let text = read();
      const all = servers(text);
      const from = oldName || name;
      const prev = all[from];
      if (oldName && oldName !== name && all[name]) throw new Error(`"${name}" already exists in Codex`);

      const { enabled: _ignored, ...clean } = config;
      const wantEnabled = enabled ?? (prev ? prev.enabled !== false : true);
      const cfg = wantEnabled
        ? (prev && 'enabled' in prev ? { enabled: true, ...clean } : clean)
        : { enabled: false, ...clean };

      if (from !== name) text = replaceTomlServer(text, from, null);
      text = replaceTomlServer(text, name, cfg);
      write(text);
    },

    remove(name) {
      write(replaceTomlServer(read(), name, null));
    },

    setEnabled(name, enabled) {
      const item = self.list().find(s => s.name === name);
      if (!item) throw new Error(`"${name}" not found in Codex`);
      self.upsert(name, item.config, { enabled });
    },
  };
  return self;
}

// ---------- registry ----------

function getSources() {
  const sources = [
    jsonAdapter({ id: 'desktop', label: 'Claude Desktop', client: 'desktop', file: FILES.desktop, scope: 'user', containerPath: ['mcpServers'] }),
    jsonAdapter({ id: 'code', label: 'Claude Code', client: 'code', file: FILES.code, scope: 'user', containerPath: ['mcpServers'] }),
  ];

  // Claude Code local scopes: only projects that actually have servers (active or stashed).
  try {
    const { data } = readJson(FILES.code);
    const stash = loadStash();
    for (const [p, proj] of Object.entries(data.projects || {})) {
      const id = `code:${p}`;
      const has = proj && typeof proj === 'object' && Object.keys(proj.mcpServers || {}).length;
      if (has || stash[id]) {
        sources.push(jsonAdapter({
          id, label: `Claude Code · ${p.replace(HOME, '~')}`, client: 'code', file: FILES.code,
          scope: p, containerPath: ['projects', p, 'mcpServers'],
        }));
      }
    }
  } catch { /* reported by snapshot() */ }

  sources.push(codexAdapter());
  return sources;
}

function getSource(id) {
  const s = getSources().find(x => x.id === id);
  if (!s) throw new Error(`Unknown source "${id}"`);
  return s;
}

function snapshot() {
  return getSources().map(s => {
    const base = { id: s.id, label: s.label, client: s.client, file: s.file.replace(HOME, '~'), scope: s.scope, format: s.format };
    try { return { ...base, servers: s.list() }; }
    catch (e) { return { ...base, servers: [], error: e.message }; }
  });
}

// ---------- unified model ----------
// Every native config maps to one neutral shape the UI edits:
//   { transport: 'stdio'|'http'|'sse', command, args, env, cwd, url, headers, bearerEnv }
// Native keys outside that shape (Codex startup_timeout_sec, tools.*, ...) are "extras"
// and are carried over untouched when the neutral form is written back.

const KNOWN_KEYS = {
  claude: ['type', 'command', 'args', 'env', 'url', 'headers'],
  codex: ['enabled', 'command', 'args', 'env', 'cwd', 'url', 'http_headers', 'bearer_token_env_var'],
};

function extrasOf(format, cfg) {
  return Object.fromEntries(Object.entries(cfg || {}).filter(([k]) => !KNOWN_KEYS[format].includes(k)));
}

// Claude Desktop remote bridge, either form:
//   npx -y mcp-remote[@ver] <url> [--header "K: V"]... [--allow-http]
//   <node> /path/to/mcp-remote.mjs | mcp-remote/dist/proxy.js <url> [--header "K: V"]... [--allow-http]
function parseMcpRemote(cfg) {
  if (!Array.isArray(cfg.args)) return null;
  let a;
  if (cfg.command === 'npx') {
    a = cfg.args.filter(x => x !== '-y');
    if (!/^mcp-remote(@[\w.-]+)?$/.test(a[0] || '')) return null;
    a = a.slice(1);
  } else if (/mcp-remote(\/dist\/proxy\.js|\.mjs)$/.test(cfg.args[0] || '')) {
    a = cfg.args.slice(1);
  } else return null;

  if (!/^https?:\/\//.test(a[0] || '')) return null;
  const headers = {};
  for (let i = 1; i < a.length; i++) {
    if (a[i] === '--allow-http') continue;
    const m = a[i] === '--header' && String(a[i + 1]).match(/^([^:]+):\s*(.*)$/);
    if (!m) return null;
    headers[m[1].trim()] = m[2];
    i++;
  }
  return { transport: 'http', url: a[0], ...(Object.keys(headers).length ? { headers } : {}) };
}

function isLocalUrl(url) {
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(url).hostname); } catch { return false; }
}

function toNeutral(format, cfg) {
  if (format === 'claude') {
    const remote = parseMcpRemote(cfg);
    if (remote) return remote;
  }
  const n = { transport: cfg.url ? (format === 'claude' && cfg.type === 'sse' ? 'sse' : 'http') : 'stdio' };
  if (cfg.command) n.command = cfg.command;
  if (cfg.args?.length) n.args = cfg.args;
  if (cfg.env && Object.keys(cfg.env).length) n.env = cfg.env;
  if (cfg.url) n.url = cfg.url;
  const headers = format === 'codex' ? cfg.http_headers : cfg.headers;
  if (headers && Object.keys(headers).length) n.headers = { ...headers };
  if (format === 'codex') {
    if (cfg.cwd) n.cwd = cfg.cwd;
    if (cfg.bearer_token_env_var) n.bearerEnv = cfg.bearer_token_env_var;
  }
  return n;
}

// Fields every client understands; used to tell whether two clients are "in sync".
function comparable(n) {
  const { cwd, bearerEnv, ...rest } = n;
  return canon(rest);
}

function fromNeutral(target, n) {
  const warnings = [];
  const out = {};
  const hasEnv = n.env && Object.keys(n.env).length;
  const hasHeaders = n.headers && Object.keys(n.headers).length;

  if (target.format === 'codex') {
    if (n.transport === 'stdio') {
      Object.assign(out, { command: n.command, args: n.args || [] });
      if (hasEnv) out.env = n.env;
      if (n.cwd) out.cwd = n.cwd;
    } else {
      if (n.transport === 'sse') warnings.push('Codex does not support SSE — the URL was saved as HTTP');
      out.url = n.url;
      if (hasHeaders) out.http_headers = n.headers;
      if (n.bearerEnv) out.bearer_token_env_var = n.bearerEnv;
    }
    return { config: out, warnings };
  }

  if (n.transport === 'stdio') {
    if (target.client === 'code') out.type = 'stdio';
    Object.assign(out, { command: n.command, args: n.args || [] });
    if (hasEnv) out.env = n.env;
  } else if (target.client === 'code') {
    Object.assign(out, { type: n.transport, url: n.url });
    if (hasHeaders) out.headers = n.headers;
  } else {
    // Claude Desktop config file has no remote transports -> bridge via mcp-remote.
    const args = [mcpRemoteProxy(), n.url];
    for (const [k, v] of Object.entries(n.headers || {})) args.push('--header', `${k}: ${v}`);
    if (n.url.startsWith('http://') && !isLocalUrl(n.url)) args.push('--allow-http');
    Object.assign(out, { command: process.execPath, args });
  }
  return { config: out, warnings };
}

// Writes one neutral config into several clients; renames across every client that has oldName.
function saveUnified({ name, oldName, neutral, targets }) {
  const warnings = [];
  const from = oldName || name;
  for (const src of getSources()) {
    const existing = src.list().find(s => s.name === from);
    if (targets.includes(src.id)) {
      const { config, warnings: w } = fromNeutral(src, neutral);
      const merged = { ...extrasOf(src.format, existing?.config), ...config };
      src.upsert(name, merged, { oldName: existing ? from : undefined });
      warnings.push(...w.map(x => `${src.label}: ${x}`));
    } else if (existing && from !== name) {
      src.upsert(name, existing.config, { oldName: from });
    }
  }
  return warnings;
}

// Raw view: JSON for Claude clients, the actual TOML table for Codex.
function getRaw(src, name) {
  const item = src.list().find(s => s.name === name);
  if (!item) throw new Error(`"${name}" not found in ${src.label}`);
  if (src.format === 'codex') {
    const cfg = item.enabled ? item.config : { enabled: false, ...item.config };
    return { lang: 'toml', text: TOML.stringify({ mcp_servers: { [name]: cfg } }) };
  }
  return { lang: 'json', text: JSON.stringify(item.config, null, 2) };
}

function saveRaw(src, name, text) {
  if (src.format === 'codex') {
    const entries = Object.entries(TOML.parse(text).mcp_servers || {});
    if (entries.length !== 1) throw new Error('Expected exactly one [mcp_servers.<name>] table');
    const { enabled, ...cfg } = entries[0][1];
    src.upsert(name, cfg, { enabled: enabled !== false });
  } else {
    const cfg = JSON.parse(text);
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) throw new Error('Config must be a JSON object');
    src.upsert(name, cfg);
  }
}

module.exports = {
  getSources, getSource, snapshot, toNeutral, comparable, saveUnified, getRaw, saveRaw,
};
