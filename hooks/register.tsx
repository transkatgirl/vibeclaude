// The part of the plugin that runs inside Claude Code. It watches a session
// (the model's response as it streams, tool calls, permission prompts, turns)
// and tells the daemon what happened, in order; it shows the daemon's toasts
// and serves the /intiface commands, drawing the device dialog.
//
// A hooks module has no Node, so it cannot hold the connection to Intiface:
// everything that vibrates lives in the daemon (daemon/daemon.mjs), reached
// over loopback HTTP.
//
// Only sizes and identifiers leave this module. Prompt, message and tool text
// never do, apart from todo item titles (needed to tell items apart).

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Device } from '../types'

const TOAST_MS = 3000
const DAEMON_START_TIMEOUT_MS = 15_000
// How long to leave a daemon that would not start before trying again: twice
// as long after each failure in a row, up to the longest.
const DAEMON_RETRY_MS = 5000
const DAEMON_RETRY_MAX_MS = 5 * 60_000
const NOTICE_RETRY_MS = 2000
const DIALOG = 'intiface'
// Room for the title and six devices; a longer list scrolls.
const DIALOG_ROWS = 7

type Daemon = { port: number; pid: number }

type TodoUpdate = {
  todos?: { key: string; status: string }[]
  todo?: { key: string; status: string }
}

type DaemonEvent = TodoUpdate & {
  event: string
  session?: string
  id?: string
  tool?: string
  agent?: string
  chars?: number
  status?: 'completed' | 'error'
  reason?: string
}

type CommandReply = {
  message?: string
  error?: string
  connected?: boolean
  devices?: Device[]
  selected?: number | null
}

/** What a todo/task tool call says about item statuses, if anything. */
const todoUpdate = (tool: string, input: Record<string, unknown>): TodoUpdate => {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return {
      todos: input.todos.map((todo: { content?: unknown; status?: unknown }) => ({
        key: String(todo.content),
        status: String(todo.status),
      })),
    }
  }
  if (tool === 'TaskUpdate' && input.taskId !== undefined && typeof input.status === 'string') {
    return { todo: { key: String(input.taskId), status: input.status } }
  }
  return {}
}

// The module's own state. A reload starts it over; the daemon keeps what matters.
let wsAddress = ''
let daemon: Promise<Daemon | null> | null = null
// Starts that failed in a row, the latest start, and what the last failure
// said: the same failure again is not toasted again.
let startFailures = 0
let startAttempt = 0
let lastStartError = ''
// True while the session ends: no daemon is started only to be told so.
let isEnding = false
let sessionID: string | null = null
const queue: DaemonEvent[] = []
let sending: Promise<void> | null = null
// Tool calls whose permission check said "ask", by call ID, until a prompt
// for that tool and input comes up; then the calls whose prompt is still
// unanswered.
const mayAsk = new Map<string, { tool: string; input: string }>()
const asked = new Set<string>()
// A subagent's calls that have not finished, each with its subagent. One in
// the background outlives the turn that started it, so a turn's start and end
// leave these as they are: they go when the call finishes or its subagent's
// run ends.
const agentCalls = new Map<string, string>()
const forgetTurnCalls = () => {
  for (const id of [...mayAsk.keys(), ...asked]) {
    if (agentCalls.has(id)) continue
    mayAsk.delete(id)
    asked.delete(id)
  }
}
const dialog = atom({ plugin: 'vibeclaude', key: 'dialog' } as const, { title: '', devices: [], selected: null })

const toast = ($: EngineInterface, message: string) => {
  $.ui.toast(`Intiface: ${message}`, { timeoutMs: TOAST_MS })
}

// The daemon ---------------------------------------------------------------

const startDaemon = async ($: EngineInterface): Promise<Daemon | null> => {
  const attempt = ++startAttempt
  try {
    const { exitCode, stdout, stderr } = await $.process.run(
      ['node', `${$.plugin.root}/daemon/daemon.mjs`, 'start', ...(wsAddress ? ['--ws', wsAddress] : [])],
      { timeoutMs: DAEMON_START_TIMEOUT_MS },
    )
    if (exitCode !== 0) throw new Error(stderr.trim() || `exit ${exitCode}`)
    const started = JSON.parse(stdout) as Daemon
    if (typeof started.port !== 'number') throw new Error('unexpected answer')
    startFailures = 0
    lastStartError = ''
    return started
  } catch (e) {
    const error = String(e)
    if (error !== lastStartError) toast($, `Daemon failed to start: ${error}`)
    lastStartError = error
    $.clock.after(Math.min(DAEMON_RETRY_MS * 2 ** startFailures++, DAEMON_RETRY_MAX_MS), () => {
      if (attempt === startAttempt) daemon = null
    })
    return null
  }
}

