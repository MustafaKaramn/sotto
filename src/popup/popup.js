import {
  DEFAULT_SETTINGS,
  Msg,
  Target,
  Volume,
  clampVolume,
  isDefault,
  send,
  toSettings,
} from '../shared/protocol.js';

/**
 * @typedef {import('../shared/protocol.js').Settings} Settings
 * @typedef {import('../shared/protocol.js').ControlledTab} ControlledTab
 */

/**
 * The slider is two linear zones: the left half is 0–100%, the right half the
 * boost range up to Volume.MAX, so everyday levels keep their precision.
 */
const UNITY_POSITION = 0.5;
const SLIDER_STEPS = 1000;
/** Pointer drags that land this close to 100% snap onto it. */
const SNAP_DISTANCE = 4;
const WHEEL_STEP = 5;
/** Volume steps for keys on a focused slider. */
const KEY_STEPS = /** @type {Record<string, number>} */ ({
  ArrowUp: 1,
  ArrowRight: 1,
  ArrowDown: -1,
  ArrowLeft: -1,
  PageUp: 10,
  PageDown: -10,
});
/** How often the popup asks whether the limiter is working, in ms. */
const LIMITER_POLL_MS = 300;
/** Pages whose audio the browser lets extensions capture. */
const CAPTURABLE_URL = /^(https?|file):/;

/** @param {string} key */
const i18n = (key) => chrome.i18n.getMessage(key);

/**
 * One tab's settings as seen by the popup. Updates are optimistic: the UI
 * changes at once, and requests go out one at a time per tab with only the
 * latest wish kept, so fast slider drags never pile up or race a release.
 */
class TabController {
  /** @type {'update' | 'release' | null} */
  #pending = null;
  #busy = false;

  /**
   * @param {number} tabId
   * @param {Settings} settings
   * @param {boolean} engaged Whether the tab is already under control.
   * @param {{ onChange: () => void, onError: (error: unknown) => void }} hooks
   */
  constructor(tabId, settings, engaged, hooks) {
    this.tabId = tabId;
    /** @type {Settings} */
    this.settings = toSettings(settings);
    this.engaged = engaged;
    this.hooks = hooks;
  }

  /** @param {Partial<Settings>} patch */
  set(patch) {
    this.settings = { ...this.settings, ...patch };
    this.engaged = true;
    this.#queue('update');
  }

  release() {
    if (!this.engaged) return;
    this.settings = { ...DEFAULT_SETTINGS };
    this.engaged = false;
    this.#queue('release');
  }

  /** @param {'update' | 'release'} op */
  #queue(op) {
    this.#pending = op;
    this.hooks.onChange();
    void this.#flush();
  }

  async #flush() {
    if (this.#busy) return;
    this.#busy = true;
    while (this.#pending) {
      const op = this.#pending;
      this.#pending = null;
      try {
        if (op === 'update') {
          await send(Target.BACKGROUND, Msg.UPDATE, { tabId: this.tabId, settings: this.settings });
        } else {
          await send(Target.BACKGROUND, Msg.RELEASE, { tabId: this.tabId });
        }
      } catch (error) {
        if (op === 'update') {
          this.#pending = null;
          this.settings = { ...DEFAULT_SETTINGS };
          this.engaged = false;
          this.hooks.onChange();
        }
        this.hooks.onError(error);
      }
    }
    this.#busy = false;
  }
}

const ui = {
  favicon: /** @type {HTMLImageElement} */ (document.getElementById('tab-icon')),
  title: /** @type {HTMLElement} */ (document.getElementById('tab-title')),
  status: /** @type {HTMLElement} */ (document.getElementById('status')),
  readout: /** @type {HTMLElement} */ (document.getElementById('readout')),
  limiter: /** @type {HTMLElement} */ (document.getElementById('limiter')),
  value: /** @type {HTMLOutputElement} */ (document.getElementById('volume-value')),
  volume: /** @type {HTMLInputElement} */ (document.getElementById('volume')),
  mono: /** @type {HTMLButtonElement} */ (document.getElementById('mono')),
  reset: /** @type {HTMLButtonElement} */ (document.getElementById('reset')),
  release: /** @type {HTMLButtonElement} */ (document.getElementById('release')),
  notice: /** @type {HTMLElement} */ (document.getElementById('notice')),
  shortcuts: /** @type {HTMLButtonElement} */ (document.getElementById('shortcuts')),
  others: /** @type {HTMLElement} */ (document.getElementById('others')),
  otherList: /** @type {HTMLUListElement} */ (document.getElementById('other-list')),
  rowTemplate: /** @type {HTMLTemplateElement} */ (document.getElementById('other-row')),
};

main().catch((error) => {
  console.error(error);
  showNotice(i18n('noticeFailed'));
});

