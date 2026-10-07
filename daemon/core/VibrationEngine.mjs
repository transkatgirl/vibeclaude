// One active source at a time: the last command wins. A command is a constant
// intensity, optionally stopped after a fixed duration.
export class VibrationEngine {
  deviceIndex = null;
  activeSource = null;
  stopTimer = null;
  commandChain = Promise.resolve();

  constructor(connector) {
    this.connector = connector;
  }

  setDevice(index) {
    if (this.deviceIndex !== index) {
      this.stopAll();
    }
    this.deviceIndex = index;
  }

  getDeviceIndex() {
    return this.deviceIndex;
  }

  /** cmd: { source, intensity, duration? } */
  play(cmd) {
    if (this.deviceIndex === null) return;
    this.cancelStopTimer();
    this.activeSource = cmd.source;
    this.vibrate(cmd.intensity);

    if (cmd.duration && cmd.duration > 0) {
      this.stopTimer = setTimeout(() => {
        this.stopTimer = null;
        this.stopAll();
      }, cmd.duration);
    }
  }

  stopSource(source) {
    if (this.activeSource === source) {
      this.stopAll();
    }
  }

  stopStreaming() {
    if (this.activeSource !== null && isStreamingSource(this.activeSource)) {
      this.stopAll();
    }
  }

  stopAll() {
    this.cancelStopTimer();
    this.activeSource = null;
    if (this.deviceIndex !== null) {
      this.stopDevice();
    }
  }

  /** Resolves once every command queued so far has been sent. */
  flush() {
    return this.commandChain;
  }

  cancelStopTimer() {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  vibrate(intensity) {
    const deviceIndex = this.deviceIndex;
    if (deviceIndex === null) return;
    this.enqueue(() => this.connector.vibrate(deviceIndex, intensity));
  }

  stopDevice() {
    const deviceIndex = this.deviceIndex;
    if (deviceIndex === null) return;
    this.enqueue(() => this.connector.stopDevice(deviceIndex));
  }

  enqueue(command) {
    this.commandChain = this.commandChain.then(command, command);
  }
}

const isStreamingSource = (source) =>
  source === 'cot' || source === 'message' || source === 'preparing' || source === 'exec';
