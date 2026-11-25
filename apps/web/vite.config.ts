import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

import { consoleUrl, deploymentProfile } from '../host/src/deployment.js'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        client: fileURLToPath(new URL('index.html', import.meta.url)),
        console: fileURLToPath(new URL('console/index.html', import.meta.url)),
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8080',
        bypass(_req, _res, options) {
          options.target = new URL(consoleUrl(deploymentProfile().read().active)).origin
        },
        changeOrigin: true,
      },
    },
  },
})