async function main() {
  localize(document);
  document.documentElement.lang = chrome.i18n.getUILanguage();
  document.documentElement.style.setProperty('--unity', String(UNITY_POSITION));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  /** @type {{ tabs: ControlledTab[], limiting: boolean }} */
  const { tabs, limiting } = await send(Target.BACKGROUND, Msg.GET_STATE);

  setUpCurrentTab(
    tab,
    tabs.find((controlled) => controlled.tabId === tab.id),
  );
  setUpOtherTabs(tabs.filter((controlled) => controlled.tabId !== tab.id));
  showLimiting(limiting);
  setInterval(pollLimiter, LIMITER_POLL_MS);
  await showShortcuts();
}

/** Adds the assigned keyboard shortcuts to the tooltips of what they control. */
async function showShortcuts() {
  const commands = await chrome.commands.getAll();
  /** @param {string} name */
  const key = (name) => commands.find((command) => command.name === name)?.shortcut;

  /**
   * @param {HTMLElement} element
   * @param {(string | undefined)[]} keys
   */
  const hint = (element, keys) => {
    const assigned = keys.filter(Boolean);
    if (assigned.length) element.title = `${element.title} (${assigned.join(' / ')})`.trim();
  };
  hint(ui.volume, [key('volume-up'), key('volume-down')]);
  hint(ui.mono, [key('toggle-mono')]);
  hint(ui.reset, [key('reset')]);
  hint(ui.release, [key('release')]);

  ui.shortcuts.addEventListener('click', () => {
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    window.close();
  });
}

async function pollLimiter() {
  if (ui.limiter.hidden) return;
  try {
    const { limiting } = await send(Target.BACKGROUND, Msg.GET_STATE);
    showLimiting(limiting);
  } catch {
    showLimiting(false);
  }
}

/** @param {boolean} limiting */
function showLimiting(limiting) {
  ui.limiter.toggleAttribute('data-active', limiting);
}

/**
 * @param {chrome.tabs.Tab} tab
 * @param {ControlledTab | undefined} controlled
 */
function setUpCurrentTab(tab, controlled) {
  ui.title.textContent = tab.title || tab.url || '';
  showFavicon(ui.favicon, tab.favIconUrl);
  setUpSlider(ui.volume);

  if (tab.id === undefined || !CAPTURABLE_URL.test(tab.url ?? '')) {
    for (const control of [ui.volume, ui.mono, ui.reset, ui.release]) control.disabled = true;
    ui.status.textContent = i18n('statusIdle');
    renderSlider(ui.volume, Volume.DEFAULT);
    showNotice(i18n('noticeRestricted'));
    return;
  }

  const controller = new TabController(tab.id, controlled ?? DEFAULT_SETTINGS, !!controlled, {
    onChange: render,
    onError(error) {
      console.error(error);
      showNotice(i18n('noticeFailed'));
    },
  });

  function render() {
    const { volume, mono } = controller.settings;
    renderSlider(ui.volume, volume);
    ui.value.textContent = String(volume);
    ui.readout.toggleAttribute('data-boost', volume > Volume.DEFAULT);
    ui.limiter.hidden = !controller.engaged || volume <= Volume.DEFAULT;
    ui.mono.setAttribute('aria-pressed', String(mono));
    ui.reset.disabled = !controller.engaged || isDefault(controller.settings);
    ui.release.disabled = !controller.engaged;
    ui.status.dataset.state = controller.engaged ? 'active' : 'idle';
    ui.status.textContent = i18n(controller.engaged ? 'statusActive' : 'statusIdle');
  }

  bindSlider(ui.volume, controller);
  ui.mono.addEventListener('click', () => controller.set({ mono: !controller.settings.mono }));
  ui.reset.addEventListener('click', () => controller.set(DEFAULT_SETTINGS));
  ui.release.addEventListener('click', () => controller.release());
  render();
}

/** @param {ControlledTab[]} tabs */
function setUpOtherTabs(tabs) {
  ui.others.hidden = tabs.length === 0;
  for (const tab of tabs) ui.otherList.append(createOtherRow(tab));
}

