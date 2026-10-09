import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:4174',
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 5181,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:4174',
    },
  },
})
