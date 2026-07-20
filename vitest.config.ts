import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 테스트 전용 설정 (프로젝트 루트 기준). react 플러그인은 .tsx 테스트의 JSX 변환용.
// 서버 통합/단위 테스트는 node 환경(기본), 클라이언트 컴포넌트 테스트는 파일 상단
// `// @vitest-environment jsdom` 주석으로 개별 지정한다.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // ADR-0005: 모든 대기에 상한 — flaky 방지.
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
