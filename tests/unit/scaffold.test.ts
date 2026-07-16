import { describe, expect, it } from 'vitest';
import { GLOBAL_ROOM } from '../../src/shared/types';

// 스캐폴드 배선 검증 — 제품 행동 테스트가 아니다 (ADR-0005 예외: 설정).
// vitest가 TS로 src 모듈을 임포트해 실행할 수 있는지만 확인한다.
// 제품 테스트(GA-*)는 tdd-workflow의 test-writer가 Red부터 작성한다.
describe('scaffold', () => {
  it('vitest + TS + src 임포트 경로가 작동한다', () => {
    expect(GLOBAL_ROOM).toBe('global');
  });
});
