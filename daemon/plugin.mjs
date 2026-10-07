// The plugin proper: wires what happens in a Claude Code session to the
// vibration handlers and implements the /intiface commands. daemon.mjs feeds
// it events and commands; it knows nothing about HTTP.

import { CoTHandler } from './handlers/CoTHandler.mjs';
import { CompletionHandler } from './handlers/CompletionHandler.mjs';
import { InterruptHandler } from './handlers/InterruptHandler.mjs';
import { ActivityHandler, isFileMutationTool } from './handlers/ActivityHandler.mjs';
import { PermissionHandler } from './handlers/PermissionHandler.mjs';
import { IntifaceConnector } from './core/IntifaceConnector.mjs';
import { VibrationEngine } from './core/VibrationEngine.mjs';
import { DeviceMixer } from './core/DeviceMixer.mjs';
import { findSavedDevice } from './core/DeviceSelection.mjs';

const DEFAULT_SCAN_MS = 3000;
const SELECTED_DEVICE_KEY = 'vibeclaude.selected-device';
const INTENSITY_KEY = 'vibeclaude.intensity';
const SNAPSHOT_OUTPUT_DURATION = 150;
const SNAPSHOT_OUTPUT_INTENSITY = 0.4;
// How long a loop that is over is given to end what it plays last, and for
// its last stop to reach the device.
const LOOP_CLOSE_MS = 1000;
// A session that starts this soon after an automatic connection failed does
// not try again: the daemon's own start and its first session come together.
const AUTO_CONNECT_RETRY_MS = 5000;
// The events that only end something: a block, a call's writing, a call or its prompt.
const ENDING_EVENTS = new Set(['reasoning.ended', 'text.ended', 'tool.input.ended', 'tool.finished', 'permission.replied']);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the intensity can be: from 0 (nothing is felt) to 1 (every pattern as strong as it asks to be). */
const isIntensity = (value) => typeof value === 'number' && value >= 0 && value <= 1;

/** A run that ended any other way than by the model's own word (its answer, or its refusal) was cut short. */
const isCutShort = (reason) => reason !== 'answer' && reason !== 'refusal';

