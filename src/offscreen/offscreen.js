/**
 * Audio engine. Each controlled tab gets one small graph on a shared
 * AudioContext:
 *
 *   tab stream -> gain (volume) -> mixer (stereo | mono) -> speakers
 *
 * Capturing a tab silences its own output, so the graph must always reach the
 * speakers. Releasing a tab stops its tracks, which is what makes Chrome drop
 * the "tab is being shared" indicator; the tab then plays on its own again.
 */
import { Msg, Target, listen, send } from '../shared/protocol.js';

/**
 * @typedef {import('../shared/protocol.js').Settings} Settings
 * @typedef {import('../shared/protocol.js').TabMeta} TabMeta
 * @typedef {import('../shared/protocol.js').ControlledTab} ControlledTab
 */

/**
 * @typedef {object} Channel
 * @property {MediaStream} stream
 * @property {MediaStreamAudioSourceNode} source
 * @property {GainNode} gain
 * @property {GainNode} mixer
 * @property {TabMeta} meta
 * @property {Settings} settings
 */

/** Time constant for volume changes: feels instant, but doesn't click. */
const SMOOTHING_SECONDS = 0.015;

/** @type {AudioContext | null} */
let context = null;

/** @type {Map<number, Channel>} */
const channels = new Map();

listen(Target.OFFSCREEN, async (message) => {
  switch (message.type) {
    case Msg.GET_STATE:
      return { tabs: [...channels].map(([tabId, channel]) => describe(tabId, channel)) };
    case Msg.CAPTURE:
      await capture(message.tabId, message.streamId, message.settings, message.meta);
      return { ok: true };
    case Msg.APPLY:
      return { applied: apply(message.tabId, message.settings) };
    case Msg.RELEASE:
      release(message.tabId);
      return { remaining: channels.size };
    default:
      throw new Error(`Unknown message: ${message.type}`);
  }
});

/**
 * @param {number} tabId
 * @param {string} streamId
 * @param {Settings} settings
 * @param {TabMeta} meta
 */
async function capture(tabId, streamId, settings, meta) {
  if (channels.has(tabId)) {
    apply(tabId, settings);
    return;
  }

  /** @type {any} Chrome-specific constraints, not in the standard typings. */
  const audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
  const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });

  context ??= new AudioContext({ latencyHint: 'interactive' });
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  const mixer = context.createGain();
  source.connect(gain).connect(mixer).connect(context.destination);

  channels.set(tabId, { stream, source, gain, mixer, meta, settings });
  apply(tabId, settings);

  for (const track of stream.getAudioTracks()) {
    track.addEventListener('ended', () => onEnded(tabId), { once: true });
  }
  if (context.state === 'suspended') await context.resume();
}

/**
 * @param {number} tabId
 * @param {Settings} settings
 * @returns {boolean} Whether the tab is controlled (and the settings applied).
 */
function apply(tabId, settings) {
  const channel = channels.get(tabId);
  if (!channel || !context) return false;

  channel.gain.gain.setTargetAtTime(settings.volume / 100, context.currentTime, SMOOTHING_SECONDS);

  // Mono: force one channel with "speakers" downmix, i.e. (L + R) / 2. The
  // destination upmixes it back to stereo, so both ears hear everything.
  channel.mixer.channelCount = settings.mono ? 1 : 2;
  channel.mixer.channelCountMode = settings.mono ? 'explicit' : 'max';

  channel.settings = { volume: settings.volume, mono: settings.mono };
  return true;
}

/** @param {number} tabId */
function release(tabId) {
  const channel = channels.get(tabId);
  if (!channel) return;
  channels.delete(tabId);

  channel.source.disconnect();
  channel.gain.disconnect();
  channel.mixer.disconnect();
  for (const track of channel.stream.getTracks()) track.stop();

  if (channels.size === 0 && context) {
    context.close();
    context = null;
  }
}

/** @param {number} tabId */
function onEnded(tabId) {
  if (!channels.has(tabId)) return;
  release(tabId);
  send(Target.BACKGROUND, Msg.TAB_ENDED, { tabId, remaining: channels.size }).catch(() => {});
}

/**
 * @param {number} tabId
 * @param {Channel} channel
 * @returns {ControlledTab}
 */
function describe(tabId, channel) {
  return { tabId, ...channel.meta, ...channel.settings };
}
