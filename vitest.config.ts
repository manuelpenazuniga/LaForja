import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Codex-owned suites are marked `.skip` with executable spec bodies until
    // implemented. CI stays green; skipped
    // tests double as the punch-list. Unskip as each stub is filled.
    passWithNoTests: false,
  },
});
