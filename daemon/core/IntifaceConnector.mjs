import { ButtplugClient, ButtplugNodeWebsocketClientConnector, DeviceOutput, OutputType } from 'buttplug';

// How long a command may go unanswered before it is given up on.
const COMMAND_TIMEOUT_MS = 5000;
const CONNECTION_LOST = new Error('Connection to Intiface was lost');

const withTimeout = (promise) => {
  let timer;
  const overdue = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Intiface did not answer')), COMMAND_TIMEOUT_MS);
  });
  return Promise.race([promise, overdue]).finally(() => clearTimeout(timer));
};

export class IntifaceConnector {
  bpClient = null;
  // The client whose handshake is done: an open socket is not yet a connection.
  established = null;
  socket = null;
  // Rejects when the current client's connection goes.
  lost = null;
  connectPromise = null;
  disconnectPromise = null;
  intentionallyDisconnecting = false;

  onDeviceListChanged = null;
  onDisconnected = null;
  onError = null;

  constructor(wsAddress) {
    this.wsAddress = wsAddress;
  }

  connect(address) {
    if (this.connectPromise !== null) return this.connectPromise;

    const connection = this.connectAfterDisconnect(address);
    this.connectPromise = connection.finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  disconnect() {
    if (this.disconnectPromise !== null) return this.disconnectPromise;

    const disconnection = this.disconnectAfterConnect();
    this.disconnectPromise = disconnection.finally(() => {
      this.disconnectPromise = null;
    });
    return this.disconnectPromise;
  }

  async startScanning() {
    if (!this.bpClient?.connected) return;
    await this.answered(this.bpClient.startScanning());
  }

  async stopScanning() {
    if (!this.bpClient?.connected) return;
    try {
      await this.answered(this.bpClient.stopScanning());
    } catch (error) {
      this.report(`Stop scanning failed: ${String(error)}`, error);
    }
  }

  getDevices() {
    if (!this.bpClient?.connected) return [];
    return Array.from(this.bpClient.devices.values()).map((d) => ({
      index: d.index,
      name: d.name,
      supportsVibration: d.hasOutput(OutputType.Vibrate),
    }));
  }

  getDevice(index) {
    if (!this.bpClient?.connected) return undefined;
    return this.bpClient.devices.get(index);
  }

  async vibrate(index, intensity) {
    const device = this.getDevice(index);
    if (!device) {
      this.onError?.(`Device ${index} is not connected`);
      return;
    }
    if (!device.hasOutput(OutputType.Vibrate)) {
      this.onError?.(`Device ${index} does not support vibration`);
      return;
    }
    try {
      await this.answered(device.runOutput(DeviceOutput.Vibrate.percent(intensity)));
    } catch (error) {
      this.report(`Vibrate failed for device ${index}: ${String(error)}`, error);
    }
  }

  async stopDevice(index) {
    const device = this.getDevice(index);
    if (!device) return;
    try {
      await this.answered(device.stop());
    } catch (error) {
      this.report(`Stop failed for device ${index}: ${String(error)}`, error);
    }
  }

  async stopAll() {
    if (!this.bpClient?.connected) return;
    try {
      await this.answered(this.bpClient.stopAllDevices());
    } catch (error) {
      this.report(`Stop all failed: ${String(error)}`, error);
    }
  }

  get connected() {
    return this.bpClient !== null && this.bpClient === this.established && this.bpClient.connected;
  }

  /**
   * A command's answer, or its failure when none will come: buttplug leaves a
   * command pending for good if the connection goes or the server says nothing.
   */
  answered(command) {
    return withTimeout(Promise.race([command, this.lost]));
  }

  /** A lost connection is said once, by `onDisconnected`, not by each command it cut short. */
  report(message, error) {
    if (error !== CONNECTION_LOST) this.onError?.(message);
  }

  emitDeviceList() {
    this.onDeviceListChanged?.(this.getDevices());
  }

  async connectAfterDisconnect(address) {
    if (this.disconnectPromise !== null) await this.disconnectPromise;
    if (address) this.wsAddress = address;
    if (this.bpClient?.connected) {
      if (!address) return;
      await this.disconnectClient();
    }

    const client = new ButtplugClient('Claude Code');
    const connector = new ButtplugNodeWebsocketClientConnector(this.wsAddress);
    let giveUp;
    const lost = new Promise((_, reject) => {
      giveUp = reject;
    });
    lost.catch(() => {});
    this.bpClient = client;
    this.socket = connector;
    this.lost = lost;

    client.on('deviceadded', () => this.emitDeviceList());
    client.on('deviceremoved', () => this.emitDeviceList());
    client.on('disconnect', () => {
      giveUp(CONNECTION_LOST);
      if (this.bpClient !== client) return;
      this.bpClient = null;
      if (this.established === client && !this.intentionallyDisconnecting) this.onDisconnected?.();
    });

    try {
      // A server that opens the socket and says nothing would be waited on for good.
      await withTimeout(client.connect(connector));
      this.established = client;
    } catch (error) {
      if (this.bpClient === client) this.bpClient = null;
      await connector.disconnect().catch(() => {});
      throw error;
    }
  }

  async disconnectAfterConnect() {
    if (this.connectPromise !== null) {
      try {
        await this.connectPromise;
      } catch {
        return;
      }
    }
    await this.disconnectClient();
  }

  async disconnectClient() {
    const client = this.bpClient;
    const socket = this.socket;
    if (!client) return;
    if (!client.connected) {
      if (this.bpClient === client) this.bpClient = null;
      return;
    }

    let stopError;
    let disconnectError;
    this.intentionallyDisconnecting = true;
    try {
      try {
        await this.answered(client.stopAllDevices());
      } catch (error) {
        stopError = error;
      }
      try {
        // It stops the devices again before it closes; unanswered, close anyway.
        await withTimeout(client.disconnect());
      } catch (error) {
        disconnectError = error;
        await socket.disconnect().catch(() => {});
      }
    } finally {
      if (this.bpClient === client) this.bpClient = null;
      this.intentionallyDisconnecting = false;
    }

    if (stopError !== undefined) throw stopError;
    if (disconnectError !== undefined) throw disconnectError;
  }
}
