// What the hooks module tells the daemon, run against the engine itself:
//   claude plugin test .
import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

type Sent = { session: string; event: string; [key: string]: unknown }

// What a call on `$` resolves to is answered beneath the plugin as { value }.
const answer = (body: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(body) } })

/** Stands in for the daemon and the host beneath the plugin; records what reaches them. */
const world = (on: On, commands: Record<string, unknown> = {}, start = { exitCode: 0, stdout: '{"port":4242,"pid":77}', stderr: '' }) => {
  const sent: Sent[] = []
  let starts = 0
  const toasts: string[] = []
  const ran: unknown[] = []
  const registered: string[] = []
  const panes: string[] = []
  let polls = 0
  // How many commands find the daemon gone before one is answered.
  const gone = { commands: 0 }
  const session = { id: 'S1' }
  const clock = mock.clock(on)

  on('session.id', () => ({ value: session.id }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.end', (_$, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('command.register', (_$, e) => {
    registered.push(e.name)

    return { value: { command: e.name } }
  })
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.open', (_$, e) => {
    panes.push(`open ${e.id}`)

    return { value: { isPlaced: true as const } }
  })
  on('ui.close', (_$, e) => {
    panes.push(`close ${e.id}`)

    return { value: undefined }
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by the engine'] }))
  on('process.run', () => {
    starts++

    return { value: { ...start, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', (_$, e) => {
    const { pathname } = new URL(e.url)
    const body = JSON.parse(e.init?.body ?? '{}')
    if (pathname === '/events') {
      sent.push(...body.events)
      return answer({ ok: true })
    }
    if (pathname === '/cmd') {
      if (gone.commands-- > 0) throw new Error('gone')
      ran.push(body)
      return answer(commands[body.cmd] ?? { error: 'unexpected' })
    }
    // One notice, then the daemon is "gone": the module waits to retry.
    if (polls++ === 0) return answer({ id: 'd', seq: 1, notices: [{ message: 'Restored Mock Vibe' }] })
    throw new Error('gone')
  })

  // Without the session.
  const events = () => sent.map(({ session: _, ...event }): Omit<Sent, 'session'> => event)

  return { sent, toasts, ran, registered, panes, clock, session, gone, events, starts: () => starts }
}

const START = { cwd: '/tmp', surface: 'terminal', isInteractive: true } as const

test('a session starts the daemon, registers the commands and shows its notices', async ($, on) => {
  const { sent, toasts, registered, clock } = world(on)
  await $.session.start(START)
  await clock.settle()

  expect(sent).toEqual([{ session: 'S1', event: 'session.start' }])
  expect(toasts).toEqual(['Intiface: Restored Mock Vibe'])
  expect(registered.sort()).toEqual(['intiface', 'intiface-connect', 'intiface-disconnect'])
})

test('thinking, text and a tool call are reported as they stream, in order', async ($, on) => {
  const { events, clock } = world(on)
  on('turn.step', async function* (_$, e) {
    yield { kind: 'thinking', index: 0, text: 'hm' }
    yield { kind: 'thinking', index: 0, text: 'mm.' }
    yield { kind: 'text', index: 1, text: 'Editing' }
    yield { kind: 'tool', index: 2, id: 'toolu_1', name: 'Edit' }
    yield { kind: 'input', index: 2, json: '{"file_path":' }
    yield { kind: 'input', index: 2, json: '"a.ts"}' }
    // A call's writing ends where the next block begins.
    yield { kind: 'tool', index: 3, id: 'toolu_2', name: 'Bash' }
    yield { kind: 'stop', stopReason: 'tool_use', usage: null }

    return { turnId: e.turnId, index: e.index, answer: 'Editing', toolUses: [], stopReason: 'tool_use', usage: null }
  })
  await $.session.start(START)

  const stream = $.turn.step({ turnId: 'T', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of stream) {
    // read to the end, as the engine does
  }
  await stream.result
  await clock.settle()

  expect(events().slice(1)).toEqual([
    { event: 'reasoning.started', id: 'T:0:0' },
    { event: 'reasoning.delta', id: 'T:0:0', chars: 2 },
    { event: 'reasoning.delta', id: 'T:0:0', chars: 3 },
    { event: 'reasoning.ended', id: 'T:0:0' },
    { event: 'text.started', id: 'T:0:1' },
    { event: 'text.delta', id: 'T:0:1', chars: 7 },
    { event: 'text.ended', id: 'T:0:1' },
    { event: 'tool.input.started', id: 'toolu_1', tool: 'Edit' },
    { event: 'tool.input.ended', id: 'toolu_1' },
    { event: 'tool.input.started', id: 'toolu_2', tool: 'Bash' },
    { event: 'tool.input.ended', id: 'toolu_2' },
  ])
})

test('withheld thinking is silent and makes the response live; an unstreamed one is a snapshot; a subagent says nothing but its tools', async ($, on) => {
  const { events, clock } = world(on)
  on('turn.step', async function* (_$, e) {
    // Thinking whose text is withheld: the chunks come, empty.
    if (e.turnId === 'T') yield { kind: 'thinking', index: 0, text: '' }
    if (e.agentId !== undefined) {
      yield { kind: 'text', index: 0, text: 'from a subagent' }
      yield { kind: 'tool', index: 1, id: 'toolu_2', name: 'Bash' }
    }

    return { turnId: e.turnId, index: e.index, answer: 'All done.', toolUses: [], stopReason: 'end_turn', usage: null }
  })
  await $.session.start(START)

  for (const agentId of [undefined, 'agent-1']) {
    const stream = $.turn.step({ turnId: 'T', index: 0, model: 'm', messageCount: 1, agentId })
    for await (const _ of stream) {
      // read to the end
    }
    await stream.result
  }
  // Nothing of this one streams at all.
  const whole = $.turn.step({ turnId: 'U', index: 0, model: 'm', messageCount: 1 })
  for await (const _ of whole) {
    // read to the end
  }
  await whole.result
  await clock.settle()

  expect(events().slice(1)).toEqual([
    { event: 'reasoning.started', id: 'T:0:0' },
    { event: 'reasoning.ended', id: 'T:0:0' },
    { event: 'tool.input.started', id: 'toolu_2', tool: 'Bash' },
    { event: 'tool.input.ended', id: 'toolu_2' },
    { event: 'output.snapshot', id: 'U:0:answer' },
  ])
})

test('a tool call is reported when it runs and how it ended', async ($, on) => {
  const { events, clock } = world(on)
  on('tool.call', { tool: 'Bash' }, (_$, e) =>
    e.command === 'false'
      ? { result: 'exit 1', text: 'exit 1', isError: true }
      : { result: { stdout: 'a\nb\n' }, text: 'a\nb\n' },
  )
  on('tool.call', { tool: 'TodoWrite' }, () => ({ result: {}, text: 'ok' }))
  await $.session.start(START)

  await $.tool.call({ tool: 'Bash', tool_use_id: 't1', command: 'ls' })
  await $.tool.call({ tool: 'Bash', tool_use_id: 't2', command: 'false' })
  await $.tool.call({
    tool: 'TodoWrite',
    tool_use_id: 't3',
    todos: [{ content: 'write tests', status: 'completed', activeForm: 'Writing tests' }],
  })
  await clock.settle()

  expect(events().slice(1)).toEqual([
    { event: 'tool.started', id: 't1', tool: 'Bash' },
    { event: 'tool.finished', id: 't1', tool: 'Bash', status: 'completed' },
    { event: 'tool.started', id: 't2', tool: 'Bash' },
    { event: 'tool.finished', id: 't2', tool: 'Bash', status: 'error' },
    { event: 'tool.started', id: 't3', tool: 'TodoWrite' },
    {
      event: 'tool.finished',
      id: 't3',
      tool: 'TodoWrite',
      status: 'completed',
      todos: [{ key: 'write tests', status: 'completed' }],
    },
  ])
})

test('a permission prompt is reported for the call it is about, and its answer once the call runs', async ($, on) => {
  const { events, clock } = world(on)
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PermissionRequest', () => ({}))
  await $.session.start(START)

  await $.tool.check({ tool: 'Read', input: { file_path: '/x' }, tool_use_id: 'p0' })
  // An earlier call to the same tool that the mode let through without a prompt.
  await $.tool.check({ tool: 'Bash', input: { command: 'sleep 60' }, tool_use_id: 'p9' })
  await $.tool.check({ tool: 'Bash', input: { command: 'rm x' }, tool_use_id: 'p1' })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm x' } })
  const pill = await $.ui.mount({
    plugin: 'vibeclaude',
    surface: 'terminal',
    component: 'ToolProgress',
    props: { tool_use_id: 'p1', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
  })
  await pill.unmount()
  await clock.settle()

  expect(events().slice(1)).toEqual([
    { event: 'permission.asked', id: 'p1' },
    { event: 'permission.replied', id: 'p1' },
  ])
})

test('a subagent\'s call is still its own when the turn that started it ends', async ($, on) => {
  const { events, clock } = world(on)
  let answerPrompt = () => {}
  on('tool.call', async () => {
    await new Promise<void>((resolve) => (answerPrompt = resolve))

    return { result: 'done' }
  })
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PermissionRequest', () => ({}))
  await $.session.start(START)

  await $.turn.start({ text: 'hi', turnId: 'T' })
  const inSubagent = { tool: 'Bash' as const, tool_use_id: 'b1', command: 'make', agentId: 'agent-1' }
  const call = $.tool.call(inSubagent)
  await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'b1', agentId: 'agent-1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'ls' }, tool_use_id: 'm1' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'T', reason: 'answer' })
  // The main loop's call is forgotten with its turn; the subagent's is asked about after it.
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } })
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'make' } })
  answerPrompt()
  await call
  await clock.settle()

  expect(events().slice(1)).toEqual([
    { event: 'turn.start' },
    { event: 'tool.started', id: 'b1', tool: 'Bash', agent: 'agent-1' },
    { event: 'turn.complete', reason: 'answer' },
    { event: 'permission.asked', id: 'b1' },
    { event: 'tool.finished', id: 'b1', tool: 'Bash', status: 'completed' },
  ])
})

