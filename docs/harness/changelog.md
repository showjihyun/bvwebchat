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
| 2026-07-17 | 게이트 실질화 — 스캐폴드(TS/Vitest/ESLint) + check.sh·ci.yml 실명령, 예외 문구 조임(m-4), 스택 문답 기록(m-3) | package.json, scripts/check.sh, ci.yml, CLAUDE.md, answers.md | ADR-0005 승인에 따른 활성화 (실측: fast 1.4초/전체 3.2초) |
| 2026-07-17 | 디자인 hand-off 브리프 + 절차 문서화 (Step 1~4 + 검증 체크리스트) | docs/design/handoff-brief.md, CLAUDE.md 참조 맵 | Phase 3.5 — 클로드 디자인 선행 방식(인터뷰 Q26)의 인수인계 절차 박제 |
| 2026-07-17 | 디자인 인터뷰(D1~D16) 추가 + 브리프 §3을 구체적 디자인 방향으로 재작성 | specs/interview/design-answers.md, docs/design/handoff-brief.md | 초판 브리프가 요구사항만 담아 몰개성한 산출물 위험 — H섹션이 "어떻게 확보"만 묻고 "어때야 하는지"를 안 물은 공백 |
| 2026-07-17 | 스펙 v1.1 — RQ-18(안 읽음 개수) 신설, ADR-0003 세션 상태 확장, GA-12~16, D13 개정 | specs/requirements.md, docs/adr/0003, evals/golden, design-answers.md | 사용자 요청: 숫자 배지 채택 — 표시가 아닌 상태 추적이라 스펙 개정이 선행돼야 함 |
| 2026-07-17 | PR #11 리뷰 처방 반영 — ADR-0003에 활성 room 정의, RQ-18 상한 50·수명 정정, 동행 규칙에 스펙 개정 예외 명문화, M2 측정식 축소, 브리프 3건 정정(폰트·아바타·체크리스트), Q37 교훈 정정·Q38 신설 | requirements, ADR-0003, CLAUDE.md, metrics-baseline, handoff-brief, question-bank, golden | 리뷰 major 6·minor 7 — "보고 있는 room" 미정의로 test-writer가 멈출 상태였음 |
| 2026-07-20 | 재리뷰 처방 반영 — 게이트 정의 단일화(CLAUDE.md 유일 정의처)·근거 문서(design-answers) 동기화·GA-17 정정·ADR·하네스·디자인 카브아웃 복원(PR #7 포섭) | CLAUDE.md, requirements, metrics-baseline, design-answers, ADR-0003, handoff-brief, golden | 재리뷰 major 3·minor 5 — 처방 커밋이 근거 문서를 빠뜨려 근거가 RQ와 모순한 상태였음 |
