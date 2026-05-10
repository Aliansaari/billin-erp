import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';

const API_PORT = process.env.VITE_API_PORT || '3001';

// Capacitor's webDir loader expects an index.html at the root. Our entry is
// index.mobile.html (so it can sit next to the desktop index.html during dev
// without colliding). After Vite finishes the build, rename the emitted
// index.mobile.html → index.html so Capacitor finds it.
function renameMobileEntry() {
  return {
    name: 'rename-mobile-entry',
    apply: 'build',
    closeBundle() {
      const dir = path.resolve('dist-mobile');
      const src = path.join(dir, 'index.mobile.html');
      const dst = path.join(dir, 'index.html');
      if (fs.existsSync(src)) {
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        fs.renameSync(src, dst);
      }
    },
  };
}

function mobileHistoryFallback() {
  return {
    name: 'mobile-history-fallback',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url || '';
        if (
          req.method === 'GET' &&
          !url.startsWith('/api') &&
          !url.startsWith('/@') &&
          !url.startsWith('/node_modules') &&
          !url.startsWith('/src') &&
          !url.includes('.') &&
          req.headers.accept?.includes('text/html')
        ) {
          req.url = '/index.mobile.html';
        }
        next();
      });
    },
  };
}

export default defineConfig({
  // Relative asset URLs so the same dist-mobile/ works under capacitor:// /
  // file:// (native shell) AND under http(s):// (browser preview).
  base: './',
  publicDir: 'public-mobile',
  plugins: [react(), mobileHistoryFallback(), renameMobileEntry()],
  build: {
    outDir: 'dist-mobile',
    emptyOutDir: true,
    rollupOptions: {
      input: 'index.mobile.html',
      output: {
        manualChunks: {
          react:         ['react', 'react-dom', 'react-router-dom'],
          'antd-mobile': ['antd-mobile'],
        },
      },
    },
    sourcemap: process.env.VITE_SOURCEMAP === 'true',
  },
  server: {
    // 0.0.0.0 so the phone on the same Wi-Fi can hit the dev server.
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '5174', 10),
    strictPort: false,
    open: '/index.mobile.html',
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
