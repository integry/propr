import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, Worker, workerData } from 'node:worker_threads';
import sharp from 'sharp';
import {
  CANONICAL_ARTWORK_SHA256,
  DESKTOP_ICON_FILE,
  inspectIcnsBytes,
  MACOS_ICON_FILE,
  sha256,
  TRAY_ICON_FILE,
  verifyDesktopPngBytes,
  verifyMacIconBytes,
  verifyTrayPngBytes,
} from './desktop-icon-assets.mjs';

const sourcePath = fileURLToPath(new URL('../../../media/logo-only-large.png', import.meta.url));
const outputDirectory = fileURLToPath(new URL('../assets/icons/', import.meta.url));
const pngOutputPath = resolve(outputDirectory, DESKTOP_ICON_FILE);
const icnsOutputPath = resolve(outputDirectory, MACOS_ICON_FILE);
const trayOutputPath = resolve(outputDirectory, TRAY_ICON_FILE);
// The legacy transparent export contains colored edge noise below this
// alpha level. Removing it produces a clean silhouette without changing the
// visible canonical mark.
const SOURCE_ALPHA_FLOOR = 24;
const DESKTOP_ARTWORK_SCALE = 0.75;
const TRAY_ARTWORK_SCALE = 0.875;
const iconEntries = Object.freeze([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]);
const pngOptions = Object.freeze({ compressionLevel: 9, adaptiveFiltering: false, palette: false });
const WASM_RENDER_WORKER = 'desktop-icon-wasm-render-worker';

const cleanCanonicalArtwork = async source => {
  const { data, info } = await sharp(source).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      const offset = (y * info.width + x) * 4;
      if (data[offset + 3] >= SOURCE_ALPHA_FLOOR) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      } else {
        data.fill(0, offset, offset + 4);
      }
    }
  }
  if (right < left || bottom < top) throw new Error('Canonical ProPR artwork contains no visible mark');
  return sharp(data, { raw: info })
    .extract({ left, top, width: right - left + 1, height: bottom - top + 1 })
    .png(pngOptions)
    .toBuffer();
};

const renderTransparentIcon = async (artwork, size, artworkScale) => {
  const artworkBox = Math.floor(size * artworkScale);
  const resized = await sharp(artwork)
    .resize(artworkBox, artworkBox, { fit: 'inside', kernel: sharp.kernel.lanczos3 })
    .png(pngOptions)
    .toBuffer();
  const metadata = await sharp(resized).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Generated ProPR artwork has invalid dimensions');
  return sharp({
    create: {
      width: size,
      height: size,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: resized,
      left: Math.floor((size - metadata.width) / 2),
      top: Math.floor((size - metadata.height) / 2),
      // PNG stores straight-alpha RGB. Sharp's default false value preserves
      // those channels; premultiplied: true would unpremultiply them again.
    }])
    .png(pngOptions)
    .toBuffer();
};

const icnsEntry = (type, png) => {
  const header = Buffer.alloc(8);
  header.write(type, 0, 4, 'ascii');
  header.writeUInt32BE(header.length + png.length, 4);
  return Buffer.concat([header, png]);
};

const buildDesktopIconsWithDeterministicRenderer = async () => {
  if (!sharp.versions.emscripten) {
    throw new Error('Desktop icon generation must use the pinned Sharp WebAssembly renderer');
  }
  const source = await readFile(sourcePath);
  if (sha256(source) !== CANONICAL_ARTWORK_SHA256) {
    throw new Error('Canonical transparent ProPR artwork checksum changed');
  }
  const artwork = await cleanCanonicalArtwork(source);
  const png = await renderTransparentIcon(artwork, 512, DESKTOP_ARTWORK_SCALE);
  const tray = await renderTransparentIcon(artwork, 32, TRAY_ARTWORK_SCALE);
  const entries = await Promise.all(iconEntries.map(async ([type, size]) => icnsEntry(
    type,
    size === 512 ? png : await renderTransparentIcon(artwork, size, DESKTOP_ARTWORK_SCALE),
  )));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(header.length + entries.reduce((total, entry) => total + entry.length, 0), 4);
  const icns = Buffer.concat([header, ...entries]);
  inspectIcnsBytes(icns);
  await Promise.all([
    verifyDesktopPngBytes(png, 'generated Linux desktop icon'),
    verifyMacIconBytes(icns, 'generated macOS desktop icon'),
    verifyTrayPngBytes(tray, 'generated desktop tray icon'),
  ]);
  return { png, icns, tray };
};

export const buildDesktopIcons = async () => {
  // Native libvips changes decoded Lanczos pixels across x64 and ARM64 even
  // with SIMD disabled. Run the bounded generation pipeline in Sharp's pinned
  // WebAssembly build instead of relying on host floating-point behavior.
  const generated = await new Promise((accept, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      execArgv: ['--no-addons'],
      workerData: WASM_RENDER_WORKER,
    });
    let result;
    worker.once('message', value => {
      result = value;
    });
    worker.once('error', reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`Desktop icon WebAssembly renderer exited with code ${code}`));
      else if (!result) reject(new Error('Desktop icon WebAssembly renderer returned no assets'));
      else accept(result);
    });
  });
  const assets = {
    png: Buffer.from(generated.png),
    icns: Buffer.from(generated.icns),
    tray: Buffer.from(generated.tray),
  };
  // Recheck the transferred result in the caller as a defense against worker
  // protocol or decoding regressions.
  await Promise.all([
    verifyDesktopPngBytes(assets.png, 'generated Linux desktop icon'),
    verifyMacIconBytes(assets.icns, 'generated macOS desktop icon'),
    verifyTrayPngBytes(assets.tray, 'generated desktop tray icon'),
  ]);
  return assets;
};

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (!isMainThread && workerData === WASM_RENDER_WORKER) {
  const generated = await buildDesktopIconsWithDeterministicRenderer();
  // WebAssembly output can be backed by shared linear memory. Copy it before
  // the worker exits so the caller never observes released WASM storage.
  parentPort.postMessage({
    png: Uint8Array.from(generated.png),
    icns: Uint8Array.from(generated.icns),
    tray: Uint8Array.from(generated.tray),
  });
  parentPort.close();
} else if (invokedDirectly) {
  const generated = await buildDesktopIcons();
  if (process.argv[2] === '--check') {
    const [png, icns, tray] = await Promise.all([
      readFile(pngOutputPath),
      readFile(icnsOutputPath),
      readFile(trayOutputPath),
    ]);
    if (!png.equals(generated.png) || !icns.equals(generated.icns) || !tray.equals(generated.tray)) {
      throw new Error('Desktop native icons are stale; run npm run icons:generate -w @propr/desktop');
    }
    console.log('Desktop native icons match the canonical transparent ProPR artwork.');
  } else if (process.argv.length === 2) {
    await mkdir(outputDirectory, { recursive: true });
    await Promise.all([
      writeFile(pngOutputPath, generated.png),
      writeFile(icnsOutputPath, generated.icns),
      writeFile(trayOutputPath, generated.tray),
    ]);
    console.log(`Generated ${DESKTOP_ICON_FILE}, ${MACOS_ICON_FILE}, and ${TRAY_ICON_FILE}.`);
  } else {
    throw new Error('Usage: generate-desktop-icons.mjs [--check]');
  }
}
