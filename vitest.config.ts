import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC is needed so Nest's decorator metadata (emitDecoratorMetadata) works under Vitest.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // The first integration run downloads/starts a mongod binary.
    hookTimeout: 120_000,
    testTimeout: 30_000,
  },
});
