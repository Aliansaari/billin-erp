import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.VITE_API_PORT || '3001';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${API_PORT}`,
        changeOrigin: true,
      },
    },
  },
});
