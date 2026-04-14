/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
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
    sourcemap: true
  }
})
