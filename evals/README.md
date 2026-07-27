# 골든 eval 세트

두 트랙은 **다른 것을 잰다**. 트랙 A는 제품이 스펙대로 도는가를, 트랙 B는
하네스가 압박 아래에서도 규칙을 지키는가를 잰다. 합치면 둘 다 흐려진다.

| | 트랙 A (`golden/track-a-product.jsonl`) | 트랙 B (`golden/track-b-harness.jsonl`) |
|---|---|---|
| 대상 | 제품 행동 | 하네스·에이전트 행동 |
| 케이스 | 27 | 7 (GB-01~07) |
| 판정 | 통합 테스트 (`verify` 필드가 가리키는 파일) | rubric — `auto`(결정론) + `judge`(추론) |
| 실행 | `npx vitest run` · `golden-coverage.mjs` | `eval-b.mjs` |
| 게이트 | `GREEN→EVAL`의 `golden_coverage` 가드 | `HARNESS→REVIEW`의 `track_b_passing` 가드 |

## 트랙 A — 제품 행동

각 케이스는 통합 테스트 코드로 구현하고 `verify` 필드에 테스트 파일 경로를 적는다.

```
node scripts/golden-coverage.mjs              # 전체 커버리지
node scripts/golden-coverage.mjs --rq RQ-13   # 해당 RQ만 (전이 가드가 이 형태로 부른다)
node scripts/golden-coverage.mjs --orphans    # 어느 RQ에도 매핑되지 않은 케이스
```

이 검사가 묻는 것은 **테스트의 존재 여부**이지 통과 여부가 아니다. 그것이
자동 테스트(S2)와의 결정적 차이다 — "테스트 전부 통과인데 GA-22에 해당하는
테스트가 아예 없다"는 S2로 원리적으로 관측되지 않는다.

배포 후 스모크(`scripts/smoke.sh`)는 트랙 A의 **프로덕션 승격분**이다.
새 테스트를 만들지 않고 GA-01·GA-04를 실제 컨테이너에 대해 재실행한다.

## 트랙 B — 하네스 행동

### 왜 지금까지 한 번도 안 돌았나

판정이 전부 사람 눈이었기 때문이다. `status:"todo"`가 5건 모두에 붙은 채로
남아 있었다. 단계 상태 머신이 생기면서 **rubric의 절반이 공짜로 결정론이 된다** —
`phase.jsonl`·`tools.jsonl`이 곧 증거다.

### 케이스 스키마

```json
{
  "id": "GB-07",
  "type": "harness_task",
  "task": "에이전트에게 던지는 입력",
  "expected_behavior": "기대하는 행동",
  "rubric": [
    { "text": "…", "auto": { "check": "blocked", "args": { "min": 1, "glob": "src/**" } } },
    { "text": "…", "judge": "llm" }
  ],
  "last_run": { "sha": null, "at": null, "verdict": null, "artifact": null },
  "status": "todo",
  "note": "선택 — 이 케이스가 무엇을 증명하고 무엇을 증명하지 않는지"
}
```

- `auto`가 있는 rubric = **blocking**. 로그·git에서 기계로 판정한다.
- `judge`가 있는 rubric = **non-blocking**. LLM 판정은 비결정론이라
  판정 분산만으로 PR이 빨개질 수 있다. **2회 연속 실패 시에만** 문제로 다룬다.
- `last_run`이 실행 증거다. `sha`는 평가 당시의 HEAD.

### 체커 어휘 (전부 7개)

| `check` | `args` | 원천 |
|---|---|---|
| `no_write` | `{glob, phase?}` | `tools.jsonl` gate_block · `trajectory.jsonl` file_edit_counts · git diff |
| `no_commit` | `{glob, unless_transition?}` | git |
| `transition` | `{from, to, forced}` | `phase.jsonl` |
| `guard_pass` | `{name}` | `phase.jsonl`의 `guards[].ok` |
| `no_force` | `{}` | `phase.jsonl`에 `forced:true` 0건 |
| `blocked` | `{min, glob?}` | `tools.jsonl` gate_block |
| `resume_test` | `{cold, min_score, max_files, max_minutes}` | `scripts/resume-test.mjs` 위임 |

어휘를 늘리기 전에, 그 판정을 기존 7개의 조합으로 표현할 수 있는지 먼저 본다.

### 실행 절차

```
node scripts/eval-b.mjs                     # 전 케이스 실행 → evals/results/track-b/<sha>.json
node scripts/eval-b.mjs --case GB-07        # 한 건만
node scripts/eval-b.mjs --verify-artifact   # 아티팩트가 현재 HEAD에 대해 유효한지 (전이 가드가 부른다)
```

1. `python harness/phase.py enter HARNESS` (또는 `harness-audit` 스킬이 대신 한다)
2. `node scripts/eval-b.mjs` — auto rubric이 로그에서 판정된다
3. 결과를 커밋한다: `evals/results/track-b/<sha>.json`
4. `HARNESS→REVIEW` 전이의 `track_b_passing` 가드가 아티팩트를 요구한다

**CI에서 `claude`를 돌리지 않는다.** 1인 프로젝트에서 CI에 API 키를 넣는 건
과하다. 로컬이 실행·커밋하고 CI는 head sha 일치만 본다. 정직하고 분수에 맞다.

### 정직한 한계

7 케이스는 얇다. 승격 루프가 케이스를 늘리기 전까지 이 게이트를 "안전망"이라
부르면 거짓말이고, **"스모크"** 라고 불러야 맞다.

> **미검증 (2026-07-27)**: `scripts/eval-b.mjs`·`scripts/resume-test.mjs`는
> 아직 저장소에 없다. 위 명령은 골든 파일이 확정한 계약이고, 러너가 생기면
> 이 절을 실행 출력으로 교체한다. GB-06의 `resume_test` rubric은 러너 부재
> 시 SKIP으로 빼고 나머지를 채점한다 — 없는 검사 하나 때문에 게이트 전체가
> 영구히 빨개지면 그 게이트는 그날로 무시된다.

## 승격 루프

주간 회고(`retro-metrics` 스킬)에서 `.harness/logs/trajectory.jsonl`을 훑고,
이상했던 세션의 입력을 여기 새 케이스로 추가한다. M7(골든 케이스 수)이
이 루프가 작동한다는 증거다.

승격 기준: 그 실패가 (a) 이미 한 번 **실제로** 일어났고, (b) 결정론적으로 판정
가능하면 `auto`로, (c) 판정에 추론이 필요하면 `judge`로. (b)도 (c)도 아니면
골든이 아니라 회고 메모다.

**정답(`then`·`rubric`)은 반드시 사람이 쓴다** — 에이전트가 자기 정답을 쓰게
하지 않는다. 강제 수단: `.claude/settings.json`의 permissions가
`evals/golden/**` 수정을 승인(ask) 게이트로 막는다. 에이전트가 초안을 쓰더라도
사람 승인을 거친다.
