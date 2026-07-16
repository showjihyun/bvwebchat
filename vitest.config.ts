import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // ADR-0005: 모든 대기에 상한을 명시한다 — flaky 테스트가 게이트를 잡아먹지 않게.
    testTimeout: 5000,
    hookTimeout: 5000,
  },
});
