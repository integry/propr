import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readCompleteEnvironmentGroup,
  parseWindowsSignerPins,
  requireProductionReleaseConfiguration,
  resolveDesktopVersion,
  resolveTrustedUpdateBuildConfig,
} from './src/release-config';
const DESKTOP_EXECUTABLE_NAME = 'propr-desktop';

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
}
if (process.env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1') {
  const windowsSignerPins = process.platform === 'win32'
    ? parseWindowsSignerPins(process.env.PROPR_DESKTOP_WINDOWS_SIGNER_PINS)
    : [];
  requireProductionReleaseConfiguration({
    platform: process.platform,
    updateConfig,
    macSigning,
    macNotarization,
    windowsSigning,
    windowsSignerPins,
  });
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
    name: DESKTOP_EXECUTABLE_NAME,
    executableName: DESKTOP_EXECUTABLE_NAME,
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
    postMake: async (_forgeConfig, makeResults) => {
      if (process.platform !== 'win32') return makeResults;
      const installerModule = './scripts/build-windows-machine-installer.mjs';
      const { buildWindowsMachineInstaller } = await import(installerModule);
      for (const result of makeResults) {
        if (result.platform !== 'win32' || (result.arch !== 'x64' && result.arch !== 'arm64')) continue;
        const triggerArtifact = result.artifacts[0];
        if (!triggerArtifact) throw new Error('Windows make did not produce its private MSI build trigger');
        const machineInstaller = resolve(
          dirname(triggerArtifact),
          `ProPR-Desktop-${releaseVersion}-Machine-Setup.msi`,
        );
        const built = await buildWindowsMachineInstaller({
          appDirectory: resolve('out', `propr-desktop-win32-${result.arch}`),
          output: machineInstaller,
          version: releaseVersion,
          arch: result.arch,
        });
        if (built.skipped) throw new Error('Machine-wide Windows installer was not built');
        if (windowsSign) {
          const { sign } = await import('@electron/windows-sign');
          await sign({ files: [machineInstaller], ...windowsSign });
        }
        await Promise.all(result.artifacts.map(path => rm(path, { force: true })));
        result.artifacts = [machineInstaller];
      }
      return makeResults;
    },
  },
  makers: [
    // Forge requires a maker result before postMake. On Windows this ZIP is a
    // private build trigger only: postMake deletes it and returns exactly the
    // protected machine-wide MSI as the sole maker artifact.
    new MakerZIP({}, ['darwin', 'linux', 'win32']),
    ...(process.env.PROPR_DESKTOP_ENABLE_DEB === '1'
      ? [new MakerDeb({
        options: {
          name: DESKTOP_EXECUTABLE_NAME,
          productName: 'ProPR Desktop',
          version: releaseVersion,
          bin: DESKTOP_EXECUTABLE_NAME,
        },
      })]
      : []),
    ...(process.env.PROPR_DESKTOP_ENABLE_RPM === '1'
      ? [new MakerRpm({
        options: {
          name: DESKTOP_EXECUTABLE_NAME,
          productName: 'ProPR Desktop',
          version: releaseVersion,
          bin: DESKTOP_EXECUTABLE_NAME,
        },
      })]
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
