import { DEFAULT_SETTINGS, Msg, Target, Volume, send } from '../shared/protocol.js';

/**
 * @typedef {import('../shared/protocol.js').Settings} Settings
 * @typedef {import('../shared/protocol.js').ControlledTab} ControlledTab
 */

/** Pointer drags that land this close to 100% snap onto it. */
const SNAP_DISTANCE = 4;
const WHEEL_STEP = 5;
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
    this.settings = { volume: settings.volume, mono: settings.mono };
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
  value: /** @type {HTMLOutputElement} */ (document.getElementById('volume-value')),
  volume: /** @type {HTMLInputElement} */ (document.getElementById('volume')),
  mono: /** @type {HTMLButtonElement} */ (document.getElementById('mono')),
  reset: /** @type {HTMLButtonElement} */ (document.getElementById('reset')),
  release: /** @type {HTMLButtonElement} */ (document.getElementById('release')),
  notice: /** @type {HTMLElement} */ (document.getElementById('notice')),
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
  document.documentElement.style.setProperty('--unity', String(Volume.DEFAULT / Volume.MAX));

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  /** @type {{ tabs: ControlledTab[] }} */
  const { tabs } = await send(Target.BACKGROUND, Msg.GET_STATE);

  setUpCurrentTab(
    tab,
    tabs.find((controlled) => controlled.tabId === tab.id),
  );
  setUpOtherTabs(tabs.filter((controlled) => controlled.tabId !== tab.id));
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
  slider.min = String(Volume.MIN);
  slider.max = String(Volume.MAX);
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
    let volume = Number(slider.value);
    if (dragging && Math.abs(volume - Volume.DEFAULT) <= SNAP_DISTANCE) volume = Volume.DEFAULT;
    controller.set({ volume });
  });

  slider.addEventListener(
    'wheel',
    (event) => {
      if (slider.disabled) return;
      event.preventDefault();
      const step = event.deltaY < 0 ? WHEEL_STEP : -WHEEL_STEP;
      const volume = Math.round((controller.settings.volume + step) / WHEEL_STEP) * WHEEL_STEP;
      controller.set({ volume: Math.min(Volume.MAX, Math.max(Volume.MIN, volume)) });
    },
    { passive: false },
  );
}

/**
 * @param {HTMLInputElement} slider
 * @param {number} volume
 */
function renderSlider(slider, volume) {
  slider.value = String(volume);
  slider.style.setProperty('--fill', String((volume - Volume.MIN) / (Volume.MAX - Volume.MIN)));
}

/** @param {Settings} settings */
function isDefault(settings) {
  return settings.volume === DEFAULT_SETTINGS.volume && settings.mono === DEFAULT_SETTINGS.mono;
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
