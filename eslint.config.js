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
  {
    // ADR-0007 규칙3(순수 코어) 기계 강제 — state.ts·validation.ts는 전송 계층을
    // 알아서는 안 된다. 기본 no-restricted-imports는 `import type`도 함께 잡는데,
    // 순수성 주장에 타입 전용 간선까지 포함되므로 그게 의도한 동작이다.
    // patterns는 계층 역행(L1/L2가 상위 계층을 끌어오는 것)을 막는다.
    files: ['src/server/chat/state.ts', 'src/server/chat/validation.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'socket.io', message: '상태·규칙 모듈은 전송 계층을 알아서는 안 된다 (ADR-0007 규칙3).' },
            { name: 'socket.io-client', message: '상태·규칙 모듈은 전송 계층을 알아서는 안 된다 (ADR-0007 규칙3).' },
          ],
          patterns: ['./protocol', './broadcast', './session', './room', './departure', './connection'],
        },
      ],
    },
  },
);
