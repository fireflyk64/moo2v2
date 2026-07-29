import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Standalone config (does not merge vite.config.ts): node-environment unit tests
// need the path aliases but not the svelte plugin or dev-server middleware.
const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@engine': r('./src/engine'),
      '@protocol': r('./src/protocol'),
      '@storage': r('./src/storage'),
      '@ui': r('./src/ui'),
      '@vendor': r('./vendor'),
    },
  },
  test: {
    environment: 'node',
    include: [
      'src/**/*.test.ts',
      'tests/unit/**/*.test.ts',
      'tests/data/**/*.test.ts',
      'tests/protocol/**/*.test.ts',
      'tests/storage/**/*.test.ts',
      'tests/determinism/**/*.test.ts',
      'tests/balance/**/*.test.ts',
    ],
    // The sandbox has 2 CPUs; keep contention low.
    maxWorkers: 2,
    // Full game-protocol loops (MemoryHub multi-seat games) measure ~1.6s in
    // isolation but stretch 3-4x under 2-core worker contention — the default
    // 5s cap turned pure wall-clock variance into "flaky" failures that could
    // mask real bugs (multibot timed out at 5s while behaviorally identical
    // across runs). 60s means only a genuine hang fails, and it still fails.
    testTimeout: 60_000,
  },
});
