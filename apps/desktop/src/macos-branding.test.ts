import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { brandMacOSPackage, brandMacOSPlist, configureMacOSBranding } from './macos-branding';

const original = `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>propr-desktop</string>
<key>CFBundleIdentifier</key><string>dev.propr.desktop</string>
<key>CFBundleName</key><string>propr-desktop</string>
<key>CFBundleDisplayName</key><string>propr-desktop</string>
<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>propr</string></array></dict></array>
<key>ElectronAsarIntegrity</key><dict><key>Resources/app.asar</key><dict><key>hash</key><string>0123456789</string></dict></dict>
</dict></plist>`;

it('localizes visible names, preserving bundle paths, identity, deep links and ASAR integrity', async () => {
  const branded = brandMacOSPlist(original);
  assert.equal(branded, original);
  assert.equal(brandMacOSPlist(branded), branded);
  assert.throws(() => brandMacOSPlist(original.replace('dev.propr.desktop', 'another.app')));
  assert.throws(() => brandMacOSPlist(original.replace('CFBundleDisplayName', 'MissingName')));
  const root = await mkdtemp(join(tmpdir(), 'propr-branding-'));
  try {
    const contents = join(root, 'propr-desktop.app', 'Contents');
    await mkdir(contents, { recursive: true });
    const path = join(contents, 'Info.plist');
    await writeFile(path, original);
    const locale = join(contents, 'Resources', 'fr.lproj');
    await mkdir(locale, { recursive: true });
    await writeFile(join(locale, 'InfoPlist.strings'), 'CFBundleName = "Electron";\nNSMicrophoneUsageDescription = "Existing consent text";\n');
    await brandMacOSPackage({ buildPath: root, platform: 'linux' });
    assert.equal(await readFile(path, 'utf8'), original);
    await brandMacOSPackage({ buildPath: root, platform: 'darwin' });
    assert.equal(await readFile(path, 'utf8'), branded);
    for (const language of ['en', 'Base', 'fr']) {
      const strings = await readFile(join(contents, 'Resources', `${language}.lproj`, 'InfoPlist.strings'), 'utf8');
      assert.match(strings, /CFBundleName = "ProPR";/);
      assert.match(strings, /CFBundleDisplayName = "ProPR";/);
      assert.ok(!strings.includes('Electron'));
      if (language === 'fr') assert.ok(strings.includes('Existing consent text'));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('brands About without accessing the internal name or data paths', () => {
  let about: unknown;
  configureMacOSBranding(new Proxy({
    setAboutPanelOptions(value) { about = value; },
  }, {
    get(target, key, receiver) {
      assert.equal(key, 'setAboutPanelOptions', 'Branding must only use presentation APIs');
      return Reflect.get(target, key, receiver);
    },
    set() { assert.fail('Branding must not mutate app properties'); },
  }));
  assert.deepEqual(about, { applicationName: 'ProPR' });
});

it('keeps the shipped productName as the legacy encryption identity', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.productName, 'ProPR Desktop');
});

it('registers branding before packager signing and leaves the final signing hook last', () => {
  const config = readFileSync(new URL('../forge.config.ts', import.meta.url), 'utf8');
  assert.match(config, /afterCopyExtraResources: \[brandMacOSPackage\]/);
  const packager = readFileSync(new URL('../../../node_modules/@electron/packager/dist/mac.js', import.meta.url), 'utf8');
  const create = packager.slice(packager.indexOf('async create()'));
  assert.ok(create.indexOf('updatePlistFiles()') < create.indexOf('copyExtraResources()'));
  assert.ok(create.indexOf('copyExtraResources()') < create.indexOf('signAppIfSpecified()'));
  assert.match(config, /await finalizeDarwinLocalPackages\([\s\S]*?\);\s*},\s*postMake/);
});
