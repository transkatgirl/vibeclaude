// Lets several vibration engines drive one device. Each engine gets a channel
// that stands in for the connector; the device plays the strongest of what the
// channels are asking for, and goes back to the rest when one of them stops.
export class DeviceMixer {
  levels = new Map();

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

  set(channel, index, intensity) {
    this.levels.set(channel, intensity);
    // Disconnected on purpose, the engines play on: there is nothing to send to.
    if (!this.connector.connected) return;
    // A stop for a device that has gone is not the rest's to play there.
    if (intensity === 0 && !this.connector.getDevice(index)) return;
    const strongest = Math.max(...this.levels.values());
    if (strongest > 0) return this.connector.vibrate(index, strongest);
    return this.connector.stopDevice(index);
  }
}
