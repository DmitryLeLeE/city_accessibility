import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['vendor/**', 'node_modules/**', 'dist/**', '_site/**'] },
  js.configs.recommended,
  {
    files: ['js/**/*.js', 'tests/**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.browser, ...globals.node, L: 'readonly', osmtogeojson: 'readonly', axe: 'readonly' } },
    rules: { 'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }], 'no-empty': ['error', { allowEmptyCatch: true }] },
  },
  {
    files: ['electron/**/*.cjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'commonjs', globals: { ...globals.node } },
  },
];
