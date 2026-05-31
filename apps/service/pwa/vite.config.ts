import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Dev: proxy the API + SSE to the HTTPS service so the browser stays same-origin
// (no CORS). Prod: the Fastify service serves this build (same origin).
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Secretary',
        short_name: 'Secretary',
        description: 'Locally-run AI email assistant',
        display: 'standalone',
        start_url: '/needs-attention',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
      },
      workbox: {
        navigateFallback: '/index.html',
        globPatterns: ['**/*.{js,css,html,svg}'],
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api/v1': { target: 'https://localhost:47824', changeOrigin: true, secure: false },
    },
  },
  build: { outDir: 'dist' },
});
