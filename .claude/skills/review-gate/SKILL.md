---
name: review-gate
description: PR 머지 전 독립 리뷰 게이트. "리뷰해줘", "머지 전 검토", "PR 리뷰", "머지해도 돼?", "재리뷰", "리뷰 다시" 요청 시, 그리고 tdd-workflow Phase 4에서 PR 준비 시 반드시 이 스킬을 사용하라. 솔로 체제에서 사람 리뷰어를 대체한다 — reviewer 에이전트(Opus)가 별도 세션에서 diff를 검토해 APPROVE 판정을 내려야 머지할 수 있다. 코드 구현·수정 요청(tdd-workflow), 하네스 점검, 스펙 인터뷰에는 사용하지 않는다.
---

# Review Gate — 머지 전 독립 리뷰

솔로 체제의 리뷰 게이트. GitHub은 자기 PR을 자기가 승인할 수 없으므로,
사람 리뷰 대신 **격리된 세션의 reviewer 에이전트(Opus) APPROVE**를 머지의
필요조건으로 삼는다. 브랜치 보호(status check `gate` 필수)와 함께 이중
게이트를 구성한다: CI가 결정론적 검사를, reviewer가 추론적 검사를 맡는다.

**규칙: reviewer의 APPROVE 없이 머지하지 않는다.** blocker가 있는데 급하다는
이유로 우회하면 이 게이트는 그날로 장식이 된다 (트랙 B GB-04와 같은 원리).

## Phase 0: 대상·전제 확인

1. 리뷰 대상 결정: 현재 브랜치 vs `main` (또는 사용자가 지정한 PR/브랜치)
2. 전제: 작업이 커밋된 상태여야 한다. 미커밋 변경이 있으면 먼저 커밋을 요청
3. `_workspace/review/{브랜치명}.md`가 이미 있으면 **재리뷰 모드** —
   이전 보고서를 reviewer 입력에 포함한다

## Phase 1: 리뷰 패키지 수집 (오케스트레이터가 직접)

- `git diff main...HEAD` + `--stat` (변경 파일 목록)
- PR 설명·커밋 메시지에서 관련 RQ-ID/ADR 번호 추출
- 관련 스펙 문장(requirements.md)과 ADR 파일 경로 목록화

## Phase 2: 독립 리뷰 — reviewer (별도 세션, opus)

`Agent(subagent_type: "reviewer", model: "opus")` 호출. 프롬프트에 포함:
- diff 전문(또는 대용량이면 파일 경로 목록 + 읽기 지시), 관련 RQ/ADR 목록
- 산출 경로: `_workspace/review/{브랜치명}.md`
- **구현 세션의 대화·의도 설명은 전달하지 않는다** — 작성자 논리와의 격리가
  이 게이트의 존재 이유다

## Phase 3: 판정 처리

- **APPROVE** → 사용자에게 보고서 요약과 함께 "머지 가능"을 보고.
  머지 실행은 사용자 확인 후 (`gh pr merge`)
- **REQUEST_CHANGES** → blocker 목록을 사용자에게 보고.
  - 구현 수정이 필요하면 tdd-workflow(coder 재호출)로 라우팅
  - 스펙·ADR 문제면 해당 문서 개정이 먼저 (같은 PR)
  - 수정 후 이 스킬을 재실행 (재리뷰 모드)
- major/minor만 있으면 APPROVE와 동일하게 머지 가능 — 단, 지적 사항을
  사용자에게 보고하고 후속 처리 여부를 확인받는다

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| diff 없음 (main과 동일) | 리뷰 대상 없음 보고, 게이트 통과 아님 |
| reviewer 실행 실패 | 1회 재시도, 재실패 시 중단·보고 (리뷰 생략하고 머지 금지) |
| REQUEST_CHANGES 2회 연속 | 자동 반복 중단 — 사용자 개입 (설계 자체의 재검토 필요 신호) |

## 테스트 시나리오

1. **정상**: tdd-workflow가 RQ-03 PASS 후 이 스킬 호출 → reviewer APPROVE →
   사용자 확인 → 머지 → deploy.yml 트리거.
2. **에러**: 스펙에 없는 편의 기능이 diff에 포함 → reviewer가 스코프 검사에서
   blocker 판정(M1) → 머지 차단 → 스펙 개정 또는 코드 제거 후 재리뷰.
