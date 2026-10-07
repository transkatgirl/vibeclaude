#!/usr/bin/env node
// VibeClaude daemon
//
//   node daemon.mjs                 run (foreground; the hooks module starts this detached)
//   node daemon.mjs start           make sure a daemon is running; print how to reach it
//   node daemon.mjs scan            connect to Intiface, scan, list vibration-capable devices
//   node daemon.mjs select <index>  select a device from the last scan
//   node daemon.mjs connect         connect to the configured Intiface server
//   node daemon.mjs disconnect      disconnect and stop all device output
//   node daemon.mjs status          is a daemon answering on the port?
//   node daemon.mjs stop            stop all output and exit the daemon
//
// Architecture:
//   hooks module (hooks/register.tsx) --HTTP--> [this process] --WebSocket--> Intiface Central --BLE--> device
//
// A hooks module runs inside Claude Code with no Node, so it cannot run the
// buttplug client or hold a WebSocket. The long-lived parts of the plugin
// (the Intiface connection, the selected device, the vibration engine and its
// handlers) live here. Everything except `run` is a thin client that asks the
// running daemon to do the work.
//
//   POST /events   { pid, events: [{ session, event, ... }] }   what happened, in order
//   POST /cmd      { cmd, ... }                                 a command; replies with its outcome
//   GET  /notices  ?id=&after=&since=                           long poll for the daemon's toasts

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, kv, DATA_DIR, LOG_PATH } from './config.mjs';
import { request, ensureDaemon } from './client.mjs';

const cfg = loadConfig();
// The daemon is the plugin instance: it loads with the first session and
// unloads when the last one ends. A Claude Code that dies without ending its
// session never says so, so the daemon watches the Claude Code process behind
// each session and treats its exit as the session's end.
const LIVENESS_POLL_MS = 5000;
// Where it cannot tell which process that is, it leaves by itself once no
// event or command has reached it for this long.
const IDLE_EXIT_MS = 30 * 60_000;
const MAX_KEPT_NOTICES = 50;
// How long a /notices request waits for a notice before it is answered empty.
const NOTICE_WAIT_MS = 10_000;
// The same message again within this long is one notice, not a stream of them.
const NOTICE_REPEAT_MS = 1000;
// How long shutting down may take before the daemon exits anyway.
const SHUTDOWN_TIMEOUT_MS = 5000;
// How long the port is given to come free when a daemon on its way out still
// holds it: longer than its shutdown may take.
const LISTEN_RETRY_MS = 500;
const LISTEN_ATTEMPTS = 12;
// session.end reasons where the same Claude Code carries straight on with
// another session, so the plugin stays loaded.
const HANDOVER_REASONS = new Set(['clear', 'resume']);
// How many ended sessions are remembered, so that what was still on its way
// when one ended does not bring it back.
const MAX_ENDED_SESSIONS = 100;
// The events a session begins with: one that ended and says either is back
// (a resumed session keeps its id).
const BEGINNING_EVENTS = new Set(['session.start', 'turn.start']);
// VIBECLAUDE_DEBUG=1 logs every event as it arrives.
const DEBUG = Boolean(process.env.VIBECLAUDE_DEBUG);
// The buttplug client uses iterator helpers, which older Nodes do not have.
const MIN_NODE_MAJOR = 22;
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Why no daemon can run from here, said where whoever asked will read it; undefined if one can. */
const cannotRun = () => {
  if (Number(process.versions.node.split('.')[0]) < MIN_NODE_MAJOR) {
    return `Node.js ${MIN_NODE_MAJOR} or newer is needed; "node" is ${process.version}.`;
  }
  try {
    import.meta.resolve('buttplug');
  } catch {
    return `the "buttplug" npm package is missing. Run "npm install" in ${PLUGIN_DIR}, then try again.`;
  }
  return undefined;
};

const isRunning = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
};

