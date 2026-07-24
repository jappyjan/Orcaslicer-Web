import { defineConfig } from 'vitest/config';

// One root runner for every workspace. Later milestones that need a different
// environment (jsdom for apps/web, a real container for the M1 integration slice)
// add a project entry here rather than a competing config file.
export default defineConfig({
  test: {
    include: ['{apps,packages,tools}/*/src/**/*.{test,spec}.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    passWithNoTests: false,
    reporters: ['default'],
  },
});
