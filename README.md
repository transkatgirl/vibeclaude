<p align="center"><img src="logo.svg" width="160" alt="VibeClaude logo"></p>

# VibeClaude

*Vibe coding, taken entirely too literally.*

Use an "extra controller" from [Intiface Central](https://intiface.com/central) and
[buttplug.io](https://buttplug.io) to connect every Claude Code action deeply with your
body. A port of [opencode-buttplugio](https://github.com/FurryR/opencode-buttplugio) to
Claude Code's function hooks.

```
Claude Code ──hooks module──HTTP──▶ daemon ──WebSocket──▶ Intiface Central ──BLE──▶ you
```

## Requirements

- Claude Code with function-hooks plugin support (an early-access API; built against 2.1.291)
- Node.js 22+, as `node` on your `PATH` (the `buttplug` client does not run on older versions)
- Intiface Central with its WebSocket server running (default `ws://127.0.0.1:12345`)
- A little desire
- A comfortable, private setting
- Some lubricant (optional, but strongly recommended)
- A vibration-capable "controller", paired in Intiface Central

## Install

```bash
git clone https://github.com/transkatgirl/vibeclaude.git ~/.claude/vibeclaude
cd ~/.claude/vibeclaude && npm install
```

Then either load it for one session:

```bash
claude --plugin-dir ~/.claude/vibeclaude
```

or add it permanently from inside Claude Code:

```
/plugin marketplace add ~/.claude/vibeclaude
/plugin install vibeclaude@vibeclaude-local
```

Restart Claude Code. The plugin loads at session start.

The daemon runs from the directory Claude Code loads the plugin from, and needs its
`node_modules` there. A plugin installed from a marketplace is loaded from Claude Code's own
copy, which may not have them (one cloned from a git repository never does). If a toast says
`the "buttplug" npm package is missing`, run `npm install` in the directory it names.

## Use

1. Start Intiface Central and press the server start button.
2. In Claude Code run `/intiface`.
3. Select a vibration-capable device from the scan results.
4. Get comfortable, connect with your device, and slowly adjust to the feeling of becoming
   one with it.
5. Start enjoying your coding session.

| Command | Description |
|---|---|
| `/intiface` | Connect to Intiface, scan, and select a device. |
| `/intiface-connect` | Connect to the configured Intiface server and go back to the device you last selected, if it is there. |
| `/intiface-disconnect` | Disconnect and stop all device output. |
| `/intiface-intensity [0.0-1.0]` | Set how strong everything is, as a multiplier from `0` to `1`. Without a number, says what it is set to. |

The commands run in the plugin itself: they start no model turn, use no tokens, and leave
nothing in the conversation. All four also work while a turn is running.

`/intiface` opens a dialog that says what it is doing (Connecting, Scanning) and then lists
the devices that can vibrate, the selected one marked Connected. Move with the arrows or
Tab, pick with Enter or a click, leave with Escape.

Nothing plays until a device has been selected. Exactly one device is driven at a time:
it has your undivided attention, and you have its.
When the first session starts, the plugin connects to Intiface and restores the previously
selected device when it is available. If Intiface was not running then, each Claude Code
started later tries again, unless you disconnected with `/intiface-disconnect`. When the
last session ends, it stops the device and disconnects.

Notices such as "Restored …" or "Connection to Intiface was lost" appear as toasts, in
every open session, as they happen. If the connection is lost the device is deselected;
reconnect with `/intiface`. A device that drops off on its own is selected again when it
comes back.

You can do something else while a turn runs. You do not need to watch the screen: bodily
pleasure and the haze in your mind will tell you whether the task is complete.

## What you feel

Every pattern is a constant intensity for a fixed time. Within a conversation only one
plays at once: the most recent event wins, so your body always knows what Claude is doing
right now.

| What happens | Pattern |
|---|---|
| Thinking and text, as they stream | A 70ms pulse per piece, 0.35–0.8, rising with average output speed (saturates at 40 chars/s). A faster model finishes sooner. You know what I mean. |
| A response arrives whole, with nothing of it streamed (thinking included) | One 150ms pulse at 0.4 |
| The model starts writing a tool call | One 120ms pulse at 0.5 |
| The model starts writing an `Edit`/`Write`/`MultiEdit`/`NotebookEdit` | No pulse: a steady hold at 0.3 for as long as the edit is being written and applied, until it finishes, fails, or asks for permission |
| A tool call succeeds | One slow, deep 180ms pulse at 0.7 |
| A tool call fails, is denied, or is rejected at its prompt | One sudden, sharp 280ms pulse at 1.0 |
| A todo/task tool completes an item | One pulse at 0.8, replaced at once by the tool's own success pulse |
| A subagent's run ends | The pulse of a tool call succeeding; of one failing if the run was interrupted or failed |
| A permission prompt is waiting | Three 90ms pulses at 0.85, a pause, repeating until answered. Thinking and text are not felt meanwhile |
| The turn ends | Three 100ms pulses at 1.0 |
| The turn is interrupted or fails | Everything of the turn's stops, then the three pulses of a turn ending |
| The session ends | Everything stops |

Every Claude Code session you have open drives the device, each keeping track of its own
tool calls, permission prompts and todos. When more than one is playing you feel the
strongest of them, and when that one stops the device goes back to whatever the others are
still playing: a pulse from one session does not cut short an edit hold in another, and
ending or interrupting one session stops only its own output.

A subagent is felt like the conversation that started it: its thinking and text as they
stream, a response that arrives whole, its tool calls, its permission prompts and its
todos. It is mixed with that conversation, and with any other subagent at work, the way
another session is: you feel the strongest of them, and a pulse from one does not cut
short an edit hold, or the pulses of the turn ending, in another. The end of a subagent's
run is not the end of the turn: it is felt as a tool call's result, and for a subagent in
the foreground it lands together with the result of the call that started it. One that
is interrupted with its turn is felt as the turn ending, whose three pulses take the place
of its result. One in the background plays on after the turn has ended or been
interrupted, until its own run does; ending the session stops them all. While a permission
prompt waits, thinking and text are held back in the whole of its session, so that
whatever else is still streaming does not fill the pauses that give the prompt its rhythm;
tool calls and edit holds still come through.

Too much, or saving yourself for later? `/intiface-intensity 0.5` halves everything. The
intensity is one multiplier for the whole daemon, applied last: every session and subagent
plays its patterns as the table has them, the strongest is picked, and that is what gets
multiplied. It starts at `1.0` (every pattern as written), takes effect at once, whatever
is playing included, and is remembered until you change it. At `0` nothing is felt;
anything above it still is, since a faint level rounds up to the device's weakest step,
never down to nothing.

Turn completion, permission requests, interruptions, completed todos... you no longer need
a separate notification plugin. Now you can feel it all with your body, as though Claude
Code has become one with you.

Three things are approximations, because of what Claude Code tells a plugin:

- **Thinking.** Claude Code hands a plugin thinking's text only where it is shown to
  someone. Where it is withheld (a headless `claude -p` run is one such place), thinking is
  not felt.
- **Answering a permission prompt.** Claude Code draws the prompt itself and does not say
  when it was answered. The pattern stops when the tool that asked finishes or fails, or
  when you reject it. So after you approve a call that takes a while, the pattern goes on
  until the call is done. The one earlier sign is the run-in-background hint Claude Code
  draws under a long-running command a moment after it starts: that stops the pattern
  too, but only in the terminal, and where several commands share one hint, only for the
  first of them. A subagent's prompt also stops when the subagent's run ends. Other tool
  calls running alongside do not silence it.
- **Tool output.** Nothing reports a command's output as it is printed, so it is not
  felt: a tool's result is its one pulse.

Worn out? Output stops automatically when you switch devices, end the session, disconnect,
lose the Intiface connection, or the daemon exits. After intense "coding," a rest may be
in order.

## Configure

Claude Code asks for the plugin's options when you enable it; change them later under
`/plugin` → manage.

| Option | Default | Description |
|---|---|---|
| `wsAddress` | `ws://127.0.0.1:12345` | Intiface Central WebSocket address. |

A new address takes effect when the daemon next starts: end your sessions, or run
`node daemon/daemon.mjs stop` and let the next event start it again.

The selected device, the intensity and `daemon.log` are kept in `~/.config/vibeclaude`. If TCP
port 12350 is taken on your machine, a `config.json` there containing `{ "port": 12351 }`
moves the daemon.

## How it works

`hooks/register.tsx` is a hooks module: it runs inside Claude Code, where it sees the
model's response as it streams (`turn.step`), each tool call from start to finish
(`tool.call`), permission checks, subagents being started (`agent.spawn`), and turns and
sessions beginning and ending, in the conversation and in each subagent's own loop. It reduces
each to a tiny event (sizes and identifiers, not text) and posts them, in order, to the
daemon on `127.0.0.1:12350`. It never makes the model's stream wait for a request. It also
registers the slash commands, draws the `/intiface` dialog and shows the daemon's notices
as toasts.

A hooks module has no Node, so it cannot run the `buttplug` client or hold a WebSocket.
`daemon/daemon.mjs` holds everything else: the connection to Intiface Central through the official `buttplug`
client, the selected device, and the vibration engine and its handlers, which are the
original plugin's. A device answers slower than a response streams, so it is sent the
latest level asked of it, never a backlog. The first session starts it; it exits when the last session ends
(`/clear` and resuming hand over to the next session instead). It also watches the Claude
Code process behind each session, and ends the session of one that went away without saying
so. Only where it cannot tell which process that is does it fall back to exiting after 30
minutes without activity. It can be driven from a shell too:

| Command | What it does |
|---|---|
| `node daemon/daemon.mjs scan` | Connect, scan 3s, list vibration-capable devices |
| `node daemon/daemon.mjs select <index>` | Select a device from the scan |
| `node daemon/daemon.mjs connect` / `disconnect` | Connect to / disconnect from Intiface |
| `node daemon/daemon.mjs intensity [value]` | Set the intensity multiplier (`0` to `1`); without a value, print it |
| `node daemon/daemon.mjs start` | Make sure a daemon is running; print its port |
| `node daemon/daemon.mjs status` | Is a daemon answering? |
| `node daemon/daemon.mjs stop` | Stop all output and exit the daemon |
| `node daemon/daemon.mjs` | Run in the foreground |

These use `~/.config/vibeclaude` and the default address unless you pass
`--home <dir>` and `--ws <address>`. `VIBECLAUDE_DEBUG=1 node daemon/daemon.mjs` logs every
event as it arrives.

## Try it without hardware

No "controller" on hand? A mock will take its place and stoically print what it would have
felt:

```bash
node test/mock-intiface.mjs 12345      # fake Intiface Central with one device, prints motor level
npm test                               # the daemon end to end against its own mock, then the hooks module
```

## Privacy

The plugin sends device commands only to the configured Intiface address on your machine.
The daemon listens on loopback only and takes JSON requests addressed to `127.0.0.1` or
`localhost`, which a page in your browser cannot send it.
There is no telemetry. Nobody will know you used it to push your KPIs far beyond your coworkers'.

## Not included (yet)

- Live tool output, and the exact moment a permission prompt is answered: see above.
- Patterns that scale with the size of an edit. The original's code for this is never
  reached, so there is nothing to port.
- Codex CLI: its `notify` hook only reports turn completion and approval requests, so a port
  would get the completion and permission pulses but not the per-tool or streaming feedback.
- Non-vibration outputs (rotate, oscillate, linear). Pull requests welcome.

## License

This project is licensed under the [MIT License](LICENSE). Buttplug and Intiface are
trademarks of Nonpolynomial Labs, LLC.
