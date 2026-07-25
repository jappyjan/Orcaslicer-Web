// Flat config. Root-level so every workspace inherits one rule set — later
// milestones add framework-specific blocks (React for apps/web) rather than
// their own parallel configs.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      'work/**',
      'test/golden/**',
      'test/fixtures/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': 'off',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // The web client runs in a browser, not in Node: `window`, `fetch`, `EventSource`
    // and `XMLHttpRequest` are the ambient globals here, and `process` is not.
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
  },
  {
    // Vite's own config is the one file in apps/web that runs in Node.
    files: ['apps/web/vite.config.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    // Plain-JS tooling scripts: no type-aware rules, and they are allowed to be
    // scrappy in ways the TypeScript sources are not.
    files: ['**/*.mjs', '**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
