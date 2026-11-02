import { defineConfig, devices } from '@playwright/test';

// The e2e suite runs against the production builds (`npm run e2e` builds first),
// served with cross-origin isolation headers (4173), without them (4174), and
// the GitHub Pages build under its subfolder, also without them (4175).
export default defineConfig({
  testDir: 'app/e2e',
  timeout: 60_000,
  fullyParallel: false,
  // One worker: the solver specs run 8-thread wasm simulations, and running
  // spec files side by side starves the CAD import and the runs of cores.
  workers: 1,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'npx vite preview', url: 'http://localhost:4173', reuseExistingServer: false },
    { command: 'npx vite preview --mode noiso', url: 'http://localhost:4174', reuseExistingServer: false },
    { command: 'npx vite preview --mode pages', url: 'http://localhost:4175/volna/', reuseExistingServer: false },
  ],
});
