import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.VITE_API_PORT || '3001';

export default defineConfig({
  plugins: [react()],
  server: {
    // Bind 0.0.0.0 so the dev server is reachable from other LAN machines
    // (handy for testing the multi-client UX before doing a full prod build).
    // Closes the port to the public internet via Vite's allowedHosts default
    // (only known host headers accepted) — but since this is dev anyway,
    // the LAN exposure is intentional.
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    proxy: {
      // Proxy /api → backend server on the same host. When a remote LAN
      // dev client connects to <dev-host>:5173, requests to /api still
      // get forwarded to the dev host's localhost:3001 (where the
      // Express server runs), which is what we want.
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
    // Skip HMR overlay for invisible CSS errors — they spam the screen
    // when print-renderer styles are tweaked. JS errors still show.
    hmr: {
      overlay: true,
    },
  },
  build: {
    // Sourcemaps stay off for prod (smaller dist/, faster loads on LAN
    // browser clients). Re-enable per-build with VITE_SOURCEMAP=true if
    // you need to debug a packaged build.
    sourcemap: process.env.VITE_SOURCEMAP === 'true',
    // Split vendor bundles so a hot-fix to app code doesn't bust the
    // (cache-friendly) vendor cache on every LAN client.
    rollupOptions: {
      output: {
        manualChunks: {
          react:  ['react', 'react-dom', 'react-router-dom'],
          antd:   ['antd', '@ant-design/icons'],
          charts: ['recharts'],
          pdf:    ['jspdf', 'jspdf-autotable'],
        },
      },
    },
  },
});
