import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/** Globs for the shared packages, where `any` is banned outright (doc 11 §7). */
export const SHARED_PACKAGE_FILES = ['packages/*/src/**/*.{ts,tsx}'];

/**
 * Rules that together enforce "zero `any`" — both writing it explicitly and
 * letting it leak in from untyped values.
 * @type {import('eslint').Linter.RulesRecord}
 */
export const NO_ANY_RULES = {
  '@typescript-eslint/no-explicit-any': ['error', { fixToUnknown: false, ignoreRestArgs: false }],
  '@typescript-eslint/no-unsafe-argument': 'error',
  '@typescript-eslint/no-unsafe-assignment': 'error',
  '@typescript-eslint/no-unsafe-call': 'error',
  '@typescript-eslint/no-unsafe-member-access': 'error',
  '@typescript-eslint/no-unsafe-return': 'error',
};

/**
 * Apps may only depend on `packages/*`, never on each other (doc 05 §2).
 * @type {import('eslint').Linter.RulesRecord}
 */
export const NO_CROSS_APP_IMPORT_RULES = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: ['@akiba/api', '@akiba/api/*', '@akiba/web', '@akiba/web/*', '**/apps/*/**'],
          message: 'Apps must not import from each other; share code through packages/*.',
        },
      ],
    },
  ],
};

/**
 * Build the flat ESLint config for the monorepo root.
 * @param {{ tsconfigRootDir: string }} options absolute path of the repository root
 * @returns {import('eslint').Linter.Config[]}
 */
export function createConfig({ tsconfigRootDir }) {
  return defineConfig(
    {
      name: 'akiba/ignores',
      ignores: [
        '**/dist/**',
        '**/coverage/**',
        '**/node_modules/**',
        '**/src/generated/**',
        'docs/**',
        'research/**',
      ],
    },
    js.configs.recommended,
    tseslint.configs.recommendedTypeChecked,
    {
      name: 'akiba/typescript',
      languageOptions: {
        parserOptions: { projectService: true, tsconfigRootDir },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': 'error',
      },
    },
    {
      name: 'akiba/plain-js',
      files: ['**/*.{js,mjs,cjs}'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: { globals: globals.node },
    },
    {
      name: 'akiba/shared-packages-no-any',
      files: SHARED_PACKAGE_FILES,
      rules: NO_ANY_RULES,
    },
    {
      name: 'akiba/apps-no-cross-imports',
      files: ['apps/**/*.{ts,tsx}'],
      rules: NO_CROSS_APP_IMPORT_RULES,
    },
    {
      name: 'akiba/api',
      files: ['apps/api/**/*.ts'],
      languageOptions: { globals: globals.node },
    },
    {
      name: 'akiba/web',
      files: ['apps/web/src/**/*.{ts,tsx}'],
      languageOptions: { globals: globals.browser },
      // Only the rules are registered: the plugin's bundled `configs` object is
      // not assignable to ESLint's `Plugin` type, and we do not use it.
      plugins: { 'react-hooks': { meta: reactHooks.meta, rules: reactHooks.rules } },
      rules: {
        'react-hooks/rules-of-hooks': 'error',
        'react-hooks/exhaustive-deps': 'warn',
      },
    },
    prettier,
  );
}
