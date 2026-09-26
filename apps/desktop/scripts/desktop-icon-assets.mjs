import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import sharp from 'sharp';

export const DESKTOP_ICON_FILE = 'propr-desktop.png';
export const MACOS_ICON_FILE = 'propr-desktop.icns';
export const TRAY_ICON_FILE = 'propr-tray.png';
export const DESKTOP_ICON_SIZE = 512;
export const TRAY_ICON_SIZE = 32;
export const CANONICAL_ARTWORK_SHA256 = 'be93a4380feff56fb89f3ee911413fa21cfa6f2fbbbaa2c44c1293f799edc829';
export const DESKTOP_ICON_SHA256 = '2fa41fd8ec51bc665d5251aa0953f75f6917555f46997fb24700a2d27dc7dc19';
export const MACOS_ICON_SHA256 = '32de388c73e8d1d90a54de8b42c8a9b22c0167e5c9a0099457024c71f0eb4a60';
export const TRAY_ICON_SHA256 = '404cf1e5ff527710cfad84b0a38efc873f874a2f27f72f4a0dcb05f3698c7353';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICNS_SIZES = Object.freeze(new Map([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]));
const ICNS_PIXEL_SHA256 = Object.freeze({
  icp4: '8befdd6c22b4baa95199ea8b3645030952d3cce695501dcd9b12de767ea75a89',
  icp5: 'a6b7ab21c6d279794f3259467da0108cf7de1909798efd8e30221ebb1f3367fe',
  icp6: 'b283f14671fa6a51c4c1e9378319c8f2cea32a0bc47c75161b69a906f24a0252',
  ic07: '9ea03adec62985c6a849a3655ccf18dbf39390128b70aa614a59b12ee029962b',
  ic08: '0ff104d9d3f6cf7bca2437bbc0dfce54d40bab7d94f443089c9947d3d9e01df2',
  ic09: 'b5b9d69eb6c34350826698d955a04cefecb7dc95401587682803c5076bce64da',
  ic10: '1aca9d70c815ffa9225a352356e6150384dc04effe41fb528dcc05ab58d51156',
});

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export const readPngSize = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 26 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new Error('Desktop icon is not a valid PNG image');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) throw new Error('Desktop icon PNG dimensions are invalid');
  return { width, height };
};

const inspectTransparentPngBytes = async (bytes, { label, size, minimumPadding }) => {
  const dimensions = readPngSize(bytes);
  if (dimensions.width !== size || dimensions.height !== size) {
    throw new Error(`${label} must be exactly ${size}x${size}`);
  }
  const metadata = await sharp(bytes).metadata();
  if (metadata.format !== 'png' || metadata.channels !== 4 || metadata.hasAlpha !== true) {
    throw new Error(`${label} must be an RGBA PNG`);
  }
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const cornerAlpha = [
    data[3],
    data[(info.width - 1) * 4 + 3],
    data[((info.height - 1) * info.width) * 4 + 3],
    data[(info.width * info.height - 1) * 4 + 3],
  ];
  if (cornerAlpha.some(alpha => alpha !== 0)) {
    throw new Error(`${label} outer corners must be fully transparent`);
  }
  let left = info.width;
  let top = info.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[(y * info.width + x) * 4 + 3] === 0) continue;
      left = Math.min(left, x);
      top = Math.min(top, y);
      right = Math.max(right, x);
      bottom = Math.max(bottom, y);
    }
  }
  if (right < left || bottom < top) throw new Error(`${label} contains no visible artwork`);
  const padding = {
    left,
    top,
    right: info.width - 1 - right,
    bottom: info.height - 1 - bottom,
  };
  if (Object.values(padding).some(value => value < minimumPadding)) {
    throw new Error(`${label} must preserve transparent outer padding`);
  }
  return { ...dimensions, cornerAlpha, padding };
};

export const verifyDesktopPngBytes = async (bytes, label = 'desktop icon') => {
  if (sha256(bytes) !== DESKTOP_ICON_SHA256) {
    throw new Error(`${label} does not match the generated transparent ProPR artwork`);
  }
  return inspectTransparentPngBytes(bytes, { label, size: DESKTOP_ICON_SIZE, minimumPadding: 60 });
};

export const verifyTrayPngBytes = async (bytes, label = 'desktop tray icon') => {
  if (sha256(bytes) !== TRAY_ICON_SHA256) {
    throw new Error(`${label} does not match the generated transparent ProPR tray artwork`);
  }
  return inspectTransparentPngBytes(bytes, { label, size: TRAY_ICON_SIZE, minimumPadding: 1 });
};

