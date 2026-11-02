/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cross-origin isolation is required for SharedArrayBuffer, which the
// multi-threaded (pthreads) solver build needs. `--mode noiso` serves the
// same build without these headers to exercise the single-thread fallback.
// `--mode pages` is the GitHub Pages build: served from /volna/, without headers
// (Pages cannot set them), isolated by a service worker instead (src/platform/coi.ts).
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

export default defineConfig(({ mode }) => {
  const pages = mode === 'pages';
  const headers = mode === 'noiso' || pages ? {} : isolationHeaders;
  return {
    root: 'app',
    base: pages ? '/volna/' : '/',
    publicDir: 'public',
    plugins: [react()],
    server: { headers, port: 5173, strictPort: true },
    preview: { headers, port: pages ? 4175 : mode === 'noiso' ? 4174 : 4173, strictPort: true },
    build: { outDir: pages ? '../dist-pages' : '../dist', emptyOutDir: true, target: 'es2022', chunkSizeWarningLimit: 1500 },
    worker: { format: 'es' },
    test: { include: ['tests/**/*.test.ts'], environment: 'node' },
  };
});
