import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // relative base so the build works on any static host (and sub-paths)
  base: './',
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 30000,
  },
});
