import { defineConfig } from 'vite';
import { resolveTrustedUpdateBuildConfig } from './src/release-config';

const updateConfig = resolveTrustedUpdateBuildConfig();

export default defineConfig({
  define: {
    __PROPR_DESKTOP_UPDATE_MANIFEST_URL__: JSON.stringify(updateConfig.manifestUrl),
    __PROPR_DESKTOP_UPDATE_PUBLIC_KEY__: JSON.stringify(updateConfig.publicKey),
    __PROPR_DESKTOP_UPDATE_SIGNING_IDENTITY__: JSON.stringify(updateConfig.signingIdentity),
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
});
