import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import type { PluginOption } from 'vite';

const UNIT_INCLUDE = ['{apps,packages,tools}/*/src/**/*.{test,spec}.ts'];
const INTEGRATION_INCLUDE = ['{apps,packages}/*/src/**/*.integration.test.ts'];
const WEB_INCLUDE = ['apps/web/src/**/*.{test,spec}.{ts,tsx}'];

/**
 * The React plugin, if this checkout has one.
 *
 * It is a **dev dependency of the repo, not of the image**, and this config is loaded in
 * both. `docker compose run --rm integration` bind-mounts the repo into the runtime
 * container — which was installed with `npm ci --omit=dev` — and runs `npx vitest run
 * --project integration`. `npx` fetches vitest itself, but nothing fetches
 * `@vitejs/plugin-react`, so a top-level `import react from '@vitejs/plugin-react'` here
 * fails to resolve and takes the *whole config* down with it, integration project
 * included. MEASURED: that is what "Cannot find package '@vitejs/plugin-react'" in CI's
 * container job was, and it had nothing to do with the project being run.
 *
 * So it is loaded on demand, and when it is absent the `web` project is simply not
 * declared: without a JSX transform those tests cannot run, and a project registered
 * without one would fail with a syntax error instead of an explanation. `--project web`
 * then says no project matched, which is the truth.
 */
async function reactPlugin(): Promise<PluginOption | null> {
  try {
    const module = await import('@vitejs/plugin-react');
    return module.default();
  } catch {
    console.warn(
      '[vitest] @vitejs/plugin-react is not installed; the "web" project is unavailable. ' +
        'Run `npm ci` at the repo root to enable it.',
    );
    return null;
  }
}

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
export default defineConfig(async () => {
  const react = await reactPlugin();

  return {
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
        // Vite plugins beyond React are deliberately not loaded: these tests exercise pure
        // modules and React components, not the CSS pipeline, and pulling Tailwind into
        // the test run would only slow it down.
        ...(react === null
          ? []
          : [
              {
                plugins: [react],
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
            ]),
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
  };
});
