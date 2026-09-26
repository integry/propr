import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import sharp from 'sharp';
import {
  CANONICAL_ARTWORK_SHA256,
  DESKTOP_ICON_FILE,
  DESKTOP_ICON_SHA256,
  inspectIcnsBytes,
  inspectIcnsPixelHashes,
  MACOS_ICON_FILE,
  MACOS_ICON_SHA256,
  readIcnsPngEntries,
  sha256,
  TRAY_ICON_FILE,
  TRAY_ICON_SHA256,
  verifyDesktopPngBytes,
  verifyLinuxLauncherIcon,
  verifyMacApplicationIcon,
  verifyMacIconBytes,
  verifyPackagedLinuxIcon,
  verifyPackagedTrayIcon,
  verifyTrayPngBytes,
} from './desktop-icon-assets.mjs';
import { buildDesktopIcons } from './generate-desktop-icons.mjs';

const iconDirectory = new URL('../assets/icons/', import.meta.url);
const canonicalArtwork = new URL('../../../media/logo-only-large.png', import.meta.url);
const hostedPwaArtwork = new URL('../../../propr-ui/public/icons/pwa-512x512.png', import.meta.url);
const hostedPwaSha256 = 'e66a28f489d5367e08b1b49b1b98b10dd0a29a4e424e38c0684be9513baa7726';
const icnsSizes = Object.freeze(new Map([
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
]));
const icnsPixelHashes = Object.freeze({
  icp4: '8befdd6c22b4baa95199ea8b3645030952d3cce695501dcd9b12de767ea75a89',
  icp5: 'a6b7ab21c6d279794f3259467da0108cf7de1909798efd8e30221ebb1f3367fe',
  icp6: 'b283f14671fa6a51c4c1e9378319c8f2cea32a0bc47c75161b69a906f24a0252',
  ic07: '9ea03adec62985c6a849a3655ccf18dbf39390128b70aa614a59b12ee029962b',
  ic08: '0ff104d9d3f6cf7bca2437bbc0dfce54d40bab7d94f443089c9947d3d9e01df2',
  ic09: 'b5b9d69eb6c34350826698d955a04cefecb7dc95401587682803c5076bce64da',
  ic10: '1aca9d70c815ffa9225a352356e6150384dc04effe41fb528dcc05ab58d51156',
});

const assertTransparentCorners = async (bytes, size) => {
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.width, size);
  assert.equal(metadata.height, size);
  assert.equal(metadata.channels, 4);
  assert.equal(metadata.hasAlpha, true);
  const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  assert.deepEqual([
    data[3],
    data[(info.width - 1) * 4 + 3],
    data[((info.height - 1) * info.width) * 4 + 3],
    data[(info.width * info.height - 1) * 4 + 3],
  ], [0, 0, 0, 0]);
};

const readPixel = async (bytes, x, y, background) => {
  const pipeline = sharp(bytes);
  if (background) pipeline.flatten({ background });
  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true });
  const offset = (y * info.width + x) * info.channels;
  return [...data.subarray(offset, offset + info.channels)];
};

const compositeStraightAlpha = (rgba, background) => rgba.slice(0, 3).map((channel, index) => Math.floor(
  (channel * rgba[3] + background[index] * (255 - rgba[3])) / 255,
));

const buildAlternateValidIcns = async () => {
  const entries = await Promise.all([...icnsSizes].map(async ([type, size]) => {
    const png = await sharp({
      create: {
        width: size,
        height: size,
        channels: 4,
        background: '#000000',
      },
    }).png().toBuffer();
    const header = Buffer.alloc(8);
    header.write(type, 0, 4, 'ascii');
    header.writeUInt32BE(header.length + png.length, 4);
    return Buffer.concat([header, png]);
  }));
  const header = Buffer.alloc(8);
  header.write('icns', 0, 4, 'ascii');
  header.writeUInt32BE(header.length + entries.reduce((total, entry) => total + entry.length, 0), 4);
  return Buffer.concat([header, ...entries]);
};

