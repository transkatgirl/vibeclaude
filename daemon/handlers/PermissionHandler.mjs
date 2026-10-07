const PULSE_DURATION = 90;
const PULSE_GAP = 70;
const PULSE_INTENSITY = 0.85;
const PULSES_PER_BURST = 3;
const BURST_PAUSE = 600;

export class PermissionHandler {
  requests = new Map();
  timer = null;

  constructor(engine) {
    this.engine = engine;
  }

  onAsked(id, sessionID) {
    const wasEmpty = this.requests.size === 0;
    this.requests.set(id, sessionID);
    if (wasEmpty) this.playBurst(0);
  }

  onReplied(requestID) {
    this.requests.delete(requestID);
    if (this.requests.size === 0) this.stop();
  }

  reset(sessionID) {
    if (sessionID === undefined) {
      this.requests.clear();
    } else {
      for (const [requestID, requestSessionID] of this.requests) {
        if (requestSessionID === sessionID) this.requests.delete(requestID);
      }
    }
    if (this.requests.size === 0) this.stop();
  }

  stop() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.engine.stopSource('permission');
  }

  playBurst(pulse) {
    if (this.requests.size === 0) return;
    this.engine.play({
      source: 'permission',
      intensity: PULSE_INTENSITY,
      duration: PULSE_DURATION,
    });
    const nextDelay = PULSE_DURATION + PULSE_GAP;
    if (pulse + 1 < PULSES_PER_BURST) {
      this.timer = setTimeout(() => this.playBurst(pulse + 1), nextDelay);
      return;
    }
    this.timer = setTimeout(() => this.playBurst(0), nextDelay + BURST_PAUSE);
  }
}
