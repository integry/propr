import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROPR_API_COMPATIBILITY } from '@propr/shared';
import {
  readCompleteEnvironmentGroup,
  parseWindowsSignerPins,
  requireProductionReleaseConfiguration,
  resolveDesktopVersion,
  resolveTrustedUpdateBuildConfig,
} from './src/release-config';
import {
  normalizeDesktopRuntimeManifestMode,
  readDesktopRuntimeManifest,
} from './scripts/desktop-runtime-manifest.mjs';
import { brandMacOSPackage } from './src/macos-branding';
import { DESKTOP_MICROPHONE_USAGE_DESCRIPTION } from './src/microphone-consent';
import { copyPackagedNativeAuthority } from './src/package-native-authority';
import { ProprMakerRpm } from './src/rpm-maker';

const DESKTOP_EXECUTABLE_NAME = 'propr-desktop';
const desktopIconDirectory = fileURLToPath(new URL('./assets/icons', import.meta.url));
const desktopLinuxIcon = resolve(desktopIconDirectory, 'propr-desktop.png');
const desktopMacIcon = resolve(desktopIconDirectory, 'propr-desktop.icns');
const desktopTrayIcon = resolve(desktopIconDirectory, 'propr-tray.png');

const connectNativePrebuilds = fileURLToPath(new URL('../../packages/cli/native/prebuilds', import.meta.url));
const connectOrchestrator = fileURLToPath(new URL('../../packages/cli/dist/orchestrator', import.meta.url));
const setupAssets = fileURLToPath(new URL('../../packages/cli/dist/assets', import.meta.url));
const configuredRuntimeManifest = process.env.PROPR_DESKTOP_RUNTIME_MANIFEST?.trim();
if (process.env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1' && !configuredRuntimeManifest) {
  throw new Error('Production desktop releases require an aligned published runtime manifest');
}
const desktopRuntimeManifest = configuredRuntimeManifest
  ? resolve(configuredRuntimeManifest)
  : resolve(connectOrchestrator, 'manifest.json');
if (basename(desktopRuntimeManifest) !== 'manifest.json') {
  throw new Error('PROPR_DESKTOP_RUNTIME_MANIFEST must name a manifest.json file');
}
if (configuredRuntimeManifest) {
  readDesktopRuntimeManifest(desktopRuntimeManifest, {
    apiCompatibility: PROPR_API_COMPATIBILITY,
    ...(process.env.PROPR_DESKTOP_RELEASE_SHA
      ? { sourceRevision: process.env.PROPR_DESKTOP_RELEASE_SHA }
      : {}),
    ...(process.env.PROPR_DESKTOP_PRODUCTION_RELEASE === '1'
      ? { distribution: 'published' as const }
      : {}),
  });
}
const linuxSetupResources = process.platform === 'linux'
  ? {
      afterCopyExtraResources: [({ buildPath, platform }: { buildPath: string; platform: string }) => {
        if (platform === 'linux') {
          normalizeDesktopRuntimeManifestMode(resolve(buildPath, 'resources', 'manifest.json'));
        }
      }],
    }
  : {};

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
  { opaqueNames: ['PROPR_DESKTOP_WINDOWS_CERTIFICATE_PASSWORD'] },
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
    asar: { unpack: '**/.vite/native/prebuilds/**' },
    extraResource: [
      desktopTrayIcon,
      ...(process.platform === 'linux' ? [
        desktopLinuxIcon,
        resolve(connectOrchestrator, 'orchestrator.mjs'),
        desktopRuntimeManifest,
        setupAssets,
      ] : []),
    ],
    ...linuxSetupResources,
    ...(process.platform === 'darwin' ? { afterCopyExtraResources: [brandMacOSPackage] } : {}),
    appBundleId: 'dev.propr.desktop',
    extendInfo: {
      NSMicrophoneUsageDescription: DESKTOP_MICROPHONE_USAGE_DESCRIPTION,
      ...(process.platform === 'darwin' ? { CFBundleDevelopmentRegion: 'en' } : {}),
    },
    appCategoryType: 'public.app-category.developer-tools',
    appVersion: releaseVersion,
    buildVersion: releaseVersion,
    name: DESKTOP_EXECUTABLE_NAME,
    executableName: DESKTOP_EXECUTABLE_NAME,
    protocols: [{ name: 'ProPR Desktop', schemes: ['propr'] }],
    ...(process.platform === 'darwin' ? { icon: desktopMacIcon } : {}),
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
      copyPackagedNativeAuthority({
        arch,
        platform,
        resourcesPath,
        sourceRoot: connectNativePrebuilds,
      });
      const packagedOrchestrator = resolve(resourcesPath, '.vite/build');
      mkdirSync(packagedOrchestrator, { recursive: true });
      for (const asset of ['orchestrator.mjs', 'manifest.json']) {
        copyFileSync(resolve(connectOrchestrator, asset), resolve(packagedOrchestrator, basename(asset)));
      }
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
    postPackage: async (_forgeConfig, packageResult) => {
      // Run after final plist/icon/ASAR-integrity changes, before ZIP/DMG makers.
      // The earlier fuse signature reset only covers an intermediate bundle.
      const signingModule = './scripts/sign-darwin-local-package.mjs';
      const { finalizeDarwinLocalPackages } = await import(signingModule);
      await finalizeDarwinLocalPackages({
        ...packageResult,
        signingIdentity: macSigning?.PROPR_DESKTOP_MAC_SIGNING_IDENTITY,
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
          wixDirectory: process.env.PROPR_DESKTOP_WIX_DIRECTORY,
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
          icon: desktopLinuxIcon,
          mimeType: ['x-scheme-handler/propr'],
        },
      })]
      : []),
    ...(process.env.PROPR_DESKTOP_ENABLE_RPM === '1'
      ? [new ProprMakerRpm({
        options: {
          name: DESKTOP_EXECUTABLE_NAME,
          productName: 'ProPR Desktop',
          version: releaseVersion,
          bin: DESKTOP_EXECUTABLE_NAME,
          icon: desktopLinuxIcon,
          mimeType: ['x-scheme-handler/propr'],
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
