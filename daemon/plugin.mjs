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
const SNAPSHOT_OUTPUT_DURATION = 150;
const SNAPSHOT_OUTPUT_INTENSITY = 0.4;
// How long an ended session's last stop is given to reach the device.
const SESSION_FLUSH_MS = 1000;
// A session that starts this soon after an automatic connection failed does
// not try again: the daemon's own start and its first session come together.
const AUTO_CONNECT_RETRY_MS = 5000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Everything that belongs to one Claude Code session. Each session is its own
// instance of the plugin's engine and handlers, so several Claude Codes can be
// open at once without stopping or overriding each other's output; they share
// the Intiface connection and the device.
//
// Events arrive in the order they happened. Text never does: the hooks module
// sends how many characters arrived, so deltas are character counts.
function createSession(sessionID, engine) {
  const cotHandler = new CoTHandler(engine);
  const messageHandler = new CoTHandler(engine, 'message');
  const preparationHandler = new CoTHandler(engine, 'preparing', null);
  const completionHandler = new CompletionHandler(engine, cotHandler, messageHandler);
  const interruptHandler = new InterruptHandler(engine, cotHandler, messageHandler);
  const activityHandler = new ActivityHandler(engine);
  const permissionHandler = new PermissionHandler(engine);
  const activeReasoningIDs = new Set();
  const activeTextIDs = new Set();
  const patchPreparationCallIDs = new Set();
  const runningCallIDs = new Set();
  // A subagent's calls that have not finished, each with its subagent. One in
  // the background outlives the turn that started it, so the turn's end leaves
  // these as they are: they go when the call finishes or its subagent's run ends.
  const agentCallIDs = new Map();
  const snapshotOutputParts = new Set();

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

  const startReasoning = (id) => {
    if (activeReasoningIDs.has(id)) return;
    activeReasoningIDs.add(id);
    cotHandler.start();
  };

  const startText = (id) => {
    if (activeTextIDs.has(id)) return;
    activeTextIDs.add(id);
    messageHandler.start();
  };

  const onToolFinished = (m) => {
    runningCallIDs.delete(m.id);
    agentCallIDs.delete(m.id);
    permissionHandler.onReplied(m.id);
    if (isFileMutationTool(m.tool)) endPatchPreparation(m.id);
    // A todo changes while its tool runs, so its pulse comes before the
    // tool's own: the success pulse is the one that lands.
    if (m.status === 'completed') {
      if (Array.isArray(m.todos)) activityHandler.onTodosUpdated(m.todos);
      if (m.todo) activityHandler.onTodoUpdated(m.todo.key, m.todo.status);
    }
    activityHandler.onToolUpdated(m.id, m.tool, m.status);
  };

  // A subagent's run is over: a call of its own that never said it finished
  // is over with it, and so are its prompt and its hold.
  const onAgentComplete = (agent) => {
    for (const [callID, owner] of [...agentCallIDs]) {
      if (owner !== agent) continue;
      agentCallIDs.delete(callID);
      runningCallIDs.delete(callID);
      permissionHandler.onReplied(callID);
      if (patchPreparationCallIDs.has(callID)) endPatchPreparation(callID);
    }
  };

  const onTurnComplete = (reason) => {
    // An interrupted or failed turn stops everything, then goes idle like
    // any other: the turn's end is felt whatever ended it.
    if (reason !== 'answer' && reason !== 'refusal') {
      completionHandler.stop();
      interruptHandler.onSessionError();
    }
    const endsWithTurn = (callID) => !agentCallIDs.has(callID);
    // No prompt of the turn's own outlives it, however the turn ended.
    for (const callID of [...permissionHandler.requests.keys()].filter(endsWithTurn)) {
      permissionHandler.onReplied(callID);
    }
    activeReasoningIDs.clear();
    activeTextIDs.clear();
    for (const callID of [...runningCallIDs].filter(endsWithTurn)) runningCallIDs.delete(callID);
    // A call the turn's end cut short never says it finished.
    for (const callID of [...patchPreparationCallIDs].filter(endsWithTurn)) patchPreparationCallIDs.delete(callID);
    if (patchPreparationCallIDs.size === 0) preparationHandler.end();
    completionHandler.onSessionIdle();
  };

  const handleEvent = (m) => {
    switch (m.event) {
      case 'reasoning.started':
        // Silent: thinking is felt as its text streams. Where the text is
        // withheld there is nothing to feel.
        completionHandler.stop();
        startReasoning(m.id);
        break;

      case 'reasoning.delta':
        completionHandler.stop();
        startReasoning(m.id);
        cotHandler.onTextDelta(m.chars ?? 0);
        break;

      case 'reasoning.ended':
        activeReasoningIDs.delete(m.id);
        if (activeReasoningIDs.size === 0) cotHandler.end();
        break;

      case 'text.started':
        completionHandler.stop();
        startText(m.id);
        break;

      case 'text.delta':
        completionHandler.stop();
        startText(m.id);
        messageHandler.onTextDelta(m.chars ?? 0);
        break;

      case 'text.ended':
        activeTextIDs.delete(m.id);
        if (activeTextIDs.size === 0) messageHandler.end();
        break;

      case 'output.snapshot':
        // A part that arrived whole: nothing of it streamed, so it gets one
        // pulse instead of a speed-driven stream.
        playSnapshot(m.id);
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
        if (m.agent !== undefined) agentCallIDs.set(m.id, m.agent);
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
        onAgentComplete(m.agent);
        break;

      default:
        break;
    }
  };

  /** The session is over: stop whatever it was playing. */
  const dispose = () => {
    completionHandler.stop();
    patchPreparationCallIDs.clear();
    preparationHandler.end();
    permissionHandler.reset();
    interruptHandler.onSessionDeleted();
  };

  return { handleEvent, dispose };
}

export function createPlugin({ wsAddress, kv, notify }) {
  const connector = new IntifaceConnector(wsAddress);
  const mixer = new DeviceMixer(connector);
  // sessionID → { engine, channel, handleEvent, dispose }
  const sessions = new Map();
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
    for (const session of sessions.values()) session.engine.setDevice(index);
  };

  const stopAll = () => {
    for (const session of sessions.values()) session.engine.stopAll();
  };

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

    const device = findSavedDevice(
      (await scan()).filter((candidate) => candidate.supportsVibration),
      saved,
    );
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
    try {
      if (!connector.connected) return { message: 'Not connected' };
      isDisconnectedOnPurpose = true;
      stopAll();
      await connector.disconnect();
      listedIndexes = new Set();
      isDeviceLost = false;
      return { message: 'Disconnected' };
    } catch (e) {
      return { error: 'Disconnect failed: ' + String(e) };
    }
  };

  // Session events -----------------------------------------------------------

  const startSession = (sessionID) => {
    const channel = mixer.channel();
    const engine = new VibrationEngine(channel);
    engine.setDevice(deviceIndex);
    const session = { engine, channel, ...createSession(sessionID, engine) };
    sessions.set(sessionID, session);
    return session;
  };

  const endSession = (sessionID) => {
    const session = sessions.get(sessionID);
    if (!session) return;
    sessions.delete(sessionID);
    session.dispose();
    // Its last stop is still on its way to the device.
    return Promise.race([session.engine.flush(), wait(SESSION_FLUSH_MS)]).then(() => mixer.release(session.channel));
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

  return { handleEvent, getState, ensureConnected, scanForDevices, selectDeviceByIndex, connect, disconnect, start, dispose };
}
