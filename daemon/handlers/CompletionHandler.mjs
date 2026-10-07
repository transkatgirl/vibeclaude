const PULSE_DURATION = 100;
const PULSE_GAP = 80;
const PULSES_PER_BURST = 3;
const PULSE_INTENSITY = 1.0;

export class CompletionHandler {
  timer = null;

  constructor(engine, cotHandler, messageHandler) {
    this.engine = engine;
    this.cotHandler = cotHandler;
    this.messageHandler = messageHandler;
  }

  onSessionIdle() {
    this.stop();
    this.cotHandler.end();
    this.messageHandler.end();
    this.playBurst(0);
  }

  stop() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.engine.stopSource('completion');
  }

  playBurst(pulse) {
    this.engine.play({
      source: 'completion',
      intensity: PULSE_INTENSITY,
      duration: PULSE_DURATION,
    });
    if (pulse + 1 >= PULSES_PER_BURST) return;
    this.timer = setTimeout(() => this.playBurst(pulse + 1), PULSE_DURATION + PULSE_GAP);
  }
}