// One loop of a Claude Code session: the conversation's own, or a subagent's.
// Each loop is its own instance of the plugin's engine and handlers, so several
// can be at work at once (in one Claude Code or in several) without stopping
// or overriding each other's output; they share the Intiface connection and
// the device.
//
// Events arrive in the order they happened. Text never does: the hooks module
// sends how many characters arrived, so deltas are character counts.
function createLoop(sessionID, engine, isSessionAsking, isCutShortWithTurn, taskStatuses, todoStatuses) {
  const cotHandler = new CoTHandler(engine);
  const messageHandler = new CoTHandler(engine, 'message');
  const preparationHandler = new CoTHandler(engine, 'preparing', null);
  const completionHandler = new CompletionHandler(engine, cotHandler, messageHandler);
  const interruptHandler = new InterruptHandler(engine, cotHandler, messageHandler);
  const activityHandler = new ActivityHandler(engine, taskStatuses, todoStatuses);
  const permissionHandler = new PermissionHandler(engine);
  const activeReasoningIDs = new Set();
  const activeTextIDs = new Set();
  const patchPreparationCallIDs = new Set();
  const runningCallIDs = new Set();
  const snapshotOutputParts = new Set();
  // How the loop's last turn ended.
  let wasTurnCutShort = false;

  const startPatchPreparation = (callID) => {
    if (patchPreparationCallIDs.has(callID)) return;
    patchPreparationCallIDs.add(callID);
    preparationHandler.start(Date.now(), false, true);
  };

  const endPatchPreparation = (callID) => {
    patchPreparationCallIDs.delete(callID);
    if (patchPreparationCallIDs.size === 0) preparationHandler.end();
  };

  const playSnapshot = (partID) => {
    if (snapshotOutputParts.has(partID)) return;
    snapshotOutputParts.add(partID);
    engine.play({ source: 'output', intensity: SNAPSHOT_OUTPUT_INTENSITY, duration: SNAPSHOT_OUTPUT_DURATION });
  };

  // Output means the loop's run is going: what is left of the last turn's
  // ending gives way to it.
  const startReasoning = (id) => {
    completionHandler.stop();
    if (activeReasoningIDs.has(id)) return;
    activeReasoningIDs.add(id);
    cotHandler.start();
  };

  const startText = (id) => {
    completionHandler.stop();
    if (activeTextIDs.has(id)) return;
    activeTextIDs.add(id);
    messageHandler.start();
  };

  const isAsking = () => permissionHandler.requests.size > 0;

  const onToolFinished = (m) => {
    runningCallIDs.delete(m.id);
    permissionHandler.onReplied(m.id);
    if (isFileMutationTool(m.tool)) endPatchPreparation(m.id);
    // A todo changes while its tool runs, so its pulse comes before the
    // tool's own: the success pulse is the one that lands.
    if (m.status === 'completed') {
      if (Array.isArray(m.todos)) activityHandler.onTodosUpdated(m.todos);
      if (m.todo) activityHandler.onTodoUpdated(m.todo.key, m.todo.status);
    }
    // A call that fails as its run is cut short with the turn failed with
    // it, and the turn's ending is how that is felt.
    if (m.status === 'error' && isCutShortWithTurn()) return;
    activityHandler.onToolUpdated(m.id, m.tool, m.status);
  };

  // The loop's run is over, a turn or a subagent's: no prompt of its own
  // outlives it, however it ended, nor does its thinking or text. A call its
  // end cut short never says it finished.
  const endRun = () => {
    permissionHandler.reset();
    activeReasoningIDs.clear();
    activeTextIDs.clear();
    cotHandler.end();
    messageHandler.end();
    runningCallIDs.clear();
    patchPreparationCallIDs.clear();
    preparationHandler.end();
  };

  const onTurnComplete = (reason) => {
    wasTurnCutShort = isCutShort(reason);
    // An interrupted or failed turn stops everything, then goes idle like
    // any other: the turn's end is felt whatever ended it.
    if (wasTurnCutShort) {
      completionHandler.stop();
      interruptHandler.onSessionError();
    }
    endRun();
    completionHandler.onSessionIdle();
  };

  // A subagent's run is what the call that started it came to, and is felt as
  // a call's result: for a subagent in the background, the only one it gets.
  // A run cut short with the turn (a subagent in the foreground is interrupted
  // with it) is felt as the turn's ending: a pulse of the run's own, or of the
  // call it was in the middle of, is as strong and would run the ending's
  // three into one.
  const onAgentComplete = (reason) => {
    endRun();
    if (isCutShort(reason) && isCutShortWithTurn()) {
      engine.stopAll();
      return;
    }
    activityHandler.onAgentCompleted(isCutShort(reason) ? 'error' : 'completed');
  };

  const handleEvent = (m) => {
    switch (m.event) {
      case 'reasoning.started':
        // Silent: thinking is felt as its text streams. Where the text is
        // withheld there is nothing to feel.
        startReasoning(m.id);
        break;

      case 'reasoning.delta':
        startReasoning(m.id);
        // Held back while a prompt waits, it still counts towards how fast it comes.
        cotHandler.onTextDelta(m.chars ?? 0, !isSessionAsking());
        break;

      case 'reasoning.ended':
        activeReasoningIDs.delete(m.id);
        if (activeReasoningIDs.size === 0) cotHandler.end();
        break;

      case 'text.started':
        startText(m.id);
        break;

      case 'text.delta':
        startText(m.id);
        messageHandler.onTextDelta(m.chars ?? 0, !isSessionAsking());
        break;

      case 'text.ended':
        activeTextIDs.delete(m.id);
        if (activeTextIDs.size === 0) messageHandler.end();
        break;

      case 'output.snapshot':
        // A part that arrived whole: nothing of it streamed, so it gets one
        // pulse instead of a speed-driven stream. It is text all the same:
        // held back, like text that streams, while a prompt waits.
        if (!isSessionAsking()) playSnapshot(m.id);
        break;

      case 'tool.input.started':
        // The model has begun writing a tool call's arguments.
        if (isFileMutationTool(m.tool)) startPatchPreparation(m.id);
        activityHandler.onToolUpdated(m.id, m.tool, 'pending');
        break;

      case 'tool.input.ended':
        // A call can start running before its response has finished streaming.
        if (!runningCallIDs.has(m.id)) endPatchPreparation(m.id);
        break;

      case 'tool.started':
        runningCallIDs.add(m.id);
        if (isFileMutationTool(m.tool)) startPatchPreparation(m.id);
        activityHandler.onToolUpdated(m.id, m.tool, 'running');
        break;

      case 'tool.finished':
        onToolFinished(m);
        break;

      case 'permission.asked':
        preparationHandler.end();
        permissionHandler.onAsked(m.id, sessionID);
        break;

      case 'permission.replied':
        permissionHandler.onReplied(m.id);
        break;

      case 'turn.complete':
        onTurnComplete(m.reason);
        break;

      case 'agent.complete':
        onAgentComplete(m.reason);
        break;

      default:
        break;
    }
  };

  /** The loop is over: stop whatever it was playing. */
  const dispose = () => {
    completionHandler.stop();
    patchPreparationCallIDs.clear();
    preparationHandler.end();
    permissionHandler.reset();
    interruptHandler.onSessionDeleted();
  };

  return {
    engine,
    handleEvent,
    isAsking,
    isRunning: (callID) => runningCallIDs.has(callID),
    isCutShortEnding: () => wasTurnCutShort && completionHandler.isPlaying(),
    todoStatuses: () => activityHandler.todoStatuses,
    dispose,
  };
}

