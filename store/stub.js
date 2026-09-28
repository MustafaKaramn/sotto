// A fake `chrome` API that feeds the real popup with demo data for the store
// images. Loaded before popup.js by scripts/store-assets.mjs; never shipped.
(() => {
  const params = new URLSearchParams(location.search);
  const lang = params.get('lang') ?? 'en';
  const scene = params.get('scene') ?? 'boost';

  const request = new XMLHttpRequest();
  request.open('GET', `/src/_locales/${lang}/messages.json`, false);
  request.send();
  const messages = JSON.parse(request.responseText);

  const icon = (color) =>
    'data:image/svg+xml,' +
    encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/><path d="M6.5 4.5l5 3.5-5 3.5z" fill="white"/></svg>`,
    );

  const titles = {
    en: [
      'Late-night documentary: Episode 3',
      'Lo-fi radio · beats to study to',
      'Weekly tech podcast #142',
    ],
    tr: [
      'Gece belgeseli: 3. bölüm',
      'Lo-fi radyo · çalışma müzikleri',
      "Haftalık teknoloji podcast'i #142",
    ],
  }[lang];

  const settings = (volume, mono = false, night = false, balance = 0) => ({
    volume,
    mono,
    night,
    balance,
  });
  const other = (tabId, volume, extra = {}) => ({
    tabId,
    title: titles[tabId - 1],
    favIconUrl: icon(tabId === 2 ? '#0f9d8a' : '#d9480f'),
    ...settings(volume),
    ...extra,
  });

  const scenes = {
    boost: { current: settings(320), others: [other(2, 60)], limiting: true },
    tools: { current: settings(100, true, true, -30), others: [], limiting: false },
    release: {
      current: null,
      others: [other(2, 60), other(3, 140, { night: true })],
      limiting: false,
    },
  };
  const { current, others, limiting } = scenes[scene];
  const currentIcon = icon('#5b5bd6');
  const tabs = [
    ...(current ? [{ tabId: 1, title: titles[0], favIconUrl: currentIcon, ...current }] : []),
    ...others,
  ];

  window.chrome = {
    i18n: {
      getMessage: (key) => messages[key]?.message ?? key,
      getUILanguage: () => lang,
    },
    tabs: {
      query: async () => [
        { id: 1, title: titles[0], url: 'https://example.com/watch', favIconUrl: currentIcon },
      ],
      update: async () => undefined,
      create: async () => undefined,
    },
    windows: { update: async () => undefined },
    commands: {
      getAll: async () => [
        { name: 'volume-up', shortcut: 'Alt+Shift+Up' },
        { name: 'volume-down', shortcut: 'Alt+Shift+Down' },
        { name: 'toggle-mono', shortcut: 'Alt+Shift+M' },
        { name: 'release', shortcut: 'Alt+Shift+0' },
      ],
    },
    runtime: {
      sendMessage: async (message) =>
        message.type === 'get-state' ? { tabs, limiting, limiterEnabled: true } : { ok: true },
    },
  };
})();