test('a subagent\'s call that never says it finished is over when the subagent\'s run ends', async ($, on) => {
  const { events, clock } = world(on)
  on('tool.call', () => new Promise<never>(() => {}))
  on('tool.check', () => ({ decision: 'ask' }))
  on('classic.PermissionRequest', () => ({}))
  await $.session.start(START)

  void $.tool.call({ tool: 'Bash' as const, tool_use_id: 'b1', command: 'make', agentId: 'agent-1' })
  await $.tool.check({ tool: 'Bash', input: { command: 'make' }, tool_use_id: 'b1', agentId: 'agent-1' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'T', agentId: 'agent-2', reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 'T', agentId: 'agent-1', reason: 'aborted' })
  // The call is forgotten: a prompt for the same tool and input is not taken for its own.
  await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'make' } })
  await clock.settle()

  expect(events().slice(1)).toEqual([
    { event: 'tool.started', id: 'b1', tool: 'Bash', agent: 'agent-1' },
    { event: 'agent.complete', agent: 'agent-2' },
    { event: 'agent.complete', agent: 'agent-1' },
  ])
})

test('a daemon that will not start is said once, and tried again less and less often', async ($, on) => {
  const { toasts, clock, starts } = world(on, {}, { exitCode: 1, stdout: '', stderr: 'no node' })
  await $.session.start(START)
  await clock.advance(60_000)

  // After 0s, 5s, 15s and 35s; the next is at 75s.
  expect(starts()).toBe(4)
  expect(toasts).toEqual(['Intiface: Daemon failed to start: Error: no node'])
})

