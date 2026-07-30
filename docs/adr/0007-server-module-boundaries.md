# ADR-0007: 서버 모듈 경계 — createChatServer 분해와 인스턴스별 상태 소유

- 상태: 승인
- 날짜: 2026-07-27
- 관련 스펙: 전 RQ(서버). 관련 ADR: 0001(전송), 0002(링버퍼 50),
  0003(세션·유예 30초), 0004(global 예약), 0005(테스트 전략), 0006(esbuild 번들)

## 맥락

createChatServer.ts는 RQ-01부터 RQ-18까지 14개 요구사항을 한 파일(822줄)에
누적했다. 결과로 (a) ADR-0002의 링버퍼 상한, ADR-0003의 5개 결정, ADR-0004의
2개 예외가 각각 서로 300줄 떨어진 지점에 흩어져 있어 "이 ADR이 어디서
집행되는가"를 코드에서 읽을 수 없고, (b) 세션리스 소켓 가드가 세 곳에 복제돼
있으며, (c) 닉네임 고유화·링버퍼 상한 같은 순수 로직조차 실제 소켓 핸드셰이크
없이는 실행할 수 없다. 동시에 현재의 클로저 지역 상태는 테스트 격리의
유일한 근거이므로(테스트 파일당 서버를 8~11개 기동한다) 어떤 분해도 이
성질을 깨서는 안 된다.

## 결정

createChatServer.ts를 `src/server/chat/` 아래 8개 모듈로 분해하고, 다음 4개
규칙을 이 결정의 본문으로 고정한다.

1. **인스턴스별 상태**: 가변 컨테이너는 `createChatState()`가 만들고 인자로만
   전달한다. `src/server/chat/**`에 모듈 스코프 가변 바인딩을 두지 않는다.
2. **단방향 계층**: shared/types → validation·protocol → state → broadcast →
   session → room·departure → connection → createChatServer. 역방향 import 금지.
3. **순수 코어**: state.ts·validation.ts는 socket.io를 타입으로도 import 하지
   않는다(ESLint no-restricted-imports로 강제). 이 두 모듈은 서버 없이 단위
   테스트한다.
4. **타이머 소유권**: 유예 타이머는 departure.ts에서만 생성하고 핸들은
   SessionState에 보관한다. `setTimeout`은 전역으로 호출한다 — `node:timers`
   import나 DI 시임은 ADR-0005 결정4(vi fake timer)를 무효화한다.

공개 계약 `createChatServer(requestListener?)`와 반환 shape은 무변경이며,
통합 테스트 11개 파일은 한 줄도 수정하지 않는다.

## 근거

- 경계 기준을 "상태 소유권"으로 잡으면 ADR과 파일이 1:1로 대응한다 —
  session.ts = ADR-0003 전문, state.ts = ADR-0002 상한, departure.ts =
  ADR-0003 결정5 + ADR-0004 예외2.
- 세션리스 소켓 가드(RQ-18 회귀 방지)를 한 곳으로 모으면 이후 RQ가 이 가드를
  다시 유도할 필요가 없다.
- 버린 대안: **핸들러 1개당 1파일**(14개) — 같은 장부 불변식을 공유하는
  join/leave/message를 갈라 import 의례만 늘린다. **ChatContext 객체 주입** —
  activeRoom·resume이 io를 전혀 쓰지 않는다는 타입 수준 신호를 지운다.
  **클래스 기반 ChatServer** — 요구하는 힘이 없고 리스너 동일성·this 의미가
  바뀐다. **protocol을 src/shared로 승격** — 클라이언트 배선까지 건드려
  행동 보존 범위를 벗어난다(별도 PR로 남긴다). **현상 유지** — 다음 RQ마다
  822줄을 다시 읽는 비용을 계속 지불한다.

## 결과

- 파일 수 3 → 11, 총 줄 수 약 25% 증가(파일 헤더·import). 탐색 비용과의 교환.
- join의 예약 이름 검사는 대소문자 무시(구 L357), leave는 정확 일치(구 L491)라는
  기존 비대칭을 **그대로 보존**한다. 통합 테스트가 leave의 대소문자 변형을
  덮지 않으므로, 두 검사를 하나의 헬퍼로 통합하면 무증상 행동 변경이 된다 —
  이 ADR이 그 비대칭을 명시적 결정으로 기록한다. 헬퍼 이름을
  `isReservedRoomNameForCreation`으로 지어 leave 지점에서의 재사용을 이름으로
  봉쇄했다.
- io.close() 시 유예 타이머 정리는 이 결정의 범위가 아니다(현행 유지) —
  필요해지면 ADR-0003 결정5의 후속으로 별도 처리한다.
- 향후 실시간 로직 변경은 이 계층 표를 어기면 안 된다. 어겨야 한다면 이
  ADR을 새 ADR로 대체한다.
