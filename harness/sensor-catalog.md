# 센서 카탈로그 [스텁③] — 가드레일 지도 한 장

모델: Guide(행동 **전** 읽는 규칙) / Sensor(행동 **후** 관찰·교정).
실행: Comp(결정론적·빠름) / Inf(추론적·느림·비결정).
원칙: "반드시"는 hook·CI로 강제, "권장"은 Guide로.

## Guides (feed-forward)

| 이름 | 실행 | 배치 | 상태 |
|---|---|---|---|
| CLAUDE.md (헌법) | — | 세션 시작 시 로드 | ✅ |
| specs/requirements.md | — | 작업 착수 시 참조 | ✅ |
| docs/adr/ | — | 아키텍처 관련 작업 시 | ✅ (내용은 Phase 3) |
| plan mode 승인 | — | 3스텝 이상 작업 전 | ✅ (CLAUDE.md 규칙) |

## Sensors (feedback)

| 이름 | 실행 | 배치 | 강제 수단 | 상태 |
|---|---|---|---|---|
| 트래젝토리 로그 | Comp | 세션 종료(Stop) | hook | ✅ |
| 스펙 동결 게이트 (🟡 존재 시 구현 차단) | Comp | 구현 파일 수정 직전(PreToolUse) + PR(CI fail) | hook exit 2 + ci.yml | ✅ |
| 골든 정답 수정 승인 게이트 | Comp | evals/golden/** Edit·Write 시 | permissions (ask) | ✅ |
| 파일 수정 후 빠른 검사 | Comp | 수정 직후(PostToolUse) | hook → check.sh --fast | 🟡 스택 확정 후 |
| lint / typecheck | Comp | pre-commit·CI | check.sh | 🟡 스택 확정 후 |
| 단위·통합 테스트 (트랙 A) | Comp | CI, PR 머지 게이트 | ci.yml | 🟡 스택 확정 후 |
| 테스트-코드 동행 검사 (M3 프록시) | Comp | CI, PR | ci.yml (경고) | ✅ (경로 패턴은 ADR-0005 후 확정) |
| 독립 평가 에이전트 (evaluator) | Inf | 각 RQ 구현 직후 (tdd-workflow Phase 3) | 오케스트레이터 스킬 | ✅ |
| 트랙 B rubric 체크 | Inf | 하네스 변경 시·주간 | 사람 (수동) | ✅ 절차만 |
| PR 리뷰 게이트 (reviewer, 솔로 대체) | Inf | PR 머지 전 (review-gate 스킬) | APPROVE 없이 머지 금지 + 브랜치 보호(status check `gate` 필수) | ✅ |
| 배포 후 스모크 (트랙 A 승격) | Comp | main 머지 → 배포 직후 | deploy.yml → smoke.sh | 🟡 배포 대상(RQ-17) 확정 후 |

## 운영 규칙

1. 센서는 가능한 한 왼쪽(수정 직후 > pre-commit > CI > 리뷰)에 배치한다.
2. 센서 에러 메시지에는 "어떻게 고치는지"를 담는다 — 에이전트가 읽고
   자기 교정하는 것이 목적이다.
3. 같은 실수가 2회 반복되면: 그 실수를 잡는 센서를 추가하거나,
   Guide 한 줄을 추가한다. (둘 다는 과잉 — 하나만)
4. 분기마다 이 표를 갱신한다. 상태가 전부 ✅면 이 문서가 곧 회고 자료다.
