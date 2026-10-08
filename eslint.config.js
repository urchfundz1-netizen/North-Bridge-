/**
 * Flat ESLint config for the workspace.
 *
 * The server, the client and the tooling scripts are linted as separate blocks
 * because they have different globals. That split is the point: `window` on
 * the server, or `process` inside the browser bundle, are real bugs that a
 * single undifferentiated config would wave through.
 *
 * The React plugin is present mainly for `jsx-uses-vars`: without it core
 * `no-unused-vars` cannot see that a component referenced in JSX is used, and
 * reports every imported component as dead.
 */

import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import jsxA11y from 'eslint-plugin-jsx-a11y';

/** Rules shared by every JavaScript file in the repository. */
const sharedRules = {
  'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
  'no-console': 'off',
  eqeqeq: ['error', 'smart'],
  'prefer-const': 'error',
  'no-var': 'error',
  'object-shorthand': ['error', 'properties'],
  'prefer-template': 'error',
  'no-return-await': 'error',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'server/data/**',
      'server/uploads/**',
      'coverage/**',
    ],
  },

  js.configs.recommended,

  /* ---------------------------------------------------------------- server */
  {
    files: ['server/src/**/*.js', 'server/test/**/*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: sharedRules,
  },

  /* ---------------------------------------------------------------- client */
  {
    ...react.configs.flat.recommended,
    files: ['client/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: { ...globals.browser },
    },
    settings: { react: { version: 'detect' } },
    plugins: {
      ...react.configs.flat.recommended.plugins,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...sharedRules,
      ...react.configs.flat.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
      // Rules of Hooks is a correctness rule, not a style preference: a hook
      // called conditionally silently breaks state. The exhaustive-deps check
      // stays a warning so an intentional omission is possible without an
      // eslint-disable comment.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      // The project targets React 17+, so the React import is unnecessary.
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      // A sign-in page exists to be signed in to; moving focus to its first
      // field is the point, not an accident.
      'jsx-a11y/no-autofocus': 'off',
      // Labels in this app wrap their control and keep the visible text in
      // nested spans, so the default depth of 3 cannot see the label text.
      'jsx-a11y/label-has-associated-control': ['error', { depth: 6 }],
    },
  },
];