function log(...a) {
  console.log(`[${new Date().toISOString()}] ${a.join(' ')}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Resolves once `server` listens on the loopback port; rejects with the error if it cannot. */
const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

const readBody = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'));
      } catch {
        resolve(null);
      }
    });
    req.on('error', () => resolve(null));
  });

async function runDaemon() {
  let createPlugin;
  try {
    ({ createPlugin } = await import('./plugin.mjs'));
  } catch (e) {
    if (e?.code !== 'ERR_MODULE_NOT_FOUND') throw e;
    console.error(`[vibeclaude] the "buttplug" npm package is missing. Run "npm install" in ${PLUGIN_DIR}, then try again.`);
    process.exit(1);
  }

  log(`VibeClaude daemon starting (pid ${process.pid}); data: ${DATA_DIR}`);
  log(`  intiface=${cfg.wsAddress} http=127.0.0.1:${cfg.port}`);

  // Notices are the daemon's toasts. It cannot draw them itself: every
  // session's hooks module waits on /notices and shows them as they come.
  const daemonID = String(Date.now());
  let notices = [];
  let noticeSeq = 0;
  let waiters = [];
  const notify = (message, variant = 'info') => {
    log(`${variant}: ${message}`);
    const last = notices.at(-1);
    const now = Date.now();
    if (last?.message === message && now - last.at < NOTICE_REPEAT_MS) return;
    notices.push({ seq: ++noticeSeq, at: now, message, variant });
    if (notices.length > MAX_KEPT_NOTICES) notices.shift();
    for (const wake of waiters.splice(0)) wake();
  };
  /** The notices a poller has not seen: after its cursor, or since it began. */
  const noticesFor = (query) => {
    if (query.get('id') === daemonID) {
      const after = Number(query.get('after')) || 0;
      return notices.filter((notice) => notice.seq > after);
    }
    const since = Number(query.get('since')) || 0;
    return notices.filter((notice) => notice.at >= since);
  };

  const plugin = createPlugin({ wsAddress: cfg.wsAddress, kv, notify });
  // Sessions that have been heard from and have not ended, each with the
  // Claude Code process its events come from. One that has said the same
  // process twice is trusted to be watched; anything else is not.
  const sessions = new Map();
  const trackSession = (sessionID, pid) => {
    const session = sessions.get(sessionID);
    if (!session) sessions.set(sessionID, { pid, trusted: false });
    else if (session.pid === pid) session.trusted = pid !== null;
    else if (session.pid !== null) sessions.set(sessionID, { pid: null, trusted: false });
    handovers.delete(pid);
  };
  // Claude Codes between sessions: one ended in a handover and the next has
  // not been heard from. The daemon stays for them as it does for a session.
  const handovers = new Set();
  const isUnattended = () => sessions.size === 0 && handovers.size === 0;
  const allTrusted = () => sessions.size > 0 && [...sessions.values()].every((session) => session.trusted);
  // Sessions that have ended, oldest first.
  const endedSessions = new Set();
  const forgetSession = (sessionID) => {
    sessions.delete(sessionID);
    endedSessions.delete(sessionID);
    endedSessions.add(sessionID);
    if (endedSessions.size > MAX_ENDED_SESSIONS) endedSessions.delete(endedSessions.values().next().value);
  };
  let lastActivityAt = Date.now();
  let stopping = false;

  const onEvents = ({ pid: sender, events }) => {
    if (!Array.isArray(events)) return;
    // The events have only just been sent, so a process that is already gone
    // did not send them: `node` was a wrapper that started the real one, and
    // `start` saw the wrapper. Such a session is not watched.
    const pid = Number.isInteger(sender) && isRunning(sender) ? sender : null;
    for (const m of events) {
      if (typeof m?.event !== 'string' || typeof m.session !== 'string') continue;
      if (DEBUG) log('event', JSON.stringify(m));
      // An event that was on its way when its session ended is not the
      // session again: it would never end a second time.
      if (endedSessions.has(m.session)) {
        if (!BEGINNING_EVENTS.has(m.event)) continue;
        endedSessions.delete(m.session);
      }
      // One event that cannot be handled is not worth every session's output.
      try {
        plugin.handleEvent(m);
      } catch (e) {
        log('event failed', m.event, e?.stack ?? e);
      }
      if (m.event !== 'session.end') {
        trackSession(m.session, pid);
        continue;
      }
      forgetSession(m.session);
      if (HANDOVER_REASONS.has(m.reason)) {
        if (pid !== null) handovers.add(pid);
      } else if (isUnattended()) {
        log('last session ended; exiting');
        shutdown();
      }
    }
  };

  const onCommand = async (m) => {
    switch (m?.cmd) {
      case 'ping':
        return { ok: true };
      case 'stop':
        log('stop requested');
        setImmediate(shutdown);
        return { ok: true };
      case 'state':
        return plugin.getState();
      case 'ensure-connected':
        return plugin.ensureConnected();
      case 'scan':
        return plugin.scanForDevices();
      case 'select':
        return plugin.selectDeviceByIndex(m.index);
      case 'connect':
        return plugin.connect();
      case 'disconnect':
        return plugin.disconnect();
      default:
        return { error: `unknown command "${m?.cmd}"` };
    }
  };

  const server = http.createServer(async (req, res) => {
    const reply = (body, status = 200) => {
      if (res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, 'http://127.0.0.1');
    // A web page can reach a loopback port too. One that got here under a
    // name of its own (DNS rebinding) is not asking this host; any other
    // cannot send JSON without a preflight, which is never granted.
    const host = req.headers.host;
    if (host !== `127.0.0.1:${cfg.port}` && host !== `localhost:${cfg.port}`) return reply({ error: 'forbidden' }, 403);
    if (req.method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      return reply({ error: 'unsupported media type' }, 415);
    }
    // On its way out, it is no one's daemon: a session that asks now starts
    // another, which waits for this one to go, and sends its events there.
    if (stopping) return reply({ error: 'the daemon is stopping' }, 503);
    lastActivityAt = Date.now();

    if (req.method === 'GET' && url.pathname === '/notices') {
      const answer = () => reply({ id: daemonID, seq: noticeSeq, notices: noticesFor(url.searchParams) });
      if (noticesFor(url.searchParams).length > 0) return answer();
      const forget = () => {
        clearTimeout(timer);
        waiters = waiters.filter((waiter) => waiter !== wake);
      };
      const wake = () => {
        forget();
        answer();
      };
      const timer = setTimeout(wake, NOTICE_WAIT_MS);
      waiters.push(wake);
      res.on('close', forget);
      return;
    }

    if (req.method !== 'POST') return reply({ error: 'not found' }, 404);
    const body = await readBody(req);
    if (body === null) return reply({ error: 'bad request' }, 400);
    if (url.pathname === '/events') {
      // Answered first: nothing an event does is worth making the session wait.
      reply({ ok: true });
      onEvents(body);
      return;
    }
    if (url.pathname === '/cmd') {
      try {
        return reply(await onCommand(body));
      } catch (e) {
        log('command failed', body?.cmd, e?.stack ?? e);
        return reply({ error: 'Command failed: ' + String(e) });
      }
    }
    reply({ error: 'not found' }, 404);
  });
  // The port may still be a leaving daemon's (the last session ended as this
  // one's first began): wait for it to go. One that answers is here to stay,
  // and this one is not needed.
  for (let attempt = 0; ; attempt++) {
    try {
      await listen(server, cfg.port);
      break;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE') throw e;
      if ((await request({ cmd: 'ping' }, 400))?.ok === true) {
        log(`port ${cfg.port} is in use: another daemon is running. Exiting.`);
        process.exit(0);
      }
      if (attempt >= LISTEN_ATTEMPTS) {
        log(`port ${cfg.port} is in use and nothing on it answers as a daemon. Exiting.`);
        process.exit(1);
      }
      if (attempt === 0) log(`port ${cfg.port} is in use by a daemon that is stopping; waiting for it`);
      await sleep(LISTEN_RETRY_MS);
    }
  }
  server.on('error', (e) => log('http error', e.message));

  plugin.start();

  const lifeTimer = setInterval(() => {
    let hasLeft = false;
    for (const pid of handovers) {
      if (isRunning(pid)) continue;
      log(`Claude Code (pid ${pid}) is gone before its next session`);
      handovers.delete(pid);
      hasLeft = true;
    }
    for (const [sessionID, session] of sessions) {
      if (!session.trusted || isRunning(session.pid)) continue;
      log(`Claude Code (pid ${session.pid}) is gone; ending its session`);
      plugin.handleEvent({ event: 'session.end', session: sessionID });
      forgetSession(sessionID);
      hasLeft = true;
    }
    if (hasLeft && isUnattended()) {
      log('last session ended; exiting');
      shutdown();
      return;
    }
    if (!allTrusted() && Date.now() - lastActivityAt > IDLE_EXIT_MS) {
      log('no activity for 30 min; exiting');
      shutdown();
    }
  }, LIVENESS_POLL_MS);

  async function shutdown() {
    if (stopping) return;
    stopping = true;
    clearInterval(lifeTimer);
    try {
      await Promise.race([plugin.dispose(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS))]);
    } catch (e) {
      log('shutdown error', e?.message ?? e);
    } finally {
      for (const wake of waiters.splice(0)) wake();
      server.close();
      server.closeAllConnections();
      log('bye');
      process.exit(0);
    }
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, shutdown);
  for (const failure of ['uncaughtException', 'unhandledRejection']) {
    process.on(failure, (e) => {
      log('uncaught', e?.stack ?? e);
      shutdown();
    });
  }
}

/** Run one command against the daemon (starting it if needed) and print the outcome. */
async function command(message, timeoutMs, print) {
  if (!(await ensureDaemon())) {
    console.error('Intiface: the VibeClaude daemon did not start. See ' + LOG_PATH);
    process.exit(1);
  }
  const result = await request(message, timeoutMs);
  if (!result) {
    console.error('Intiface: the VibeClaude daemon did not answer');
    process.exit(1);
  }
  if (result.error) {
    console.error(`Intiface: ${result.error}`);
    process.exit(1);
  }
  print(result);
  process.exit(0);
}

// No mode, or flags alone (`node daemon.mjs --home <dir>`), is `run`.
const mode = process.argv[2] === undefined || process.argv[2].startsWith('--') ? 'run' : process.argv[2];
if (mode !== 'status' && mode !== 'stop') {
  const obstacle = cannotRun();
  if (obstacle !== undefined) {
    console.error(obstacle);
    process.exit(1);
  }
}
switch (mode) {
  case 'run':
    await runDaemon();
    break;
  case 'start':
    // What the hooks module runs. `pid` is the Claude Code that ran it: the
    // daemon stays for as long as that process is running.
    if (!(await ensureDaemon())) {
      console.error('the VibeClaude daemon did not start. See ' + LOG_PATH);
      process.exit(1);
    }
    console.log(JSON.stringify({ port: cfg.port, pid: process.ppid }));
    process.exit(0);
  // eslint-disable-next-line no-fallthrough
  case 'scan':
    await command({ cmd: 'scan' }, 20_000, ({ devices, selected }) => {
      if (devices.length === 0) {
        console.log('No vibration-capable devices found');
        return;
      }
      console.log('Select device:');
      for (const device of devices) {
        console.log(`  ${device.name} (Device #${device.index})${selected === device.index ? '  [Connected]' : ''}`);
      }
    });
    break;
  case 'select': {
    const index = Number(process.argv[3]);
    if (!Number.isInteger(index)) {
      console.error('Usage: node daemon.mjs select <device index>');
      process.exit(2);
    }
    await command({ cmd: 'select', index }, 2000, ({ message }) => console.log(`Intiface: ${message}`));
    break;
  }
  case 'connect':
  case 'disconnect':
    await command({ cmd: mode }, 10_000, ({ message }) => console.log(`Intiface: ${message}`));
    break;
  case 'status': {
    const up = (await request({ cmd: 'ping' }, 500))?.ok === true;
    console.log(up ? `daemon is running (http 127.0.0.1:${cfg.port})` : 'daemon is not running');
    process.exit(up ? 0 : 1);
  }
  // eslint-disable-next-line no-fallthrough
  case 'stop':
    await request({ cmd: 'stop' }, 500);
    console.log('stop sent');
    process.exit(0);
  // eslint-disable-next-line no-fallthrough
  default:
    console.error(`unknown mode "${mode}". Use: run | start | scan | select | connect | disconnect | status | stop`);
    process.exit(2);
}