/** The daemon, started if need be. A command the person ran (`isAsked`) does not wait out a failed start. */
const getDaemon = async ($: EngineInterface, isAsked = false): Promise<Daemon | null> => {
  const current = daemon
  if (isAsked && current !== null && startFailures > 0 && (await current) === null && daemon === current) {
    daemon = null
    lastStartError = ''
  }
  if (daemon === null && isEnding) return null
  return (daemon ??= startDaemon($))
}

const post = async <T,>($: EngineInterface, { port }: Daemon, path: string, body: unknown): Promise<T> => {
  const response = await $.http.fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`the daemon answered ${response.status}`)
  return JSON.parse(response.text) as T
}

// Events -------------------------------------------------------------------
// Queued and sent one request at a time, so they reach the daemon in the
// order they happened and a slow request never holds up the model's stream.

const drain = async ($: EngineInterface) => {
  while (queue.length > 0) {
    const target = await getDaemon($)
    const events = queue.splice(0)
    if (target === null) continue
    const session = events.some((event) => event.session === undefined) ? (sessionID ??= await $.session.id()) : ''
    const body = (to: Daemon) => ({
      pid: to.pid,
      events: events.map((event) => ({ ...event, session: event.session ?? session })),
    })
    try {
      await post($, target, '/events', body(target))
    } catch {
      // The daemon went away (it was stopped, or it crashed): start another.
      daemon = null
      const restarted = await getDaemon($)
      if (restarted !== null) await post($, restarted, '/events', body(restarted)).catch(() => {})
    }
  }
}

/** Resolves once everything queued so far has been sent, or given up on: what is queued as a drain ends is drained too. */
const flush = async ($: EngineInterface): Promise<void> => {
  while (queue.length > 0 || sending !== null) {
    await (sending ??= drain($)
      .catch(() => {})
      .finally(() => {
        sending = null
      }))
  }
}

const emit = ($: EngineInterface, event: DaemonEvent) => {
  queue.push(sessionID === null ? event : { session: sessionID, ...event })
  void flush($)
}

// Toasts -------------------------------------------------------------------
// The daemon's notices ("Restored …", "Connection to Intiface was lost"),
// shown as they happen: each request waits at the daemon until there is one.

// The module outlives a /clear, and each session starts its own poller: only
// the latest one goes on, or every notice would be shown once per session.
let poller = 0

const pollNotices = async ($: EngineInterface, cursor: string, generation: number): Promise<void> => {
  if (generation !== poller) return
  const retry = () => {
    $.clock.after(NOTICE_RETRY_MS, () => void pollNotices($, cursor, generation))
  }
  const target = await getDaemon($)
  if (target === null) return retry()
  let next: string
  try {
    const response = await $.http.fetch(`http://127.0.0.1:${target.port}/notices?${cursor}`)
    const { id, seq, notices } = JSON.parse(response.text) as {
      id: string
      seq: number
      notices: { message: string }[]
    }
    if (generation !== poller) return
    for (const notice of notices) toast($, notice.message)
    next = `id=${id}&after=${seq}`
  } catch {
    return retry()
  }
  void pollNotices($, next, generation)
}

// Commands -----------------------------------------------------------------

const command = async (
  $: EngineInterface,
  body: { cmd: string; index?: number; value?: number },
): Promise<CommandReply> => {
  const target = await getDaemon($, true)
  if (target === null) return { error: 'The daemon is not running' }
  try {
    return await post<CommandReply>($, target, '/cmd', body)
  } catch {
    // The daemon went away (it was stopped, or it crashed): start another.
    daemon = null
    const restarted = await getDaemon($, true)
    if (restarted === null) return { error: 'The daemon is not running' }
    try {
      return await post<CommandReply>($, restarted, '/cmd', body)
    } catch (e) {
      daemon = null
      return { error: `Command failed: ${String(e)}` }
    }
  }
}

const report = ($: EngineInterface, reply: CommandReply) => {
  const message = reply.error ?? reply.message
  if (message !== undefined) toast($, message)
}

// /intiface: a dialog that says which step it is on (Connecting, Scanning),
// then lists what can vibrate. Picking a device selects it and closes the
// dialog; Escape closes it at any step.

const showDialog = ($: EngineInterface, title: string, devices: Device[] = [], selected: number | null = null) =>
  update($, dialog, () => ({ title, devices, selected }))

const scanIntoDialog = async ($: EngineInterface, isConnected: boolean) => {
  const fail = async (reply: CommandReply) => {
    report($, reply)
    await $.ui.close({ id: DIALOG })
  }

  if (!isConnected) {
    const connection = await command($, { cmd: 'ensure-connected' })
    if (connection.error !== undefined) return fail(connection)
    await showDialog($, 'Scanning')
  }
  const scan = await command($, { cmd: 'scan' })
  if (scan.error !== undefined) return fail(scan)

  const devices = scan.devices ?? []
  if (devices.length === 0) return showDialog($, 'No vibration-capable devices found')
  await showDialog($, 'Select device', devices, scan.selected ?? null)
}

