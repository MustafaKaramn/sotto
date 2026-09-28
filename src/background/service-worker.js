/**
 * Coordinator. Owns the lifetime of the offscreen document: it exists only
 * while at least one tab is controlled and is closed as soon as the last one
 * is released, so an idle Sotto costs nothing.
 */
import {
  DEFAULT_SETTINGS,
  Msg,
  Target,
  clampVolume,
  listen,
  send,
  toSettings,
} from '../shared/protocol.js';

/**
 * @typedef {import('../shared/protocol.js').Settings} Settings
 * @typedef {import('../shared/protocol.js').ControlledTab} ControlledTab
 */

const OFFSCREEN_URL = 'offscreen/offscreen.html';
const BADGE_COLOR = '#5b5bd6';
/** Volume change per keyboard shortcut press, in percent. */
const SHORTCUT_VOLUME_STEP = 10;

/**
 * Captures in progress, so rapid slider input never captures a tab twice.
 * @type {Map<number, Promise<unknown>>}
 */
const pendingCaptures = new Map();

/** @type {Promise<void> | null} */
let creatingOffscreen = null;

listen(Target.BACKGROUND, (message) => {
  switch (message.type) {
    case Msg.GET_STATE:
      return getState();
    case Msg.UPDATE:
      return update(message.tabId, message.settings);
    case Msg.RELEASE:
      return release(message.tabId);
    case Msg.TAB_ENDED:
      return afterRelease(message.tabId, message.remaining);
    default:
      throw new Error(`Unknown message: ${message.type}`);
  }
});

// Safety net; the offscreen engine also notices when a captured tab goes away.
chrome.tabs.onRemoved.addListener((tabId) => {
  release(tabId).catch(() => {});
});

// A shortcut counts as invoking the extension on the active tab, like a click
// on the toolbar button, so it may take control of the tab without the popup.
chrome.commands.onCommand.addListener((command, tab) => {
  if (tab?.id === undefined) return;
  runCommand(command, tab.id).catch((error) => console.warn(`Sotto: "${command}" failed`, error));
});

/**
 * @param {string} command A key of `commands` in the manifest.
 * @param {number} tabId
 */
async function runCommand(command, tabId) {
  /** @type {{ tabs: ControlledTab[] }} */
  const { tabs } = await getState();
  const controlled = tabs.find((tab) => tab.tabId === tabId);
  const settings = controlled ? toSettings(controlled) : { ...DEFAULT_SETTINGS };

  switch (command) {
    case 'volume-up':
      return update(tabId, {
        ...settings,
        volume: clampVolume(settings.volume + SHORTCUT_VOLUME_STEP),
      });
    case 'volume-down':
      return update(tabId, {
        ...settings,
        volume: clampVolume(settings.volume - SHORTCUT_VOLUME_STEP),
      });
    case 'toggle-mono':
      return update(tabId, { ...settings, mono: !settings.mono });
    case 'reset':
      return controlled && update(tabId, { ...DEFAULT_SETTINGS });
    case 'release':
      return release(tabId);
  }
}

async function getState() {
  if (!(await hasOffscreenDocument())) return { tabs: [], limiting: false };
  return send(Target.OFFSCREEN, Msg.GET_STATE);
}

/**
 * @param {number} tabId
 * @param {Settings} settings
 */
async function update(tabId, settings) {
  const applied =
    (await hasOffscreenDocument()) &&
    (await send(Target.OFFSCREEN, Msg.APPLY, { tabId, settings })).applied;
  if (!applied) await captureOnce(tabId, settings);
  await setBadge(tabId, settings.volume);
  return { ok: true };
}

/**
 * @param {number} tabId
 * @param {Settings} settings
 */
function captureOnce(tabId, settings) {
  const inFlight = pendingCaptures.get(tabId);
  if (inFlight) return inFlight.then(() => send(Target.OFFSCREEN, Msg.APPLY, { tabId, settings }));

  const capture = startCapture(tabId, settings)
    .finally(() => pendingCaptures.delete(tabId))
    .catch(async (error) => {
      // Clean up after a failed capture, e.g. close an offscreen document
      // that was opened just for it.
      const { tabs } = await getState();
      await afterRelease(tabId, tabs.length);
      throw error;
    });
  pendingCaptures.set(tabId, capture);
  return capture;
}

/**
 * @param {number} tabId
 * @param {Settings} settings
 */
async function startCapture(tabId, settings) {
  const tab = await chrome.tabs.get(tabId);
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  await ensureOffscreenDocument();
  await send(Target.OFFSCREEN, Msg.CAPTURE, {
    tabId,
    streamId,
    settings,
    meta: { title: tab.title ?? '', favIconUrl: tab.favIconUrl ?? '' },
  });
}

/** @param {number} tabId */
async function release(tabId) {
  if (!(await hasOffscreenDocument())) return { ok: true };
  const { remaining } = await send(Target.OFFSCREEN, Msg.RELEASE, { tabId });
  return afterRelease(tabId, remaining);
}

/**
 * @param {number} tabId
 * @param {number} remaining Tabs still under control.
 */
async function afterRelease(tabId, remaining) {
  await chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
  if (remaining === 0 && pendingCaptures.size === 0) await closeOffscreenDocument();
  return { ok: true };
}

/**
 * @param {number} tabId
 * @param {number} volume
 */
async function setBadge(tabId, volume) {
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
  await chrome.action.setBadgeText({ tabId, text: String(volume) });
}

async function hasOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Processes tab audio captured with chrome.tabCapture (volume, mono).',
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
}
