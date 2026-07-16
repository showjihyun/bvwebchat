# 하네스 변경 이력

> CLAUDE.md에서 분리된 이력 원장. 하네스(에이전트·스킬·hook·CI·규칙) 변경 시
> 반드시 여기에 기록한다. 목적: 진화 방향 추적 + 퇴행(regression) 방지.

| 날짜 | 변경 내용 | 대상 | 사유 |
|------|----------|------|------|
| 2026-07-16 | 인터뷰 G(테스트)·H(디자인) 섹션, ADR-0005 예약, GB-04/05, CI M3 검사 추가 | specs, docs/adr, evals, ci.yml | TDD 도입 준비 |
| 2026-07-16 | TDD 파이프라인 하네스 구성 — test-writer·coder(Sonnet 5), evaluator(Opus) | .claude/agents, .claude/skills | 평가·테스트 세션 분리 + 모델 지정 (사용자 지시) |
| 2026-07-16 | git 저장소 초기화 + hook 인터프리터 수정 (python3→python, bash→Git Bash 절대경로) | .git, .claude/settings.json | Windows에서 hook 무음 실패 (하네스 점검 결함 ②③) |
| 2026-07-16 | CI fetch-depth:0, check.sh 권한 패턴 `:*`, 골든 파일 ask 게이트 | ci.yml, .claude/settings.json | 하네스 점검 결함 ④⑤⑥ 해소 |
| 2026-07-16 | 솔로 리뷰 게이트(reviewer+review-gate) + CD 골격(deploy.yml+smoke.sh) + main 브랜치 보호 | .claude/agents, .claude/skills, .github/workflows, scripts | 1인 다역 체제 — 사람 리뷰 불가·CD 부재 보완 |
| 2026-07-16 | 스펙 동결 게이트 — 🟡 존재 시 src/tests 수정(hook)·머지(CI) 차단 | .claude/hooks, settings.json, ci.yml | 인터뷰 생략 후 구현 착수 방지 (사용자 지시: 강제) |
| 2026-07-16 | 단계 전환 대화식 규칙 — Recommended 포함 최소 3개 선택지 제시 | CLAUDE.md 작업 방식 | 사용자 지시: 매 다음 단계를 대화식으로 진행 |
| 2026-07-16 | 진행 원장(docs/progress.md) 신설 + CLAUDE.md 포인터 인덱스화 + 변경 이력 분리(이 파일) | CLAUDE.md, docs/ | 사용자 지시(최우선 규칙): 요구사항·참조 파일 기록 후 진행, CLAUDE.md 최소화 |
| 2026-07-16 | 리뷰 후속 반영 — "읽지 않은 파일 단정 금지" 복원, 대화식 규칙에 하드 게이트 위계·이진 예외 명시, ADR 미작성 각주 | CLAUDE.md, docs/progress.md | PR #4·#5 독립 리뷰 지적 (major 1 + minor 2) |
| 2026-07-17 | 스펙-코드 동행 규칙에 동결·ADR·하네스 전용 PR 예외 명문화 | CLAUDE.md | PR #7 리뷰 M-2 — spec-only PR과의 표면 충돌 해소 |
