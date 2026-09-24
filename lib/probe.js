// Health check: launch a server exactly as a client would (same command/args/env, or same
// url/headers), do the MCP handshake (initialize -> notifications/initialized -> tools/list)
// and report what the server says about itself.

const { spawn } = require('child_process');

const TIMEOUT_MS = 30_000;       // npx may need to download the package first
const CACHE_TTL_MS = 10 * 60_000;
const PROTOCOL = '2025-06-18';
const CLIENT = { name: 'mcp-manager-probe', version: '1.0.0' };

const cache = new Map();         // spec key -> { at, result }
const inflight = new Map();      // spec key -> Promise

// Native client config -> what the client actually launches.
function launchSpec(format, cfg) {
  if (format === 'codex') {
    if (cfg.url) {
      const headers = { ...(cfg.http_headers || {}) };
      if (cfg.bearer_token_env_var) headers.Authorization = `Bearer ${process.env[cfg.bearer_token_env_var] ?? ''}`;
      return { kind: 'http', url: cfg.url, headers };
    }
    return { kind: 'stdio', command: cfg.command, args: cfg.args || [], env: cfg.env || {}, cwd: cfg.cwd };
  }
  if (cfg.url || cfg.type === 'http' || cfg.type === 'sse') {
    return { kind: cfg.type === 'sse' ? 'sse' : 'http', url: cfg.url, headers: cfg.headers || {} };
  }
  return { kind: 'stdio', command: cfg.command, args: cfg.args || [], env: cfg.env || {} };
}

const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const initParams = { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: CLIENT };

function summarize(init, tools, started) {
  return {
    ok: true,
    name: init?.serverInfo?.name ?? null,
    version: init?.serverInfo?.version ?? null,
    protocol: init?.protocolVersion ?? null,
    tools: Array.isArray(tools) ? tools.length : null,
    toolList: Array.isArray(tools) ? tools.map(t => ({ name: t.name, description: firstSentence(t.description) })) : null,
    ms: Date.now() - started,
  };
}

// Tool descriptions are often paragraphs; the first sentence is enough for a tooltip.
function firstSentence(text) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  const m = s.match(/^.{20,}?[.!?](?=\s|$)/);
  const out = m ? m[0] : s;
  return out.length > 180 ? out.slice(0, 177) + '…' : out;
}

// ---------- stdio ----------

// The useful part of a crash log: the first "...Error: ..." line and what follows, not the node version footer.
function errorExcerpt(stderr) {
  const lines = stderr.split('\n').map(l => l.trimEnd()).filter(l => l && !/^Node\.js v\d/.test(l));
  if (!lines.length) return undefined;
  const i = lines.findIndex(l => /\b\w*Error\b|ERR_|error:/i.test(l));
  return (i >= 0 ? lines.slice(i, i + 6) : lines.slice(-6)).join('\n').slice(0, 800);
}

function probeStdio(spec) {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(spec.command, spec.args, {
        cwd: spec.cwd || undefined,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,             // own process group, so npx + its child die together
      });
    } catch (e) {
      return resolve({ ok: false, error: e.message, ms: 0 });
    }

    let stdout = '', stderr = '', init = null, done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500).unref();
      if (!result.ok) result.stderr = errorExcerpt(stderr);
      resolve(result);
    };
    const send = (msg) => { try { child.stdin.write(JSON.stringify(msg) + '\n'); } catch {} };
    const timer = setTimeout(() => finish({ ok: false, error: `No response in ${TIMEOUT_MS / 1000} s`, ms: Date.now() - started }), TIMEOUT_MS);

    child.on('error', (e) => finish({ ok: false, error: e.code === 'ENOENT' ? `Command not found: ${spec.command}` : e.message, ms: Date.now() - started }));
    child.on('exit', (code, signal) => finish({ ok: false, error: `Process exited before answering (${signal || 'code ' + code})`, ms: Date.now() - started }));
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (d) => {
      stdout += d;
      let nl;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }   // servers sometimes log to stdout
        if (msg.id === 0) {
          if (msg.error) return finish({ ok: false, error: `initialize: ${msg.error.message}`, ms: Date.now() - started });
          init = msg.result;
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send(rpc(1, 'tools/list'));
        } else if (msg.id === 1) {
          finish(summarize(init, msg.result?.tools, started));
        }
      }
    });

    send(rpc(0, 'initialize', initParams));
  });
}

// ---------- streamable HTTP ----------

async function readRpc(res, id, signal) {
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) {
    const body = await res.json();
    return (Array.isArray(body) ? body : [body]).find(m => m.id === id);
  }
  if (!type.includes('text/event-stream')) throw new Error(`Unexpected response: ${res.status} ${type}`);
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let sep;
      while ((sep = buf.search(/\r?\n\r?\n/)) >= 0) {
        const event = buf.slice(0, sep);
        buf = buf.slice(sep).replace(/^\r?\n\r?\n/, '');
        const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
        if (!data) continue;
        try { const msg = JSON.parse(data); if (msg.id === id) return msg; } catch {}
      }
    }
  } finally { reader.cancel().catch(() => {}); }
  return null;
}

async function probeHttp(spec) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const base = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...spec.headers };
  let session = null;
  const post = (body) => fetch(spec.url, {
    method: 'POST', signal: ctrl.signal, body: JSON.stringify(body),
    headers: { ...base, ...(session ? { 'mcp-session-id': session, 'mcp-protocol-version': PROTOCOL } : {}) },
  });

  try {
    const r0 = await post(rpc(0, 'initialize', initParams));
    if (!r0.ok) {
      const text = (await r0.text().catch(() => '')).slice(0, 300);
      return { ok: false, error: `HTTP ${r0.status} ${r0.statusText}`, stderr: text || undefined, ms: Date.now() - started };
    }
    session = r0.headers.get('mcp-session-id');
    const init = await readRpc(r0, 0, ctrl.signal);
    if (!init) return { ok: false, error: 'No response to initialize', ms: Date.now() - started };
    if (init.error) return { ok: false, error: `initialize: ${init.error.message}`, ms: Date.now() - started };

    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then(r => r.body?.cancel()).catch(() => {});
    let tools = null;
    try {
      const r1 = await post(rpc(1, 'tools/list'));
      if (r1.ok) tools = (await readRpc(r1, 1, ctrl.signal))?.result?.tools;
    } catch {}
    if (session) {
      fetch(spec.url, { method: 'DELETE', headers: { ...spec.headers, 'mcp-session-id': session } }).catch(() => {});
    }
    return summarize(init.result, tools, started);
  } catch (e) {
    const msg = e.name === 'AbortError' ? `No response in ${TIMEOUT_MS / 1000} s`
      : e.cause?.code === 'ECONNREFUSED' ? `Connection refused (${new URL(spec.url).host})`
      : e.cause?.message || e.message;
    return { ok: false, error: msg, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- entry ----------

async function probe(format, cfg, { force } = {}) {
  const spec = launchSpec(format, cfg);
  const key = JSON.stringify(spec);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.result, cached: true, at: hit.at };
  if (inflight.has(key)) return inflight.get(key);

  const run = (async () => {
    let result;
    if (spec.kind === 'sse') result = { ok: null, error: 'Health check for the SSE transport is not supported yet' };
    else if (spec.kind === 'http') result = await probeHttp(spec);
    else if (!spec.command) result = { ok: false, error: 'No command specified' };
    else result = await probeStdio(spec);
    const at = Date.now();
    cache.set(key, { at, result });
    return { ...result, at };
  })().finally(() => inflight.delete(key));

  inflight.set(key, run);
  return run;
}

module.exports = { probe };
