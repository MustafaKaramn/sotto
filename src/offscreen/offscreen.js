/**
 * Audio engine. Each controlled tab gets one small graph, and all of them meet
 * in a shared limiter on one AudioContext:
 *
 *   tab stream -> gain (volume) -> [night mode] -> mixer (stereo | mono) ─┐
 *   tab stream -> gain (volume) -> [night mode] -> mixer (stereo | mono) ─┴-> limiter -> speakers
 *
 * The limiter keeps boosted audio (and the sum of several tabs) from clipping;
 * below the ceiling it passes audio through untouched.
 *
 * Capturing a tab silences its own output, so the graph must always reach the
 * speakers. Releasing a tab stops its tracks, which is what makes Chrome drop
 * the "tab is being shared" indicator; the tab then plays on its own again.
 */
import { Msg, Target, listen, send, toSettings } from '../shared/protocol.js';
import { createNightChain } from './night-mode.js';

/**
 * @typedef {import('../shared/protocol.js').Settings} Settings
 * @typedef {import('../shared/protocol.js').TabMeta} TabMeta
 * @typedef {import('../shared/protocol.js').ControlledTab} ControlledTab
 * @typedef {import('./night-mode.js').NightChain} NightChain
 */

/**
 * @typedef {object} Channel
 * @property {MediaStream} stream
 * @property {MediaStreamAudioSourceNode} source
 * @property {GainNode} gain
 * @property {GainNode} mixer
 * @property {NightChain | null} night Created the first time night mode is used.
 * @property {boolean} nightWired Whether the night chain is currently in the path.
 * @property {boolean} rewiring
 * @property {TabMeta} meta
 * @property {Settings} settings
 */

/**
 * @typedef {object} Engine
 * @property {AudioContext} context
 * @property {AudioWorkletNode} limiter
 */

/** Time constant for volume changes: feels instant, but doesn't click. */
const SMOOTHING_SECONDS = 0.015;
/** Rewiring happens under a short fade, so switching paths never clicks. */
const REWIRE_FADE_SECONDS = 0.004;
const REWIRE_WAIT_MS = 25;

/** @type {Promise<Engine> | null} */
let engine = null;

/** Whether the limiter is currently holding the output down. */
let limiting = false;

/** @type {Map<number, Channel>} */
const channels = new Map();

/** Captures still being set up; the engine must not close under them. */
let pendingCaptures = 0;

listen(Target.OFFSCREEN, async (message) => {
  switch (message.type) {
    case Msg.GET_STATE:
      return {
        tabs: [...channels].map(([tabId, channel]) => describe(tabId, channel)),
        limiting,
      };
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

/** @returns {Promise<Engine>} */
function getEngine() {
  engine ??= createEngine();
  return engine;
}

async function createEngine() {
  const context = new AudioContext({ latencyHint: 'interactive' });
  await context.audioWorklet.addModule('limiter-processor.js');
  const limiter = new AudioWorkletNode(context, 'sotto-limiter', {
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  });
  limiter.port.onmessage = (event) => (limiting = event.data.limiting);
  limiter.connect(context.destination);
  return { context, limiter };
}

async function closeEngine() {
  const closing = engine;
  engine = null;
  limiting = false;
  if (closing) await (await closing).context.close();
}

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

  pendingCaptures++;
  /** @type {MediaStream | undefined} */
  let stream;
  try {
    /** @type {any} Chrome-specific constraints, not in the standard typings. */
    const audio = { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } };
    stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });

    const { context, limiter } = await getEngine();
    const source = context.createMediaStreamSource(stream);
    const gain = context.createGain();
    const mixer = context.createGain();
    source.connect(gain);
    mixer.connect(limiter);
    /** @type {Channel} */
    const channel = {
      stream,
      source,
      gain,
      mixer,
      night: null,
      nightWired: false,
      rewiring: false,
      meta,
      settings,
    };
    wire(channel, settings.night);
    channels.set(tabId, channel);
    apply(tabId, settings);

    for (const track of stream.getAudioTracks()) {
      track.addEventListener('ended', () => onEnded(tabId), { once: true });
    }
    if (context.state === 'suspended') await context.resume();
  } catch (error) {
    // Never leave a half-set-up capture behind: it would keep the tab muted
    // and the sharing indicator on.
    if (channels.has(tabId)) release(tabId);
    else for (const track of stream?.getTracks() ?? []) track.stop();
    throw error;
  } finally {
    pendingCaptures--;
    if (channels.size === 0 && pendingCaptures === 0) void closeEngine();
  }
}

/**
 * @param {number} tabId
 * @param {Settings} settings
 * @returns {boolean} Whether the tab is controlled (and the settings applied).
 */
function apply(tabId, settings) {
  const channel = channels.get(tabId);
  if (!channel) return false;

  const { currentTime } = channel.gain.context;
  channel.gain.gain.setTargetAtTime(settings.volume / 100, currentTime, SMOOTHING_SECONDS);

  // Mono: force one channel with "speakers" downmix, i.e. (L + R) / 2. The
  // limiter's input upmixes it back to stereo, so both ears hear everything.
  channel.mixer.channelCount = settings.mono ? 1 : 2;
  channel.mixer.channelCountMode = settings.mono ? 'explicit' : 'max';

  channel.settings = toSettings(settings);
  if (settings.night !== channel.nightWired) rewire(tabId, channel);
  return true;
}

/**
 * Switches a channel's path to match its night setting: fade out, reconnect,
 * fade back in. Toggles that arrive meanwhile are picked up at the end.
 * @param {number} tabId
 * @param {Channel} channel
 */
function rewire(tabId, channel) {
  if (channel.rewiring) return;
  channel.rewiring = true;
  const fade = channel.mixer.gain;
  fade.setTargetAtTime(0, channel.mixer.context.currentTime, REWIRE_FADE_SECONDS);

  setTimeout(() => {
    channel.rewiring = false;
    if (channels.get(tabId) !== channel) return;
    wire(channel, channel.settings.night);
    fade.setTargetAtTime(1, channel.mixer.context.currentTime, REWIRE_FADE_SECONDS);
  }, REWIRE_WAIT_MS);
}

/**
 * Connects gain -> mixer either directly or through the night chain.
 * @param {Channel} channel
 * @param {boolean} night
 */
function wire(channel, night) {
  channel.gain.disconnect();
  channel.night?.output.disconnect();
  if (night) {
    channel.night ??= createNightChain(channel.gain.context);
    channel.gain.connect(channel.night.input);
    channel.night.output.connect(channel.mixer);
  } else {
    channel.gain.connect(channel.mixer);
  }
  channel.nightWired = night;
}

/** @param {number} tabId */
function release(tabId) {
  const channel = channels.get(tabId);
  if (!channel) return;
  channels.delete(tabId);

  channel.source.disconnect();
  channel.gain.disconnect();
  for (const node of channel.night?.nodes ?? []) node.disconnect();
  channel.mixer.disconnect();
  for (const track of channel.stream.getTracks()) track.stop();

  if (channels.size === 0 && pendingCaptures === 0) void closeEngine();
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
