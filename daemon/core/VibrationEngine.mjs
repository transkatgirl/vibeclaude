// One active source at a time: the last command wins. A command is a constant
// intensity, optionally stopped after a fixed duration.
export class VibrationEngine {
  deviceIndex = null;
  activeSource = null;
  stopTimer = null;
  // The level each device is to be sent next, by index, while a command is
  // on its way: a device answers slower than a stream of deltas comes, so it
  // is sent the latest level asked for, not every one in turn. A device being
  // left (its stop) keeps its place ahead of the one selected after it.
  pending = new Map();
  isDraining = false;
  draining = null;

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

  /** Resolves once every command asked for so far has been sent. */
  flush() {
    return this.draining ?? Promise.resolve();
  }

  cancelStopTimer() {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  vibrate(intensity) {
    if (this.deviceIndex === null) return;
    this.send(this.deviceIndex, intensity);
  }

  stopDevice() {
    if (this.deviceIndex === null) return;
    this.send(this.deviceIndex, 0);
  }

  send(index, intensity) {
    this.pending.set(index, intensity);
    if (!this.isDraining) this.draining = this.drain();
  }

  // Sends what is pending, one command at a time, until nothing is. Whether a
  // drain is running is kept apart from its promise, and settled in the same
  // tick as the loop: a command asked for as one ends is never left waiting.
  async drain() {
    this.isDraining = true;
    try {
      while (this.pending.size > 0) {
        const [index, intensity] = this.pending.entries().next().value;
        this.pending.delete(index);
        try {
          await (intensity > 0 ? this.connector.vibrate(index, intensity) : this.connector.stopDevice(index));
        } catch {
          // The connector reports its own failures.
        }
      }
    } finally {
      this.isDraining = false;
    }
  }
}

const isStreamingSource = (source) =>
  source === 'cot' || source === 'message' || source === 'preparing' || source === 'exec';
