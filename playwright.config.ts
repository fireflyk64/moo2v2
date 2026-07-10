import { defineConfig } from '@playwright/test';

// Uses the system Chrome (channel) to avoid a browser download; --no-sandbox and
// --disable-dev-shm-usage are required inside this dev sandbox. The second web
// server is the local lobbylink signaling server (Go) for real-WebRTC tests.
export default defineConfig({
  testDir: 'e2e',
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  retries: 0,
  reporter: [['list']],
  use: {
    channel: 'chrome',
    headless: true,
    launchOptions: {
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    },
    baseURL: 'http://localhost:5173',
  },
  webServer: [
    {
      command: 'npm run dev',
      url: 'http://localhost:5173',
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'bash scripts/run-lobby-server.sh',
      url: 'http://127.0.0.1:8787/healthz',
      reuseExistingServer: true,
      timeout: 180_000, // first run downloads the Go toolchain
    },
    {
      // the PRODUCTION bundle served statically — solo.spec proves the game
      // runs from it with no lobby/PBM server at all
      command: 'npm run build && npm run preview',
      url: 'http://localhost:4173',
      reuseExistingServer: true,
      timeout: 120_000,
    },
  ],
});
