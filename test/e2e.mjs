// End-to-end: mock Intiface ← daemon ← HTTP ← the events the hooks module sends.
//   node test/e2e.mjs
import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { startMock } from './mock-intiface.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const WS_PORT = 23456;
const HTTP_PORT = 23457;
const home = mkdtempSync(join(tmpdir(), 'vibeclaude-e2e-'));
writeFileSync(join(home, 'config.json'), JSON.stringify({ wsAddress: `ws://127.0.0.1:${WS_PORT}`, port: HTTP_PORT }));
const HOME = ['--home', home];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Nothing of an earlier run may hold a port: the daemon exits when its port
// is taken, and the suite would go on against whatever has it.
const isPortTaken = (port) =>
  new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
  });
for (const port of [WS_PORT, HTTP_PORT]) {
  if (await isPortTaken(port)) {
    console.error(`port ${port} is in use (a daemon or mock of an earlier run?); stop it first: lsof -nP -iTCP:${port}`);
    process.exit(2);
  }
}

let mock = startMock(WS_PORT, { log: () => {} });

/** Run a node script to completion; resolves with { code, stdout, stderr }. */
function run(script, args, stdin) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(root, script), ...args, ...HOME], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('exit', (code) => resolve({ code, stdout, stderr }));
    p.stdin.end(stdin ?? '');
  });
}
const cli = (...args) => run('daemon/daemon.mjs', args);

const url = (path) => `http://127.0.0.1:${HTTP_PORT}${path}`;
/** What the hooks module does: tell the daemon what happened in a session, in order. */
const sendAs = (session, pid, ...events) =>
  fetch(url('/events'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pid, events: events.map((event) => ({ session, ...event })) }),
  }).catch(() => null);
const send = (...events) => sendAs('test', process.pid, ...events);
const other = (...events) => sendAs('other', process.pid, ...events);
const notices = async (query) => (await (await fetch(url(`/notices?${query}`))).json()).notices.map((n) => n.message);