/** @param {ControlledTab} tab */
function createOtherRow(tab) {
  const row = /** @type {HTMLLIElement} */ (
    ui.rowTemplate.content.firstElementChild?.cloneNode(true)
  );
  localize(row);

  const focusButton = /** @type {HTMLButtonElement} */ (row.querySelector('.row__tab'));
  const favicon = /** @type {HTMLImageElement} */ (row.querySelector('.favicon'));
  const title = /** @type {HTMLElement} */ (row.querySelector('.row__title'));
  const value = /** @type {HTMLElement} */ (row.querySelector('.row__value'));
  const releaseButton = /** @type {HTMLButtonElement} */ (row.querySelector('.icon-btn'));
  const slider = /** @type {HTMLInputElement} */ (row.querySelector('.slider'));

  title.textContent = tab.title;
  showFavicon(favicon, tab.favIconUrl);
  setUpSlider(slider);

  const controller = new TabController(tab.tabId, tab, true, {
    onChange: render,
    onError: console.error,
  });

  function render() {
    if (!controller.engaged) {
      row.remove();
      ui.others.hidden = ui.otherList.childElementCount === 0;
      return;
    }
    const { volume, mono } = controller.settings;
    renderSlider(slider, volume);
    value.textContent = `${volume}%${mono ? ' · M' : ''}`;
  }

  bindSlider(slider, controller);
  focusButton.addEventListener('click', () => focusTab(tab.tabId));
  releaseButton.addEventListener('click', () => controller.release());
  render();
  return row;
}

/** @param {HTMLInputElement} slider */
function setUpSlider(slider) {
  slider.min = '0';
  slider.max = String(SLIDER_STEPS);
  slider.step = '1';
}

/**
 * @param {HTMLInputElement} slider
 * @param {TabController} controller
 */
function bindSlider(slider, controller) {
  let dragging = false;
  slider.addEventListener('pointerdown', () => (dragging = true));
  slider.addEventListener('change', () => (dragging = false));

  slider.addEventListener('input', () => {
    let volume = positionToVolume(Number(slider.value) / SLIDER_STEPS);
    if (dragging && Math.abs(volume - Volume.DEFAULT) <= SNAP_DISTANCE) volume = Volume.DEFAULT;
    controller.set({ volume });
  });

  // The native key steps would be fractions of a percent; use whole percents.
  slider.addEventListener('keydown', (event) => {
    const { volume } = controller.settings;
    let next;
    if (event.key in KEY_STEPS) next = volume + KEY_STEPS[event.key];
    else if (event.key === 'Home') next = Volume.MIN;
    else if (event.key === 'End') next = Volume.MAX;
    else return;
    event.preventDefault();
    controller.set({ volume: clampVolume(next) });
  });

  slider.addEventListener(
    'wheel',
    (event) => {
      if (slider.disabled) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
      const volume = Math.round((controller.settings.volume + step) / WHEEL_STEP) * WHEEL_STEP;
      controller.set({ volume: clampVolume(volume) });
    },
    { passive: false },
  );
}

/**
 * @param {HTMLInputElement} slider
 * @param {number} volume
 */
function renderSlider(slider, volume) {
  const position = volumeToPosition(volume);
  slider.value = String(Math.round(position * SLIDER_STEPS));
  slider.style.setProperty('--fill', String(position));
  slider.setAttribute('aria-valuetext', `${volume}%`);
}

/**
 * @param {number} volume
 * @returns {number} Slider position, 0..1.
 */
function volumeToPosition(volume) {
  if (volume <= Volume.DEFAULT) {
    return ((volume - Volume.MIN) / (Volume.DEFAULT - Volume.MIN)) * UNITY_POSITION;
  }
  const boost = (volume - Volume.DEFAULT) / (Volume.MAX - Volume.DEFAULT);
  return UNITY_POSITION + boost * (1 - UNITY_POSITION);
}

/**
 * @param {number} position Slider position, 0..1.
 * @returns {number} Volume in whole percents.
 */
function positionToVolume(position) {
  const volume =
    position <= UNITY_POSITION
      ? Volume.MIN + (position / UNITY_POSITION) * (Volume.DEFAULT - Volume.MIN)
      : Volume.DEFAULT +
        ((position - UNITY_POSITION) / (1 - UNITY_POSITION)) * (Volume.MAX - Volume.DEFAULT);
  return Math.round(volume);
}

/**
 * @param {HTMLImageElement} img
 * @param {string | undefined} url
 */
function showFavicon(img, url) {
  if (!url) return;
  img.addEventListener('error', () => (img.hidden = true), { once: true });
  img.src = url;
  img.hidden = false;
}

/** @param {string} text */
function showNotice(text) {
  ui.notice.textContent = text;
  ui.notice.hidden = false;
}

/** @param {number} tabId */
async function focusTab(tabId) {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab) await chrome.windows.update(tab.windowId, { focused: true });
  window.close();
}

/** @param {ParentNode} root */
function localize(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) {
    el.textContent = i18n(/** @type {HTMLElement} */ (el).dataset.i18n ?? '');
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const html = /** @type {HTMLElement} */ (el);
    html.title = i18n(html.dataset.i18nTitle ?? '');
  }
  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    const html = /** @type {HTMLElement} */ (el);
    html.setAttribute('aria-label', i18n(html.dataset.i18nLabel ?? ''));
  }
}
