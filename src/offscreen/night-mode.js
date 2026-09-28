/**
 * Night mode: tames loud effects and brings dialogue forward, for films and
 * streams where the voices are quiet and the explosions aren't.
 *
 *   low shelf (-4 dB below 150 Hz)   less rumble, so bass hits stop masking speech
 *   peaking (+4 dB around 2.5 kHz)   the consonant range that makes speech intelligible
 *   compressor (3:1 above -24 dB)    narrows the dynamic range
 *   trim (-4 dB)                     centres the effect on typical dialogue levels
 *
 * Browsers apply automatic makeup gain to DynamicsCompressorNode
 * ((1 / full-range gain) ^ 0.6, about +9.6 dB here). With the trim, quiet
 * speech comes up about 7-8 dB while full-scale hits drop about 8-10 dB
 * (measured in Chrome). The shared limiter catches anything that still
 * overshoots.
 *
 * All native nodes: negligible CPU, and nothing runs while the mode is off.
 */

const TRIM_DB = -4;

/**
 * @typedef {object} NightChain
 * @property {AudioNode} input
 * @property {AudioNode} output
 * @property {AudioNode[]} nodes
 */

/**
 * @param {BaseAudioContext} context
 * @returns {NightChain}
 */
export function createNightChain(context) {
  const bass = new BiquadFilterNode(context, { type: 'lowshelf', frequency: 150, gain: -4 });
  const presence = new BiquadFilterNode(context, {
    type: 'peaking',
    frequency: 2500,
    Q: 0.8,
    gain: 4,
  });
  const compressor = new DynamicsCompressorNode(context, {
    threshold: -24,
    knee: 10,
    ratio: 3,
    attack: 0.005,
    release: 0.25,
  });
  const trim = new GainNode(context, { gain: 10 ** (TRIM_DB / 20) });
  bass.connect(presence).connect(compressor).connect(trim);
  return { input: bass, output: trim, nodes: [bass, presence, compressor, trim] };
}
