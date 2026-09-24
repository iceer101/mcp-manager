// Which desktop apps need a restart to pick up config changes, and restarting them.
// An app needs a restart when it is running and was started before its config last changed.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

const APPS = {
  desktop: { label: 'Claude Desktop', app: '/Applications/Claude.app', exe: 'Contents/MacOS/Claude' },
  codex: { label: 'Codex', app: '/Applications/Codex.app', exe: 'Contents/MacOS/Codex' },
};

const CHANGES_FILE = path.join(process.env.MCP_MANAGER_DATA || path.join(require('os').homedir(), '.mcp-manager'), 'changes.json');

function loadChanges() {
  try { return JSON.parse(fs.readFileSync(CHANGES_FILE, 'utf8')); } catch { return {}; }
}

// Called on every config write; persisted so it survives the manager's idle shutdown.
function markChanged(client) {
  if (!APPS[client]) return;
  const changes = loadChanges();
  changes[client] = Date.now();
  fs.mkdirSync(path.dirname(CHANGES_FILE), { recursive: true });
  fs.writeFileSync(CHANGES_FILE, JSON.stringify(changes, null, 2) + '\n');
}

// Start time (ms) of the app's main process, or null when it isn't running.
async function startedAt(client) {
  const exe = path.join(APPS[client].app, APPS[client].exe);
  const { stdout } = await run('ps', ['-axo', 'lstart=,command=']);
  for (const line of stdout.split('\n')) {
    // lstart is fixed width: "Thu Sep 24 17:13:43 2026"
    const cmd = line.slice(24).trim();
    if (cmd === exe || cmd.startsWith(exe + ' ')) {
      const t = Date.parse(line.slice(0, 24));
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

async function status() {
  const changes = loadChanges();
  return Promise.all(Object.entries(APPS).map(async ([client, a]) => {
    const started = await startedAt(client);
    const changedAt = changes[client] ?? null;
    return {
      client, label: a.label, running: started != null, startedAt: started, changedAt,
      // lstart has 1 s resolution, so "started after the change" is the safe comparison.
      needsRestart: started != null && changedAt != null && started < changedAt,
    };
  }));
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function restart(client) {
  const a = APPS[client];
  if (!a) throw new Error(`Unknown app: ${client}`);
  if (await startedAt(client) != null) {
    // A normal quit, so the app can save state (and ask if it has unsaved work).
    await run('osascript', ['-e', `tell application "${a.app}" to quit`]).catch(() => {});
    for (let i = 0; ; i++) {
      await sleep(500);
      if (await startedAt(client) == null) break;
      if (i >= 40) throw new Error(`${a.label} did not quit within 20 s — it may be waiting for confirmation. Quit it manually.`);
    }
    await sleep(500);
  }
  await run('open', [a.app]);
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    if (await startedAt(client) != null) return;
  }
  throw new Error(`${a.label} did not start`);
}

module.exports = { APPS, markChanged, status, restart };
