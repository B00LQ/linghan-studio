import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The built bundle is served by the Studio server itself, so the dev server only
// needs to forward the API surfaces it owns.
const backend = process.env.STUDIO_SERVER ?? 'http://127.0.0.1:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/v1': { target: backend, changeOrigin: true },
      '/proxy': { target: backend, changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
})