describe('desktop native icon assets', () => {
  it('wires transparent native and tray assets into Forge, runtime creation, and package checks', async () => {
    const [forge, main, workflow, smoke] = await Promise.all([
      readFile(new URL('../forge.config.ts', import.meta.url), 'utf8'),
      readFile(new URL('../src/main.ts', import.meta.url), 'utf8'),
      readFile(new URL('../../../.github/workflows/desktop-release-guard.yml', import.meta.url), 'utf8'),
      readFile(new URL('./smoke-packaged.mjs', import.meta.url), 'utf8'),
    ]);
    assert.match(forge, /process\.platform === 'darwin' \? \{ icon: desktopMacIcon \} : \{\}/);
    assert.equal(forge.match(/icon: desktopLinuxIcon/g)?.length, 2);
    assert.match(
      forge,
      /extraResource: \[\s*desktopTrayIcon,\s*\.\.\.\(process\.platform === 'linux' \? \[\s*desktopLinuxIcon,/,
    );
    assert.doesNotMatch(forge, /pwa-512x512|logo-only-small/);
    assert.match(main, /loadDesktopWindowIcon/);
    assert.match(main, /desktopWindowIcon\?\.image/);
    assert.match(main, /createDesktopNotificationOptions/);
    assert.match(main, /iconPath: desktopWindowIcon\?\.path/);
    assert.match(main, /resolveDesktopTrayIconPath/);
    assert.match(smoke, /verifyPackagedLinuxIcon/);
    assert.match(smoke, /verifyPackagedTrayIcon/);
    assert.equal(workflow.match(/icons:verify-packaged/g)?.length, 2);
  });

  it('reproducibly derives transparent assets from the pinned canonical logo-only artwork', async () => {
    const generated = await buildDesktopIcons();
    const [source, pwa, png, icns, tray] = await Promise.all([
      readFile(canonicalArtwork),
      readFile(hostedPwaArtwork),
      readFile(new URL(DESKTOP_ICON_FILE, iconDirectory)),
      readFile(new URL(MACOS_ICON_FILE, iconDirectory)),
      readFile(new URL(TRAY_ICON_FILE, iconDirectory)),
    ]);
    assert.equal(sha256(source), CANONICAL_ARTWORK_SHA256);
    assert.equal(sha256(pwa), hostedPwaSha256);
    assert.equal((await sharp(source).metadata()).hasAlpha, true);
    assert.equal((await sharp(pwa).metadata()).hasAlpha, false);
    assert.equal(sha256(png), DESKTOP_ICON_SHA256);
    assert.equal(sha256(icns), MACOS_ICON_SHA256);
    assert.equal(sha256(tray), TRAY_ICON_SHA256);
    assert.equal(png.equals(pwa), false);

    const desktopInspection = await verifyDesktopPngBytes(png);
    assert.deepEqual(desktopInspection.cornerAlpha, [0, 0, 0, 0]);
    assert.deepEqual(desktopInspection.padding, { left: 114, top: 64, right: 114, bottom: 64 });
    const trayInspection = await verifyTrayPngBytes(tray);
    assert.deepEqual(trayInspection.cornerAlpha, [0, 0, 0, 0]);
    assert.deepEqual(trayInspection.padding, { left: 5, top: 2, right: 6, bottom: 2 });
    assert.deepEqual(await verifyMacIconBytes(icns), Object.fromEntries(icnsSizes));
    assert.deepEqual(inspectIcnsBytes(icns), Object.fromEntries(icnsSizes));
    assert.deepEqual(await inspectIcnsPixelHashes(icns), icnsPixelHashes);
    assert.deepEqual(await inspectIcnsPixelHashes(generated.icns), icnsPixelHashes);
    const generatedEntries = readIcnsPngEntries(generated.icns);
    for (const [type, payload] of readIcnsPngEntries(icns)) {
      await assertTransparentCorners(payload, icnsSizes.get(type));
      assert.equal(payload.equals(generatedEntries.get(type)), true);
    }
    assert.equal(png.equals(generated.png), true);
    assert.equal(icns.equals(generated.icns), true);
    assert.equal(tray.equals(generated.tray), true);
  });

  it('generates identical bytes regardless of the caller SIMD setting', async () => {
    const originalSimd = sharp.simd();
    try {
      sharp.simd(true);
      const enabledCallerSetting = sharp.simd();
      const generatedWithSimdEnabled = await buildDesktopIcons();
      assert.equal(sharp.simd(), enabledCallerSetting);

      sharp.simd(false);
      const generatedWithSimdDisabled = await buildDesktopIcons();
      assert.equal(sharp.simd(), false);

      assert.equal(generatedWithSimdEnabled.png.equals(generatedWithSimdDisabled.png), true);
      assert.equal(generatedWithSimdEnabled.icns.equals(generatedWithSimdDisabled.icns), true);
      assert.equal(generatedWithSimdEnabled.tray.equals(generatedWithSimdDisabled.tray), true);
    } finally {
      sharp.simd(originalSimd);
    }
  });

  it('preserves canonical straight-alpha edge color on light and dark previews', async () => {
    const png = await readFile(new URL(DESKTOP_ICON_FILE, iconDirectory));
    // Representative antialiased mark pixel. The old premultiplied:true path
    // incorrectly expanded this straight-alpha RGB from [0, 102, 78] to
    // [0, 255, 205] while leaving alpha at 97.
    const sample = { x: 236, y: 187, rgba: [0, 102, 78, 97] };
    assert.deepEqual(await readPixel(png, sample.x, sample.y), sample.rgba);

    for (const { background, expected } of [
      { background: [244, 244, 245], expected: [151, 189, 181] },
      { background: [31, 35, 42], expected: [19, 60, 55] },
    ]) {
      const previewPixel = await readPixel(png, sample.x, sample.y, {
        r: background[0],
        g: background[1],
        b: background[2],
      });
      assert.deepEqual(previewPixel, compositeStraightAlpha(sample.rgba, background));
      assert.deepEqual(previewPixel, expected);
    }
  });

  it('verifies packaged Linux window, launcher, and tray icon surfaces', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-icon-linux-'));
    try {
      const applicationRoot = join(root, 'usr', 'lib', 'propr-desktop');
      const resources = join(applicationRoot, 'resources');
      const applications = join(root, 'usr', 'share', 'applications');
      const pixmaps = join(root, 'usr', 'share', 'pixmaps');
      await Promise.all([mkdir(resources, { recursive: true }), mkdir(applications, { recursive: true }), mkdir(pixmaps, { recursive: true })]);
      const [desktopIcon, trayIcon] = await Promise.all([
        readFile(new URL(DESKTOP_ICON_FILE, iconDirectory)),
        readFile(new URL(TRAY_ICON_FILE, iconDirectory)),
      ]);
      await Promise.all([
        writeFile(join(resources, DESKTOP_ICON_FILE), desktopIcon),
        writeFile(join(resources, TRAY_ICON_FILE), trayIcon),
        writeFile(join(pixmaps, DESKTOP_ICON_FILE), desktopIcon),
        writeFile(join(applications, 'propr-desktop.desktop'), [
          '[Desktop Entry]',
          'Name=ProPR Desktop',
          'Exec=propr-desktop %U',
          'Icon=propr-desktop',
          'MimeType=x-scheme-handler/propr;',
        ].join('\n')),
      ]);
      assert.equal(await verifyPackagedLinuxIcon(applicationRoot), join(resources, DESKTOP_ICON_FILE));
      assert.equal(await verifyPackagedTrayIcon(resources), join(resources, TRAY_ICON_FILE));
      await assert.doesNotReject(verifyLinuxLauncherIcon({
        desktopFile: join(applications, 'propr-desktop.desktop'),
        iconFile: join(pixmaps, DESKTOP_ICON_FILE),
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('follows Electron Packager macOS metadata and requires transparent canonical ICNS bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'propr-icon-macos-'));
    try {
      const resources = join(root, 'ProPR.app', 'Contents', 'Resources');
      const emittedIconFile = 'electron.icns';
      await mkdir(resources, { recursive: true });
      await Promise.all([
        writeFile(join(resources, emittedIconFile), await readFile(new URL(MACOS_ICON_FILE, iconDirectory))),
        writeFile(join(resources, TRAY_ICON_FILE), await readFile(new URL(TRAY_ICON_FILE, iconDirectory))),
      ]);
      const path = await verifyMacApplicationIcon({
        applicationRoot: join(root, 'ProPR.app'),
        readPlist: async key => {
          assert.equal(key, 'CFBundleIconFile');
          return emittedIconFile;
        },
      });
      assert.equal(path, join(resources, emittedIconFile));
      assert.equal(await verifyPackagedTrayIcon(resources), join(resources, TRAY_ICON_FILE));

      const alternate = await buildAlternateValidIcns();
      assert.deepEqual(inspectIcnsBytes(alternate), Object.fromEntries(icnsSizes));
      await writeFile(join(resources, emittedIconFile), alternate);
      await assert.rejects(verifyMacApplicationIcon({
        applicationRoot: join(root, 'ProPR.app'),
        readPlist: async () => emittedIconFile,
      }), /does not match the generated transparent ProPR artwork/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
