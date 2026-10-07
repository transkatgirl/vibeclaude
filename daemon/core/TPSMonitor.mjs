const MIN_MEASUREMENT_MS = 500;
const REFERENCE_TPS = 40;
const MIN_INTENSITY = 0.35;
const MAX_INTENSITY = 0.8;

export class TPSMonitor {
  chars = 0;
  startedAt = Date.now();

  record(charCount) {
    this.chars += charCount;
  }

  getTPS() {
    const elapsedMs = Math.max(MIN_MEASUREMENT_MS, Date.now() - this.startedAt);
    return this.chars / (elapsedMs / 1000);
  }

  intensityFromTPS(tps) {
    const normalizedTPS = Math.min(REFERENCE_TPS, Math.max(0, tps)) / REFERENCE_TPS;
    return MIN_INTENSITY + normalizedTPS * (MAX_INTENSITY - MIN_INTENSITY);
  }

  reset(startedAt = Date.now()) {
    this.chars = 0;
    this.startedAt = startedAt;
  }
}
