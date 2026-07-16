# 하네스 스타터 킷 — 웹 채팅 앱 (AX 워크플로우 L&L)

스펙을 단일 진실 공급원으로 삼아 의도/컨텍스트/검증 드리프트를 막는
Claude Code 하네스 뼈대입니다. 마감: 7/31.

## 구조

```
CLAUDE.md                      프로젝트 헌법 (짧게 유지 — 60줄 목표)
specs/
  requirements.md              EARS 인수 기준 (진실 공급원)
  interview/question-bank.md   Deep Interview 질문 뱅크 (Phase 1)
docs/adr/                      아키텍처 결정 기록 (WHY 박제)
.claude/
  settings.json                hooks + permissions
  hooks/log_trajectory.py      [스텁①] 트래젝토리 로그 (Stop hook → JSONL)
  agents/                      에이전트 (test-writer·coder=Sonnet 5, evaluator·reviewer=Opus)
  skills/tdd-workflow/         RQ 구현 오케스트레이터 (Red→Green→독립 평가, 세션 격리)
  skills/review-gate/          머지 전 독립 리뷰 게이트 (솔로 체제의 사람 리뷰 대체)
evals/
  golden/track-a-product.jsonl [스텁②] 제품 행동 골든 케이스
  golden/track-b-harness.jsonl [스텁②] 하네스 행동 골든 태스크
harness/
  sensor-catalog.md            [스텁③] 센서 카탈로그 (가드레일 지도)
  metrics-baseline.md          [스텁④] 메트릭 베이스라인
scripts/check.sh               스택 확정 후 채우는 검증 스크립트
scripts/smoke.sh               배포 후 스모크 (트랙 A 골든 케이스 승격분)
.github/workflows/ci.yml       PR 게이트 (스택 확정 후 활성화)
.github/workflows/deploy.yml   CD — main 머지 시 배포 + 스모크 (배포 대상 확정 후)
```

## 사용 순서

1. **Phase 1 — Deep Interview**: 새 Claude Code 세션에서
   `specs/interview/question-bank.md`를 열고 이렇게 시작:
   > "question-bank.md의 질문으로 나를 인터뷰해서 specs/requirements.md의
   > PENDING 항목을 확정해줘. AskUserQuestion 도구를 써도 좋아.
   > 코드는 절대 쓰지 마."
2. **Phase 2 — 스펙 확정**: 인터뷰 결과를 requirements.md의 EARS 문장으로
   반영. PENDING이 0이 되면 스펙 동결(v1 태그).
   **강제됨**: 🟡가 남아 있는 동안 hook이 src/tests 수정을 차단하고
   CI가 해당 변경의 머지를 거부한다 — 인터뷰를 건너뛰고 구현으로 넘어갈 수 없다.
3. **Phase 3 — ADR**: 갈림길(전송·영속성·인증·상태·테스트 전략)마다
   `docs/adr/`에 1장. ADR-0005(테스트 전략)가 확정되면 `scripts/check.sh`와
   `ci.yml`의 TODO를 채운다.
4. **Phase 3.5 — 디자인 (권장 워크플로우)**: 클로드 디자인으로 Design Style·
   디자인 md를 먼저 생성 → 산출물을 `docs/design/DESIGN.md`로 커밋 →
   이후 모든 UI 작업은 이 파일을 이어받는다. (인터뷰 질문 26~28)
5. **Phase 4~5 — 구현**: 스펙 항목 1개 = 브랜치 1개 = PR 1개.
   구현은 `tdd-workflow` 스킬로 — test-writer·coder(Sonnet 5)와
   evaluator(Opus)가 **각각 별도 에이전트 세션**에서 Red→Green→독립 평가를
   수행한다. plan mode로 계획 승인 후 진행. 탐색은 서브에이전트에게.
   **머지 전 `review-gate` 스킬로 reviewer(Opus) APPROVE 필수** (솔로 리뷰
   게이트). 머지되면 deploy.yml이 배포 + 스모크(트랙 A 승격분)를 실행.
6. **매 세션 종료 시**: Stop hook이 자동으로 `.harness/logs/`에 기록.
7. **주간 회고**: 로그에서 이상 세션 발견 → 골든 케이스로 승격 →
   `harness/metrics-baseline.md` 숫자 갱신.

## 원칙 한 줄 요약

- 스펙에 없으면 만들지 않는다. 만들고 싶으면 스펙부터 고친다(같은 PR).
- CLAUDE.md는 "요청", hook은 "보장". 반드시 지켜야 하면 hook으로.
- "된다"는 주장 대신 테스트 출력을 증거로 요구한다.
