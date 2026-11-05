import { defineConfig } from 'vite';
import { validateGithubClientId } from './src/github-client-config';
import { resolveTrustedUpdateBuildConfig } from './src/release-config';

const updateConfig = resolveTrustedUpdateBuildConfig();

export default defineConfig(({ command }) => ({
  define: {
    __PROPR_DESKTOP_GITHUB_CLIENT_ID__: JSON.stringify(command === 'build' ? validateGithubClientId(process.env.PROPR_DESKTOP_GITHUB_CLIENT_ID) : undefined),
    __PROPR_DESKTOP_UPDATE_MANIFEST_URL__: JSON.stringify(updateConfig.manifestUrl),
    __PROPR_DESKTOP_UPDATE_PUBLIC_KEY__: JSON.stringify(updateConfig.publicKey),
    __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__: JSON.stringify(updateConfig.signingIdentity),
    __PROPR_DESKTOP_WINDOWS_SIGNER_PINS__: JSON.stringify(updateConfig.windowsSignerPins),
  },
  build: {
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'main.cjs',
      },
    },
  },
}));