test('turns and the end of the session are reported; a /clear goes on under the new id', async ($, on) => {
  const { sent, clock, session } = world(on)
  await $.session.start(START)

  await $.turn.start({ text: 'hi', turnId: 'T' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: false, turnId: 'T', agentId: 'agent-1', reason: 'answer' })
  await $.turn.complete({ answer: '', durationMs: 9, isAborted: true, turnId: 'T', reason: 'aborted' })
  await $.session.end({ reason: 'clear', sessionId: 'S1', resume: { id: 'S1' } })
  session.id = 'S2'
  await $.turn.start({ text: 'again', turnId: 'U' })
  await clock.settle()

  expect(sent.slice(1)).toEqual([
    { session: 'S1', event: 'turn.start' },
    { session: 'S1', event: 'agent.complete', agent: 'agent-1' },
    { session: 'S1', event: 'turn.complete', reason: 'aborted' },
    { session: 'S1', event: 'session.end', reason: 'clear' },
    { session: 'S2', event: 'turn.start' },
  ])
})

test('connect and disconnect run in the daemon and answer with a toast, not a model turn', async ($, on) => {
  const { toasts, ran, clock } = world(on, {
    connect: { message: 'Connected' },
    disconnect: { error: 'Disconnect failed: Error: no' },
  })
  await $.session.start(START)
  await clock.settle()
  toasts.length = 0

  for (const command of ['intiface-connect', 'intiface-disconnect']) {
    const output = await $.command.run({ command, args: '', origin: ORIGIN, presentation: PRESENTATION })
    expect(output.text).toBeUndefined()
  }

  expect(ran).toEqual([{ cmd: 'connect' }, { cmd: 'disconnect' }])
  expect(toasts).toEqual(['Intiface: Connected', 'Intiface: Disconnect failed: Error: no'])
})

