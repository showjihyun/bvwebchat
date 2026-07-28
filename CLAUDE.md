# 웹 채팅 앱 — 프로젝트 헌법 (포인터 인덱스)

room 참여 채팅 + global 채팅 웹 앱. 마감 7/31. 하네스 워크플로우 L&L 겸용.
이 파일은 최소한의 규칙과 **참조 경로**만 담는다 — 상세는 참조 파일에서 읽는다.
100줄 상한은 `harness/doc-map.json`의 `max_lines`가 기계로 강제한다(검사 C5).

## 진실 공급원 (충돌 시 위가 이김)

1. `specs/requirements.md` — 요구사항(EARS). 여기 없는 기능은 만들지 않는다.
2. `docs/adr/` — 아키텍처 결정. 모순 구현 금지, 변경은 새 ADR 먼저.
3. 이 파일 — 최상위 규칙. 모호하면 추측하지 말고 질문한다.
4. `docs/design/DESIGN.md` — UI 디자인. UI 구현이 모순되면 드리프트. 디자인은
   기능을 추가할 수 없어 충돌 시 requirements가 이긴다. ADR과는 관할 직교.

## 단계 모델 — 9단계 상태 머신 (포인터)

작업은 항상 한 **단계** 안에 있고, 단계가 쓰기 가능한 경로를 정한다.
`IDLE`(기본값) · `SPEC` · `PLAN` · `RED` · `GREEN` · `EVAL` · `REVIEW` ·
`HARNESS` · `RELEASE`.

- 지금 어디인가·무엇을 쓸 수 있나: `python harness/phase.py show`
- 왜 이 작업을 하는가·전이 이력: `python harness/phase.py why`
- 전이: `python harness/phase.py enter <PHASE>` — 상태의 **유일한 writer**다.
  합법 간선도 직전 단계만 만들 수 있는 산출물을 가드로 요구한다.
- 계약: `harness/policy/phase-matrix.json` (사람용 표 `harness/policy/README.md`)
- 설계 근거 전문: `docs/harness/architecture-2026.html`

## 토폴로지 — 내려갈 때만 근거를 적는다 (포인터)

기본값은 **단일 세션**이다. 한 칸 내려갈 때마다 사유를 남긴다.
단일 세션 → **스크립트**(같은 절차 2회 이상 수동 반복 + 출력이 결정론적) →
**스킬**(다단계 + 분기·게이트, 컨텍스트 격리 불필요) → **서브 에이전트**
((a)격리 (b)병렬 (c)컨텍스트 예산 중 최소 하나가 참일 때만).
병렬로 같은 트리를 쓰는 에이전트는 `isolation: "worktree"`로 띄운다.
Red→Green→Eval 파이프라인에 팀 모드(SendMessage)를 쓰지 않는다 — 가치가 격리다.

## 참조 맵 — 작업 유형별 읽을 파일

| 작업 | 먼저 읽을 파일 |
|---|---|
| **모든 개발 작업 시작·완료** | `docs/progress.md` — 진행 원장, 갱신 의무 |
| 세션 시작·재개·체크포인트 | `checkpoint-resume` 스킬 |
| 스펙 인터뷰 | `specs/interview/question-bank.md` |
| RQ 구현·테스트·평가 | `tdd-workflow` 스킬 (.claude/skills/) |
| PR 머지 전 | `review-gate` 스킬 — APPROVE 없이 머지 금지 |
| 하네스 변경 착수 전 | `harness-audit` 스킬 — 변경은 한 번에 1건, 순서는 전이→커밋→평가 |
| 같은 원인으로 2회 실패 | `harness/recurrence.md` — 등재+처방 의무. 미처방이면 `policy-lint` P11이 차단 |
| 주간 회고·지표 | `retro-metrics` 스킬, `harness/metrics-baseline.md` |
| UI 작업 | `docs/design/DESIGN.md` (진실 공급원) |
| 골든 케이스·평가 | `evals/README.md` |
| 하네스 점검·이력 | `harness/sensor-catalog.md`, `docs/harness/changelog.md` |

## 최상위 규칙

- **원장 우선**: 작업 시작 전 `docs/progress.md`에 요구사항·참조 파일을 확인·기록(🔄)
  하고, 완료 시 체크(✅)한다. 원장에 없는 작업은 행을 추가한 뒤 시작한다.
- **단계 전환은 대화식으로**: 다음 단계 진입 전 최소 3개 선택지를 제시하고
  결정을 받는다. 첫 번째가 권장안 "(Recommended)". AskUserQuestion 권장.
  단, 하드 게이트(스펙 동결·리뷰 게이트)가 금지하는 선택지는 제시하지 않는다
  (요청 < 보장). 본질적 이진 결정은 3개 미만 예외 허용.
- 읽지 않은 파일·검증하지 않은 사실에 대해 단정하지 않는다 — 판단의 근거는
  직접 확인한 증거(파일 내용·실행 출력)다.
- 스펙 항목 1개 = 브랜치 1개 = PR 1개. 스펙 변경은 코드와 같은 PR에.
  (예외: **해당 RQ의 구현 착수 전** — 아직 코드가 없는 RQ의 신설·개정과,
  requirements를 건드리지 않는 ADR·하네스·디자인 전용 PR은 드리프트가 아니라
  백로그 추가다. 이 시점을 **"구현 게이트"**라 하며 **RQ 단위로 판정**한다
  — 이 문서가 유일한 정의처다. 게이트 이후의 스펙 변경·ADR 대체는 관련 코드와
  동행해야 한다. — ADR·하네스·디자인 전용 카브아웃은 PR #7에서 명문화된 것을 포섭)
- TDD (Red→Green→Refactor). 완료 주장에는 테스트 실행 출력을 증거로.
- 3스텝 이상 작업은 plan mode 승인 먼저. 탐색·조사는 서브에이전트에게.
- 하네스 변경 시 `docs/harness/changelog.md`에 기록.

## 금지 (hook·CI·permissions가 강제)

- 스펙에 없는 기능 추가 (스코프 크리프)
- Deep Interview 미완료(🟡 존재) 상태의 구현(src/tests) 착수
  — `PLAN→RED` 가드 `no_pending_spec`이 전이를 거부한다
- 실패 테스트를 스킵/삭제로 "해결" · ADR 없는 라이브러리/아키텍처 변경
- 시크릿·환경 파일 읽기/커밋
- 현재 단계가 허용하지 않는 경로에 쓰기 — `gate_phase.py`가 거부한다.
  우회는 `python harness/phase.py force --reason "…"`(사람 승인)뿐이고,
  `forced:true`로 이력에 박제되어 주간 리포트 최상단에 노출된다.

## 명령어·컨벤션

- 검증 일괄: `node scripts/check.mjs` (`scripts/check.sh`는 이 파일을 부르는 shim)
- 빠른 검사: `--fast` · Red 정당성 판정: `--red --rq RQ-XX` · flake: `--repeat N`
- 커밋: `feat|fix|chore|test|docs(scope): 설명` · 브랜치: `feat/<RQ-ID>-<설명>`
- 한 워킹트리를 여러 에이전트가 공유할 땐 `git commit -- <경로>`만 쓴다.
  경로 없는 `git commit`은 남이 스테이징해 둔 것까지 싣는다(2026-07-27 3회 발생).
