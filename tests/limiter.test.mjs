import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Limiter } from '../src/offscreen/limiter.js';

const SAMPLE_RATE = 48000;
const BLOCK = 128;

/**
 * Runs a stereo signal through a limiter in worklet-sized blocks.
 * @param {Limiter} limiter
 * @param {(i: number, channel: number) => number} signal
 * @param {number} frames
 */
function run(limiter, signal, frames) {
  const out = [new Float32Array(frames), new Float32Array(frames)];
  let lowest = 1;
  for (let start = 0; start < frames; start += BLOCK) {
    const size = Math.min(BLOCK, frames - start);
    const input = [0, 1].map((c) =>
      Float32Array.from({ length: size }, (_, i) => signal(start + i, c)),
    );
    const output = [new Float32Array(size), new Float32Array(size)];
    lowest = Math.min(lowest, limiter.process(input, output));
    out[0].set(output[0], start);
    out[1].set(output[1], start);
  }
  return { out, lowest };
}

/** Deterministic noise, so failures are reproducible. */
function noise(seed = 1) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 31 - 1;
  };
}

const peakOf = (/** @type {Float32Array[]} */ channels) =>
  Math.max(...channels.map((data) => data.reduce((max, s) => Math.max(max, Math.abs(s)), 0)));

test('passes signals below the ceiling through bit-exact, only delayed', () => {
  const limiter = new Limiter(SAMPLE_RATE);
  const random = noise();
  const input = [0, 1].map(() => Float32Array.from({ length: 20000 }, () => random() * 0.95));
  const { out, lowest } = run(limiter, (i, c) => input[c][i], 20000);

  assert.equal(lowest, 1);
  const delay = limiter.length;
  for (const c of [0, 1]) {
    assert.deepEqual(out[c].subarray(delay), input[c].subarray(0, 20000 - delay));
  }
});

test('never exceeds the ceiling at 500%, without relying on the safety clamp', () => {
  const random = noise(7);
  const signals = {
    'full-scale sine': (/** @type {number} */ i) =>
      Math.sin((2 * Math.PI * 1000 * i) / SAMPLE_RATE),
    'bass sine': (/** @type {number} */ i) => Math.sin((2 * Math.PI * 40 * i) / SAMPLE_RATE),
    noise: () => random(),
    'bursts from silence': (/** @type {number} */ i) => (i % 9600 < 300 ? random() : 0),
    'single-sample spikes': (/** @type {number} */ i) => (i % 1000 === 0 ? 1 : 0.01),
  };

  for (const [name, signal] of Object.entries(signals)) {
    const limiter = new Limiter(SAMPLE_RATE);
    const { out } = run(limiter, (i, c) => signal(i) * (c ? -5 : 5), SAMPLE_RATE * 2);
    assert.ok(peakOf(out) <= 1, `${name}: peak ${peakOf(out)}`);
    assert.equal(limiter.overshoots, 0, `${name}: safety clamp was needed`);
  }
});

test('recovers to exact unity gain after a loud passage', () => {
  const limiter = new Limiter(SAMPLE_RATE);
  const loud = SAMPLE_RATE / 2;
  // 150 ms release: from -12 dB, the gain is within 1e-6 of unity after ~2 s.
  run(limiter, (i) => (i < loud ? 4 : 0.5) * Math.sin(i / 10), loud + SAMPLE_RATE * 2.5);
  assert.equal(limiter.envelope, 1);
  const { lowest } = run(limiter, (i) => 0.5 * Math.sin(i / 10), BLOCK);
  assert.equal(lowest, 1);
});

test('costs a small fraction of real time', () => {
  const seconds = 20;
  const limiter = new Limiter(SAMPLE_RATE);
  const random = noise(3);
  const input = [0, 1].map(() => Float32Array.from({ length: BLOCK }, () => random() * 5));
  const output = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
  const blocks = (seconds * SAMPLE_RATE) / BLOCK;

  const start = performance.now();
  for (let b = 0; b < blocks; b++) limiter.process(input, output);
  const elapsed = performance.now() - start;

  const share = elapsed / (seconds * 1000);
  console.log(
    `  limiter: ${elapsed.toFixed(0)} ms for ${seconds} s of stereo audio (${(share * 100).toFixed(2)}% of real time)`,
  );
  assert.ok(share < 0.05, `took ${(share * 100).toFixed(2)}% of real time`);
});

test('when disabled, applies no gain reduction and just clips at the ceiling', () => {
  const limiter = new Limiter(SAMPLE_RATE);
  limiter.enabled = false;
  const { out, lowest } = run(limiter, (i) => 3 * Math.sin(i / 20), SAMPLE_RATE);

  assert.equal(lowest, 1);
  assert.ok(peakOf(out) <= 1);
  const clipped = out[0].filter((sample) => Math.abs(sample) === 1).length;
  assert.ok(clipped > out[0].length / 2, `only ${clipped} samples clipped`);
});

test('switching off glides back to unity instead of jumping', () => {
  const limiter = new Limiter(SAMPLE_RATE);
  run(limiter, (i) => 4 * Math.sin(i / 20), SAMPLE_RATE / 2);
  const before = limiter.envelope;

  limiter.enabled = false;
  run(limiter, (i) => 4 * Math.sin(i / 20), SAMPLE_RATE / 100);
  assert.ok(limiter.envelope > before && limiter.envelope < 0.5, `gain ${limiter.envelope}`);

  run(limiter, (i) => 4 * Math.sin(i / 20), SAMPLE_RATE * 3);
  assert.equal(limiter.envelope, 1);
});
