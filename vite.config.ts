import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
} as any);
