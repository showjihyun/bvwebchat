---
name: review-gate
description: PR 머지 전 독립 리뷰 게이트. "리뷰해줘", "머지 전 검토", "PR 리뷰", "머지해도 돼?", "재리뷰", "리뷰 다시" 요청 시, 그리고 tdd-workflow Phase 4·harness-audit 종료 시 반드시 이 스킬을 사용하라. 솔로 체제에서 사람 리뷰어를 대체한다 — reviewer 에이전트(Opus)가 별도 세션에서 diff를 검토해 APPROVE 판정을 내려야 REVIEW→RELEASE 전이가 열린다. 코드 구현·수정 요청(tdd-workflow), 하네스 점검(harness-audit), 스펙 인터뷰에는 사용하지 않는다.
---

# Review Gate — 머지 전 독립 리뷰

솔로 체제의 리뷰 게이트. GitHub은 자기 PR을 자기가 승인할 수 없으므로,
사람 리뷰 대신 **격리된 세션의 reviewer 에이전트(Opus) APPROVE**를 머지의
필요조건으로 삼는다. 브랜치 보호(status check `gate` 필수)와 함께 이중
게이트를 구성한다: CI가 결정론적 검사를, reviewer가 추론적 검사를 맡는다.

**규칙: reviewer의 APPROVE 없이 머지하지 않는다.** blocker가 있는데 급하다는
이유로 우회하면 이 게이트는 그날로 장식이 된다 (트랙 B GB-04와 같은 원리).
이 규칙은 이제 산문이 아니라 전이 가드다 — `REVIEW→RELEASE`의 `reviewer_approve`
가드가 `_workspace/review/{브랜치명}.md`에서 `판정 … APPROVE`를 찾지 못하면
전이가 거부된다.

## Phase 0: 대상·전제 확인

1. 단계가 `REVIEW`인지 확인: `python harness/phase.py show`.
   아니라면 선행 단계를 먼저 닫는다 (`EVAL→REVIEW`는 evaluator PASS를,
   `HARNESS→REVIEW`는 트랙 B 아티팩트와 changelog 동행을 요구한다).
2. 리뷰 대상 결정: 현재 브랜치 vs `main` (또는 사용자가 지정한 PR/브랜치)
3. 전제: 작업이 커밋된 상태여야 한다. 미커밋 변경이 있으면 먼저 커밋을 요청.
   여러 에이전트가 트리를 공유 중이면 `git commit -- <경로>`만 쓴다.
4. `_workspace/review/{브랜치명}.md`가 이미 있으면 **재리뷰 모드** —
   이전 보고서를 reviewer 입력에 포함한다

## Phase 1: 리뷰 패키지 수집 (오케스트레이터가 직접)

- `git diff main...HEAD` + `--stat` (변경 파일 목록)
- PR 설명·커밋 메시지에서 관련 RQ-ID/ADR 번호 추출
- 관련 스펙 문장(requirements.md)과 ADR 파일 경로 목록화

> **전이 전에 `session.json`을 갱신하라.** `phase.py enter`는 상태가 HEAD 커밋보다
> 낡으면 거부한다 — 체크포인트가 세션 스냅샷을 품고 재개 시험은 그것만 읽으므로,
> 낡은 채 전이하면 낡은 서사가 박제된다(`harness/recurrence.md` R6).
> 순서: `phase.py session` → `phase.py enter` → `git commit -- .harness/state`.
>
> **REQUEST_CHANGES 처리 시 주의**: 매트릭스의 `exit_hint`는 `GREEN`을 가리키는데
> 그것은 **RQ 구현 리뷰**를 전제한 것이다. 하네스 PR의 지적 사항은 `.claude/**`·
> `harness/**`·`scripts/**`에 있고 `GREEN`은 `src/**`만 열어 준다 — `IDLE`을 경유해
> `HARNESS`로 가야 한다. (2026-07-28 3차 재리뷰에서 실제로 걸렸다. 후속 이슈.)

## Phase 2: 독립 리뷰 — reviewer (별도 세션, opus)

`Agent(subagent_type: "reviewer", model: "opus")` 호출. 프롬프트에 포함:
- diff 전문(또는 대용량이면 파일 경로 목록 + 읽기 지시), 관련 RQ/ADR 목록
- 산출 경로: `_workspace/review/{브랜치명}.md`
- **구현 세션의 대화·의도 설명은 전달하지 않는다** — 작성자 논리와의 격리가
  이 게이트의 존재 이유다

