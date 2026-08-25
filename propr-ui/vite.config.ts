/// <reference types="vitest" />
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Read the product version from the root package.json so the UI footer stays
// in sync with the published release version.
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8')
) as { version: string }

// The service worker is installed after the first page load, so route chunks
// fetched by that page are not yet under its control. Publish the complete
// build-time asset list so one successful visit is enough for an offline shell.
function pwaShellAssetManifest(): Plugin {
  return {
    name: 'propr-pwa-shell-asset-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets = Object.values(bundle)
        .map(output => `/${output.fileName}`)
        .filter(fileName => fileName.startsWith('/assets/') && !fileName.endsWith('.map'))
        .sort()
      this.emitFile({
        type: 'asset',
        fileName: 'pwa-shell-assets.json',
        source: JSON.stringify(assets),
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  plugins: [react(), pwaShellAssetManifest()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_URL,
        changeOrigin: true
      },
      '/socket.io': {
        target: process.env.VITE_API_URL,
        changeOrigin: true,
        ws: true
      }
    }
  },
  build: {
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'charts-vendor': ['recharts'],
          'markdown-vendor': ['react-markdown', 'remark-breaks', 'remark-gfm'],
          'motion-vendor': ['framer-motion'],
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
        },
      },
    },
  }
})
