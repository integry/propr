import type { ForgeConfig } from '@electron-forge/shared-types';
import { MakerDeb } from '@electron-forge/maker-deb';
import { MakerRpm } from '@electron-forge/maker-rpm';
import { MakerSquirrel } from '@electron-forge/maker-squirrel';
import { MakerZIP } from '@electron-forge/maker-zip';
import { VitePlugin } from '@electron-forge/plugin-vite';
import { flipFuses, FuseV1Options, FuseVersion } from '@electron/fuses';
import { resolve } from 'node:path';

const config: ForgeConfig = {
  packagerConfig: {
    asar: true,
    executableName: 'propr-desktop',
  },
  rebuildConfig: {},
  hooks: {
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
        [FuseV1Options.LoadBrowserProcessSpecificV8Snapshot]: true,
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
