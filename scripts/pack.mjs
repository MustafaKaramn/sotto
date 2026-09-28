/**
 * Packs src/ into dist/sotto-<version>.zip, ready to upload to the Chrome Web
 * Store or Edge Add-ons. The archive is reproducible: same sources, same bytes.
 * Run: npm run pack
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_DIR = join(ROOT, 'src');
const DIST_DIR = join(ROOT, 'dist');

/** 1980-01-01 00:00 in DOS format, the earliest ZIP date; keeps builds reproducible. */
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1;
const UTF8_NAMES = 0x0800;
const DEFLATE = 8;
const ZIP_VERSION = 20;

const manifest = JSON.parse(readFileSync(join(SRC_DIR, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (manifest.version !== pkg.version) {
  console.error(`Version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}`);
  process.exit(1);
}

const entries = listFiles(SRC_DIR)
  .map((path) => ({ name: relative(SRC_DIR, path).split(sep).join('/'), data: readFileSync(path) }))
  .sort((a, b) => a.name.localeCompare(b.name));

mkdirSync(DIST_DIR, { recursive: true });
const out = join(DIST_DIR, `sotto-${manifest.version}.zip`);
const zip = createZip(entries);
writeFileSync(out, zip);
console.log(
  `${relative(ROOT, out)}  (${entries.length} files, ${(zip.length / 1024).toFixed(1)} KB)`,
);

/** @param {string} dir */
function listFiles(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith('.'))
    .flatMap((entry) => {
      const path = join(dir, entry.name);
      return entry.isDirectory() ? listFiles(path) : [path];
    });
}

/** @param {{ name: string, data: Buffer }[]} files */
function createZip(files) {
  const parts = [];
  const directory = [];
  let offset = 0;

  for (const { name, data } of files) {
    const fileName = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(ZIP_VERSION, 4);
    local.writeUInt16LE(UTF8_NAMES, 6);
    local.writeUInt16LE(DEFLATE, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(fileName.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(ZIP_VERSION, 4);
    central.writeUInt16LE(ZIP_VERSION, 6);
    central.writeUInt16LE(UTF8_NAMES, 8);
    central.writeUInt16LE(DEFLATE, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(fileName.length, 28);
    central.writeUInt32LE(offset, 42);

    parts.push(local, fileName, compressed);
    directory.push(central, fileName);
    offset += local.length + fileName.length + compressed.length;
  }

  const directorySize = directory.reduce((size, part) => size + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directorySize, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, ...directory, end]);
}
