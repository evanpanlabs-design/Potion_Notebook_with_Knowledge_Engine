import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5174,
    proxy: {
      '/api': { target: 'http://127.0.0.1:3100', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '/api/v1') },
    },
  },
})