## Phase 2.5: 보고서 형식 검사 (판정 처리 전에)

> `tdd-workflow` 에 같은 검사(Phase 3.5)가 2026-08-04에 생겼다 — 그전까지 **한쪽만**
> 선검사를 했고, 그래서 evaluator 보고서의 형식 불일치가 평가에 20분을 쓴 **뒤**
> 전이 시점에야 드러났다. 계약의 비대칭은 비용을 물릴 때까지 보이지 않는다.

보고서에 아래 두 줄이 있는지 먼저 본다.

```
판정: APPROVE | REQUEST_CHANGES
라벨: drift | 없음
```

**둘 중 하나라도 없으면 리뷰를 미완성으로 간주하고 reviewer를 재요청한다.**
판정 내용을 오케스트레이터가 대신 채워 넣지 않는다.

- `판정:` 줄이 없으면 `REVIEW→RELEASE`의 `reviewer_approve` 가드가 읽지 못한다
  — 판정이 있어도 형식이 다르면 전이가 거부된다.
- **재리뷰로 보고서에 판정이 여러 개면 가드는 마지막 것만 본다** (2026-08-03,
  `latest_of`). 앞에 `APPROVE`가 있어도 마지막이 `REQUEST_CHANGES`면 열리지 않는다 —
  덮어쓰기 관례에서는 판정이 하나뿐이라 차이가 없지만, append로 바뀌는 순간
  **옛 판정이 최신을 덮는 것**이 `evaluator_pass`에서 실제로 일어났다(RQ-13-a).
- `라벨:` 줄이 없으면 M1(스펙 밖 변경)이 그 PR에 대해 **측정 불가**가 된다.
  규약은 강제되지 않으면 지켜지지 않고, 지켜지지 않은 규약은 지표를 지운다.

## Phase 3: 판정 처리

- **APPROVE** → `python harness/phase.py enter RELEASE`.
  전이가 `reviewer_approve` 가드로 보고서를 한 번 더 확인한다 — 통과하면
  RELEASE의 쓰기 허용은 `docs/progress.md`·`docs/harness/changelog.md`뿐이므로,
  머지 직전에 코드가 더 들어가는 일이 구조적으로 막힌다.
  사용자에게 보고서 요약과 함께 "머지 가능"을 보고하고,
  머지 실행은 사용자 확인 후 (`gh pr merge` — `permissions.ask`)
- **REQUEST_CHANGES** → blocker 목록을 사용자에게 보고. `enter GREEN`으로 되돌린다.
  - 구현 수정이 필요하면 tdd-workflow(coder 재호출)로 라우팅
  - 스펙·ADR 문제면 해당 문서 개정이 먼저 (같은 PR)
  - 하네스 변경이면 `enter HARNESS` + `harness-audit` 스킬
  - 수정 후 이 스킬을 재실행 (재리뷰 모드)
- major/minor만 있으면 APPROVE와 동일하게 머지 가능 — 단, 지적 사항을
  사용자에게 보고하고 후속 처리 여부를 확인받는다

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| diff 없음 (main과 동일) | 리뷰 대상 없음 보고, 게이트 통과 아님 |
| reviewer 실행 실패 | 1회 재시도, 재실패 시 중단·보고 (리뷰 생략하고 머지 금지) |
| REQUEST_CHANGES 2회 연속 | 자동 반복 중단 — 사용자 개입 (설계 자체의 재검토 필요 신호) |
| `enter RELEASE`가 거부됨 | 보고서의 판정 문자열을 확인한다. 가드는 `판정 … APPROVE` 패턴을 찾는다 — 형식이 다르면 판정이 있어도 못 읽는다 |

## 테스트 시나리오

1. **정상**: tdd-workflow가 RQ-03 PASS 후 이 스킬 호출 → reviewer APPROVE →
   `enter RELEASE` → 사용자 확인 → 머지 → deploy.yml 트리거.
2. **에러**: 스펙에 없는 편의 기능이 diff에 포함 → reviewer가 스코프 검사에서
   blocker 판정(M1) → 머지 차단 → 스펙 개정 또는 코드 제거 후 재리뷰.
