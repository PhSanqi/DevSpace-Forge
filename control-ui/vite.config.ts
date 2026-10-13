import { defineConfig } from 'vite';

export default defineConfig({
  base: '/next/',
  server: { host: '127.0.0.1', proxy: { '/api': 'http://127.0.0.1:7678' } },
  build: { outDir: 'dist', emptyOutDir: true }
});
