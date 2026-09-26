import type { App } from 'electron';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MACOS_APP_NAME = 'ProPR';

export const configureMacOSBranding = (app: Pick<App, 'setAboutPanelOptions'>): void => {
  // Keep package.json productName (ProPR Desktop) as Electron's internal name.
  // Before ready, Electron derives the macOS safeStorage Keychain namespace
  // from app.getName(), independently of userData. Restoring paths after a
  // setName() cannot preserve encryption identity. Do not rename at any point:
  // visible branding belongs in menu labels, About and localized bundle names.
  app.setAboutPanelOptions({ applicationName: MACOS_APP_NAME });
};

export const brandMacOSPlist = (plist: string): string => {
  for (const [key, expected] of [
    ['CFBundleExecutable', 'propr-desktop'],
    ['CFBundleIdentifier', 'dev.propr.desktop'],
  ]) {
    if (!plist.includes(`<key>${key}</key>`) || !new RegExp(`<key>${key}</key>\\s*<string>${expected.replaceAll('.', '\\.')}</string>`).test(plist)) {
      throw new Error(`Unexpected macOS ${key}; refusing to change bundle identity`);
    }
  }
  // Finder treats a mismatch with the bundle filename as a user rename.
  // Keep the unlocalized names aligned with propr-desktop.app and provide the
  // visible name through InfoPlist.strings, as documented by Apple:
  // https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/CoreFoundationKeys.html
  for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
    const pattern = new RegExp(`(<key>${key}</key>\\s*<string>)[^<]*(</string>)`, 'g');
    if ([...plist.matchAll(pattern)].length !== 1) throw new Error(`Expected exactly one macOS ${key}`);
    plist = plist.replace(pattern, '$1propr-desktop$2');
  }
  return plist;
};

/** Packager overwrites extendInfo names; run after plist generation, before signing. */
export const brandMacOSPackage = async ({ buildPath, platform }: { buildPath: string; platform: string }): Promise<void> => {
  if (platform !== 'darwin') return;
  const path = join(buildPath, 'propr-desktop.app', 'Contents', 'Info.plist');
  await writeFile(path, brandMacOSPlist(await readFile(path, 'utf8')));
  const resources = join(buildPath, 'propr-desktop.app', 'Contents', 'Resources');
  await mkdir(resources, { recursive: true });
  const locales = new Set(['en.lproj', 'Base.lproj', ...(await readdir(resources)).filter(name => name.endsWith('.lproj'))]);
  for (const locale of locales) {
    const directory = join(resources, locale);
    await mkdir(directory, { recursive: true });
    const stringsPath = join(directory, 'InfoPlist.strings');
    let strings = '';
    try {
      const bytes = await readFile(stringsPath);
      strings = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString('utf16le') : bytes.toString('utf8');
      if (strings.startsWith('bplist') || strings.trimStart().startsWith('<?xml') || strings.includes('\0')) throw new Error('Unsupported InfoPlist.strings encoding');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    // Preserve other localized metadata, including any consent descriptions.
    strings = strings.replace(/^\s*"?CFBundle(?:Display)?Name"?\s*=\s*"(?:[^"\\]|\\.)*"\s*;\s*$/gm, '');
    await writeFile(stringsPath, `${strings.trim()}\nCFBundleName = "${MACOS_APP_NAME}";\nCFBundleDisplayName = "${MACOS_APP_NAME}";\n`);
  }
};
