import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const rootPackage = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(rootPackage.version),
    __PROPR_DESKTOP__: 'true',
  },
  plugins: [react()],
  publicDir: '../../propr-ui/public',
  build: {
    sourcemap: true,
    rollupOptions: {
      input: 'renderer.html',
      output: {
        manualChunks: {
          'charts-vendor': ['recharts'],
          'markdown-vendor': ['react-markdown', 'remark-breaks', 'remark-gfm'],
          'motion-vendor': ['framer-motion'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  },
});
