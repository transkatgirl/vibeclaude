// Talking to the daemon over loopback HTTP: one JSON request, one JSON reply.
// Used by the command-line modes; the hooks module speaks the same protocol
// through Claude Code.
import http from 'node:http';
import { openSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, DATA_DIR, LOG_PATH, DAEMON_ARGS } from './config.mjs';

const DAEMON = join(dirname(fileURLToPath(import.meta.url)), 'daemon.mjs');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Send a command; resolve with the daemon's reply, or null if none came within `timeoutMs`. */
export function request(message, timeoutMs) {
  const { port } = loadConfig();
  const body = JSON.stringify(message);
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/cmd',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(text));
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end(body);
  });
}

/** Start the daemon detached, logging to daemon.log. */
export function startDaemon() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    const log = openSync(LOG_PATH, 'a');
    const child = spawn(process.execPath, [DAEMON, 'run', ...DAEMON_ARGS], {
      detached: true,
      stdio: ['ignore', log, log],
      windowsHide: true,
    });
    child.unref();
  } catch {
    /* no daemon; whoever asked will be told */
  }
}

/** Make sure a daemon is answering, starting one if needed and giving it `attempts` x 250ms to come up. */
export async function ensureDaemon(attempts = 20) {
  if (await request({ cmd: 'ping' }, 400)) return true;
  startDaemon();
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(250);
    if (await request({ cmd: 'ping' }, 400)) return true;
  }
  return false;
}
