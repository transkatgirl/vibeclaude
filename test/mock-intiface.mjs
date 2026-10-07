// A tiny Buttplug v4 server that pretends to be Intiface Central with one
// vibrating device (and a spare, when asked for one). Used by test/e2e.mjs;
// also handy for trying the plugin without hardware:
//   node test/mock-intiface.mjs 12345
import { WebSocketServer } from 'ws';

export function startMock(port = 12345, { log = console.log } = {}) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port });
  const outputs = []; // { t, device, value } every OutputCmd / StopCmd
  let isDevicePresent = true;
  let isSpareDevicePresent = false;
  let isAnswering = true;
  // How long a device command takes to answer: a BLE device is not instant.
  let replyDelayMs = 0;
  const device = (DeviceIndex, DeviceName, DeviceDisplayName) => ({
    DeviceIndex,
    DeviceName,
    DeviceDisplayName,
    DeviceMessageTimingGap: 50,
    DeviceFeatures: {
      0: { FeatureIndex: 0, FeatureDescriptor: 'Main motor', Output: { Vibrate: { Value: [0, 20] } }, Input: {} },
    },
  });
  const deviceList = (Id) => ({
    DeviceList: {
      Id,
      Devices: {
        ...(isDevicePresent ? { 0: device(0, 'Mock Vibe 3000', 'Mock Vibe') } : {}),
        ...(isSpareDevicePresent ? { 1: device(1, 'Mock Spare 2000', 'Mock Spare') } : {}),
      },
    },
  });
  /** Every client is sent the new list, unasked. */
  const sendDeviceList = () => {
    for (const ws of wss.clients) ws.send(JSON.stringify([deviceList(0)]));
  };
  /** The device drops off or comes back. */
  const setDevicePresent = (isPresent) => {
    isDevicePresent = isPresent;
    sendDeviceList();
  };
  /** A second device (#1) turns up or goes. */
  const setSpareDevicePresent = (isPresent) => {
    isSpareDevicePresent = isPresent;
    sendDeviceList();
  };
  /** Stop (or go back to) answering: what arrives is still recorded. */
  const setAnswering = (answers) => {
    isAnswering = answers;
  };
  /** Device commands are answered this long after they arrive. */
  const setReplyDelay = (ms) => {
    replyDelayMs = ms;
  };
  /** The connection goes, with whatever was unanswered left that way. */
  const drop = () => {
    for (const ws of wss.clients) ws.terminate();
  };
  wss.on('connection', (ws) => {
    const send = (m) => isAnswering && ws.send(JSON.stringify([m]));
    /** A device's answer: after `replyDelayMs`, if the client is still there. */
    const answer = (m) => {
      if (!isAnswering) return;
      if (replyDelayMs === 0) return ws.send(JSON.stringify([m]));
      setTimeout(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify([m])), replyDelayMs);
    };
    ws.on('message', (data) => {
      let msgs;
      try {
        msgs = JSON.parse(data.toString());
      } catch {
        return;
      }
      for (const m of msgs) {
        const [type, body] = Object.entries(m)[0];
        const Id = body.Id;
        switch (type) {
          case 'RequestServerInfo':
            send({ ServerInfo: { Id, ServerName: 'Mock Intiface', MaxPingTime: 0, ProtocolVersionMajor: 4, ProtocolVersionMinor: 0 } });
            break;
          case 'RequestDeviceList':
            send(deviceList(Id));
            break;
          case 'OutputCmd': {
            const v = body.Command?.Vibrate?.Value;
            outputs.push({ t: Date.now(), device: body.DeviceIndex, value: v });
            log(`  motor → ${String(v).padStart(2)} / 20  ${'█'.repeat(v ?? 0)}`);
            answer({ Ok: { Id } });
            break;
          }
          case 'StopCmd':
            outputs.push({ t: Date.now(), device: body.DeviceIndex, value: 0, stop: true });
            log('  motor → stop');
            answer({ Ok: { Id } });
            break;
          default:
            send({ Ok: { Id } });
        }
      }
    });
  });
  return {
    wss,
    outputs,
    setDevicePresent,
    setSpareDevicePresent,
    setAnswering,
    setReplyDelay,
    drop,
    close: () => new Promise((r) => wss.close(r)),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 12345);
  startMock(port);
  console.log(`mock Intiface listening on ws://127.0.0.1:${port}`);
}
