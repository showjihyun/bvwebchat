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
- [x] ✅ **게이트 실질화(배포)**: RQ-05 — Docker 단일 컨테이너(ADR-0006),
      deploy.yml(이미지 빌드→기동→스모크), smoke.sh(GA-01·GA-04 프로덕션 승격).
      **컨테이너 검증 완료**: docker build/run OK, health 1초, 스모크 exit 0.
- [x] ✅ **Phase 4~5 — RQ 구현 전부 완료** (2026-07-21): 기능 RQ 11개
      (RQ-01/02/03/04/10/11/12/13/14/15/18) + 배포 RQ-05, 모두 tdd-workflow
      (Red→Green→독립평가) + review-gate 통과. RQ-16/17은 ADR-0001/0006·게이트
      제약으로 반영. 각 RQ 상세는 아래 작업 원장.
- [x] ✅ **UI 수정 (2026-07-21, PR #29)**: 브라우저 수동 테스트 사용자 피드백 —
      메시지 겹침(`.msg-row flex-shrink:0`)·세로 스크롤(justify-content 제거+자동
      하단 스크롤)·입장 닉네임 최소 2자·닉네임 10자 초과 축약(…). 클라 전용,
      DESIGN §5 동기화, review-gate APPROVE. 서버·스펙·골든 무변경.
- [x] ✅ **FE 토대 + RQ-01 UI 슬라이스** (2026-07-20): React+Vite+TS, DESIGN.md
      토큰/레이아웃, 입장→단일 room 채팅(실 Socket.IO). `npm run dev:server` +
      `npm run dev`. 참여자 목록·안 읽음·히스토리·global·닉네임 고유화 UI는
      각 서버 RQ(15/18/11/04/10) 구현 시 확장. 다음: RQ-02

- [x] ✅ **서버 모듈 분해 (2026-07-27, ADR-0007)**: `createChatServer.ts` 822줄 →
      `src/server/chat/` 8모듈 + 조립점 51줄. 행동 보존 리팩터 —
      공개 계약 `createChatServer(requestListener?)` 무변경, **`tests/` 무수정(0줄)**.
      참조: `docs/adr/0007-server-module-boundaries.md`,
      `_workspace/harness-redesign/01_server-split-design.md`.
      커밋 17개(Phase A 인플레이스 9 → Phase B 파일 이동 8), 커밋마다
      eslint → tsc → vitest ×3, 페이즈마다 `npm run build`.
      - **구속 규칙 4개**(ADR-0007): 인스턴스별 상태 / 단방향 계층 /
        순수 코어(ESLint `no-restricted-imports`로 기계 강제, 고의 위반으로
        발화 실증) / 타이머 소유권(`setTimeout` 전역 맨몸 호출 — departure.ts 1곳).
      - `rg '^(const|let)\s+\w+.*new (Map|Set)' src/server/` → **0건**
        (`createChatState` 밖 모듈 스코프 가변 상태 없음).
      - `npm run build` OK. `dist/server/main.js` 14,032 → 15,353 B (+1,321).
        번들 실측: `protocol.ts` 흔적 0건(타입 전용 소거 확인), socket.io
        import 1건(external 유지), 예상 밖 모듈 유입 없음.
      - ⚠️ **flake 베이스라인은 머신 부하에 따라 이동한다**(이번 작업의 발견).
        Step 0(단독 실행) 9/10 → 동시 에이전트 5개 상태에서 재측정 시
        **미변경 원본 HEAD가 7/10**(worktree 대조군), 분해 후 6/10.
        `--pool=threads`는 양쪽 다 클린(6/6). 전 과정에서 **단언 수준 실패 0건**.
        ⇒ 수용 기준은 "실패 횟수"가 아니라 "단언 수준 실패 0 + 모든 실패가
        워커 크래시 시그니처(`Worker exited unexpectedly`, 단언 diff 없음)"여야 한다.

## 작업 원장 — RQ 구현

> 착수 시 `tdd-workflow` 스킬 사용 (Red→Green→평가→review-gate). 브랜치 `feat/RQ-XX-*`.
> 참조 컬럼의 ADR-0001~0005는 2026-07-17 전부 승인됨 (docs/adr/).

| RQ | 내용 | 상태 | 참조 파일 | 산출물/PR |
|---|---|---|---|---|
| RQ-01 | room 참여 → 수신자 등록 | ✅ | requirements.md §1, GA-05, ADR-0001 | PR #13 머지 · src/server/createChatServer.ts · GA-05 done |
| RQ-02 | room 메시지 격리 전달 | ✅ | requirements.md §1, GA-01/02/06/10, ADR-0001 | PR #16 머지 · GA-10 이월 구멍 닫음(발신자 `socket.rooms.has` 검증) · GA-01/02/06/10 done |
| RQ-03 | 퇴장 후 수신 차단 | ✅ | requirements.md §1, GA-03, GB-02 | PR #17 머지 · leave 이벤트(`socket.leave`) · GA-03 done |
| RQ-04 | global 전체 전달 | ✅ | requirements.md §1, GA-04, ADR-0004 | PR #18 머지 · 접속 시 global 자동 참여 + leave 거부(ADR-0004) · GA-04 done |
| RQ-05 | 7/31 배포 가능 | ✅ | requirements §1, RQ-17, **ADR-0006**(Docker 단일 컨테이너) | PR #26 머지 · 단일 서버(정적 클라 + Socket.IO 단일 포트) · esbuild 번들 · Dockerfile 멀티스테이지 · smoke.sh(health+DoS가드+GA-01+GA-04) · deploy.yml · docs/deploy.md. **검증**: 로컬 컨테이너 스모크 exit 0 + **CD(GitHub) 성공**(이미지 빌드+컨테이너 스모크). ⚠️ 리뷰 B-1(잘못된 URL 인코딩 크래시=무인증 DoS) 수정. 리뷰 minor 해소(chore/deploy-minors): m-1(런타임 이미지 슬리밍 20개, node:24-slim)·m-2(.dockerignore 시크릿 방어) |
| RQ-10 | 닉네임 식별·자동 접미사·새로고침 유지 | ✅ | requirements §2, GA-09/11, ADR-0003 | PR #19 identify(GA-09/11) + **잔여는 RQ-18(PR #25)이 마감**: 세션 토큰(randomUUID)·resume·30초 유예·활성 room 구현+검증, 클라 identify/resume·localStorage 토큰 배선. 새로고침 시 세션(닉네임·참여 room·활성·안읽음) 복원 ✅ (메시지 히스토리 재생만 범위 밖 — ADR-0002 휘발과 일관) |
| RQ-11 | 입장 시 최근 50개 히스토리 (인메모리) | ✅ | requirements §2, GA-08, ADR-0002 | PR #20 머지 · 서버 링버퍼(50)+join ack 히스토리 + 클라 소비(end-to-end 표시) · GA-08 done |
| RQ-12 | room 자유 생성 + 빈 room 자동 삭제 | ✅ | requirements §2, GA-25/26/27, ADR-0001, **ADR-0004**(global 예외 2) | PR #23 머지 · 마지막 참여자 이탈(leave·disconnect) 시 roomMembers·roomHistories 실삭제(RQ-15 minor-3 빈 배열 잔존 해소) · global은 예외 게이팅으로 존속 · GA-25/26/27 done · 서버 전용 · ⚠️ 하네스: vitest fork-pool 워커 크래시 flake(~1/10, RQ-12 무관·Red에서도 관측) 별도 이슈 권고 |
| RQ-13 | room 목록 공개·이름 고유 | ✅ | requirements §2, GA-21/22/23/24, ADR-0001, **ADR-0004**(global 예외) | PR #22 머지 · 서버 `rooms` 전역 방송([global]+멤버≥1 user room 생성순)+예약 이름 거부 + 클라 소비(JoinRoomModal room 디렉토리, end-to-end) · GA-21~24 done · **ADR-0004 준수**. 테스트 3커밋(최초→ADR정합→관찰교정). ⚠️ 후속(리뷰 minor): RoomList.tsx 주석 "전체 목록…붙인다"는 이제 오정보(디렉토리는 모달에 배치)—RQ-04/18 사이드바 작업 시 전체 목록 표면 확정+주석 갱신. global 조회 탭 RQ-04, 비공개 room 비범위 |
| RQ-14 | room 내 순서 보장 | ✅ | requirements §2, GA-07, **ADR-0001**(§근거·결과: 단일 프로세스 이벤트 루프 자연 보장) | PR #24 머지 · `tests/integration/rq-14-message-order.test.ts` 4건(GA-07 + 파생 3건) **구현 없이 즉시 Green** — ADR-0001 아키텍처 부수 효과(handleMessage 전동기). evaluator PASS(11회 클린 재현, 가드 강도 확인). src/ 변경 0. GA-07 done · 서버 전용(클라 append-only) |
| RQ-15 | 참여자 목록 표시 | ✅ | requirements §2, GA-19/20, ADR-0001 | PR #21 머지 · 서버 `participants` 방송(join순, RQ-02 격리) + 클라 렌더(ParticipantList, 본인 seed로 solo 간극 보완) · GA-19/20 done · 온라인/타이핑 비범위 |
| RQ-18 | 안 읽음 개수 (활성 room 외 +1, 열면 0, 상한 50) | ✅ | requirements §2-1, GA-12~18, **ADR-0003**(세션 토큰·활성 room·30초 유예 전부) | PR #25 머지 · **대형 파이프라인**: 서버 세션 토큰(randomUUID)+resume+활성 room 통지/검증+30초 유예(fake timer)+room별 안읽음 카운팅(상한 50) + 클라(identify/resume·localStorage 토큰·activeRoom 통지·숫자 배지) end-to-end. GA-12~18 done. evaluator PASS(44/44). DESIGN §5 개정(점→숫자 배지). ⚠️ 후속(리뷰 minor): 클라 배선은 evaluator 미검증(review-gate 대체)·새로고침 닉네임 재입력·복원 room 빈 패널·global 미렌더(RQ-04). RQ-10 잔여 이 RQ로 마감 |
| RQ-10-a | 새로고침 시 닉네임 재입력 요구 (RQ-10 위반) | ✅ | requirements §2 RQ-10(:30-32), ADR-0003, `src/client/App.tsx` · `useChat.ts` · `ChatApp.tsx` | **`tdd-workflow` 첫 완주.** 토큰 존재만으로 `resuming` 을 켜고 `ChatApp` 을 `nickname=null` 로 먼저 mount → `resume` ack 의 `nickname` 을 `selfNickname` 으로 승격. 실패 시 `onResumeFail` 이 `EntryScreen` 복귀(폴백 보존). `localStorage` 에는 토큰만 — 진실 공급원 하나. 신규 3 · 전체 47/47 회귀 0. evaluator PASS · reviewer APPROVE(blocker 0). **게이트에는 `RQ-10`, 원장에는 `RQ-10-a`** — 접미사는 원장 표기 문제이고 게이트가 알 일이 아니다(`decisions.jsonl`). ⚠️ 후속 3건(우선순위순): **major-1** `useChat.ts:104` 의 `nickname ?? ''` 가 타입 체커 사각지대 — resume 대기 창에 room 참여를 누르면 서버가 거부하는데 낙관적 갱신은 실행돼 **유령 room** 이 남는다 · **minor-1** · **major-2** 두 진입 경로의 끊김 내성 비대칭(ADR 개정 선행) |

> RQ-16(동시 100명)·RQ-17(사내망 단일 서버)은 독립 구현 항목이 아니라
> ADR-0001과 "게이트 실질화"(deploy.yml·smoke.sh)의 제약 조건으로 반영한다.

## 진행 중

- [ ] 🔄 2026-07-31 — **입력 해시 밖의 축 두 개** (브랜치 `fix/harness-artifact-checkpoint`)
      8차 재리뷰가 "추정"으로 남기고 9차가 관측한 위험을 게이트로 내린다.
      ① `--verify-artifact` 가 GB-06 의 채점 대상 체크포인트를 최신 커밋본과 대조한다
      — `inputs_hash` 는 `HASH_GLOBS` 만 덮고 `.harness/state` 는 밖이라, 체크포인트가
      교체돼도 해시가 그대로여서 **옛 판정이 새 상태의 보증처럼 읽혔다**(실측: 아티팩트
      `e286fa86` 의 초록은 하루 전 다른 RQ 의 체크포인트에 대한 것).
      ② `policy-lint` P9 가 저장소가 아니라 체크아웃 환경을 재고 있었다 — `* text=auto`
      탓에 Windows 에서만 빨갛고 CI(Linux)는 초록. 비교 축에서 줄바꿈을 뺐다(R9 부류).
      음성 시험 16건 신설. 참조: `scripts/{eval-b,policy-lint}.mjs`, `harness/recurrence.md` R2·R9.
      ⚠️ 같은 부류의 미처방 구멍 1건 — `HASH_GLOBS` 에 `scripts/` 가 없어 **채점기
      (`resume-test.mjs`)와 채점 엔진(`eval-b.mjs`) 자체를 바꿔도 옛 아티팩트가 유효**하다.
      **이 PR 안에서 실제로 발현했다**(재리뷰 M-2, 서술 정정): `cacheIsStale` 을 워킹트리에만
      둔 채 `--case GB-06` 을 돌려 통과 아티팩트가 났고, 그 아티팩트의 `head_sha`(`060ea249`)에
      커밋된 엔진에는 그 함수가 **없다**(`git show 060ea249:scripts/eval-b.mjs | grep -c
      cacheIsStale` = 0). `requireCleanState()` 는 `scripts/` 를 안 보므로 막지 못했다.
      "아직 실패로 관측된 적이 없다"고 적었던 앞 판단은 **틀렸고**, 그래서 후속이 아니라
      다음 하네스 PR 의 1순위다. 처방 비용은 트랙 B 전수 재실행 1회.

## 하네스 엔지니어링 — 동결 (2026-08-02)

> **하네스 변경을 여기서 멈춘다.** 기능 RQ 12개는 7/21에 전부 끝났고 CD 도 초록인데,
> 7/28 이후 83커밋 중 65가 하네스·문서·상태였고 `src/`·`tests/` 를 건드린 것은 7개다.
> 하네스에 **종료 조건이 적혀 있지 않았던 것**이 원인이다 — 게이트가 매번 실재 문제를
> 잡으니(R1~R12 전부 진짜였다) 다음 게이트가 항상 정당해 보인다. 이 절이 그 종료 조건이다.
>
> **동결의 의미**: 아래 항목들은 *"나중에 한다"* 가 아니라 **"하지 않기로 결정했다"** 다.
> 되살리려면 근거가 바뀌어야 하고, 그 근거는 항목마다 적혀 있다.
> 판정 근거는 `_workspace/harness-audit/2026-08-02.md`.

| 보류 항목 | 하지 않는 근거 | 되살릴 조건 |
|---|---|---|
| `HASH_GLOBS` 에 `scripts/` 추가 | 이 구멍(채점 엔진을 바꿔도 옛 아티팩트가 유효)의 위험은 **`scripts/` 변경 빈도에 비례**한다. 동결하면 빈도가 0으로 가고 위험도 함께 간다. 채택 비용은 전수 재실행 **$7.21** | **`scripts/` 중 트랙 B 채점에 관여하는 것**(`eval-b.mjs` · `resume-test.mjs`)을 손대게 되면 그 PR 안에서 함께 넣는다. **센서 전용**(`policy-lint.mjs` · `doc-freshness.mjs` · `hooks-selftest.mjs`)은 해당 없다 — 채점 경로에 호출되지 않으므로 아티팩트 판정에 닿지 않는다.<br>**발동 이력**: 2026-08-03 `policy-lint.mjs` 변경 시 검토했고 위 근거로 **해당 없음** 판정(재리뷰가 `eval-b`·`resume-test` 어디에도 `policy-lint` 호출이 없음을 실측 확인) |
| **R13 의 올바른 배치** — `goal`·`next` 정합 확인을 **전이 시점**으로 옮긴다 | 주간 회고에 둔 처방이 **등재 5분 만에 실패**했다. 실패는 세션 안에서 나고 회고는 주간이라 배치 시점이 어긋난다. 올바른 자리는 체크포인트가 찍히는 순간(`harness/phase.py enter` 가 `goal` 과 `next` 를 나란히 출력) 인데 **`phase.py` 는 `HASH_GLOBS`** 라 한 줄에 전수 재실행이 붙는다. 방금 그 값을 냈고 다시 낼 근거가 없다 | 스킬·`phase.py` 를 다시 손대는 PR 에 태운다. **4회째면 물을 것은 "게이트를 만들까"가 아니라 "`goal` 이 늘어날 때 그 이전 체크포인트를 무효로 볼 것인가"다** — 리뷰가 범위를 넓히는 것은 정상이므로 고칠 대상이 작성자가 아닐 수 있다 |
| **`HASH_GLOBS` 잠금 묶음 — 2차** (3차 재리뷰) — ① `.claude/skills/harness-audit/SKILL.md:151` 의 `recurrence R1, 9회` (실측 13 · 같은 파일 `:130`·`:172` 는 참) ② `.claude/skills/retro-metrics/SKILL.md:201` 의 R13 값 전재(`두 번 · 0/2 · 1/2`) ③ `scripts/eval-b.mjs` 에 `superseded` 표식 — 같은 `inputs_hash` 에서 빨강을 초록이 대체한 흔적이 없다 ④ R13 의 올바른 배치(`harness/phase.py` 전이 시점) ⑤ P12 의 범위를 *"이 PR 이 만든 체크포인트 전부"* 로 (`doc-freshness --pr` 과 같은 원리) | **묶음이 다시 형성됐다는 것이 이 행의 요점이다.** 1차를 2026-08-03 에 지불해 닫았는데 같은 날 다섯이 새로 모였다. ③④⑤ 는 파일 자체가 해시 밖(`scripts/`)인데도 `.claude/skills/harness-audit/SKILL.md` 가 넷을 전부 `depends_on` 에 가져 C2 가 따라온다 — **동결의 경계는 재서술하는 문서까지**라는 이 PR 의 교훈이 비용 구조로 확인된 것이다. 셋 다 방향이 안전 쪽이거나(9 < 13, 문제를 적게 적음) 표식 부재이지 거짓 방어 단언이 아니다 | **다음 하네스 PR 에서 한꺼번에.** 조건을 *"스킬을 손대면"* 으로 쓰지 않는다 — `.claude/skills/harness-audit/SKILL.md` 가 센서 넷을 전부 의존하므로 **어떤 센서를 고쳐도 발동해** 조건이 판별력을 잃는다. 값이 묶음당이라는 이 PR 의 실측이 그대로 적용된다 |
| ~~`HASH_GLOBS` 잠금 묶음 — 1차~~ → **2026-08-03 지불 완료** | 값이 항목당이 아니라 **묶음당**이라는 것이 이 항목의 교훈이었다. 재리뷰 N-2(P12 판별식)를 "무료"로 판단했는데 그것을 재서술하는 `.claude/skills/harness-audit/SKILL.md` 가 `HASH_GLOBS` 안이라 C2 가 걸었고, **그 순간 값이 확정되자 나머지 셋을 함께 여는 것이 합리적이 됐다** | — (닫힘) |
| `resume-test.mjs` Q3 만 100% 일치 요구 (Q4·Q5 는 60%) | 정답지가 체크포인트 자신의 `next` 필드라 **작성 규칙으로 점수를 움직일 수 있는 구조**이고, 그 길은 `checkpoint-resume` 스킬이 이미 기각했다. 남은 처방은 채점기 쪽인데 **채점기는 하네스가 바뀔 때만 값을 낸다** | 하네스 변경이 재개되면 1순위 |
| `phase-audit.mjs` CI 배선 | `2bcaa28` 한 건으로 `exit 1` 이고 그 커밋을 어떻게 처리할지 결정이 없다. **빨간 채로 배선된 게이트는 그날로 무시된다** | 그 결정이 서면 |
| `doc-freshness` C6 오탐 4건 | 🟡 를 *설명하는* 산문을 열린 마커로 잡는다. **advisory 등급이라 차단하지 않는다** | 차단 등급으로 올릴 이유가 생기면 |

## 하네스 작업 이력 (완료분)

- [x] 2026-07-16 — 하네스 구축·게이트·CD 골격·원장 체계 (PR #1~#6)
      상세: `docs/harness/changelog.md`
- [x] 2026-07-28 — **반복 실패 대장** `harness/recurrence.md` + `policy-lint` P11
      운영 규칙 3("2회 반복 시 센서 또는 Guide")은 있었는데 **누적을 세는 자리가
      없어** 하루에 같은 원인으로 3~9회를 반복했다. 등재 6건(R1~R6), 3회 이상
      미처방 0건. 첫 실행에서 즉시 R1 을 잡았고, 그 1차 처방(doc-freshness C2)이
      **실패했다는 사실**을 기록하게 만들어 harness-audit 의 역추적 필수 질문으로
      재처방했다. 대장 파일 자신도 R1 로 재발해(차단 주체를 metrics 로 오기)
      C4 가 잡았다 — 센서가 자기 문서를 잡은 첫 사례.
      상세: `docs/harness/changelog.md`
- [x] 2026-07-29 — **하네스 L3 재구성 완료** (8차 재리뷰 APPROVE, `REVIEW→RELEASE`)
      3평면(Feedforward / Execution Boundary / Feedback) · 9단계 상태 머신 ·
      전이 가드 11종 · 센서 S1~S4 · 상태 계약(체크포인트·결정 로그) ·
      트랙 B 회귀 평가(필수 6건 전원 통과) · 반복 실패 대장 R1~R8.
      **머지 직후 첫 작업 5건이 리뷰 보고서에 순서까지 못박혀 있다** —
      `--verify-artifact` 의 체크포인트 대조 · `resume-test.mjs` 채점기 넷 ·
      `.env`/`secrets` 읽기 경로 재확인 · `phase-audit` CI 배선 · R7 규칙 정리.
      상세: `docs/harness/changelog.md`
