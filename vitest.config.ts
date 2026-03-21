import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'client',
          environment: 'jsdom',
          include: ['tests/client/**/*.test.{ts,tsx}'],
          pool: 'forks',
          poolOptions: {
            forks: {
              maxForks: 1,
            },
          },
        },
      },
      {
        extends: true,
        test: {
          name: 'server',
          environment: 'node',
          include: [
            'src/**/*.test.{ts,tsx}',
            'tests/server/**/*.test.{ts,tsx}',
            'tests/integration/**/*.test.{ts,tsx}',
          ],
        },
      },
    ],
  },
});
