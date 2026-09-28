/**
 * Messages exchanged between the popup, the service worker and the offscreen
 * audio engine. `chrome.runtime.sendMessage` reaches every extension context,
 * so each message names its `target` and listeners ignore the rest.
 */

export const Target = Object.freeze({
  BACKGROUND: 'background',
  OFFSCREEN: 'offscreen',
});

export const Msg = Object.freeze({
  /** List the tabs currently under control. */
  GET_STATE: 'get-state',
  /** Apply settings to a tab, taking control of it first if needed. */
  UPDATE: 'update',
  /** Stop controlling a tab and leave it exactly as it was. */
  RELEASE: 'release',
  /** Service worker -> offscreen: start processing a captured tab. */
  CAPTURE: 'capture',
  /** Service worker -> offscreen: apply settings to an already captured tab. */
  APPLY: 'apply',
  /** Offscreen -> service worker: a tab's capture ended on its own (tab closed). */
  TAB_ENDED: 'tab-ended',
});

/** Volume is expressed in percent; above 100 is boost. */
export const Volume = Object.freeze({
  MIN: 0,
  MAX: 300,
  DEFAULT: 100,
});

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({ volume: Volume.DEFAULT, mono: false });

/**
 * @typedef {object} Settings
 * @property {number} volume Percent, `Volume.MIN`..`Volume.MAX`.
 * @property {boolean} mono Downmix to a single channel played in both ears.
 */

/**
 * @typedef {object} TabMeta
 * @property {string} title
 * @property {string} favIconUrl
 */

/**
 * @typedef {{ tabId: number } & TabMeta & Settings} ControlledTab
 */

/**
 * Sends a message to another extension context and unwraps `{ error }` replies.
 * @param {string} target
 * @param {string} type
 * @param {object} [payload]
 * @returns {Promise<any>}
 */
export async function send(target, type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ target, type, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

/**
 * Registers the message handler for one target. Handlers may be async; thrown
 * errors are sent back as `{ error }`.
 * @param {string} target
 * @param {(message: any) => unknown} handler
 */
export function listen(target, handler) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== target) return false;
    Promise.resolve()
      .then(() => handler(message))
      .then(sendResponse, (error) => sendResponse({ error: String(error?.message ?? error) }));
    return true;
  });
}