// Everything that belongs to one Claude Code session: the conversation's own
// loop, one for each subagent at work, and which of them an event is for.
// Every loop has an engine of its own, on its own channel of the mixer, so a
// subagent is felt beside the conversation that started it as another session
// would be: a pulse of one does not cut short an edit hold, or the turn's
// ending, in another.
function createSession(sessionID, openEngine, closeEngine) {
  // subagent → its loop, from the first that is heard of it to the end of its run.
  const agentLoops = new Map();
  // Loops of subagents whose run is over, until what they play last is too.
  const endedLoops = new Set();
  // What a subagent is thinking, saying and calling, each with its subagent:
  // an event that follows may name only the block or the call.
  const owners = new Map();
  // subagent → what its todos had come to when its run last ended. A subagent
  // can be woken under the id it had, and each of a teammate's turns is a run:
  // a todo completed in one is not completed anew in the next.
  const agentTodos = new Map();
  // What the tasks have come to. Theirs is one list, the conversation's and
  // its subagents' alike: a task one of them completed is not completed anew
  // when another says so.
  const taskStatuses = new Map();
  // subagent → the call that started it, for as long as that call runs: the
  // subagent is in the foreground till then, and is cut short if the call is.
  // null once the call is over or the run is, and for a subagent started in
  // the background. The hooks module says which call it was; a subagent it
  // said nothing of (a forked skill's, or one met mid-run) is not here.
  const startedBy = new Map();
  // Subagents cut short with the call that started them, until the end of
  // their run is heard of.
  const cutShort = new Set();

  // A prompt is told by its rhythm, and waits on the person: what streams
  // meanwhile (a subagent's output, mostly) is not played into its pauses,
  // whichever of the session's loops is asking.
  const isAsking = () => [main, ...agentLoops.values()].some((loop) => loop.isAsking());

  // A subagent in the foreground is interrupted with its turn, and that is
  // felt as the turn's ending, not as a failure of the subagent's own. Where
  // the call that started it is known, so is whether it was: `cutShortRun`
  // ends its loop there and then. Where it is not, it is guessed at: what
  // fails while the ending of a turn that was itself cut short plays failed
  // with the turn.
  const isCutShortWithTurn = (agent) => agent !== undefined && !startedBy.has(agent) && main.isCutShortEnding();

  const openLoop = (agent) =>
    createLoop(sessionID, openEngine(), isAsking, () => isCutShortWithTurn(agent), taskStatuses, agentTodos.get(agent));
  const main = openLoop();

  // A subagent the daemon has not met (it may have started mid-run) is picked
  // up from whichever event arrives first.
  const loopOf = (agent) => {
    if (agent === undefined) return main;
    if (!agentLoops.has(agent)) agentLoops.set(agent, openLoop(agent));
    return agentLoops.get(agent);
  };

  // A subagent's loop is over: a call of its own that never said it finished,
  // its prompt, its hold and what it was saying. What `end` has it play is
  // the last thing its engine plays.
  const endLoop = (agent, end) => {
    const loop = loopOf(agent);
    agentLoops.delete(agent);
    for (const [id, owner] of [...owners]) {
      if (owner === agent) owners.delete(id);
    }
    end(loop);
    const todos = loop.todoStatuses();
    if (todos.size > 0) agentTodos.set(agent, todos);
    else agentTodos.delete(agent);
    endedLoops.add(loop);
    closeEngine(loop.engine).then(() => endedLoops.delete(loop));
  };

  // The calls `isOver` picks out are over. A subagent one of them started
  // whose run has not ended is in the background from here on, unless the
  // call was cut short: that cuts the subagent short with it.
  const endCalls = (isOver, wasCutShort) => {
    for (const agent of [...startedBy.keys()]) {
      const call = startedBy.get(agent);
      if (call === null || !isOver(call)) continue;
      startedBy.set(agent, null);
      if (wasCutShort) cutShortRun(agent);
    }
  };

  // A subagent in the foreground was cut short with the call that started it.
  // That is felt as the call failing or, when the turn went with it, as the
  // turn's ending; its loop is over here if it has one yet, however late the
  // end of its run is heard of, and nothing more of the run is felt: not the
  // call it was in the middle of failing, nor the run's own end. The
  // subagents its calls were holding in the foreground go with it.
  const cutShortRun = (agent) => {
    endCalls((call) => owners.get(call) === agent, true);
    cutShort.add(agent);
    if (agentLoops.has(agent)) endLoop(agent, (loop) => loop.dispose());
  };

  // The hooks module says which call started a subagent, once it has. A call
  // that is not running (a workflow's, a plugin's own) holds nothing in the
  // foreground.
  const onAgentStarted = (m) => {
    const parent = owners.get(m.id);
    const loop = parent === undefined ? main : agentLoops.get(parent);
    startedBy.set(m.agent, loop?.isRunning(m.id) ? m.id : null);
    cutShort.delete(m.agent);
  };

  // A subagent's run is over, and its loop with it. The pulse of its result
  // is the last thing its engine plays.
  const onAgentComplete = (m) => {
    endCalls((call) => owners.get(call) === m.agent, isCutShort(m.reason));
    if (startedBy.has(m.agent)) startedBy.set(m.agent, null);
    // Cut short with the call that started it: this is the end that was
    // still to be heard of, and there is nothing left of it to feel.
    if (cutShort.delete(m.agent) && isCutShort(m.reason)) {
      if (agentLoops.has(m.agent)) endLoop(m.agent, (loop) => loop.dispose());
      return;
    }
    endLoop(m.agent, (loop) => loop.handleEvent(m));
  };

  const handleEvent = (m) => {
    if (m.event === 'agent.started') {
      onAgentStarted(m);
      return;
    }
    if (m.event === 'agent.complete') {
      onAgentComplete(m);
      return;
    }
    // The turn's ending takes the place of a result that is still playing: a
    // subagent's, of a run that ended just before, as the conversation's own.
    // The conversation's calls are over with its turn, said or not.
    if (m.event === 'turn.complete') {
      for (const loop of endedLoops) loop.dispose();
      endCalls((call) => !owners.has(call), isCutShort(m.reason));
    }
    if (m.event === 'tool.finished') endCalls((call) => call === m.id, m.status === 'error');
    const agent = m.agent ?? owners.get(m.id);
    // What only ends something does not begin a subagent's run. One that was
    // still on its way when the run ended is not its loop again, which would
    // never end a second time, nor is it the conversation's to feel.
    if (agent !== undefined && !agentLoops.has(agent) && ENDING_EVENTS.has(m.event)) return;
    if (m.agent !== undefined && m.id !== undefined) owners.set(m.id, m.agent);
    loopOf(agent).handleEvent(m);
    // The block is over, or the call: nothing more is heard of it.
    if (m.event === 'reasoning.ended' || m.event === 'text.ended' || m.event === 'tool.finished') owners.delete(m.id);
  };

  /** The session is over: stop whatever its loops were playing. Resolves once their engines are closed. */
  const dispose = () => {
    // One whose run is over is being closed as it is: stopped, it has nothing left to wait for.
    for (const loop of endedLoops) loop.dispose();
    const loops = [main, ...agentLoops.values()];
    for (const loop of loops) loop.dispose();
    return Promise.all(loops.map((loop) => closeEngine(loop.engine)));
  };

  return { handleEvent, dispose };
}

