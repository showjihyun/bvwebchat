# ADR 목록

2026-07-17 Deep Interview 완료로 5개 갈림길 전부 승인됨
(입력: `specs/interview/answers.md`).

| 번호 | 갈림길 | 결정 | 상태 |
|---|---|---|---|
| [ADR-0001](0001-realtime-transport.md) | 실시간 전송 계층 | Node.js+TS + Socket.IO (FE: React+Vite) | 승인 |
| [ADR-0002](0002-message-persistence.md) | 메시지 영속성 | 인메모리 링버퍼 (room당 50개) | 승인 |
| [ADR-0003](0003-user-identity.md) | 사용자 식별 | 닉네임 + 서버 발급 토큰, 퇴장 유예 30초 | 승인 |
| [ADR-0004](0004-global-channel.md) | global 채널 모델링 | 예약된 상설 room (RQ-12/13 예외 명문화) | 승인 |
| [ADR-0005](0005-test-strategy.md) | 테스트 전략 | 통합 중심 TDD, Vitest, 전송만 대역 | 승인 |
| [ADR-0006](0006-deployment.md) | 배포 (RQ-05/17) | Docker 단일 컨테이너 — 정적 클라 + Socket.IO 단일 서버, 스모크=골든 승격 | 승인 |

> ADR-0001~0005는 2026-07-17 Deep Interview로 일괄 승인. ADR-0006은
> 2026-07-21 RQ-05 착수 시 배포 방식 결정(사용자 선택: Docker).

디자인 스타일은 ADR이 아니라 `docs/design/DESIGN.md`(클로드 디자인
산출물 — 질문 26~28)가 진실 공급원이다. UI 구현은 이를 이어받는다.

규칙: ADR과 모순되는 코드 변경 금지. 바꾸려면 새 ADR로 기존 것을 대체.
