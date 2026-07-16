# ADR-0005: 테스트 전략 — 통합 중심 TDD, Vitest

- 상태: 승인
- 날짜: 2026-07-17
- 관련 스펙: 전 RQ, 트랙 B GB-02/04/05, 메트릭 M3 (입력: answers.md G19~25)

## 맥락

TDD(Red→Green→Refactor)가 헌법 규칙이고 tdd-workflow 파이프라인
(test-writer→coder→evaluator)이 이 ADR의 확정을 전제조건으로 대기 중이다.
인터뷰 G섹션에서 레벨·증거·더블·속도 예산·예외·커버리지를 결정했다.

## 결정

1. **레벨**: 골든 케이스(GA-*)는 서버 경계 **통합 테스트**로 구현하고
   (`verify: integration_test`와 일치), 라우팅·버퍼 등 핵심 로직만 단위
   테스트로 보조한다.
2. **러너**: **Vitest** — Vite 생태계와 일관, TS 네이티브, fake timer 내장.
   테스트 위치: `tests/integration/`, `tests/unit/`. 테스트 이름에 RQ-ID·GA-ID 포함.
3. **Red 증거**: 테스트 커밋이 구현 커밋보다 선행 **그리고** PR에 Red 실행
   출력 첨부 (GB-02 rubric = M3 측정 방식).
4. **테스트 더블**: 전송 계층만 대체 허용 — Socket.IO 서버를 테스트
   프로세스 안에서 기동하고 socket.io-client로 접속(실 네트워크 스택 불요).
   fake timer 허용(유예기간 등 시간 의존 로직 — ADR-0003). 모든 대기에
   상한(timeout)을 명시한다. 저장소(인메모리 버퍼)는 실제 구현을 그대로 사용.
5. **속도 예산**: `check.sh --fast` 5초(변경 파일 lint+typecheck),
   CI 게이트 3분(전체 lint+typecheck+test). 초과분은 게이트 밖(수동·야간)으로.
6. **예외**: 문서·설정·순수 스타일 변경은 TDD 면제. 스파이크(탐색)는
   `spike/*` 브랜치에서만 — 머지 금지, 교훈만 가져와 TDD로 재구현.
7. **커버리지**: 수치 게이트 없음 — M3(테스트 선행률 ≥80%)만 추적한다.
   이유: 커버리지는 게이트가 되는 순간 게임의 대상이 된다.

## 근거

- 채팅 앱의 검증력은 경계면(전송↔라우팅↔버퍼)에 있다 — 통합 중심이
  GA 골든의 given/when/then과 직접 대응한다.
- flaky 방지: 실시간을 실 타이머·실 네트워크로 돌리면 게이트 신뢰가 죽는다
  (인터뷰 G21). in-process 서버 + fake timer가 결정론과 충실도의 균형.
- 버린 대안: **단위 중심**(경계 검증력 약함), **브라우저 E2E 상시**(느리고
  flaky — 필요 시 스모크로만), **Jest**(Vite 프로젝트에서 설정 이중화).

## 결과

- 이 ADR 승인으로 `scripts/check.sh`·`ci.yml`의 TODO를 채울 수 있다
  (다음 작업: 게이트 실질화).
- deploy 후 스모크(smoke.sh)는 GA-01/GA-04를 실 서버 대상으로 재실행 —
  통합 테스트 코드의 재사용을 우선한다.
- tdd-workflow Phase 0 전제조건 중 "ADR-0001·0005 승인" 충족.
