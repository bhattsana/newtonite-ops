import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['**/node_modules/**', 'web/dist/**', '**/*.tgz'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ['src/**', 'tests/**', 'scripts/**', '*.ts', '*.js'], languageOptions: { globals: globals.node } },
  { files: ['web/**/*.{ts,tsx}'], languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks }, rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'warn' } },
  { rules: { '@typescript-eslint/no-explicit-any': 'warn', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true }] } },
);
