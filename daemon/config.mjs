// Shared configuration and persisted state for the VibeClaude plugin.
//
// Settings come from Claude Code's plugin options (`userConfig` in
// .claude-plugin/plugin.json), which the hooks module receives and passes on
// as `--ws <address>`. State lives in ~/.config/vibeclaude, or in the
// directory given as `--home <dir>` (the end-to-end test uses that):
//
//   state.json    written by the daemon: the last selected device
//   daemon.log    the daemon's log
//   config.json   optional, written by you: { "port": 12350 }
//
// Whoever starts the daemon hands both flags on.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// An empty value means "not set": that is what an unconfigured option looks like.
const flag = (name) => {
  const at = process.argv.indexOf(name);
  return (at > 0 && process.argv[at + 1]) || undefined;
};

export const DATA_DIR = flag('--home') ?? join(homedir(), '.config', 'vibeclaude');
export const CONFIG_PATH = join(DATA_DIR, 'config.json');
export const STATE_PATH = join(DATA_DIR, 'state.json');
export const LOG_PATH = join(DATA_DIR, 'daemon.log');

const WS_ADDRESS_OPTION = flag('--ws');

/** Arguments that give a daemon started from this process the same settings. */
export const DAEMON_ARGS = ['--home', DATA_DIR, ...(WS_ADDRESS_OPTION ? ['--ws', WS_ADDRESS_OPTION] : [])];

export const DEFAULTS = {
  // Intiface Central WebSocket server (Settings → Server → Websocket port)
  wsAddress: 'ws://127.0.0.1:12345',
  // Local HTTP port the hooks module talks to the daemon on (loopback only)
  port: 12350,
};

const readJSON = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    /* missing or unparsable: treat as empty */
    return {};
  }
};

export function loadConfig() {
  const file = readJSON(CONFIG_PATH);
  const fileAddress = typeof file.wsAddress === 'string' && file.wsAddress.length > 0 ? file.wsAddress : undefined;
  return {
    wsAddress: WS_ADDRESS_OPTION ?? fileAddress ?? DEFAULTS.wsAddress,
    port: Number(file.port) || DEFAULTS.port,
  };
}

/** Tiny key/value store for daemon state. */
export const kv = {
  get(key, fallback) {
    const state = readJSON(STATE_PATH);
    return key in state ? state[key] : fallback;
  },
  set(key, value) {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify({ ...readJSON(STATE_PATH), [key]: value }, null, 2) + '\n');
  },
};