const openDeviceDialog = async ($: EngineInterface) => {
  const state = await command($, { cmd: 'state' })
  if (state.error !== undefined) return report($, state)

  const isConnected = state.connected === true
  await showDialog($, isConnected ? 'Scanning' : 'Connecting')
  await $.ui.open({ id: DIALOG, title: 'Intiface', focus: true, closeOnEscape: true, rows: DIALOG_ROWS })
  // The rest goes on behind the open dialog, which stays the person's to close.
  void scanIntoDialog($, isConnected).catch((e) => toast($, `Command failed: ${String(e)}`))
}

export const register: Register = (on, options) => {
  wsAddress = typeof options.wsAddress === 'string' ? options.wsAddress : ''

  // Session ------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    const startedAt = await $.clock.now()
    sessionID = await $.session.id()
    emit($, { event: 'session.start' })
    void pollNotices($, `since=${startedAt}`, ++poller)

    await Promise.all([
      $.command.register({
        name: 'intiface',
        description: 'Connect to Intiface, scan, and select a device',
        immediate: true,
      }),
      $.command.register({
        name: 'intiface-connect',
        description: 'Connect to the configured Intiface server',
        immediate: true,
      }),
      $.command.register({
        name: 'intiface-disconnect',
        description: 'Disconnect from Intiface and stop all device output',
        immediate: true,
      }),
      $.command.register({
        name: 'intiface-intensity',
        description: 'Set how strong all device output is, from 0 to 1',
        argumentHint: '[0.0-1.0]',
        immediate: true,
      }),
    ])

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    isEnding = true
    emit($, { event: 'session.end', session: e.sessionId, reason: e.reason })
    await flush($).finally(() => {
      isEnding = false
    })
    // After a /clear the same Claude Code goes on under another session id.
    sessionID = null

    return next(e)
  })

  on('command.run', { command: 'intiface' }, async $ => {
    await openDeviceDialog($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: DIALOG }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const { title, devices, selected } = await read($, dialog)
    const focused = devices.find((device) => device.index === selected) ?? devices[0]

    return (
      <Box flexDirection="column">
        <Text bold>{title}</Text>
        {devices.map((device) => (
          <Box key={`row-${device.index}`} gap={1}>
            <Button
              key={`device-${device.index}`}
              label={device.name}
              plain
              {...(device === focused ? { autoFocus: true } : {})}
              onPress={async () => {
                report($, await command($, { cmd: 'select', index: device.index }))
                await $.ui.close({ id: DIALOG })
              }}
            />
            <Text dimColor>{`Device #${device.index}`}</Text>
            {selected === device.index && <Text color="success">Connected</Text>}
          </Box>
        ))}
      </Box>
    )
  })

  on('command.run', { command: 'intiface-connect' }, async $ => {
    report($, await command($, { cmd: 'connect' }))

    return {}
  })

  on('command.run', { command: 'intiface-disconnect' }, async $ => {
    report($, await command($, { cmd: 'disconnect' }))

    return {}
  })

  // With no argument it says what the intensity is. One that is not a number
  // reaches the daemon as null, and is refused there with the rest.
  on('command.run', { command: 'intiface-intensity' }, async ($, e) => {
    const text = e.args.trim()
    report($, await command($, text === '' ? { cmd: 'intensity' } : { cmd: 'intensity', value: Number(text) }))

    return {}
  })

  // Turns --------------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    sessionID ??= await $.session.id()
    forgetTurnCalls()
    emit($, { event: 'turn.start' })

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    // A subagent's run ending is not the turn ending, but it is the end of
    // that subagent's calls: one that never said it finished is over too. The
    // daemon is told either way, since it may know of calls this module has
    // forgotten (a reload starts the module over).
    if (e.agentId === undefined) {
      forgetTurnCalls()
      emit($, { event: 'turn.complete', reason: e.reason })
    } else {
      for (const [id, agent] of agentCalls) {
        if (agent !== e.agentId) continue
        agentCalls.delete(id)
        mayAsk.delete(id)
        asked.delete(id)
      }
      emit($, { event: 'agent.complete', agent: e.agentId })
    }

    return next(e)
  })

  // The model's response, piece by piece. Thinking and text are felt as they
  // stream; a tool call is felt from the moment the model starts writing it.
  on('turn.step', async function* ($, e, next) {
    // A subagent's tool calls are felt like any others; what it thinks and
    // says is not the conversation's.
    const isMain = e.agentId === undefined
    const step = `${e.turnId}:${e.index}`
    let open = null as { kind: 'reasoning' | 'text' | 'tool.input'; id: string; chars: number } | null
    let isLive = false

    // Blocks arrive one after another, and nothing marks a block's end but
    // the next one beginning or the response stopping.
    const close = () => {
      if (open === null) return
      emit($, { event: `${open.kind}.ended`, id: open.id })
      open = null
    }
    const enter = (kind: 'reasoning' | 'text' | 'tool.input', id: string) => {
      if (open !== null && open.kind === kind && open.id === id) return open
      close()
      open = { kind, id, chars: 0 }
      return open
    }

    const stream = next(e)
    try {
      for await (const chunk of stream) {
        if (chunk.kind === 'thinking' || chunk.kind === 'text') {
          if (!isMain) {
            // Not felt, but a new block all the same: the call before it is written.
            if (open?.kind === 'tool.input') close()
          } else {
            const kind = chunk.kind === 'thinking' ? 'reasoning' : 'text'
            const id = `${step}:${chunk.index}`
            // The engine keeps thinking's text to itself where no one is shown
            // it: the chunks still come, empty, and nothing is felt.
            if (enter(kind, id).chars++ === 0) emit($, { event: `${kind}.started`, id })
            if (chunk.text.length > 0) emit($, { event: `${kind}.delta`, id, chars: chunk.text.length })
            // A block that has started makes the response live, text or not.
            isLive = true
          }
        } else if (chunk.kind === 'tool') {
          if (enter('tool.input', chunk.id).chars++ === 0) {
            emit($, { event: 'tool.input.started', id: chunk.id, tool: chunk.name })
          }
        } else if (chunk.kind === 'stop') {
          // A block's end is one of the engine's own items, which cannot be
          // told from its others (a retry marker, the envelope): a call's
          // arguments are taken as whole when the next block begins or the
          // response stops. The daemon ends the wait itself if the call runs first.
          close()
        }
        yield chunk
      }
    } finally {
      close()
    }

    const response = await stream.result
    // A part that arrived whole is felt once, by its ID, unless the response
    // was live: one that streamed anything, thinking included, has been felt.
    // The response's text is the one part that can arrive whole: thinking
    // reaches a plugin only as it streams.
    if (isMain && !isLive && response.answer.length > 0) {
      emit($, { event: 'output.snapshot', id: `${step}:answer` })
    }

    return response
  })

  // Tools --------------------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    const tool = String(e.tool)
    if (e.agentId !== undefined) agentCalls.set(id, e.agentId)
    emit($, { event: 'tool.started', id, tool, ...(e.agentId === undefined ? {} : { agent: e.agentId }) })

    const finish = (status: 'completed' | 'error') => {
      agentCalls.delete(id)
      mayAsk.delete(id)
      asked.delete(id)
      const update = status === 'completed' ? todoUpdate(tool, e as Record<string, unknown>) : {}
      emit($, { event: 'tool.finished', id, tool, status, ...update })
    }

    try {
      const ran = await next(e)
      const hasFailed = ran.deny !== undefined || ran.isError === true
      finish(hasFailed ? 'error' : 'completed')

      return ran
    } catch (error) {
      finish('error')
      throw error
    }
  }).catch(($, e, next) => next(e))

  // Permission prompts. The engine draws the dialog itself and says neither
  // which call it is for nor when it was answered, so both are worked out:
  // the call is the one whose check said "ask" for the tool and input the
  // prompt names (failing that, the tool alone), and the answer has come once
  // the call is running, fails or finishes.
  //
  // All three only watch: one that fails lets the call go on as it would have.

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'ask' && e.tool_use_id !== undefined) {
      mayAsk.set(e.tool_use_id, { tool: e.tool, input: JSON.stringify(e.input) })
    }

    return verdict
  }).catch(($, e, next) => next(e))

  on('classic.PermissionRequest', ($, e, next) => {
    const input = JSON.stringify(e.tool_input)
    const calls = [...mayAsk].filter(([, call]) => call.tool === e.tool_name)
    const [id] = calls.find(([, call]) => call.input === input) ?? calls[0] ?? []
    if (id !== undefined) {
      mayAsk.delete(id)
      asked.add(id)
      emit($, { event: 'permission.asked', id })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // The run-in-background hint is drawn under a call that is running: for a
  // long command, the first sign that its prompt was answered. Only the
  // terminal draws it, and for calls that share one hint it names the first:
  // any other call's answer is known when the call finishes.
  on('ui.render', { component: 'ToolProgress' }, ($, e, next) => {
    const id = e.props.tool_use_id
    // A running call is past its permission check, prompt or none.
    mayAsk.delete(id)
    if (asked.delete(id)) emit($, { event: 'permission.replied', id })

    return next(e)
  })
}
