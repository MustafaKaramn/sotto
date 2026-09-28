/**
 * Look-ahead peak limiter. Output samples never exceed `ceiling`; below the
 * ceiling the gain is exactly 1, so the signal passes through untouched (only
 * delayed by the look-ahead).
 *
 * Gain computer after G. Luff, "Designing a straightforward limiter"
 * (Signalsmith Audio, 2021), with release smoothing as in D. Giannoulis,
 * M. Massberg & J. D. Reiss, "Digital Dynamic Range Compressor Design — A
 * Tutorial and Analysis" (JAES 60(6), 2012). With look-ahead L samples:
 *
 *   1. required gain  r[n] = min(1, ceiling / max_c |x_c[n]|)       (channels linked)
 *   2. hold           m[n] = min(r[n-L] .. r[n])                     (sliding minimum)
 *   3. release        e[n] = m[n] if m[n] <= e[n-1],
 *                            else m[n] - (m[n] - e[n-1]) * a         (a = exp(-1 / (release * fs)))
 *   4. smoothing      g[n] = mean(e[n-L+1] .. e[n])                  (moving average)
 *   5. output         y_c[n] = g[n] * x_c[n-L]
 *
 * Every e averaged in step 4 is at most r[n-L], so |y| <= ceiling without
 * overshoot, and the attack is a smooth L-sample ramp instead of a click.
 * All steps are O(1) per sample.
 *
 * When disabled, r is always 1: the gain glides back to unity over the
 * release time and loud passages hard-clip at the ceiling, like a plain
 * gain boost would.
 */

/** Release gets snapped to exactly 1 this close to it, so pass-through stays bit-exact. */
const UNITY_SNAP = 1e-6;
/** The running gain sum can drift by ~1e-13; the clamp absorbs that silently. */
const ROUNDING_TOLERANCE = 1 + 1e-9;

export class Limiter {
  /**
   * @param {number} sampleRate
   * @param {{ ceiling?: number, lookahead?: number, release?: number, channels?: number }} [options]
   *   `lookahead` and `release` in seconds.
   */
  constructor(sampleRate, { ceiling = 1, lookahead = 0.005, release = 0.15, channels = 2 } = {}) {
    this.ceiling = ceiling;
    this.length = Math.max(1, Math.round(lookahead * sampleRate));
    this.releaseCoefficient = Math.exp(-1 / (release * sampleRate));
    this.channels = channels;
    this.enabled = true;

    /** Look-ahead delay line per channel, and the moving-average window of gains. */
    this.delay = Array.from({ length: channels }, () => new Float32Array(this.length));
    this.gains = new Float64Array(this.length).fill(1);
    this.gainSum = this.length;
    this.position = 0;
    this.envelope = 1;

    /** Monotonic deque for the sliding minimum over L + 1 samples. */
    this.holdWindow = this.length + 1;
    this.holdCapacity = this.holdWindow + 1;
    this.holdValues = new Float64Array(this.holdCapacity);
    this.holdIndices = new Float64Array(this.holdCapacity);
    this.holdHead = 0;
    this.holdCount = 0;
    this.sampleIndex = 0;

    /**
     * Samples the final safety clamp had to pull back by more than float
     * rounding. Stays 0 as long as the math above holds.
     */
    this.overshoots = 0;
  }

  /**
   * Processes one block. Missing input channels count as silence.
   * @param {Float32Array[]} input
   * @param {Float32Array[]} output
   * @returns {number} The lowest gain applied in this block (1 = no limiting).
   */
  process(input, output) {
    const frames = output[0]?.length ?? 0;
    const { ceiling, channels, delay, gains, length } = this;
    let lowest = 1;

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let c = 0; c < channels; c++) {
        const sample = input[c]?.[i] ?? 0;
        const magnitude = sample < 0 ? -sample : sample;
        if (magnitude > peak) peak = magnitude;
      }

      const held = this.#hold(this.enabled && peak > ceiling ? ceiling / peak : 1);
      if (held <= this.envelope) {
        this.envelope = held;
      } else {
        this.envelope = held - (held - this.envelope) * this.releaseCoefficient;
        if (held === 1 && 1 - this.envelope < UNITY_SNAP) this.envelope = 1;
      }

      const slot = this.position;
      this.gainSum += this.envelope - gains[slot];
      gains[slot] = this.envelope;
      const gain = this.gainSum >= length ? 1 : this.gainSum / length;
      if (gain < lowest) lowest = gain;

      for (let c = 0; c < channels; c++) {
        const line = delay[c];
        let sample = line[slot] * gain;
        line[slot] = input[c]?.[i] ?? 0;
        if (sample > ceiling || sample < -ceiling) {
          if (this.enabled && (sample < 0 ? -sample : sample) > ceiling * ROUNDING_TOLERANCE) {
            this.overshoots++;
          }
          sample = sample > 0 ? ceiling : -ceiling;
        }
        const out = output[c];
        if (out) out[i] = sample;
      }

      this.position = slot + 1 === length ? 0 : slot + 1;
    }
    return lowest;
  }

  /**
   * Pushes a value and returns the minimum of the last L + 1 values.
   * @param {number} value
   */
  #hold(value) {
    const { holdValues: values, holdIndices: indices, holdCapacity: capacity } = this;
    const index = this.sampleIndex++;

    while (this.holdCount > 0) {
      const back = (this.holdHead + this.holdCount - 1) % capacity;
      if (values[back] < value) break;
      this.holdCount--;
    }
    const tail = (this.holdHead + this.holdCount) % capacity;
    values[tail] = value;
    indices[tail] = index;
    this.holdCount++;

    if (indices[this.holdHead] <= index - this.holdWindow) {
      this.holdHead = (this.holdHead + 1) % capacity;
      this.holdCount--;
    }
    return values[this.holdHead];
  }
}
