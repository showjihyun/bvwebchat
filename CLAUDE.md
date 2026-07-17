# 웹 채팅 앱 — 프로젝트 헌법 (포인터 인덱스)

room 참여 채팅 + global 채팅 웹 앱. 마감 7/31. 하네스 워크플로우 L&L 겸용.
이 파일은 최소한의 규칙과 **참조 경로**만 담는다 — 상세는 참조 파일에서 읽는다.

## 진실 공급원 (충돌 시 위가 이김)

1. `specs/requirements.md` — 요구사항(EARS). 여기 없는 기능은 만들지 않는다.
2. `docs/adr/` — 아키텍처 결정. 모순 구현 금지, 변경은 새 ADR 먼저.
3. 이 파일 — 최상위 규칙. 모호하면 추측하지 말고 질문한다.

## 참조 맵 — 작업 유형별 읽을 파일

| 작업 | 먼저 읽을 파일 |
|---|---|
| **모든 개발 작업 시작·완료** | `docs/progress.md` — 진행 원장, 갱신 의무 |
| 스펙 인터뷰 | `specs/interview/question-bank.md` |
| RQ 구현·테스트·평가 | `tdd-workflow` 스킬 (.claude/skills/) |
| PR 머지 전 | `review-gate` 스킬 — APPROVE 없이 머지 금지 |
| UI 작업 | `docs/design/DESIGN.md` (미확보 시 `docs/design/handoff-brief.md` 절차) |
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
  (예외: **해당 RQ의 구현 착수 전** — 아직 코드가 없는 RQ의 신설·개정은 드리프트가
  아니라 백로그 추가다. 이 시점을 **"구현 게이트"**라 하며 **RQ 단위로 판정**한다
  — 이 문서가 유일한 정의처다. 게이트 이후의 스펙 변경·ADR 대체는 관련 코드와
  동행해야 한다)
- TDD (Red→Green→Refactor). 완료 주장에는 테스트 실행 출력을 증거로.
- 3스텝 이상 작업은 plan mode 승인 먼저. 탐색·조사는 서브에이전트에게.
- 하네스 변경 시 `docs/harness/changelog.md`에 기록.

## 금지 (hook·CI·permissions가 강제)

- 스펙에 없는 기능 추가 (스코프 크리프)
- Deep Interview 미완료(🟡 존재) 상태의 구현(src/tests) 착수
- 실패 테스트를 스킵/삭제로 "해결" · ADR 없는 라이브러리/아키텍처 변경
- 시크릿·환경 파일 읽기/커밋

## 명령어·컨벤션

- 검증 일괄: `bash scripts/check.sh` / 개별: `npm run lint` · `npm run typecheck` · `npm test`
- 커밋: `feat|fix|chore|test|docs(scope): 설명` · 브랜치: `feat/<RQ-ID>-<설명>`
