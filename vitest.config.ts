import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const UNIT_INCLUDE = ['{apps,packages,tools}/*/src/**/*.{test,spec}.ts'];
const INTEGRATION_INCLUDE = ['{apps,packages}/*/src/**/*.integration.test.ts'];
const WEB_INCLUDE = ['apps/web/src/**/*.{test,spec}.{ts,tsx}'];

// Three projects, one runner.
//
//   npm test                 -> "unit" + "web": run anywhere, need no slicer binary.
//   npm run test:integration -> "integration": drives the REAL OrcaSlicer binary, so it
//                               runs inside the container (`docker compose run --rm
//                               integration`). Per the working agreement the CI suite
//                               must include at least one real slice; it lives here.
//
// "web" is a separate project only because it needs a DOM. It deliberately shares this
// file rather than adding a competing vitest config under apps/web.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: UNIT_INCLUDE,
          exclude: [
            '**/node_modules/**',
            '**/dist/**',
            ...INTEGRATION_INCLUDE,
            // The web client's tests need jsdom; they run in the "web" project below.
            ...WEB_INCLUDE,
          ],
          environment: 'node',
          passWithNoTests: false,
          env: { LOG_LEVEL: 'silent' },
        },
      },
      {
        // Vite plugins are deliberately not loaded here: these tests exercise pure
        // modules and React components, not the CSS pipeline, and pulling Tailwind into
        // the test run would only slow it down.
        plugins: [react()],
        test: {
          name: 'web',
          root: resolve(import.meta.dirname, 'apps/web'),
          include: ['src/**/*.{test,spec}.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'jsdom',
          globals: false,
          passWithNoTests: false,
        },
      },
      {
        test: {
          name: 'integration',
          include: INTEGRATION_INCLUDE,
          exclude: ['**/node_modules/**', '**/dist/**'],
          environment: 'node',
          passWithNoTests: false,
          // A real slice takes seconds; three at once on a small box take longer. This
          // is a ceiling, not an expectation.
          testTimeout: 300_000,
          hookTimeout: 120_000,
          // The test drives its own concurrency against a CPU-bound binary; a second
          // vitest worker would only fight it for cores.
          fileParallelism: false,
        },
      },
    ],
  },
});
