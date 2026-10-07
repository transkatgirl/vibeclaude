import { TPSMonitor } from '../core/TPSMonitor.mjs';

const DEFAULT_IDLE_STOP_MS = 10_000;
const TEXT_PULSE_DURATION = 70;
const START_PULSE_INTENSITY = 0.35;
const HOLD_INTENSITY = 0.3;

// Speed-driven stream of short pulses. Hooks only tell the daemon how many
// characters arrived, never the text itself, so deltas are character counts.
export class CoTHandler {
  tpsMonitor = new TPSMonitor();
  idleTimer = null;
  active = false;
  holding = false;

  constructor(engine, source = 'cot', idleStopMs = DEFAULT_IDLE_STOP_MS) {
    this.engine = engine;
    this.source = source;
    this.idleStopMs = idleStopMs;
  }

  onTextDelta(charCount) {
    if (!this.active) return;
    if (charCount <= 0) return;
    if (this.holding) {
      this.resetIdleTimer();
      return;
    }
    this.tpsMonitor.record(charCount);
    const intensity = this.tpsMonitor.intensityFromTPS(this.tpsMonitor.getTPS());
    this.engine.play({ source: this.source, intensity, duration: TEXT_PULSE_DURATION });
    this.resetIdleTimer();
  }

  start(startedAt = Date.now(), pulseImmediately = false, holdImmediately = false) {
    this.active = true;
    this.holding = holdImmediately;
    this.tpsMonitor.reset(startedAt);
    this.cancelIdleTimer();
    if (holdImmediately) {
      this.engine.play({ source: this.source, intensity: HOLD_INTENSITY });
    } else if (pulseImmediately) {
      this.engine.play({ source: this.source, intensity: START_PULSE_INTENSITY, duration: TEXT_PULSE_DURATION });
    }
  }

  end() {
    this.active = false;
    this.holding = false;
    this.tpsMonitor.reset();
    this.cancelIdleTimer();
    this.engine.stopSource(this.source);
  }

  resetIdleTimer() {
    this.cancelIdleTimer();
    if (this.idleStopMs === null) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.active) this.engine.stopSource(this.source);
    }, this.idleStopMs);
  }

  cancelIdleTimer() {
    if (this.idleTimer !== null) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}
