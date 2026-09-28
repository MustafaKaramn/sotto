/**
 * Renders the store listing images into store/images/ with headless Chrome.
 * Each screenshot is the real popup fed with demo data (store/stub.js) and
 * framed with a caption (store/scene.html), so the images stay in sync with
 * the UI. Run: npm run store-assets (set CHROME_PATH if Chrome isn't found).
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Ends with a path separator, so prefix checks can't match a sibling folder. */
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const OUT_DIR = join(ROOT, 'store', 'images');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
};

const SCENES = ['boost', 'tools', 'release'];
const IMAGES = [
  ...['en', 'tr'].flatMap((lang) =>
    SCENES.map((scene, index) => ({
      file: `screenshot-${lang}-${index + 1}-${scene}.png`,
      page: `/store/scene.html?scene=${scene}&lang=${lang}`,
      size: [1280, 800],
    })),
  ),
  { file: 'promo-small-440x280.png', page: '/store/promo.html', size: [440, 280] },
];

const chrome = findChrome();
if (!chrome) {
  console.error('Chrome not found. Set CHROME_PATH to its executable.');
  process.exit(1);
}

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', 'http://localhost');
  if (pathname === '/preview/popup.html') return reply(response, '.html', previewPopup());

  const path = normalize(join(ROOT, decodeURIComponent(pathname)));
  if (!path.startsWith(ROOT) || !existsSync(path) || !statSync(path).isFile()) {
    response.writeHead(404).end();
    return;
  }
  reply(response, extname(path), readFileSync(path));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = server.address();
const origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
const profile = mkdtempSync(join(tmpdir(), 'sotto-store-'));
mkdirSync(OUT_DIR, { recursive: true });

try {
  for (const { file, page, size } of IMAGES) {
    await screenshot(`${origin}${page}`, join(OUT_DIR, file), size);
    console.log(`store/images/${file}`);
  }
} finally {
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

/**
 * The real popup, with the demo API injected before its scripts run and
 * transitions off so nothing is captured mid-animation.
 */
function previewPopup() {
  const html = readFileSync(join(ROOT, 'src', 'popup', 'popup.html'), 'utf8');
  return html.replace(
    '<head>',
    '<head><base href="/src/popup/" /><script src="/store/stub.js"></script>' +
      '<style>*, *::before, *::after { transition: none !important; }</style>',
  );
}

/**
 * @param {import('node:http').ServerResponse} response
 * @param {string} extension
 * @param {string | Buffer} body
 */
function reply(response, extension, body) {
  response.writeHead(200, { 'content-type': TYPES[extension] ?? 'application/octet-stream' });
  response.end(body);
}

/**
 * @param {string} url
 * @param {string} file
 * @param {number[]} size
 */
function screenshot(url, file, [width, height]) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-dark-mode',
    '--blink-settings=preferredColorScheme=0',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    '--virtual-time-budget=3000',
    `--user-data-dir=${profile}`,
    `--screenshot=${file}`,
    url,
  ];
  return new Promise((resolve, reject) => {
    spawn(chrome, args, { stdio: 'ignore' }).on('exit', (code) =>
      code === 0 ? resolve(undefined) : reject(new Error(`Chrome exited with code ${code}`)),
    );
  });
}

function findChrome() {
  return [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    `${process.env.LOCALAPPDATA}/Google/Chrome/Application/chrome.exe`,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((path) => path && existsSync(path));
}
