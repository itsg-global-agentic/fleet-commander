import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environmentMatchGlobs: [
      ['tests/client/**', 'jsdom'],
    ],
    setupFiles: ['tests/client/setup.ts'],
    include: [
      'tests/client/**/*.test.{ts,tsx}',
      'tests/server/**/*.test.{ts,tsx}',
      'tests/integration/**/*.test.{ts,tsx}',
      'src/**/*.test.{ts,tsx}',
    ],
    pool: 'forks',
    logHeapUsage: true,
    teardownTimeout: 1000,
    poolOptions: {
      forks: {
        maxForks: 1,
      },
    },
  },
});