export const readIcnsPngEntries = bytes => {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 || bytes.toString('ascii', 0, 4) !== 'icns'
    || bytes.readUInt32BE(4) !== bytes.length) {
    throw new Error('macOS desktop icon is not a valid ICNS container');
  }
  const entries = new Map();
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 8 > bytes.length) throw new Error('macOS desktop icon has a truncated ICNS entry');
    const type = bytes.toString('ascii', offset, offset + 4);
    const length = bytes.readUInt32BE(offset + 4);
    if (length < 8 || offset + length > bytes.length || entries.has(type)) {
      throw new Error('macOS desktop icon has an invalid or duplicate ICNS entry');
    }
    entries.set(type, bytes.subarray(offset + 8, offset + length));
    offset += length;
  }
  return entries;
};

export const inspectIcnsBytes = bytes => {
  const entries = readIcnsPngEntries(bytes);
  if (entries.size !== ICNS_SIZES.size) throw new Error('macOS desktop icon has an incomplete native size set');
  for (const [type, size] of ICNS_SIZES) {
    const payload = entries.get(type);
    if (!payload) throw new Error(`macOS desktop icon is missing ${type}`);
    const dimensions = readPngSize(payload);
    if (dimensions.width !== size || dimensions.height !== size) {
      throw new Error(`macOS desktop icon ${type} must be exactly ${size}x${size}`);
    }
  }
  return Object.freeze(Object.fromEntries(ICNS_SIZES));
};

export const inspectIcnsPixelHashes = async bytes => {
  inspectIcnsBytes(bytes);
  const entries = readIcnsPngEntries(bytes);
  return Object.freeze(Object.fromEntries(await Promise.all([...ICNS_SIZES].map(async ([type]) => {
    const pixels = await sharp(entries.get(type)).ensureAlpha().raw().toBuffer();
    return [type, sha256(pixels)];
  }))));
};

export const verifyMacIconBytes = async (bytes, label = 'macOS desktop icon') => {
  const sizes = inspectIcnsBytes(bytes);
  if (sha256(bytes) !== MACOS_ICON_SHA256) {
    throw new Error(`${label} does not match the generated transparent ProPR artwork`);
  }
  const entries = readIcnsPngEntries(bytes);
  await Promise.all([...ICNS_SIZES].map(([type, size]) => inspectTransparentPngBytes(entries.get(type), {
    label: `${label} ${type}`,
    size,
    minimumPadding: Math.max(1, Math.floor(size / 8) - 1),
  })));
  const pixelHashes = await inspectIcnsPixelHashes(bytes);
  for (const [type, expected] of Object.entries(ICNS_PIXEL_SHA256)) {
    if (pixelHashes[type] !== expected) {
      throw new Error(`${label} ${type} decoded pixels do not match the generated transparent ProPR artwork`);
    }
  }
  return sizes;
};

export const verifyPackagedTrayIcon = async applicationResources => {
  const path = join(applicationResources, TRAY_ICON_FILE);
  await verifyTrayPngBytes(await readFile(path), 'packaged desktop tray icon');
  return path;
};

export const verifyPackagedLinuxIcon = async applicationRoot => {
  const path = join(applicationRoot, 'resources', DESKTOP_ICON_FILE);
  await verifyDesktopPngBytes(await readFile(path), 'packaged Linux runtime icon');
  return path;
};

export const verifyLinuxLauncherIcon = async ({ desktopFile, iconFile }) => {
  const desktop = await readFile(desktopFile, 'utf8');
  if (!/^Name=ProPR Desktop$/m.test(desktop)
    || !/^Exec=propr-desktop(?:\s+%U)?$/m.test(desktop)
    || !/^Icon=propr-desktop$/m.test(desktop)
    || !/^MimeType=.*x-scheme-handler\/propr;.*$/m.test(desktop)) {
    throw new Error('Linux package launcher branding or protocol declaration is invalid');
  }
  await verifyDesktopPngBytes(await readFile(iconFile), 'Linux package launcher icon');
};

export const verifyMacApplicationIcon = async ({ applicationRoot, readPlist }) => {
  const iconFile = await readPlist('CFBundleIconFile');
  // Electron Packager keeps the template's electron.icns name and replaces its bytes.
  // Treat the plist value as a resource reference; branding is established below by content.
  if (typeof iconFile !== 'string' || iconFile.length === 0 || basename(iconFile) !== iconFile
    || !iconFile.toLowerCase().endsWith('.icns')) {
    throw new Error('macOS application icon metadata does not reference a safe ICNS resource');
  }
  const path = join(applicationRoot, 'Contents', 'Resources', iconFile);
  await verifyMacIconBytes(await readFile(path), 'macOS application icon');
  return path;
};