export function createPlugin({ wsAddress, kv, notify }) {
  const connector = new IntifaceConnector(wsAddress);
  const mixer = new DeviceMixer(connector);
  // The intensity is the daemon's, not a session's, and the next daemon's too.
  const savedIntensity = kv.get(INTENSITY_KEY, null);
  if (isIntensity(savedIntensity)) mixer.intensity = savedIntensity;
  // sessionID → { handleEvent, dispose }
  const sessions = new Map();
  // Every engine that is open, with its channel of the mixer: one for each
  // loop, a session's own or a subagent's.
  const channels = new Map();
  let deviceIndex = null;
  let scanning = null;
  // The devices the connection last listed, by index.
  let listedIndexes = new Set();
  // True from the selected device leaving the list until it, or another, is selected.
  let isDeviceLost = false;
  // True from /intiface-disconnect until a command connects again: nothing
  // connects by itself in between.
  let isDisconnectedOnPurpose = false;
  let autoConnecting = null;
  let autoConnectFailedAt = -Infinity;

  // The selected device is the same for every session.
  const setDevice = (index) => {
    deviceIndex = index;
    if (index !== null) isDeviceLost = false;
    for (const engine of channels.keys()) engine.setDevice(index);
  };

  const stopAll = () => {
    for (const engine of channels.keys()) engine.stopAll();
  };

  const openEngine = () => {
    const channel = mixer.channel();
    const engine = new VibrationEngine(channel);
    engine.setDevice(deviceIndex);
    channels.set(engine, channel);
    return engine;
  };

  /** The engine's loop is over. What it plays last is left to end, and its last stop to reach the device. */
  const closeEngine = (engine) =>
    Promise.race([engine.settle(), wait(LOOP_CLOSE_MS)]).then(() => {
      mixer.release(channels.get(engine));
      channels.delete(engine);
    });

  connector.onDisconnected = () => {
    listedIndexes = new Set();
    isDeviceLost = false;
    setDevice(null);
    notify('Connection to Intiface was lost', 'warning');
  };
  connector.onError = (message) => notify(message, 'error');
  // A new connection lists its devices one at a time, so a list without the
  // selected device only means it is gone if an earlier list had it. A device
  // that went that way is selected again when it comes back.
  connector.onDeviceListChanged = (devices) => {
    const indexes = new Set(devices.map((device) => device.index));
    if (deviceIndex !== null && listedIndexes.has(deviceIndex) && !indexes.has(deviceIndex)) {
      const name = savedDevice()?.name ?? `#${deviceIndex}`;
      setDevice(null);
      isDeviceLost = true;
      notify(`Device disconnected: ${name}`, 'warning');
    }
    listedIndexes = indexes;
    if (!isDeviceLost) return;
    const restored = reselectDevice();
    if (restored) notify(`Restored ${restored.name}`, 'success');
  };

  // Startup restore and /intiface can overlap; they share one scan.
  const scan = () => {
    scanning ??= (async () => {
      if (!connector.connected) return [];
      await connector.startScanning();
      await wait(DEFAULT_SCAN_MS);
      await connector.stopScanning();
      return connector.getDevices();
    })().finally(() => {
      scanning = null;
    });
    return scanning;
  };

  const selectDevice = (device) => {
    setDevice(device.index);
    kv.set(SELECTED_DEVICE_KEY, { index: device.index, name: device.name });
  };

  const savedDevice = () => {
    const saved = kv.get(SELECTED_DEVICE_KEY, null);
    return saved && typeof saved.index === 'number' && typeof saved.name === 'string' ? saved : null;
  };

  /**
   * After connecting: keep the selection if its device is listed, else go back
   * to the saved device if that one is. Resolves to the device it went back to.
   */
  const reselectDevice = () => {
    const devices = connector.getDevices().filter((candidate) => candidate.supportsVibration);
    if (deviceIndex !== null && devices.some((candidate) => candidate.index === deviceIndex)) return null;

    const saved = savedDevice();
    const device = saved ? findSavedDevice(devices, saved) : undefined;
    if (!device) {
      setDevice(null);
      return null;
    }
    selectDevice(device);
    return device;
  };

  const restoreLastDevice = async () => {
    await connector.connect();
    const saved = savedDevice();
    if (!saved) return;

    const devices = (await scan()).filter((candidate) => candidate.supportsVibration);
    // Gone while it scanned: lost, which was said, or disconnected on purpose.
    if (!connector.connected) return;
    const device = findSavedDevice(devices, saved);
    if (!device) {
      notify(`Previously selected device is unavailable: ${saved.name}`, 'warning');
      return;
    }

    selectDevice(device);
    notify(`Restored ${device.name}`, 'success');
  };

  // Commands ---------------------------------------------------------------
  // Each resolves to what the user is told: { message } or { error }.

  // /intiface runs in steps, so its dialog can say which one it is on:
  // getState, ensureConnected, scanForDevices, then selectDeviceByIndex.

  const getState = () => ({ connected: connector.connected, selected: deviceIndex });

  const connectOnRequest = async () => {
    isDisconnectedOnPurpose = false;
    await connector.connect();
  };

  const ensureConnected = async () => {
    try {
      if (!connector.connected) {
        await connectOnRequest();
        reselectDevice();
      }
      return { connected: true };
    } catch (e) {
      return { error: 'Command failed: ' + String(e) };
    }
  };

  /** Connect if needed, scan, report what can vibrate. */
  const scanForDevices = async () => {
    try {
      if (!connector.connected) {
        await connectOnRequest();
      }
      const devices = await scan();
      reselectDevice();
      return {
        devices: devices.filter((device) => device.supportsVibration),
        selected: deviceIndex,
      };
    } catch (e) {
      return { error: 'Command failed: ' + String(e) };
    }
  };

  /** The user picked a device from the scan results. */
  const selectDeviceByIndex = (index) => {
    const device = connector.getDevices().find((candidate) => candidate.index === index && candidate.supportsVibration);
    if (!device) return { error: `Device #${index} is not an available vibration-capable device` };
    selectDevice(device);
    return { message: `Selected ${device.name}` };
  };

  const connect = async () => {
    try {
      if (connector.connected) return { message: 'Already connected' };
      await connectOnRequest();
      const restored = reselectDevice();
      return { message: restored ? `Connected; restored ${restored.name}` : 'Connected' };
    } catch (e) {
      return { error: 'Connect failed: ' + String(e) };
    }
  };

  const disconnect = async () => {
    // Asked for, with or without a connection to end: nothing connects by
    // itself until a command does. One still being made is ended with it.
    isDisconnectedOnPurpose = true;
    const hadConnection = connector.connected || connector.connecting;
    try {
      stopAll();
      await connector.disconnect();
      listedIndexes = new Set();
      isDeviceLost = false;
      return {
        message: hadConnection ? 'Disconnected' : 'Not connected; staying disconnected until /intiface or /intiface-connect',
      };
    } catch (e) {
      return { error: 'Disconnect failed: ' + String(e) };
    }
  };

  const getIntensity = () => ({ message: `Intensity is ${mixer.intensity}` });

  /** Every session's output is this much of what its patterns ask for, from now on and at once. */
  const setIntensity = (value) => {
    if (!isIntensity(value)) return { error: 'Intensity must be a number from 0 to 1' };
    mixer.setIntensity(value, deviceIndex);
    kv.set(INTENSITY_KEY, value);
    return { message: `Intensity set to ${value}` };
  };

  // Session events -----------------------------------------------------------

  const startSession = (sessionID) => {
    const session = createSession(sessionID, openEngine, closeEngine);
    sessions.set(sessionID, session);
    return session;
  };

  const endSession = (sessionID) => {
    const session = sessions.get(sessionID);
    if (!session) return;
    sessions.delete(sessionID);
    return session.dispose();
  };

  const handleEvent = (m) => {
    if (m.event === 'session.end') {
      endSession(m.session);
      return;
    }
    if (m.event === 'session.start') {
      endSession(m.session);
      // Intiface may have come up since the daemon, or the last session, tried.
      const hasJustFailed = Date.now() - autoConnectFailedAt < AUTO_CONNECT_RETRY_MS;
      if (!connector.connected && !isDisconnectedOnPurpose && !hasJustFailed) start();
    }

    // A session the daemon has not met (it may have started mid-session) is
    // picked up from whichever event arrives first.
    const session = sessions.get(m.session) ?? startSession(m.session);
    session.handleEvent(m);
  };

  // The daemon's start and a session's can overlap; they share one attempt.
  const start = () => {
    autoConnecting ??= restoreLastDevice()
      .then(() => {
        if (connector.connected && deviceIndex === null) {
          notify('Connected to Intiface', 'success');
        }
      })
      .catch((e) => {
        // Disconnected on purpose while it was connecting: as asked, not a failure.
        if (isDisconnectedOnPurpose) return;
        autoConnectFailedAt = Date.now();
        notify('Auto-connect failed: ' + String(e), 'warning');
      })
      .finally(() => {
        autoConnecting = null;
      });
  };

  const dispose = async () => {
    await Promise.all([...sessions.keys()].map(endSession));
    await connector.disconnect();
  };

  return {
    handleEvent,
    getState,
    ensureConnected,
    scanForDevices,
    selectDeviceByIndex,
    connect,
    disconnect,
    getIntensity,
    setIntensity,
    start,
    dispose,
  };
}
