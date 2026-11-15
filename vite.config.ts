import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const SERVER = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  build: { outDir: '../../dist/client', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': SERVER,
      '/packs': SERVER,
      '/ws': { target: SERVER.replace('http', 'ws'), ws: true },
    },
  },
  test: { root: '.', include: ['tests/**/*.test.ts'] },
} as any);
