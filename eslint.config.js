// ESLint flat config — ADR-0005 게이트 실질화.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'dist',
      'coverage',
      '.harness',
      '_workspace',
      // 클로드 디자인 export (생성 산출물, DESIGN.md만 tracked) — gitignore와 별개로 lint 제외
      'docs/design/Design handoff for webchat/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 서버·클라이언트·테스트·설정이 한 저장소에 있으므로 node+browser 전역을 함께 둔다.
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
);
