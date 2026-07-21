# 진행 원장 (Progress Ledger)

> **규칙 (최상위)**: 모든 개발 작업은 시작 전 이 파일에서 요구사항·참조 파일을
> 확인하고 상태를 🔄로 바꾼 뒤 진행한다. 완료 시 ✅ + 산출물/PR을 기록한다.
> 원장에 없는 작업은 먼저 행을 추가한다 — 원장 밖 작업 금지.
> 상태: ⬜ 대기 · 🔄 진행중 · ✅ 완료 · ⛔ 차단(사유 병기)

## Phase 로드맵

- [x] ✅ **Phase 1 — Deep Interview**: 🟡 8건 → 0건 (2026-07-17 완료,
      결과: `specs/interview/answers.md`)
- [x] ✅ **Phase 2 — 스펙 동결**: v1 태그 완료 (2026-07-17, PR #7)
- [x] ✅ **Phase 3 — ADR-0001~0005 승인** (2026-07-17, 스택: Node+TS/Socket.IO/React+Vite —
      결정 요약: `docs/adr/README.md`)
- [x] ✅ **Phase 3.5 — DESIGN.md 확보**: 디자인 인터뷰(D1~D16) → 클로드 디자인
      산출 → `docs/design/DESIGN.md` 커밋 + 진실 공급원 4번 등재 (2026-07-20).
      브리프는 입력 기록으로 동결, 이후 디자인 변경은 DESIGN.md에서.
- [x] ✅ **게이트 실질화(검증)**: check.sh·ci.yml 실명령 + 스캐폴드 (2026-07-17,
      실측: fast 1.4초/전체 3.2초 — ADR-0005 예산 내)
- [ ] **게이트 실질화(배포)**: deploy.yml 배포 스텝·smoke.sh 구현 — 배포 서버
      확정 후 (RQ-17: 사내망, 참조: ADR-0001)
- [ ] 🔄 **Phase 4~5 — RQ 구현**: 아래 작업 원장. **RQ-01 ✅ 완료**
      (2026-07-20, PR #13 — 첫 실제 코드).
- [x] ✅ **FE 토대 + RQ-01 UI 슬라이스** (2026-07-20): React+Vite+TS, DESIGN.md
      토큰/레이아웃, 입장→단일 room 채팅(실 Socket.IO). `npm run dev:server` +
      `npm run dev`. 참여자 목록·안 읽음·히스토리·global·닉네임 고유화 UI는
      각 서버 RQ(15/18/11/04/10) 구현 시 확장. 다음: RQ-02

## 작업 원장 — RQ 구현

> 착수 시 `tdd-workflow` 스킬 사용 (Red→Green→평가→review-gate). 브랜치 `feat/RQ-XX-*`.
> 참조 컬럼의 ADR-0001~0005는 2026-07-17 전부 승인됨 (docs/adr/).

| RQ | 내용 | 상태 | 참조 파일 | 산출물/PR |
|---|---|---|---|---|
| RQ-01 | room 참여 → 수신자 등록 | ✅ | requirements.md §1, GA-05, ADR-0001 | PR #13 머지 · src/server/createChatServer.ts · GA-05 done |
| RQ-02 | room 메시지 격리 전달 | ✅ | requirements.md §1, GA-01/02/06/10, ADR-0001 | PR #16 머지 · GA-10 이월 구멍 닫음(발신자 `socket.rooms.has` 검증) · GA-01/02/06/10 done |
| RQ-03 | 퇴장 후 수신 차단 | ✅ | requirements.md §1, GA-03, GB-02 | PR #17 머지 · leave 이벤트(`socket.leave`) · GA-03 done |
| RQ-04 | global 전체 전달 | ✅ | requirements.md §1, GA-04, ADR-0004 | PR #18 머지 · 접속 시 global 자동 참여 + leave 거부(ADR-0004) · GA-04 done |
| RQ-05 | 7/31 배포 가능 | ⬜ | deploy.yml, smoke.sh, RQ-17 | |
| RQ-10 | 닉네임 식별·자동 접미사·새로고침 유지 | ✅ | requirements §2, GA-09/11, ADR-0003 | PR #19 identify(GA-09/11) + **잔여는 RQ-18(PR #25)이 마감**: 세션 토큰(randomUUID)·resume·30초 유예·활성 room 구현+검증, 클라 identify/resume·localStorage 토큰 배선. 새로고침 시 세션(닉네임·참여 room·활성·안읽음) 복원 ✅ (메시지 히스토리 재생만 범위 밖 — ADR-0002 휘발과 일관) |
| RQ-11 | 입장 시 최근 50개 히스토리 (인메모리) | ✅ | requirements §2, GA-08, ADR-0002 | PR #20 머지 · 서버 링버퍼(50)+join ack 히스토리 + 클라 소비(end-to-end 표시) · GA-08 done |
| RQ-12 | room 자유 생성 + 빈 room 자동 삭제 | ✅ | requirements §2, GA-25/26/27, ADR-0001, **ADR-0004**(global 예외 2) | PR #23 머지 · 마지막 참여자 이탈(leave·disconnect) 시 roomMembers·roomHistories 실삭제(RQ-15 minor-3 빈 배열 잔존 해소) · global은 예외 게이팅으로 존속 · GA-25/26/27 done · 서버 전용 · ⚠️ 하네스: vitest fork-pool 워커 크래시 flake(~1/10, RQ-12 무관·Red에서도 관측) 별도 이슈 권고 |
| RQ-13 | room 목록 공개·이름 고유 | ✅ | requirements §2, GA-21/22/23/24, ADR-0001, **ADR-0004**(global 예외) | PR #22 머지 · 서버 `rooms` 전역 방송([global]+멤버≥1 user room 생성순)+예약 이름 거부 + 클라 소비(JoinRoomModal room 디렉토리, end-to-end) · GA-21~24 done · **ADR-0004 준수**. 테스트 3커밋(최초→ADR정합→관찰교정). ⚠️ 후속(리뷰 minor): RoomList.tsx 주석 "전체 목록…붙인다"는 이제 오정보(디렉토리는 모달에 배치)—RQ-04/18 사이드바 작업 시 전체 목록 표면 확정+주석 갱신. global 조회 탭 RQ-04, 비공개 room 비범위 |
| RQ-14 | room 내 순서 보장 | ✅ | requirements §2, GA-07, **ADR-0001**(§근거·결과: 단일 프로세스 이벤트 루프 자연 보장) | PR #24 머지 · `tests/integration/rq-14-message-order.test.ts` 4건(GA-07 + 파생 3건) **구현 없이 즉시 Green** — ADR-0001 아키텍처 부수 효과(handleMessage 전동기). evaluator PASS(11회 클린 재현, 가드 강도 확인). src/ 변경 0. GA-07 done · 서버 전용(클라 append-only) |
| RQ-15 | 참여자 목록 표시 | ✅ | requirements §2, GA-19/20, ADR-0001 | PR #21 머지 · 서버 `participants` 방송(join순, RQ-02 격리) + 클라 렌더(ParticipantList, 본인 seed로 solo 간극 보완) · GA-19/20 done · 온라인/타이핑 비범위 |
| RQ-18 | 안 읽음 개수 (활성 room 외 +1, 열면 0, 상한 50) | 🔄 | requirements §2-1, GA-12~18, **ADR-0003**(세션 토큰·활성 room·30초 유예 전부) | PR #25-pending (Red→Green→평가 PASS) · **대형 파이프라인**: 서버 세션 토큰(randomUUID)+resume+활성 room 통지/검증+30초 유예(fake timer)+room별 안읽음 카운팅(상한 50) + 클라(identify/resume·localStorage 토큰·activeRoom 통지·숫자 배지) end-to-end. GA-12~18 done. evaluator PASS(44/44, 유예 정합=약화 아님·handleDisconnect 바이트동일·토큰 신뢰경계). **DESIGN §5 개정**(점→숫자 배지). ⚠️ 기존 disconnect 테스트(RQ-12/15) 유예 정합(단언 보존). 새로고침 메시지 히스토리 재생은 범위 밖(resume=세션 상태만). RQ-10 잔여(세션 토큰·활성 room·유예) 이 RQ로 마감 |

> RQ-16(동시 100명)·RQ-17(사내망 단일 서버)은 독립 구현 항목이 아니라
> ADR-0001과 "게이트 실질화"(deploy.yml·smoke.sh)의 제약 조건으로 반영한다.

## 하네스 작업 이력 (완료분)

- [x] 2026-07-16 — 하네스 구축·게이트·CD 골격·원장 체계 (PR #1~#6)
      상세: `docs/harness/changelog.md`
