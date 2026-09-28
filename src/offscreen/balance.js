/**
 * Left/right balance. Unlike a panner, which moves one channel's content into
 * the other, balance only turns one side down:
 *
 *   balance < 0: left 1, right 1 + balance / 100
 *   balance > 0: left 1 - balance / 100, right 1
 *
 * Mono input (from the mono mixer) is upmixed to both sides first. At the
 * centre both gains are exactly 1, so audio passes through bit-exact.
 */

import { Balance } from '../shared/protocol.js';

/**
 * @typedef {object} BalanceStage
 * @property {AudioNode} input
 * @property {AudioNode} output
 * @property {GainNode} left
 * @property {GainNode} right
 * @property {AudioNode[]} nodes
 */

/**
 * @param {BaseAudioContext} context
 * @returns {BalanceStage}
 */
export function createBalanceStage(context) {
  // The splitter's channel interpretation is fixed to "discrete", which would
  // put mono input on the left only; upmix to stereo with "speakers" first.
  const stereo = new GainNode(context, {
    channelCount: 2,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
  const splitter = new ChannelSplitterNode(context, { numberOfOutputs: 2 });
  const left = new GainNode(context);
  const right = new GainNode(context);
  const merger = new ChannelMergerNode(context, { numberOfInputs: 2 });
  stereo.connect(splitter);
  splitter.connect(left, 0).connect(merger, 0, 0);
  splitter.connect(right, 1).connect(merger, 0, 1);
  return {
    input: stereo,
    output: merger,
    left,
    right,
    nodes: [stereo, splitter, left, right, merger],
  };
}

/**
 * @param {number} balance -100 (left only) .. 100 (right only).
 * @returns {{ left: number, right: number }}
 */
export function balanceGains(balance) {
  return {
    left: balance > 0 ? 1 - balance / Balance.MAX : 1,
    right: balance < 0 ? 1 - balance / Balance.MIN : 1,
  };
}
