import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCompleteEnvironmentGroup,
  resolveDesktopVersion,
  resolveTrustedUpdateBuildConfig,
} from './src/release-config';

const desktopPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
) as { version: string };
const releaseVersion = resolveDesktopVersion(desktopPackage.version);
const updateConfig = resolveTrustedUpdateBuildConfig();
const macSigning = readCompleteEnvironmentGroup(
  process.env,
  ['PROPR_DESKTOP_MAC_SIGNING_IDENTITY'],
  'macOS signing',
);
const macNotarization = readCompleteEnvironmentGroup(
  process.env,
  [
    'PROPR_DESKTOP_APPLE_API_KEY_FILE',
    'PROPR_DESKTOP_APPLE_API_KEY_ID',
    'PROPR_DESKTOP_APPLE_API_ISSUER_ID',
  ],
  'macOS notarization',
);
const windowsSigning = readCompleteEnvironmentGroup(
  process.env,
  ['PROPR_DESKTOP_WINDOWS_CERTIFICATE_FILE', 'PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD'],
  'Windows signing',
);

if (macNotarization && !macSigning) {
  throw new Error('macOS notarization requires macOS signing configuration');
}
if (updateConfig.enabled) {
  if (process.platform === 'darwin' && !macSigning) {
    throw new Error('The macOS signed-update build must have a macOS signing identity');
  }
  if (process.platform === 'win32' && !windowsSigning) {
    throw new Error('The Windows signed-update build must have a Windows signing certificate');
  }
}

const windowsSign = windowsSigning ? {
  certificateFile: windowsSigning.PROPR_DESKTOP_WINDOWS_CERTIFICATE_FILE,
  certificatePassword: windowsSigning.PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD,
  description: 'ProPR Desktop',
} : undefined;

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    appBundleId: 'dev.propr.desktop',
    appCategoryType: 'public.app-category.developer-tools',
    appVersion: releaseVersion,
    buildVersion: releaseVersion,
    name: 'propr-desktop',
    executableName: 'propr-desktop',
    protocols: [{ name: 'ProPR Desktop', schemes: ['propr'] }],
    ...(macSigning ? {
      osxSign: {
        continueOnError: false,
        identity: macSigning.PROPR_DESKTOP_MAC_SIGNING_IDENTITY,
      },
    } : {}),
    ...(macNotarization ? {
      osxNotarize: {
        appleApiKey: macNotarization.PROPR_DESKTOP_APPLE_API_KEY_FILE,
        appleApiKeyId: macNotarization.PROPR_DESKTOP_APPLE_API_KEY_ID,
        appleApiIssuer: macNotarization.PROPR_DESKTOP_APPLE_API_ISSUER_ID,
      },
    } : {}),
    ...(windowsSign ? { windowsSign } : {}),
  },
  rebuildConfig: {},
  hooks: {
    readPackageJson: async (_forgeConfig, packageJson) => ({
      ...packageJson,
      version: releaseVersion,
    }),
    packageAfterCopy: async (_forgeConfig, resourcesPath, _electronVersion, platform, arch) => {
      const applePlatform = platform === 'darwin' || platform === 'mas';
      const executableName = applePlatform ? 'Electron' : `electron${platform === 'win32' ? '.exe' : ''}`;
      await flipFuses(resolve(resourcesPath, '..', '..', applePlatform ? 'MacOS' : '', executableName), {
        version: FuseVersion.V1,
        resetAdHocDarwinSignature: applePlatform && arch === 'arm64',
        strictlyRequireAllFuses: true,
        [FuseV1Options.RunAsNode]: false,
        [FuseV1Options.EnableCookieEncryption]: true,
        [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
        [FuseV1Options.EnableNodeCliInspectArguments]: false,
        [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
        [FuseV1Options.OnlyLoadAppFromAsar]: true,
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: false,
        [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
        [FuseV1Options.WasmTrapHandlers]: true,
      });
    },
  },
  makers: [
    new MakerSquirrel({
      name: 'propr_desktop',
      setupExe: `ProPR-Desktop-${releaseVersion}-Setup.exe`,
      version: releaseVersion,
      ...(windowsSign ? { windowsSign } : {}),
    }),
    new MakerZIP({}, ['darwin', 'linux']),
    ...(process.env.PROPR_DESKTOP_ENABLE_DEB === '1'
      ? [new MakerDeb({ options: { name: 'propr-desktop', productName: 'ProPR Desktop', version: releaseVersion } })]
      : []),
    ...(process.env.PROPR_DESKTOP_ENABLE_RPM === '1'
      ? [new MakerRpm({ options: { name: 'propr-desktop', productName: 'ProPR Desktop', version: releaseVersion } })]
      : []),
  ],
  plugins: [
    new VitePlugin({
      build: [
        { entry: 'src/main.ts', config: 'vite.main.config.ts' },
        { entry: 'src/preload.ts', config: 'vite.preload.config.ts' },
      ],
      renderer: [
        { name: 'main_window', config: 'vite.renderer.config.ts' },
      ],
    }),
  ],
};

export default config;
