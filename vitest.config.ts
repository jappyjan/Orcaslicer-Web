import { defineConfig } from 'vitest/config';

const UNIT_INCLUDE = ['{apps,packages,tools}/*/src/**/*.{test,spec}.ts'];
const INTEGRATION_INCLUDE = ['{apps,packages}/*/src/**/*.integration.test.ts'];

// Two projects, one runner.
//
//   npm test                 -> "unit": runs anywhere, needs no slicer binary.
//   npm run test:integration -> "integration": drives the REAL OrcaSlicer binary, so it
//                               runs inside the container (`docker compose run --rm
//                               integration`). Per the working agreement the CI suite
//                               must include at least one real slice; it lives here.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: UNIT_INCLUDE,
          exclude: ['**/node_modules/**', '**/dist/**', ...INTEGRATION_INCLUDE],
          environment: 'node',
          passWithNoTests: false,
          env: { LOG_LEVEL: 'silent' },
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
