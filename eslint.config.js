// ESLint flat config — ADR-0005 게이트 실질화.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', '.harness', '_workspace'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
