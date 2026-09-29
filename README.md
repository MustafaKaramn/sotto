<p align="center">
  <img src="src/icons/icon-128.png" width="96" height="96" alt="" />
</p>

<h1 align="center">Sotto</h1>

<p align="center">Per-tab volume control for Chromium browsers. Small, clean, and it lets go when you're done.</p>

---

## Features

- **Volume slider per tab**: 0–500%. The left half of the slider covers 0–100% and the right half is boost, shown in a different color. Drags snap to 100%. The mouse wheel moves it in steps of 5, and the arrow keys in steps of 1.
- **Clean boost**: a look-ahead limiter keeps boosted audio from clipping or crackling. Below the clipping point it leaves the audio untouched. A **Limiter** badge lights up while it's working. Clicking the badge turns the limiter off for people who want maximum loudness at any cost. On already-loud sources, that adds about 6 dB at 500%, with audible distortion. The choice is remembered.
- **Mono**: plays both channels in both ears. Useful for videos whose sound comes from one side only.
- **Balance**: turns the left or right side down, for example for uneven hearing or a single earbud. Unlike a panner, it never moves one side's content into the other. It works together with mono. Drags snap to the centre, and a double-click recentres it. At the centre, audio passes through bit-exact.
- **Night mode**: tames loud effects and brings dialogue forward, for films where the voices are too quiet and the explosions too loud. It lowers the bass a little, lifts the speech range and narrows the dynamic range. Measured in Chrome, quiet speech comes up about 8 dB and full-scale hits drop about 8–10 dB. While it's off, none of its processing runs.
- **Reset**: back to 100%, stereo, night mode off, balance centred.
- **Turn off** (the power button): stops controlling the tab completely. The capture ends, Chrome's "sharing this tab" indicator goes away, and the tab plays exactly as it did before.
- **Keyboard shortcuts** that work without opening the popup: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>↑</kbd>/<kbd>↓</kbd> change the volume by 10%, <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>M</kbd> toggles mono, and <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>0</kbd> releases the tab. Reset and night mode have no default keys but can be assigned. You can change all of them at `chrome://extensions/shortcuts`.
- **All controlled tabs in one place**: every tab Sotto is controlling appears in the popup, with its own slider.
- **English and Turkish** UI; it follows the browser language.

## Principles

- **Touches nothing until you ask it to.** Opening the popup does nothing to the tab. Sotto only takes control once you move a control.
- **Leaves nothing behind.** Releasing the last tab closes the audio engine entirely. An idle Sotto has no running page and no background work.
- **No data, no network.** No analytics, no remote code. The only thing stored is the limiter on/off preference, locally. See [PRIVACY.md](PRIVACY.md).
- **No framework, no build step.** Plain JavaScript modules with JSDoc types. The whole extension is about 15 KB zipped.

## How it works

```
popup ──► service worker ──► offscreen document (audio engine)
            │                   tab stream → gain → [night] → mixer (stereo | mono) → balance ─┐
            │                   tab stream → gain → [night] → mixer (stereo | mono) → balance ─┴─► limiter → speakers
            └─ chrome.tabCapture.getMediaStreamId
```

- [`src/popup/`](src/popup): the UI. Updates are optimistic and coalesced, so fast slider drags send at most one request per tab at a time.
- [`src/background/service-worker.js`](src/background/service-worker.js): the coordinator. It captures tabs, creates the offscreen document on demand, closes it when nothing is controlled, and sets the toolbar badge.
- [`src/offscreen/`](src/offscreen): the audio engine. One Web Audio graph per tab on a shared `AudioContext`, all feeding one limiter.
- [`src/offscreen/limiter.js`](src/offscreen/limiter.js): the limiter's DSP. It's plain code with no Web Audio dependency, so [`tests/`](tests) can check it in Node. The tests confirm that no sample exceeds the ceiling at 500%, that audio below the ceiling passes through bit-exact, and that the limiter costs about 0.2% of real time.
- [`src/shared/protocol.js`](src/shared/protocol.js): message types, shared constants and messaging helpers.

Sotto uses `chrome.tabCapture` because it is the only approach that handles **all** audio in a tab: `<video>`, Web Audio, cross-origin iframes. It also allows boost and mono. The trade-off is that Chrome shows its tab-sharing indicator **while a tab is being controlled**. Chrome shows that indicator for every tab capture as a security measure, and extensions can't hide it. What Sotto guarantees is that the indicator goes away the moment you press **Turn off**.

## Browser support

Sotto needs Chromium 116 or later: Chrome, Edge, Brave, Opera, Vivaldi and others. Firefox is not supported, because it has no `tabCapture` or offscreen documents.

## Development

Requirements: Node.js 22+.

```sh
npm install        # dev tooling only (ESLint, Prettier, TypeScript for JSDoc checks)
```

Load the extension:

1. Open `chrome://extensions` (or `edge://extensions`) and turn on **Developer mode**.
2. Click **Load unpacked** and select the `src/` folder.
3. After you change code, click the reload icon on the extension card. Popup changes apply the next time you open the popup.

To debug, right-click the popup and choose _Inspect_. The service worker and the offscreen document both have _Inspect views_ links on the extension card.

| Script                 | What it does                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------- |
| `npm run check`        | Runs lint, type checks, the formatting check and the tests (run before committing) |
| `npm test`             | Runs the unit tests                                                                |
| `npm run lint`         | Runs ESLint                                                                        |
| `npm run typecheck`    | Type-checks the JSDoc-annotated JS with `tsc`                                      |
| `npm run format`       | Formats everything with Prettier                                                   |
| `npm run icons`        | Regenerates `src/icons/*.png` from code                                            |
| `npm run store-assets` | Renders store screenshots and the promo tile into `store/images/`                  |
| `npm run pack`         | Builds `dist/sotto-<version>.zip` for store upload                                 |

The version lives in both `src/manifest.json` and `package.json`. `npm run pack` refuses to build if the two differ.

## Permissions

| Permission   | Why                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------- |
| `activeTab`  | Read the current tab's title and icon when you open the popup, and allow capturing it.   |
| `tabCapture` | Capture the tab's audio so its volume and channels can be changed.                       |
| `offscreen`  | Run the Web Audio engine in a hidden page. Manifest V3 service workers can't play audio. |
| `storage`    | Remember whether the limiter is on or off.                                               |

Sotto doesn't request host permissions and doesn't inject scripts into pages.

## Publishing

See [docs/publishing.md](docs/publishing.md) for the release checklist and store setup, and [docs/store-listing.md](docs/store-listing.md) for the listing text.

## License

Copyright © 2026 Mustafa Karaman.

Sotto is free software: you can redistribute it and/or modify it under the terms of the [GNU General Public License](LICENSE), version 3 or (at your option) any later version. It is distributed in the hope that it will be useful, but without any warranty; see the license for details.
