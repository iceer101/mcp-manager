// Import of a pasted server config: JSON (comments and trailing commas allowed) or TOML, at any
// wrapper level, in the formats popular clients and READMEs use:
//
//   { "mcpServers": { "x": {...} } }          Claude Desktop / Code, Cursor, Windsurf, Cline, Gemini CLI
//   { "servers": { "x": {...} } }             VS Code mcp.json, also { "mcp": { "servers": ... } }
//   { "context_servers": { "x": {...} } }     Zed
//   { "mcp": { "x": { "type": "local", "command": [...] } } }    opencode
//   [mcp_servers.x]                           Codex config.toml
//   "x": { ... }                              an entry copied out of one of the above
//   { "command": ..., "args": ... }           a bare config, without a name
//
// Servers are found by shape (an object with a command or a url), wherever they are nested.

const TOML = require('smol-toml');
const { parseMcpRemote } = require('./sources');

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const MAX_DEPTH = 6;

// Drops // and /* */ comments (first pass) or trailing commas (second pass), leaving strings alone.
function stripJsonc(text, commas) {
  const trailing = /\s*([}\]]|$)/y;
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
      out += text.slice(start, i + 1);
    } else if (!commas && c === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (!commas && c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2) >>> 0;   // -1 -> to the end
      out += text.slice(i, end).replace(/[^\n]/g, '');  // keeps line numbers for error messages
      i = Math.min(end, text.length) + 1;
    } else if (commas && c === ',' && ((trailing.lastIndex = i + 1), trailing.test(text))) {
      // trailing comma: dropped
    } else out += c;
  }
  return out;
}

function parseText(text) {
  const clean = stripJsonc(stripJsonc(text, false), true);
  // A fragment such as `"github": { ... }` becomes valid JSON once wrapped in braces.
  for (const s of [clean, `{${clean}}`]) {
    try { return JSON.parse(s); } catch { /* next */ }
  }
  let tomlError;
  try { return TOML.parse(text); } catch (e) { tomlError = e; }
  if (/^\s*\[[^\]"{]+\]\s*$/m.test(text)) throw new Error(`TOML: ${tomlError.message.split('\n')[0]}`);
  try { JSON.parse(clean); } catch (e) { throw new Error(`JSON: ${withLine(e.message, clean)}`); }
}

// Node 18 reports only an offset: "... at position 37" -> "... at line 2, column 5".
function withLine(message, text) {
  const m = message.match(/ at position (\d+)(?: \(line \d+ column \d+\))?$/);
  if (!m) return message;
  const before = text.slice(0, Number(m[1])).split('\n');
  return `${message.slice(0, m.index)} at line ${before.length}, column ${before.at(-1).length + 1}`;
}

function looksLikeServer(o) {
  if (!isObj(o)) return false;
  if (isObj(o.transport)) return looksLikeServer(o.transport);   // Continue
  const c = o.command;
  return typeof c === 'string' || (Array.isArray(c) && typeof c[0] === 'string') || (isObj(c) && typeof c.path === 'string')
    || ['url', 'serverUrl', 'httpUrl'].some(k => typeof o[k] === 'string');
}

function findServers(node, path, depth, out) {
  if (depth > MAX_DEPTH) return out;
  const entries = Array.isArray(node) ? node.map((v, i) => [i, v]) : Object.entries(node);
  for (const [k, v] of entries) {
    if (looksLikeServer(v)) {
      const name = typeof v.name === 'string' ? v.name : Array.isArray(node) ? null : k;
      out.push({ name, path: [...path, String(k)], cfg: v });
    } else if (v && typeof v === 'object') findServers(v, [...path, String(k)], depth + 1, out);
  }
  return out;
}

// Keys every format means the same thing by; anything else is reported as not carried over.
const KNOWN = new Set(['name', 'type', 'transport', 'command', 'args', 'env', 'environment', 'cwd',
  'url', 'serverUrl', 'httpUrl', 'headers', 'http_headers', 'bearer_token_env_var', 'enabled']);

const strings = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, String(v)]));

function toNeutral(raw) {
  let cfg = raw;
  if (isObj(cfg.transport)) { const { transport, ...rest } = cfg; cfg = { ...rest, ...transport }; }
  const type = String(cfg.type ?? (typeof cfg.transport === 'string' ? cfg.transport : ''))
    .toLowerCase().replace(/[-_]/g, '');

  let { command, args } = cfg;
  let env = cfg.env ?? cfg.environment;                          // opencode: "environment"
  if (isObj(command)) {                                          // Zed: "command": { path, args, env }
    args ??= command.args; env ??= command.env; command = command.path;
  }
  if (Array.isArray(command)) {                                  // opencode: "command": ["npx", "-y", "x"]
    args = [...command.slice(1), ...(args || [])]; command = command[0];
  }
  const url = cfg.httpUrl ?? cfg.url ?? cfg.serverUrl;           // Gemini CLI: httpUrl, Windsurf: serverUrl
  const headers = cfg.headers ?? cfg.http_headers;               // Codex: http_headers

  let n;
  if (typeof url === 'string' && (typeof command !== 'string' || ['http', 'sse', 'streamablehttp', 'remote'].includes(type))) {
    // Gemini CLI's "url" is SSE and "httpUrl" is Streamable HTTP; elsewhere a bare url is HTTP
    // unless its path says otherwise.
    const sse = type === 'sse' || (!type && !cfg.httpUrl && /\/sse\/?(\?|$)/.test(url));
    n = { transport: sse ? 'sse' : 'http', url };
    if (isObj(headers) && Object.keys(headers).length) n.headers = strings(headers);
    if (typeof cfg.bearer_token_env_var === 'string') n.bearerEnv = cfg.bearer_token_env_var;
  } else {
    n = { transport: 'stdio', command, args: Array.isArray(args) ? args.map(String) : [] };
    if (isObj(env) && Object.keys(env).length) n.env = strings(env);
    if (typeof cfg.cwd === 'string' && cfg.cwd) n.cwd = cfg.cwd;
    // `npx mcp-remote <url>` is how Claude Desktop reaches remote servers: import the server itself.
    const remote = parseMcpRemote(n);
    if (remote) n = remote;
  }

  const ignored = Object.keys(raw).filter(k => !KNOWN.has(k));
  if (isObj(raw.command)) ignored.push(...Object.keys(raw.command).filter(k => !['path', 'args', 'env'].includes(k)).map(k => `command.${k}`));
  return { neutral: n, ignored };
}

// text -> { servers: [{ name, path, neutral, ignored }] }; name is null for a bare config.
function parseImport(text) {
  if (!text.trim()) throw new Error('Paste a server config');
  const root = parseText(text);
  if (!root || typeof root !== 'object') throw new Error('Expected a JSON object');
  const found = looksLikeServer(root)
    ? [{ name: typeof root.name === 'string' ? root.name : null, path: [], cfg: root }]
    : findServers(root, [], 0, []);
  if (!found.length) throw new Error('No MCP server found: expected an object with "command" or "url"');
  return { servers: found.map(({ name, path, cfg }) => ({ name, path, ...toNeutral(cfg) })) };
}

module.exports = { parseImport };
