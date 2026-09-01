import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { chmodSync, copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const connectNativePrebuilds = fileURLToPath(new URL('../../packages/cli/native/prebuilds', import.meta.url));
const connectOrchestrator = fileURLToPath(new URL('../../packages/cli/dist/orchestrator', import.meta.url));

const packagedConnectNativeArtifacts = (platform: string, arch: string): string[] => {
  if (platform === 'darwin' || platform === 'mas') {
    return [
      `${platform === 'mas' ? 'darwin' : platform}-${arch}/directory-operations.node`,
      `${platform === 'mas' ? 'darwin' : platform}-${arch}/connect-authority-broker`,
    ];
  }
  if (platform === 'linux') return [`linux-${arch}/directory-operations.node`];
  return [];
};

const config: ForgeConfig = {
  packagerConfig: {
    asar: { unpack: '**/.vite/native/prebuilds/**' },
    name: 'propr-desktop',
    executableName: 'propr-desktop',
  },
  rebuildConfig: {},
  hooks: {
    packageAfterCopy: async (_forgeConfig, resourcesPath, _electronVersion, platform, arch) => {
      for (const relativeArtifact of packagedConnectNativeArtifacts(platform, arch)) {
        const target = resolve(resourcesPath, '.vite/native/prebuilds', relativeArtifact);
        mkdirSync(dirname(target), { recursive: true });
        const source = resolve(connectNativePrebuilds, relativeArtifact);
        copyFileSync(source, target);
        if (platform !== 'win32') chmodSync(target, statSync(source).mode & 0o777);
      }
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
  },
  makers: [
    new MakerSquirrel({ name: 'propr_desktop' }),
    new MakerZIP({}, ['darwin', 'linux']),
    ...(process.env.PROPR_DESKTOP_ENABLE_DEB === '1' ? [new MakerDeb({})] : []),
    ...(process.env.PROPR_DESKTOP_ENABLE_RPM === '1' ? [new MakerRpm({})] : []),
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
