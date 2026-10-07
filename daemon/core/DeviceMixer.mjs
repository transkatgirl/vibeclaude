// Lets several vibration engines drive one device. Each engine gets a channel
// that stands in for the connector; the device plays the strongest of what the
// channels are asking for, and goes back to the rest when one of them stops.
// What it is sent is that level times the mixer's intensity: one multiplier
// for every channel, applied once they are mixed.
export class DeviceMixer {
  // What each channel is asking for, by device. A level asked of one device
  // is not played on the one selected after it: its stop may still be on its way.
  levels = new Map();
  intensity = 1;

  constructor(connector) {
    this.connector = connector;
  }

  /** A connector for one engine: the same `vibrate` and `stopDevice` it would call on the real one. */
  channel() {
    const channel = {
      vibrate: (index, intensity) => this.set(channel, index, intensity),
      stopDevice: (index) => this.set(channel, index, 0),
    };
    return channel;
  }

  /** The channel's engine is gone; forget what it asked for. */
  release(channel) {
    this.levels.delete(channel);
  }

  /** The strongest of what the channels are asking device `index` for; 0 with nothing playing there. */
  strongest(index) {
    return Math.max(0, ...[...this.levels.values()].map((asked) => asked.get(index) ?? 0));
  }

  /** Change the multiplier. What device `index` is playing is sent again, as strong as it now is. */
  setIntensity(intensity, index) {
    this.intensity = intensity;
    if (index !== null && this.strongest(index) > 0) this.send(index);
  }

  set(channel, index, intensity) {
    const asked = this.levels.get(channel) ?? new Map();
    this.levels.set(channel, asked.set(index, intensity));
    return this.send(index);
  }

  send(index) {
    // Disconnected on purpose, the engines play on: there is nothing to send to.
    if (!this.connector.connected) return;
    // A device that has left: its stop is not the rest's to play there, and
    // what was on its way to it when it left has nowhere to go.
    if (!this.connector.getDevice(index)) return;
    const level = this.strongest(index) * this.intensity;
    if (level > 0) return this.connector.vibrate(index, level);
    return this.connector.stopDevice(index);
  }
}
