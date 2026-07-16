# 웹 채팅 앱 — 프로젝트 헌법

room 참여 채팅 + global 채팅을 지원하는 웹 채팅 앱. 마감 7/31.
이 프로젝트는 하네스 워크플로우 Lesson & Learn을 겸한다.

## 진실 공급원 (우선순위 순)

1. `specs/requirements.md` — 요구사항과 인수 기준. 여기 없는 기능은 만들지 않는다.
2. `docs/adr/` — 아키텍처 결정. ADR과 모순되는 구현 금지. 바꾸려면 새 ADR 먼저.
3. 이 파일 — 작업 방식 규칙.

충돌 시 위가 이긴다. 스펙이 모호하면 추측하지 말고 질문한다.

## 작업 방식

- 스펙 항목 1개 = 브랜치 1개 = PR 1개. 스펙 변경과 코드 변경은 같은 PR에 담는다.
- 3스텝 이상 작업은 plan mode로 계획을 먼저 승인받는다.
- TDD: `specs/requirements.md`의 인수 기준을 테스트로 먼저 쓴다 (Red → Green → Refactor).
- 코드베이스 탐색·조사는 서브에이전트에게 위임한다 (메인 컨텍스트 보호).
- 완료 주장 시 반드시 테스트 실행 출력을 증거로 보여준다.
- 읽지 않은 파일에 대해 단정하지 않는다.

## 명령어

<!-- 스택 확정(ADR-0001~0004) 후 채울 것. 예시: -->
<!-- 빌드: npm run build / 테스트: npm test / 린트: npm run lint -->
- 검증 일괄: `bash scripts/check.sh`

## 컨벤션

- 커밋: `feat|fix|chore|test|docs(scope): 설명` (한글 허용)
- 브랜치: `feat/<스펙ID>-<짧은설명>` 예: `feat/RQ-03-room-join`
- 시크릿·환경 파일은 절대 읽거나 커밋하지 않는다 (permissions로도 차단됨).

## 금지

- 스펙에 없는 기능 추가 (스코프 크리프)
- 실패 테스트를 스킵/삭제로 "해결"
- ADR 없이 라이브러리·아키텍처 변경
- Deep Interview 미완료(requirements.md에 🟡 존재) 상태에서 구현(src/tests) 착수
  — hook(수정 차단)과 CI(머지 차단)가 강제한다

## 하네스: TDD 구현 파이프라인

**목표:** 테스트 작성·구현·평가를 별도 에이전트 세션으로 격리해 자기 채점 오염을 차단.

**트리거:** RQ 구현, 코딩, 테스트 작성·실행, 구현 평가·검증·QA 요청 시
`tdd-workflow` 스킬을 사용하라. 스펙 인터뷰·ADR 작성·단순 질문은 직접 처리 가능.
PR 머지 전에는 `review-gate` 스킬로 reviewer(Opus)의 APPROVE를 받는다 —
솔로 체제의 리뷰 게이트이므로 우회 금지.

**변경 이력:**
| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-16 | 인터뷰 G(테스트)·H(디자인) 섹션, ADR-0005 예약, GB-04/05, CI M3 검사 추가 | specs, docs/adr, evals, ci.yml | TDD 도입 준비 |
| 2026-07-16 | TDD 파이프라인 하네스 구성 — test-writer·coder(Sonnet 5), evaluator(Opus) | .claude/agents, .claude/skills | 평가·테스트 세션 분리 + 모델 지정 (사용자 지시) |
| 2026-07-16 | git 저장소 초기화 + hook 인터프리터 수정 (python3→python, bash→Git Bash 절대경로) | .git, .claude/settings.json | Windows에서 hook 무음 실패 (하네스 점검 결함 ②③) |
| 2026-07-16 | CI fetch-depth:0, check.sh 권한 패턴 `:*`, 골든 파일 ask 게이트 | ci.yml, .claude/settings.json | 하네스 점검 결함 ④⑤⑥ 해소 |
| 2026-07-16 | 솔로 리뷰 게이트(reviewer+review-gate) + CD 골격(deploy.yml+smoke.sh) + main 브랜치 보호 | .claude/agents, .claude/skills, .github/workflows, scripts | 1인 다역 체제 — 사람 리뷰 불가·CD 부재 보완 |
| 2026-07-16 | 스펙 동결 게이트 — 🟡 존재 시 src/tests 수정(hook)·머지(CI) 차단 | .claude/hooks, settings.json, ci.yml | 인터뷰 생략 후 구현 착수 방지 (사용자 지시: 강제) |
