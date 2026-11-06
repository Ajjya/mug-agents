import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is needed so Nest's decorator metadata (emitDecoratorMetadata) works under Vitest.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    environment: 'node',
    // Only integration tests need a mongod; unit-only runs skip starting one.
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['test/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          globalSetup: ['test/support/global-setup.ts'],
          // The first run downloads a mongod binary.
          hookTimeout: 180_000,
          testTimeout: 30_000,
        },
      },
    ],
  },
});