function startDaemon() {
  const daemon = spawn(process.execPath, [join(root, 'daemon', 'daemon.mjs'), 'run', ...HOME], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  daemon.stdout.on('data', (d) => process.stdout.write(`[daemon] ${d}`));
  return daemon;
}

/** Vibrate levels (out of 20) the device was sent since `since`, stops excluded. */
const levels = (since) => mock.outputs.filter((o) => o.t >= since && !o.stop).map((o) => o.value);
const stopped = () => Boolean(mock.outputs.at(-1)?.stop);
/**
 * What the device played since `since`, as { value, ms } in order, a stop
 * being 0. A level it was sent again (one channel of the mixer changed
 * beneath a stronger one) is the same stretch going on.
 */
const stretches = (since) => {
  const played = [];
  for (const o of mock.outputs.filter((output) => output.t >= since)) {
    const value = o.stop ? 0 : o.value;
    if (played.at(-1)?.value !== value) played.push({ value, t: o.t });
  }
  return played.map(({ value, t }, i) => ({ value, ms: (played[i + 1]?.t ?? Date.now()) - t }));
};
const felt = (since) => stretches(since).map((stretch) => stretch.value);
let failures = 0;
function expect(name, cond, detail = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${detail}`);
  if (!cond) failures++;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const began = Date.now();
let daemon = startDaemon();
await sleep(1000); // daemon connects to mock
if (daemon.exitCode !== null) {
  console.error(`the daemon exited (${daemon.exitCode}) as it started; see its log above`);
  process.exit(2);
}

// Device selection ------------------------------------------------------------
let t = Date.now();
await send({ event: 'session.start' }, { event: 'tool.finished', id: 'a0', tool: 'Bash', status: 'completed' });
await sleep(300);
expect('nothing plays until a device is selected', levels(t).length === 0);

let seen = await notices(`since=${began}`);
expect('the startup notice is waiting for the session', seen.includes('Connected to Intiface'), `(${seen})`);

let r = await cli('scan');
expect('scan lists the vibrating device', r.code === 0 && r.stdout.includes('Mock Vibe 3000 (Device #0)'), `(${r.stdout.trim()})`);
r = await cli('select', '7');
expect('selecting an unknown device fails', r.code === 1, `(${r.stderr.trim()})`);
r = await cli('select', '0');
expect('select reports the device', r.stdout.includes('Intiface: Selected Mock Vibe 3000'), `(${r.stdout.trim()})`);
const saved = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))['vibeclaude.selected-device'];
expect('the selection is persisted', same(saved, { index: 0, name: 'Mock Vibe 3000' }), `(${JSON.stringify(saved)})`);
r = await cli('scan');
expect('scan marks the selected device', r.stdout.includes('[Connected]'));

// Requests a web page could make ----------------------------------------------
t = Date.now();
const asked = JSON.stringify({ events: [{ session: 'page', event: 'permission.asked', id: 'p1' }] });
let res = await fetch(url('/events'), { method: 'POST', headers: { 'content-type': 'text/plain' }, body: asked });
expect('a request that is not JSON is refused', res.status === 415, `(${res.status})`);
const status = await new Promise((resolve) => {
  const req = http.request(
    { host: '127.0.0.1', port: HTTP_PORT, path: '/events', method: 'POST', headers: { host: 'rebound.example', 'content-type': 'application/json' } },
    (answer) => resolve(answer.statusCode),
  );
  req.end(asked);
});
expect('…and so is one under another host name', status === 403, `(${status})`);
await sleep(300);
expect('…and neither plays anything', levels(t).length === 0, `(${levels(t)})`);

// A device that drops off and comes back --------------------------------------------
// Another session is holding as it goes: its level is not played on a device that left.
const held = (...events) => sendAs('held', process.pid, ...events);
await held({ event: 'session.start' }, { event: 'tool.started', id: 'h1', tool: 'Edit' });
await sleep(200);
let mark = Date.now();
mock.setDevicePresent(false);
await sleep(300);
t = Date.now();
await send({ event: 'tool.started', id: 'x1', tool: 'Bash' });
await sleep(300);
seen = await notices(`since=${mark}`);
expect('a device that drops off is said and plays nothing', seen.includes('Device disconnected: Mock Vibe 3000') && levels(t).length === 0, `(${seen}; ${levels(t)})`);
expect('…and nothing else is said of it', seen.length === 1, `(${seen})`);
await held({ event: 'session.end', reason: 'other' });
await sleep(200);
mark = Date.now();
mock.setDevicePresent(true);
await sleep(300);
t = Date.now();
await send({ event: 'tool.started', id: 'x2', tool: 'Bash' });
await sleep(400);
seen = await notices(`since=${mark}`);
expect('…and is selected again when it comes back', seen.includes('Restored Mock Vibe 3000') && same(levels(t), [10]), `(${seen}; ${levels(t)})`);

// A command that throws is answered, and the daemon goes on ---------------------------
r = await (await fetch(url('/cmd'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cmd: 'select', index: { toString: 1 } }) })).json();
expect('a command that throws answers with its error', typeof r.error === 'string' && r.error.startsWith('Command failed'), `(${JSON.stringify(r)})`);
await send({ event: 'tool.finished', id: 'x3', tool: 'TodoWrite', status: 'completed', todos: [null] });
await sleep(450);
t = Date.now();
await send({ event: 'tool.started', id: 'x4', tool: 'Bash' });
await sleep(400);
expect('…and an event that throws leaves the daemon playing', daemon.exitCode === null && same(levels(t), [10]), `(exit ${daemon.exitCode}; ${levels(t)})`);

// Tools -------------------------------------------------------------------------
t = Date.now();
await send({ event: 'tool.input.started', id: 'a1', tool: 'Bash' });
await sleep(400);
expect('a tool call is one pulse at 0.5 as the model starts writing it', same(levels(t), [10]) && stopped(), `(${levels(t)})`);
await send({ event: 'tool.input.ended', id: 'a1' }, { event: 'tool.started', id: 'a1', tool: 'Bash' });
await sleep(300);
expect('…and not another when it runs', same(levels(t), [10]), `(${levels(t)})`);

t = Date.now();
await send({ event: 'tool.finished', id: 'a1', tool: 'Bash', status: 'completed' });
await sleep(450);
expect('tool success ends on a pulse at 0.7', levels(t).at(-1) === 14 && stopped(), `(${levels(t)})`);

t = Date.now();
await send({ event: 'tool.started', id: 'a2', tool: 'Bash' });
await sleep(400);
expect('a tool call that was never seen streaming still pulses', same(levels(t), [10]) && stopped(), `(${levels(t)})`);
t = Date.now();
await send({ event: 'tool.finished', id: 'a2', tool: 'Bash', status: 'error' });
await sleep(500);
expect('tool failure is one pulse at 1.0', same(levels(t), [20]) && stopped(), `(${levels(t)})`);

t = Date.now();
await send({ event: 'tool.input.started', id: 'a3', tool: 'Edit' });
await sleep(700);
expect('an edit holds at 0.3 while the model writes it, with no start pulse', same(levels(t), [6]) && !stopped(), `(${levels(t)})`);
await send({ event: 'tool.input.ended', id: 'a3' }, { event: 'tool.started', id: 'a3', tool: 'Edit' });
await sleep(400);
expect('…and while it is applied', levels(t).every((v) => v === 6) && !stopped(), `(${levels(t)})`);
await send({ event: 'tool.finished', id: 'a3', tool: 'Edit', status: 'completed' });
await sleep(450);
expect('…until the edit completes', levels(t).at(-1) === 14 && stopped(), `(${levels(t)})`);

// Output ------------------------------------------------------------------------
t = Date.now();
await send({ event: 'text.started', id: 'm1' });
for (let i = 0; i < 8; i++) {
  await send({ event: 'text.delta', id: 'm1', chars: 4 });
  await sleep(100);
}
let stream = levels(t);
expect('streamed text pulses between 0.35 and 0.8', stream.length >= 6 && stream.every((v) => v >= 7 && v <= 16), `(${stream})`);
await send({ event: 'text.ended', id: 'm1' });
await sleep(200);
expect('…and stops with the text', stopped());

t = Date.now();
await send({ event: 'output.snapshot', id: 's1' });
await sleep(400);
expect('a response delivered whole is one pulse at 0.4', same(levels(t), [8]) && stopped(), `(${levels(t)})`);
await send({ event: 'output.snapshot', id: 's1' });
await sleep(300);
expect('…once for that part', same(levels(t), [8]), `(${levels(t)})`);

// A slow device ------------------------------------------------------------------
// One that takes a while to answer is sent the latest level, not every one in
// turn; one that leaves mid-stream is not told what was on its way to it.
mock.setReplyDelay(40);
t = Date.now();
await send({ event: 'text.started', id: 'm2' });
for (let i = 0; i < 60; i++) {
  await send({ event: 'text.delta', id: 'm2', chars: 4 });
  await sleep(15);
}
await send({ event: 'text.ended', id: 'm2' });
const ended = Date.now();
await sleep(400);
const slow = mock.outputs.filter((o) => o.t >= t);
expect(
  'a fast stream to a slow device is not queued up',
  slow.length < 40 && stopped() && slow.at(-1).t - ended < 200,
  `(${slow.length} commands; stop ${slow.at(-1)?.t - ended}ms after the end)`,
);
mark = Date.now();
await send({ event: 'text.started', id: 'm3' });
for (let i = 0; i < 10; i++) {
  await send({ event: 'text.delta', id: 'm3', chars: 4 });
  await sleep(15);
}
mock.setDevicePresent(false);
for (let i = 0; i < 10; i++) {
  await send({ event: 'text.delta', id: 'm3', chars: 4 });
  await sleep(15);
}
await send({ event: 'text.ended', id: 'm3' });
await sleep(300);
seen = await notices(`since=${mark}`);
expect('a device that leaves mid-stream is not told what was on its way', same(seen, ['Device disconnected: Mock Vibe 3000']), `(${seen})`);
mock.setReplyDelay(0);
mock.setDevicePresent(true);
await sleep(300);
seen = await notices(`since=${mark}`);
expect('…and is selected again when it is back', seen.includes('Restored Mock Vibe 3000'), `(${seen})`);

// Thinking -----------------------------------------------------------------------
t = Date.now();
await send({ event: 'reasoning.started', id: 'r0' });
await sleep(400);
await send({ event: 'reasoning.ended', id: 'r0' });
await sleep(200);
expect('thinking whose text is withheld is not felt', levels(t).length === 0, `(${levels(t)})`);

t = Date.now();
await send({ event: 'reasoning.started', id: 'r1' });
for (let i = 0; i < 8; i++) {
  await send({ event: 'reasoning.delta', id: 'r1', chars: 40 });
  await sleep(100);
}
stream = levels(t);
expect('thinking pulses as it streams', stream.length >= 7 && stream.every((v) => v >= 7 && v <= 16), `(${stream})`);
expect('…harder the faster it comes', stream.at(-1) === 16, `(${stream})`);
t = Date.now();
await send({ event: 'reasoning.ended', id: 'r1' }, { event: 'tool.input.started', id: 'r2', tool: 'Read' });
await sleep(400);
expect('…and gives way to the tool call that follows', same(levels(t), [10]) && stopped(), `(${levels(t)})`);
await send({ event: 'tool.finished', id: 'r2', tool: 'Read', status: 'completed' });
await sleep(450);

// Permission --------------------------------------------------------------------
await send({ event: 'tool.started', id: 'a4', tool: 'Bash' });
await sleep(300);
t = Date.now();
await send({ event: 'permission.asked', id: 'a4' });
await sleep(2400);
const asks = levels(t);
expect('a permission request repeats bursts at 0.85', asks.length >= 6 && asks.every((v) => v === 17), `(${asks})`);
await send({ event: 'tool.started', id: 'a4b', tool: 'Read' }, { event: 'tool.finished', id: 'a4b', tool: 'Read', status: 'completed' });
await sleep(450);
t = Date.now();
await sleep(1200);
expect('…through other tool calls', levels(t).includes(17), `(${levels(t)})`);
await send({ event: 'permission.replied', id: 'a4' });
await sleep(300);
t = Date.now();
await sleep(1200);
expect('…and stops once it is answered, while the tool still runs', levels(t).length === 0 && stopped(), `(${levels(t)})`);
await send({ event: 'tool.finished', id: 'a4', tool: 'Bash', status: 'completed' });
await sleep(450);

await send({ event: 'tool.started', id: 'a4c', tool: 'Bash' });
await sleep(300);
await send({ event: 'permission.asked', id: 'a4c' });
// Between its bursts: a pulse of one still on its way would take the failure pulse's place.
await sleep(700);
t = Date.now();
await send({ event: 'tool.finished', id: 'a4c', tool: 'Bash', status: 'error' }, { event: 'turn.complete', reason: 'aborted' });
await sleep(700);
expect('a rejected request is the failure pulse, then the turn ending', same(levels(t), [20, 20, 20, 20]) && stopped(), `(${levels(t)})`);
t = Date.now();
await sleep(1200);
expect('…and stops asking', levels(t).length === 0, `(${levels(t)})`);

await send({ event: 'permission.asked', id: 'a4d' });
await sleep(400);
await send({ event: 'turn.complete', reason: 'answer' });
await sleep(700);
t = Date.now();
await sleep(1200);
expect('a request left unanswered stops asking when its turn ends', levels(t).length === 0 && stopped(), `(${levels(t)})`);

await send({ event: 'tool.started', id: 'a4e', tool: 'Bash', agent: 'agent-1' }, { event: 'permission.asked', id: 'a4e' });
await sleep(400);
await send({ event: 'turn.complete', reason: 'answer' });
await sleep(700);
t = Date.now();
await sleep(1200);
expect('…but a subagent\'s goes on asking: it may run on in the background', levels(t).includes(17), `(${levels(t)})`);
await send({ event: 'tool.finished', id: 'a4e', tool: 'Bash', status: 'error', agent: 'agent-1' });
await sleep(450);
t = Date.now();
await sleep(1200);
expect('…until its call ends', levels(t).length === 0 && stopped(), `(${levels(t)})`);

await send(
  { event: 'tool.started', id: 'a4f', tool: 'Bash', agent: 'agent-1' },
  { event: 'permission.asked', id: 'a4f' },
  { event: 'tool.started', id: 'a4g', tool: 'Edit', agent: 'agent-1' },
);
await sleep(400);
await send({ event: 'agent.complete', agent: 'agent-2', reason: 'answer' });
await sleep(700);
t = Date.now();
await sleep(1200);
expect('another subagent\'s run ending leaves it asking', levels(t).includes(17), `(${levels(t)})`);
await send({ event: 'agent.complete', agent: 'agent-1', reason: 'aborted' });
await sleep(450);
t = Date.now();
await sleep(1200);
expect('…and its own run ending ends what its calls left: the prompt and the edit hold', levels(t).length === 0 && stopped(), `(${levels(t)})`);

// Todos ---------------------------------------------------------------------------
const todos = (status) => ({ todos: [{ key: 'write tests', status }] });
await send({ event: 'tool.finished', id: 'a5', tool: 'TodoWrite', status: 'completed', ...todos('in_progress') });
await sleep(450);
t = Date.now();
await send({ event: 'tool.finished', id: 'a6', tool: 'TodoWrite', status: 'completed', ...todos('completed') });
await sleep(450);
expect('a newly completed todo is a pulse at 0.8, then the tool\'s success pulse', same(levels(t), [16, 14]) && stopped(), `(${levels(t)})`);
t = Date.now();
await send({ event: 'tool.finished', id: 'a7', tool: 'TodoWrite', status: 'completed', ...todos('completed') });
await sleep(450);
expect('…but only once', !levels(t).includes(16), `(${levels(t)})`);
t = Date.now();
await send({ event: 'tool.finished', id: 'a7t', tool: 'TaskUpdate', status: 'completed', todo: { key: '3', status: 'completed' } });
await sleep(450);
expect('a completed task is felt the same way', same(levels(t), [16, 14]) && stopped(), `(${levels(t)})`);

// Sessions ------------------------------------------------------------------------
await send({ event: 'tool.started', id: 'b3', tool: 'Edit' });
await sleep(200);
t = Date.now();
await other({ event: 'tool.started', id: 'b1', tool: 'Bash' });
await sleep(400);
expect('a second session is felt over the first, which then carries on', same(levels(t), [10, 6]) && !stopped(), `(${levels(t)})`);
await other({ event: 'tool.started', id: 'b4', tool: 'Edit' });
await sleep(200);
await other({ event: 'turn.complete', reason: 'aborted' });
await sleep(700);
expect('interrupting one session leaves the other playing', levels(t).at(-1) === 6 && !stopped(), `(${levels(t)})`);
await other({ event: 'session.end', reason: 'other' });
await sleep(300);
expect('…and so does one that ends', levels(t).at(-1) === 6 && !stopped(), `(${levels(t)})`);
t = Date.now();
await send({ event: 'tool.finished', id: 'b3', tool: 'Edit', status: 'completed' });
await sleep(450);
expect('…and leaves the first one as it was', same(levels(t), [14]) && daemon.exitCode === null, `(${levels(t)})`);

// Turns ---------------------------------------------------------------------------
t = Date.now();
await send({ event: 'tool.started', id: 'i1', tool: 'Edit' });
await sleep(300);
await send({ event: 'turn.complete', reason: 'aborted' });
await sleep(700);
expect('interrupting the turn stops an edit hold and plays the turn ending', same(levels(t), [6, 20, 20, 20]) && stopped(), `(${levels(t)})`);

await send({ event: 'tool.started', id: 'i2', tool: 'Bash' }, { event: 'permission.asked', id: 'i2' });
await sleep(700);
await send({ event: 'turn.complete', reason: 'aborted' });
await sleep(700);
t = Date.now();
await sleep(1200);
expect('…and a permission request', levels(t).length === 0 && stopped(), `(${levels(t)})`);

t = Date.now();
await send({ event: 'turn.complete', reason: 'answer' });
await sleep(700);
expect('turn completion is three pulses at 1.0', same(levels(t), [20, 20, 20]) && stopped(), `(${levels(t)})`);

t = Date.now();
await send({ event: 'tool.started', id: 'a8', tool: 'Edit' });
await sleep(200);
await send({ event: 'turn.complete', reason: 'error' });
await sleep(700);
expect('a failed turn ends the same way', same(levels(t), [6, 20, 20, 20]) && stopped(), `(${levels(t)})`);

// Subagents -----------------------------------------------------------------------
// What a subagent thinks and says is felt like the conversation's own, but is
// the subagent's: it goes on past the turn that started it, and ends with its
// run. It plays on a channel of its own, mixed with the conversation's and
// the other subagents' as another session's is.
const says = (id, agent, chars = 4) => ({ event: 'text.delta', id, chars, agent });
t = Date.now();
await send({ event: 'text.started', id: 'q1', agent: 'agent-1' });
for (let i = 0; i < 8; i++) {
  await send(says('q1', 'agent-1'));
  await sleep(100);
}
stream = levels(t);
expect('a subagent\'s text pulses as it streams', stream.length >= 6 && stream.every((v) => v >= 7 && v <= 16), `(${stream})`);

t = Date.now();
await send({ event: 'turn.complete', reason: 'answer' });
for (let i = 0; i < 16; i++) {
  await send(says('q1', 'agent-1'));
  await sleep(30);
}
await sleep(300);
const ending = stretches(t).filter((stretch) => stretch.value === 20);
expect(
  'the turn ending is felt whole over a subagent that is still talking',
  ending.length === 3 && ending.every((stretch) => stretch.ms >= 80),
  `(${stretches(t).map((stretch) => `${stretch.value} for ${stretch.ms}ms`).join(', ')})`,
);
const between = felt(t).slice(felt(t).indexOf(20), felt(t).lastIndexOf(20));
expect('…which is felt between its pulses', between.some((v) => v >= 7 && v <= 16), `(${felt(t)})`);
t = Date.now();
for (let i = 0; i < 4; i++) {
  await send(says('q1', 'agent-1'));
  await sleep(100);
}
stream = levels(t);
expect('…and the subagent is felt on after it', stream.length >= 3 && stream.every((v) => v >= 7 && v <= 16), `(${stream})`);

t = Date.now();
await send({ event: 'agent.complete', agent: 'agent-1', reason: 'answer' });
await sleep(450);
expect('a subagent\'s run ending is felt as a tool call succeeding', same(levels(t), [14]) && stopped(), `(${levels(t)})`);
t = Date.now();
await send({ event: 'agent.complete', agent: 'agent-1', reason: 'aborted' });
await sleep(500);
expect('…or failing, when the run was interrupted', same(levels(t), [20]) && stopped(), `(${levels(t)})`);

// The strongest of a session's loops is felt, and the rest when it stops.
t = Date.now();
await send({ event: 'tool.started', id: 'q4', tool: 'Edit' });
await sleep(200);
await send({ event: 'tool.started', id: 'q5', tool: 'Bash', agent: 'agent-3' });
await sleep(400);
expect('a subagent\'s tool call is felt over the conversation\'s edit hold, which then carries on', same(felt(t), [6, 10, 6]) && !stopped(), `(${felt(t)})`);
t = Date.now();
await send({ event: 'agent.complete', agent: 'agent-3', reason: 'answer' });
await sleep(450);
expect('…and so is the end of its run', same(felt(t), [14, 6]) && !stopped(), `(${felt(t)})`);
t = Date.now();
await send({ event: 'tool.started', id: 'q6', tool: 'Edit', agent: 'agent-4' });
await sleep(200);
await send({ event: 'tool.finished', id: 'q4', tool: 'Edit', status: 'completed' });
await sleep(450);
expect('a subagent\'s edit hold carries on when the conversation\'s ends', same(felt(t), [6, 14, 6]) && !stopped(), `(${felt(t)})`);
t = Date.now();
await send({ event: 'turn.complete', reason: 'aborted' });
await sleep(700);
expect('…and when the turn is interrupted, which is felt over it', same(felt(t).slice(-6), [20, 6, 20, 6, 20, 6]) && !stopped(), `(${felt(t)})`);
t = Date.now();
await send({ event: 'agent.complete', agent: 'agent-4', reason: 'aborted' });
await sleep(500);
expect('…until its own run ends', same(levels(t), [20]) && stopped(), `(${levels(t)})`);

// A subagent in the foreground is interrupted with its turn, and that is felt
// as the turn's ending: the pulse of a run cut short, or of the call it was in
// the middle of, is as strong and would run the ending's three into one.
const endsInThree = (since) => {
  const ending = stretches(since).filter((stretch) => stretch.value === 20);
  return ending.length === 3 && ending.every((stretch) => stretch.ms >= 80 && stretch.ms <= 200) && stopped();
};
const timed = (since) => `(${stretches(since).map((stretch) => `${stretch.value} for ${stretch.ms}ms`).join(', ')})`;
await send({ event: 'tool.started', id: 'q10', tool: 'Agent' }, { event: 'tool.started', id: 'q11', tool: 'Bash', agent: 'agent-6' });
await sleep(300);
t = Date.now();
await send(
  { event: 'tool.finished', id: 'q11', tool: 'Bash', status: 'error', agent: 'agent-6' },
  { event: 'agent.complete', agent: 'agent-6', reason: 'aborted' },
  { event: 'tool.finished', id: 'q10', tool: 'Agent', status: 'error' },
  { event: 'turn.complete', reason: 'aborted' },
);
await sleep(700);
expect('a turn interrupted with a subagent in the foreground ends in its three pulses', endsInThree(t), timed(t));
await send({ event: 'tool.started', id: 'q12', tool: 'Agent' }, { event: 'tool.started', id: 'q13', tool: 'Bash', agent: 'agent-6' });
await sleep(300);
t = Date.now();
await send(
  { event: 'tool.finished', id: 'q12', tool: 'Agent', status: 'error' },
  { event: 'turn.complete', reason: 'aborted' },
  { event: 'tool.finished', id: 'q13', tool: 'Bash', status: 'error', agent: 'agent-6' },
  { event: 'agent.complete', agent: 'agent-6', reason: 'aborted' },
);
await sleep(700);
expect('…whichever of the two is heard of first', endsInThree(t), timed(t));
await send({ event: 'tool.started', id: 'q14', tool: 'Agent' }, { event: 'text.started', id: 'q15', agent: 'agent-6' });
await sleep(300);
t = Date.now();
await send({ event: 'tool.finished', id: 'q14', tool: 'Agent', status: 'error' }, { event: 'turn.complete', reason: 'aborted' });
await sleep(250);
await send({ event: 'agent.complete', agent: 'agent-6', reason: 'aborted' });
await sleep(600);
expect('…and when the run ends while the ending plays', endsInThree(t), timed(t));

// That much is guessed at, from what fails while the ending plays. Where the
// hooks module said which call started a subagent nothing is: it is in the
// foreground for as long as that call runs, and is cut short with it.
const starts = (id, agent) => [{ event: 'tool.started', id, tool: 'Agent' }, { event: 'agent.started', agent, id }];
const longest = (since) => Math.max(0, ...stretches(since).filter((stretch) => stretch.value === 20).map((stretch) => stretch.ms));
await send(...starts('q18', 'agent-8'), { event: 'tool.started', id: 'q19', tool: 'Bash', agent: 'agent-8' });
await sleep(300);
t = Date.now();
await send({ event: 'tool.finished', id: 'q18', tool: 'Agent', status: 'error' }, { event: 'turn.complete', reason: 'aborted' });
await sleep(110);
await send({ event: 'tool.finished', id: 'q19', tool: 'Bash', status: 'error', agent: 'agent-8' });
await sleep(700);
await send({ event: 'agent.complete', agent: 'agent-8', reason: 'aborted' });
await sleep(500);
expect('a subagent cut short with the call that started it is not felt failing, however late that is heard of', endsInThree(t), timed(t));
await send(...starts('q20', 'agent-8'), { event: 'tool.started', id: 'q21', tool: 'Edit', agent: 'agent-8' });
await sleep(300);
t = Date.now();
await send({ event: 'turn.complete', reason: 'aborted' });
await sleep(700);
await send({ event: 'agent.complete', agent: 'agent-8', reason: 'aborted' });
await sleep(500);
expect('…nor when the call never says it finished: its edit hold stops with the turn', endsInThree(t) && !felt(t).includes(6), timed(t));
await send(...starts('q26', 'agent-8'));
await sleep(300);
t = Date.now();
await send({ event: 'tool.finished', id: 'q26', tool: 'Agent', status: 'error' }, { event: 'turn.complete', reason: 'aborted' });
await sleep(700);
await send({ event: 'agent.complete', agent: 'agent-8', reason: 'aborted' });
await sleep(500);
expect('…nor when nothing had been heard of it but its start', endsInThree(t), timed(t));
await send(...starts('q27', 'agent-8'), { event: 'tool.started', id: 'q28', tool: 'Bash', agent: 'agent-8' });
await sleep(300);
t = Date.now();
await send({ event: 'agent.complete', agent: 'agent-8', reason: 'aborted' });
await sleep(150);
await send({ event: 'tool.finished', id: 'q27', tool: 'Agent', status: 'error' }, { event: 'turn.complete', reason: 'aborted' });
await sleep(700);
expect('…nor when the end of its run is heard of before the call\'s', endsInThree(t), timed(t));
await send(...starts('q22', 'agent-9'), { event: 'tool.finished', id: 'q22', tool: 'Agent', status: 'completed' });
await sleep(450);
t = Date.now();
await send({ event: 'turn.complete', reason: 'aborted' });
await sleep(100);
await send({ event: 'agent.complete', agent: 'agent-9', reason: 'error' });
await sleep(800);
expect('one whose call is over is in the background: failing while an interrupted turn ends, it is felt', longest(t) >= 250 && stopped(), timed(t));
t = Date.now();
await send({ event: 'turn.complete', reason: 'answer' });
await sleep(100);
await send({ event: 'agent.complete', agent: 'agent-10', reason: 'error' });
await sleep(800);
expect('…and so is one the daemon was told nothing of, while a turn that was not cut short ends', longest(t) >= 250 && stopped(), timed(t));

// A subagent's todos are its own from one run to the next: a teammate takes
// turns, and a subagent can be woken under the id it had.
const writesTodos = async (id) => {
  await send({ event: 'tool.started', id, tool: 'TodoWrite', agent: 'agent-7' });
  await sleep(300);
  t = Date.now();
  await send({ event: 'tool.finished', id, tool: 'TodoWrite', status: 'completed', agent: 'agent-7', ...todos('completed') });
  await sleep(450);
};
await writesTodos('q16');
expect('a subagent\'s newly completed todo is felt as the conversation\'s is', same(levels(t), [16, 14]) && stopped(), `(${levels(t)})`);
await send({ event: 'agent.complete', agent: 'agent-7', reason: 'answer' });
await sleep(450);
await writesTodos('q17');
expect('…but only once, its next run included', same(levels(t), [14]) && stopped(), `(${levels(t)})`);
// The tasks are one list, the conversation's and its subagents' alike.
await send({ event: 'tool.started', id: 'q23', tool: 'TaskUpdate', agent: 'agent-7' });
await sleep(300);
t = Date.now();
await send({ event: 'tool.finished', id: 'q23', tool: 'TaskUpdate', status: 'completed', agent: 'agent-7', todo: { key: '9', status: 'completed' } });
await sleep(450);
expect('a task a subagent completes is felt as the conversation\'s is', same(levels(t), [16, 14]) && stopped(), `(${levels(t)})`);
t = Date.now();
await send({ event: 'tool.finished', id: 'q24', tool: 'TaskUpdate', status: 'completed', todo: { key: '9', status: 'completed' } });
await sleep(450);
expect('…once, whoever says so again', same(levels(t), [14]) && stopped(), `(${levels(t)})`);
await send({ event: 'agent.complete', agent: 'agent-7', reason: 'answer' });
await sleep(450);

// What was still on its way when a subagent's run ended is no one's to feel.
await send({ event: 'tool.started', id: 'q8', tool: 'Edit' }, { event: 'tool.started', id: 'q9', tool: 'Bash', agent: 'agent-5' });
await sleep(300);
await send({ event: 'agent.complete', agent: 'agent-5', reason: 'aborted' });
await sleep(500);
t = Date.now();
await send(
  { event: 'tool.finished', id: 'q9', tool: 'Bash', status: 'error', agent: 'agent-5' },
  { event: 'text.ended', id: 'q9t', agent: 'agent-5' },
);
await sleep(500);
expect('a subagent\'s call that ends after its run is not felt, and leaves the conversation\'s edit hold', felt(t).length === 0 && !stopped(), `(${felt(t)})`);
t = Date.now();
await send({ event: 'tool.finished', id: 'q8', tool: 'Edit', status: 'completed' });
await sleep(450);
expect('…which ends with its own call', same(levels(t), [14]) && stopped(), `(${levels(t)})`);

// A prompt is told by its rhythm: what another subagent says is not played into it.
await send({ event: 'tool.started', id: 'q2', tool: 'Bash', agent: 'agent-1' }, { event: 'permission.asked', id: 'q2' });
await sleep(300);
t = Date.now();
for (let i = 0; i < 12; i++) {
  await send(says('q3', 'agent-2', 40), { event: 'output.snapshot', id: `q3s${i}`, agent: 'agent-3' });
  await sleep(100);
}
expect('a waiting prompt is not played over by what another subagent says, streamed or whole', levels(t).includes(17) && levels(t).every((v) => v === 17), `(${levels(t)})`);
await send({ event: 'tool.finished', id: 'q2', tool: 'Bash', status: 'completed', agent: 'agent-1' });
await sleep(450);
t = Date.now();
await send(says('q3', 'agent-2', 40));
await sleep(200);
expect('…which is felt again once the prompt is answered, as hard as it has been coming', same(levels(t), [16]) && stopped(), `(${levels(t)})`);
await send({ event: 'agent.complete', agent: 'agent-3', reason: 'answer' });
await sleep(450);
await send({ event: 'agent.complete', agent: 'agent-2', reason: 'answer' });
await sleep(450);

// A prompt says whose it is: one for a call the daemon never saw start (it
// started since) is still its subagent's, and is over with the call.
await send({ event: 'permission.asked', id: 'q25', agent: 'agent-11' });
await sleep(400);
t = Date.now();
await send({ event: 'tool.finished', id: 'q25', tool: 'Bash', status: 'completed', agent: 'agent-11' });
await sleep(450);
expect('a subagent\'s prompt for a call the daemon never saw start ends with the call', same(levels(t).slice(-1), [14]), `(${levels(t)})`);
t = Date.now();
await sleep(1200);
expect('…and stops asking', levels(t).length === 0 && stopped(), `(${levels(t)})`);
await send({ event: 'agent.complete', agent: 'agent-11', reason: 'answer' });
await sleep(450);

// A session's end is the end of its subagents' loops too.
await other({ event: 'session.start' }, { event: 'tool.started', id: 'q7', tool: 'Bash', agent: 'agent-1' }, { event: 'permission.asked', id: 'q7' });
await sleep(400);
t = Date.now();
await other({ event: 'agent.complete', agent: 'agent-2', reason: 'aborted' }, { event: 'session.end', reason: 'other' });
await sleep(150);
expect('a session that ends cuts short the pulse of a subagent\'s run that just ended', felt(t).includes(20) && stopped(), `(${felt(t)})`);
t = Date.now();
await sleep(1200);
expect('…and stops what its other subagents were playing', levels(t).length === 0 && stopped(), `(${levels(t)})`);

const cmd = async (body) =>
  (await fetch(url('/cmd'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();

// Intensity -----------------------------------------------------------------------
// One multiplier for the whole daemon, applied to what the sessions mix down to.
r = await cmd({ cmd: 'intensity' });
expect('the intensity is 1 until it is set', same(r, { message: 'Intensity is 1' }), `(${JSON.stringify(r)})`);
r = await cli('intensity', '0.5');
expect('setting the intensity reports it', r.stdout.includes('Intiface: Intensity set to 0.5'), `(${r.stdout.trim()})`);
r = await cli('intensity');
expect('…and asking says what it is', r.stdout.includes('Intiface: Intensity is 0.5'), `(${r.stdout.trim()})`);
t = Date.now();
await send({ event: 'tool.started', id: 'n1', tool: 'Bash' });
await sleep(400);
expect('a pulse at 0.5 is felt at 0.25 under an intensity of 0.5', same(levels(t), [5]) && stopped(), `(${levels(t)})`);

t = Date.now();
await send({ event: 'tool.started', id: 'n2', tool: 'Edit' });
await sleep(200);
await other({ event: 'session.start' }, { event: 'tool.started', id: 'n3', tool: 'Bash' });
await sleep(400);
expect('the strongest session is the one scaled, then the one it goes back to', same(levels(t), [3, 5, 3]) && !stopped(), `(${levels(t)})`);
await other({ event: 'session.end', reason: 'other' });
await sleep(200);

t = Date.now();
await cmd({ cmd: 'intensity', value: 1 });
await sleep(200);
expect('a new intensity is felt at once by what is playing', same(levels(t), [6]) && !stopped(), `(${levels(t)})`);
await cmd({ cmd: 'intensity', value: 0 });
await sleep(200);
expect('…an intensity of 0 stops the device', same(levels(t), [6]) && stopped(), `(${levels(t)})`);
await cmd({ cmd: 'intensity', value: 0.5 });
await sleep(200);
expect('…and what is still playing comes back with it', same(levels(t), [6, 3]) && !stopped(), `(${levels(t)})`);
await send({ event: 'tool.finished', id: 'n2', tool: 'Edit', status: 'completed' });
await sleep(450);
expect('…until it is over', same(levels(t), [6, 3, 7]) && stopped(), `(${levels(t)})`);

// A level is the device's it was asked of. Another device selected while the
// first has not answered: the first's stop is still on its way, and a new
// intensity does not play on the second what the first was left at.
mock.setSpareDevicePresent(true);
mock.setReplyDelay(300);
await sleep(200);
await send({ event: 'tool.started', id: 'n4', tool: 'Edit' });
await sleep(50);
await cmd({ cmd: 'select', index: 1 });
await cmd({ cmd: 'intensity', value: 0.5 });
await sleep(700);
const strays = mock.outputs.filter((o) => o.device === 1 && !o.stop).map((o) => o.value);
expect('a new intensity does not play one device\'s level on the one selected after it', strays.length === 0 && stopped(), `(${strays})`);
mock.setReplyDelay(0);
await cmd({ cmd: 'select', index: 0 });
mock.setSpareDevicePresent(false);
await send({ event: 'tool.finished', id: 'n4', tool: 'Edit', status: 'completed' });
await sleep(450);

const sentBefore = mock.outputs.length;
await cmd({ cmd: 'intensity', value: 0.25 });
await sleep(200);
expect('with nothing playing, a new intensity sends the device nothing', mock.outputs.length === sentBefore, `(${mock.outputs.length - sentBefore} commands)`);
for (const value of [1.5, -0.1, null, '0.5']) {
  r = await cmd({ cmd: 'intensity', value });
  expect(`an intensity of ${JSON.stringify(value)} is refused`, r.error === 'Intensity must be a number from 0 to 1', `(${JSON.stringify(r)})`);
}
r = await cli('intensity', 'loud');
expect('…and so is one that is not a number', r.code === 1 && r.stderr.includes('Intensity must be a number from 0 to 1'), `(${r.stderr.trim()})`);
r = await cli('intensity', ' ');
expect('…while a blank one is none at all: it only asks', r.stdout.includes('Intiface: Intensity is 0.25'), `(${r.stdout.trim()})`);
r = await cmd({ cmd: 'intensity' });
expect('…and none of them changes it', same(r, { message: 'Intensity is 0.25' }), `(${JSON.stringify(r)})`);
// It is left at 0.25 for the daemon that is started after this one.
const savedIntensity = JSON.parse(readFileSync(join(home, 'state.json'), 'utf8'))['vibeclaude.intensity'];
expect('the intensity is persisted', savedIntensity === 0.25, `(${savedIntensity})`);

// Connect / disconnect / restore ------------------------------------------------------
r = await cmd({ cmd: 'state' });
expect('the dialog is told the connection and the selection', same(r, { connected: true, selected: 0 }), `(${JSON.stringify(r)})`);
r = await cmd({ cmd: 'ensure-connected' });
expect('…and connecting when connected is fine', same(r, { connected: true }), `(${JSON.stringify(r)})`);
r = await cli('connect');
expect('connect when connected', r.stdout.includes('Intiface: Already connected'), `(${r.stdout.trim()})`);
r = await cli('disconnect');
expect('disconnect', r.stdout.includes('Intiface: Disconnected'), `(${r.stdout.trim()})`);
r = await cli('disconnect');
expect('disconnect when disconnected', r.stdout.includes('Intiface: Not connected'), `(${r.stdout.trim()})`);
t = Date.now();
await send({ event: 'tool.started', id: 'a9', tool: 'Bash' });
await sleep(300);
expect('nothing plays while disconnected', levels(t).length === 0, `(${levels(t)})`);
seen = await notices(`since=${t}`);
expect('…and nothing is said of it', seen.length === 0, `(${JSON.stringify(seen)})`);
r = await cli('connect');
expect('connect', r.stdout.includes('Intiface: Connected'), `(${r.stdout.trim()})`);

await cli('stop');
await sleep(500);
expect('stop exits the daemon', daemon.exitCode === 0, `(exit ${daemon.exitCode})`);

let restarted = Date.now();
daemon = startDaemon();
await sleep(500);
// A session that is already waiting is told the moment the device is back.
const waiting = fetch(url('/notices?id=stale&after=99&since=' + restarted)).then((res) => res.json());
const told = await Promise.race([waiting, sleep(8000).then(() => null)]);
expect('a waiting session hears of the restored device as it happens', told?.notices.some((n) => n.message === 'Restored Mock Vibe 3000'), `(${JSON.stringify(told?.notices)})`);
seen = await notices(`id=${told?.id}&after=${told?.seq}`);
expect('…once', seen.length === 0, `(${seen})`);
t = Date.now();
await send({ event: 'session.start' }, { event: 'tool.started', id: 'c0', tool: 'Bash' });
await sleep(400);
expect('…and it plays again, at the intensity the last daemon was left with', same(levels(t), [3]), `(${levels(t)})`);
await cmd({ cmd: 'intensity', value: 1 });
t = Date.now();
await send({ event: 'tool.started', id: 'c1', tool: 'Bash' });
await sleep(400);
expect('…until it is set back', same(levels(t), [10]), `(${levels(t)})`);

// What was still on its way when the session ended does not bring it back.
t = Date.now();
await send({ event: 'session.end', reason: 'clear' }, { event: 'tool.finished', id: 'c1', tool: 'Bash', status: 'completed' });
await sendAs('test2', process.pid, { event: 'turn.start' });
await sleep(500);
expect('an event that arrives after its session ended is not felt', levels(t).length === 0, `(${levels(t)})`);
expect('the daemon stays for the session that follows /clear', daemon.exitCode === null, `(exit ${daemon.exitCode})`);
await sendAs('test2', process.pid, { event: 'session.end', reason: 'other' });
await sleep(1000);
expect('…nor keeps the daemon from exiting with the last session', daemon.exitCode === 0, `(exit ${daemon.exitCode})`);
daemon.kill('SIGTERM');

// Lifetime ------------------------------------------------------------------------------
r = await cli('start');
const started = JSON.parse(r.stdout || '{}');
expect('start brings up a daemon and says how to reach it', r.code === 0 && started.port === HTTP_PORT && started.pid === process.pid, `(${r.stdout.trim()})`);
await sleep(4500); // connect, scan, restore
t = Date.now();
await send({ event: 'session.start' }, { event: 'tool.started', id: 'd1', tool: 'Bash' });
await sleep(400);
expect('…which plays once the device is back', same(levels(t), [10]), `(${levels(t)})`);

// A process that was gone before its events came did not send them (`node`
// was a wrapper, and `start` saw that): its session is not ended for it.
const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)']);
const wrapperPid = Number(gone.stdout.toString());
await sendAs('wrapped', wrapperPid, { event: 'tool.started', id: 'w1', tool: 'Edit' });
await sendAs('wrapped', wrapperPid, { event: 'tool.started', id: 'w1', tool: 'Edit' });
await sleep(6500);
expect('a session is not ended for a process that was gone before its events came', !stopped());
await sendAs('wrapped', wrapperPid, { event: 'session.end', reason: 'other' });

// A Claude Code that goes away without ending its session.
const ghost = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await sendAs('ghost', ghost.pid, { event: 'tool.started', id: 'g1', tool: 'Edit' });
await sendAs('ghost', ghost.pid, { event: 'tool.started', id: 'g1', tool: 'Edit' });
await send({ event: 'session.end', reason: 'other' });
await sleep(300);
r = await cli('status');
expect('the daemon stays while another session has not ended', r.code === 0 && !stopped(), `(${r.stdout.trim()})`);
ghost.kill('SIGKILL');
await sleep(6500);
r = await cli('status');
expect('…and exits once its Claude Code is found gone', r.code === 1 && stopped(), `(${r.stdout.trim()})`);

// A connection that goes with a command unanswered ----------------------------------------
daemon = startDaemon();
await sleep(4500); // connect, scan, restore
await send({ event: 'session.start' }, { event: 'tool.started', id: 'e1', tool: 'Bash' });
await sleep(400);
mock.setAnswering(false);
await send({ event: 'tool.started', id: 'e2', tool: 'Bash' });
await sleep(100);
mark = Date.now();
mock.drop();
await sleep(300);
mock.setAnswering(true);
seen = await notices(`since=${mark}`);
expect('a connection lost with a command unanswered is said once', same(seen, ['Connection to Intiface was lost']), `(${seen})`);
r = await cli('connect');
expect('…and connecting again restores the device', r.stdout.includes('Connected; restored Mock Vibe 3000'), `(${r.stdout.trim()})`);
t = Date.now();
await send({ event: 'tool.started', id: 'e3', tool: 'Bash' });
await sleep(400);
expect('…for the session that was playing, too', same(levels(t), [10]), `(${levels(t)})`);

// A Claude Code between sessions (after /clear) is still there for the daemon.
const cleared = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
await sendAs('cleared', cleared.pid, { event: 'session.start' });
await sendAs('cleared', cleared.pid, { event: 'session.end', reason: 'clear' });
await send({ event: 'session.end', reason: 'other' });
await sleep(300);
r = await cli('status');
expect('the daemon stays for a Claude Code that has cleared and not yet gone on', r.code === 0, `(${r.stdout.trim()})`);
cleared.kill('SIGKILL');
await sleep(6500);
expect('…and exits once that Claude Code is found gone', daemon.exitCode === 0, `(exit ${daemon.exitCode})`);

// Intiface that comes up after the daemon ------------------------------------------------
mock.drop();
await mock.close();
mark = Date.now();
daemon = startDaemon();
await sleep(1000);
seen = await notices(`since=${mark}`);
expect('a daemon that finds no Intiface says so', seen.some((message) => message.startsWith('Auto-connect failed')), `(${seen})`);
await send({ event: 'session.start' });
await sleep(500);
seen = await notices(`since=${mark}`);
expect('…once, for the session it started with', seen.length === 1, `(${seen})`);
mock = startMock(WS_PORT, { log: () => {} });
await sleep(5000);
mark = Date.now();
await other({ event: 'session.start' });
await sleep(4500); // connect, scan, restore
seen = await notices(`since=${mark}`);
expect('a session that starts later connects and restores the device', seen.includes('Restored Mock Vibe 3000'), `(${seen})`);
await cli('disconnect');
await sendAs('third', process.pid, { event: 'session.start' });
await sleep(500);
r = await cmd({ cmd: 'state' });
expect('…but not after a disconnect that was asked for', r.connected === false, `(${JSON.stringify(r)})`);
r = await cli('connect');
expect('a connect asked for turns that back on', r.stdout.includes('Intiface: Connected'), `(${r.stdout.trim()})`);
mock.drop();
await mock.close();
await sleep(300);
r = await cli('disconnect');
expect('a disconnect asked for with nothing to disconnect', r.stdout.includes('Intiface: Not connected'), `(${r.stdout.trim()})`);
mock = startMock(WS_PORT, { log: () => {} });
await sleep(300);
await sendAs('fourth', process.pid, { event: 'session.start' });
await sleep(500);
r = await cmd({ cmd: 'state' });
expect('…still keeps a session that starts later from connecting', r.connected === false, `(${JSON.stringify(r)})`);

// An Intiface that opens the socket and says nothing -------------------------------------
mock.setAnswering(false);
void cmd({ cmd: 'connect' }).catch(() => null);
await sleep(500);
r = await cmd({ cmd: 'state' });
expect('a connection is not one until the server has answered', r.connected === false, `(${JSON.stringify(r)})`);
await cli('stop');
// Leaving takes it a few seconds (it waits on that connection), during which the port is still its.
await sleep(300);
r = await cli('status');
expect('a daemon on its way out says it is not running', r.code === 1, `(${r.stdout.trim()})`);
mock.setAnswering(true);
r = await cli('start');
expect(
  '…and start waits for it to go before bringing up another',
  r.code === 0 && daemon.exitCode === 0,
  `(${r.stdout.trim()}; exit ${daemon.exitCode})`,
);
await cli('stop');
await sleep(1500);
r = await cli('status');
expect('…which stops as asked', r.code === 1, `(${r.stdout.trim()})`);
mock.drop();
await mock.close();
rmSync(home, { recursive: true, force: true });
console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
