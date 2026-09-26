import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        format: 'cjs',
        entryFileNames: 'preload.cjs',
      },
    },
  },
});
