# Publishing

## Release checklist

1. Bump `version` in **both** `src/manifest.json` and `package.json`. Every upload needs a version higher than the last one.
2. Run `npm run check`.
3. Run `npm run pack`. This produces `dist/sotto-<version>.zip`.
4. Load `src/` unpacked one last time and test: volume, boost, mono, reset, release (the sharing indicator must disappear), and closing a controlled tab.
5. Commit, tag the release (`git tag v<version>`) and push.
6. Upload the zip to the stores (see below).

## Chrome Web Store

**One-time setup**

1. Sign in at the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and pay the one-time US$5 registration fee.
2. Verify your contact email address. The dashboard won't let you publish until you do.

**Each item needs**

- **Package**: `dist/sotto-<version>.zip`.
- **Store listing**: a description, at least one screenshot (1280×800 or 640×400), a 128×128 icon (the zip already has one), and a 440×280 small promo tile. `npm run store-assets` renders all of them into `store/images/`: three screenshots each in English and Turkish, plus the promo tile. Each screenshot is the real popup with demo data, so run the script again whenever the UI changes. Upload the Turkish screenshots to the Turkish listing.
- **Privacy tab**: fill it in with the text below.
- **Distribution**: public, and all regions unless you want to restrict them.

Reviews usually take from a few hours to a few days. Narrow permissions and a clear justification for each one make approval faster.

### Privacy tab: ready-to-paste answers

**Single purpose**

> Sotto adjusts the audio of individual browser tabs the user chooses: volume (including boost above 100% with a limiter), mono, night mode (dialogue clarity) and left/right balance. It can also restore or release those tabs.

**Permission justifications**

- `activeTab`: Read the title and icon of the tab the user opened the popup on, and allow capturing that tab's audio when the user moves a control.
- `tabCapture`: Capture the audio of the tab the user chose, so the extension can change its volume and channel layout. The audio is processed locally and played back immediately. It is never recorded or transmitted.
- `storage`: Remember one user preference, whether the limiter is on or off. Nothing else is stored.
- `offscreen`: Host the Web Audio engine that processes the captured tab audio. Manifest V3 service workers cannot process or play audio.

**Remote code**: No, I am not using remote code.

**Data usage**: Leave every data category unchecked. Then certify that the extension does not sell data, does not use or transfer data for purposes unrelated to its single purpose, and does not use data for creditworthiness or lending.

**Privacy policy URL**: this must be a publicly reachable page. A public repository can link to its `PRIVACY.md`. A private repository can't, so host the policy somewhere public instead, such as a public gist, a small public repository with GitHub Pages, or a Google Sites page.

## Microsoft Edge Add-ons

The same zip works. Register for free at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview), create a new extension, upload the zip, and reuse the listing and privacy text above.