test('a command that finds the daemon gone starts another and runs there', async ($, on) => {
  const { toasts, ran, clock, gone, starts } = world(on, { connect: { message: 'Connected' } })
  await $.session.start(START)
  await clock.settle()
  toasts.length = 0

  gone.commands = 1
  await $.command.run({ command: 'intiface-connect', args: '', origin: ORIGIN, presentation: PRESENTATION })
  expect(starts()).toBe(2)
  expect(ran).toEqual([{ cmd: 'connect' }])
  expect(toasts).toEqual(['Intiface: Connected'])

  // One that is gone again is said, not tried for good.
  gone.commands = 2
  await $.command.run({ command: 'intiface-connect', args: '', origin: ORIGIN, presentation: PRESENTATION })
  expect(starts()).toBe(3)
  expect(toasts.at(-1)?.startsWith('Intiface: Command failed: ')).toBe(true)
})

const ORIGIN = { kind: 'composer' } as const
const PRESENTATION = { isFullscreen: false, columns: 80 }
const DIALOG = {
  plugin: 'vibeclaude',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'intiface',
  props: {
    title: 'Intiface',
    isFocused: true,
    bodyColumns: 60,
    placement: 'inline',
    scroll: { offset: 0, bodyRows: 7 },
    view: {},
  },
} as const

test('/intiface opens a dialog that connects, scans and lists the devices; picking one selects it', async ($, on) => {
  const { toasts, ran, panes, clock } = world(on, {
    state: { connected: false, selected: 1 },
    'ensure-connected': { connected: true },
    scan: {
      devices: [
        { index: 0, name: 'Mock Vibe' },
        { index: 1, name: 'Other Vibe' },
      ],
      selected: 1,
    },
    select: { message: 'Selected Mock Vibe' },
  })
  await $.session.start(START)
  await clock.settle()
  toasts.length = 0

  const output = await $.command.run({ command: 'intiface', args: '', origin: ORIGIN, presentation: PRESENTATION })
  await clock.settle()
  expect(output.text).toBeUndefined()
  expect(ran).toEqual([{ cmd: 'state' }, { cmd: 'ensure-connected' }, { cmd: 'scan' }])
  expect(panes).toEqual(['open intiface'])

  const dialog = await $.ui.mount(DIALOG)
  expect((await dialog.findAll({ type: 'Text' })).map((text) => text.text)).toEqual([
    'Select device',
    'Device #0',
    'Device #1',
    'Connected',
  ])
  expect((await dialog.findAll({ type: 'Button' })).map((button) => button.text)).toEqual(['Mock Vibe', 'Other Vibe'])

  await dialog.press({ key: 'device-0' })
  expect(ran.at(-1)).toEqual({ cmd: 'select', index: 0 })
  expect(toasts).toEqual(['Intiface: Selected Mock Vibe'])
  expect(panes).toEqual(['open intiface', 'close intiface'])
  await dialog.unmount()
})

test('the dialog says so when nothing can vibrate, and closes with a toast when the scan fails', async ($, on) => {
  const commands: Record<string, unknown> = {
    state: { connected: true, selected: null },
    scan: { devices: [], selected: null },
  }
  const { toasts, ran, panes, clock } = world(on, commands)
  await $.session.start(START)
  await clock.settle()
  toasts.length = 0

  await $.command.run({ command: 'intiface', args: '', origin: ORIGIN, presentation: PRESENTATION })
  await clock.settle()
  expect(ran).toEqual([{ cmd: 'state' }, { cmd: 'scan' }])

  const dialog = await $.ui.mount(DIALOG)
  expect((await dialog.findAll({ type: 'Text' })).map((text) => text.text)).toEqual([
    'No vibration-capable devices found',
  ])
  expect(await dialog.findAll({ type: 'Button' })).toEqual([])
  expect(panes).toEqual(['open intiface'])
  await dialog.unmount()

  commands.scan = { error: 'Command failed: Error: no' }
  await $.command.run({ command: 'intiface', args: '', origin: ORIGIN, presentation: PRESENTATION })
  await clock.settle()
  expect(toasts).toEqual(['Intiface: Command failed: Error: no'])
  expect(panes).toEqual(['open intiface', 'open intiface', 'close intiface'])
})
