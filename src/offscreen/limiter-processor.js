/**
 * AudioWorklet wrapper around the limiter. Runs on the audio thread and tells
 * the engine whether it is currently limiting, so the popup can show it.
 */
import { Limiter } from './limiter.js';

/** Gains below this count as "limiting" (about -0.2 dB). */
const ACTIVE_BELOW = 0.98;
/** How long limiting is reported after it last happened, in seconds. */
const HOLD_SECONDS = 0.3;

class LimiterProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.limiter = new Limiter(sampleRate);
    this.active = false;
    this.lastActiveTime = -Infinity;
  }

  /**
   * @param {Float32Array[][]} inputs
   * @param {Float32Array[][]} outputs
   */
  process(inputs, outputs) {
    const lowest = this.limiter.process(inputs[0] ?? [], outputs[0]);
    if (lowest < ACTIVE_BELOW) this.lastActiveTime = currentTime;

    const active = currentTime - this.lastActiveTime < HOLD_SECONDS;
    if (active !== this.active) {
      this.active = active;
      this.port.postMessage({ limiting: active });
    }
    return true;
  }
}

registerProcessor('sotto-limiter', LimiterProcessor);
