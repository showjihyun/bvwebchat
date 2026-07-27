---
name: tdd-workflow
description: 웹 채팅 앱의 RQ 구현 파이프라인. RQ·기능 구현, 코딩, 테스트 작성, 테스트 실행, 구현 평가·검증·QA 요청 시 반드시 이 스킬을 사용하라. "RQ-XX 구현해줘", "테스트부터 짜줘", "구현 평가/검증해줘", "다시 실행", "재실행", "수정", "보완", "이전 구현 개선" 요청 포함. Red(test-writer)→Green(coder)→독립 평가(evaluator)를 각각 별도 에이전트 세션으로 실행하고, 각 경계에서 harness/phase.py 전이를 밟는다. 스펙 인터뷰, ADR 작성, 하네스 구성·점검(harness-audit), 단순 문서 편집에는 사용하지 않는다.
---

# TDD Workflow — Red → Green → 독립 평가 파이프라인

스펙(RQ) 1건을 별도 에이전트 세션 3개로 구현·검증하는 오케스트레이터.

**실행 모드: 서브 에이전트 (파이프라인 + 생성-검증 패턴).**
팀 모드를 쓰지 않는 이유: 이 파이프라인의 가치는 세션 격리다. 테스트 작성자가
구현을 보면 구현에 맞춘 테스트가 되고, 평가자가 구현 세션의 맥락을 공유하면
자기 채점이 된다. 팀 통신(SendMessage)은 이 격리를 깨므로 구조적으로 해롭다.
데이터는 `_workspace/` 파일로만 전달한다. **이 판단은 L3에서도 그대로 옳다** —
세 에이전트 전원이 토폴로지 사다리의 (a) 격리 이득으로 정당화된다.

**모델 정책 (사용자 지정, 2026-07-16):**

| 에이전트 | model | 이유 |
|---|---|---|
| test-writer | `sonnet` (Sonnet 5) | 코딩·테스트 작업 — 사용자 지정 |
| coder | `sonnet` (Sonnet 5) | 코딩·테스트 작업 — 사용자 지정 |
| evaluator | `opus` | 판정 품질이 파이프라인 신뢰도의 상한 — 평가는 사용자 지정 범위 밖이므로 기본값 유지 |

Agent 도구 호출 시 `model` 파라미터를 명시한다 (에이전트 frontmatter와 이중 지정).

## 단계 전이가 이 파이프라인의 뼈대다

각 Phase 경계에서 `python harness/phase.py enter <PHASE>`를 호출한다.
전이가 거부되면 **그것이 전제조건 검사다** — 이 문서가 조건을 다시 나열하지 않는
이유이고, 나열하면 매트릭스와 문서가 서로 다른 답을 내기 시작한다.

| Phase | 전이 | 가드가 요구하는 것 | 쓰기 허용 |
|---|---|---|---|
| 0 | `enter PLAN` | — | `_workspace/**` `docs/progress.md` |
| 1 | `enter RED` | 스펙 🟡 0건 · `session.json` 선언 · 워킹트리 clean | `tests/**` |
| 2 | `enter GREEN` | `tests/**` 커밋 ≥1 · 정당한 Red (ADR-0005 결정3) | `src/**` |
| 3 | `enter EVAL` | 전체 검증 초록 · 골든 커버리지 | `_workspace/**` |
| 4 | `enter REVIEW` | evaluator PASS 보고서 | `_workspace/**` |

거부 메시지에는 고치는 법이 들어 있다. 읽고 조건을 만든 뒤 다시 전이한다.
`force`는 사람 승인(`permissions.ask`)이 필요하고 `forced:true`로 박제된다 —
파이프라인 안에서 쓰는 것은 사실상 파이프라인을 껐다는 뜻이다.

## Phase 0: 세션 선언 · 실행 모드 판별

1. **세션 선언** — `checkpoint-resume` 스킬로 `session.json`에 `task.rq`·`goal`·
   `acceptance`를 채운다. `goal`은 "무엇"이 아니라 **"왜"** 를 적는다.
   (`session_declared` 가드가 이 셋의 존재를 요구한다.)
2. **브랜치**: `feat/{RQ-ID}-{짧은설명}` 생성 (CLAUDE.md 규칙)
3. **실행 모드 판별**:
   - `_workspace/{RQ-ID}/` 없음 → 초기 실행 (Phase 1부터)
   - 존재 + 부분 수정 요청 → 부분 재실행 (해당 Phase의 에이전트만 재호출,
     기존 산출물을 입력으로 전달)
   - 존재 + 새로 시작 요청 → 기존 폴더를 `_workspace_prev/`로 이동 후 초기 실행
4. `python harness/phase.py enter PLAN`

## Phase 1: Red — test-writer (별도 세션, sonnet)

`python harness/phase.py enter RED` → `Agent(subagent_type: "test-writer",
model: "sonnet")`. 프롬프트에 포함:

- RQ-ID + EARS 문장 전문 (requirements.md에서 인용)
- 매핑된 GA-* 골든 케이스 전문 (track-a-product.jsonl에서 인용)
- ADR-0005 요약 (테스트 레벨·더블 허용 범위)
- 산출 경로: `_workspace/{RQ-ID}/01_test-writer_red.md`

완료 조건: Red 실행 출력이 산출물에 존재. 스펙 질문이 반환되면 파이프라인을
중단하고 질문을 사용자에게 전달한다 (추측으로 진행 금지).
**테스트 커밋을 여기서 만든다** — `tests_committed` 가드가 커밋을 요구하고,
그 전이 기록이 곧 M3 테스트 선행률의 측정 단위다.

## Phase 2: Green — coder (별도 세션, sonnet)

`python harness/phase.py enter GREEN` → `Agent(subagent_type: "coder",
model: "sonnet")`. 프롬프트에 포함:

- `_workspace/{RQ-ID}/01_test-writer_red.md` 경로 + 테스트 파일 목록
- 산출 경로: `_workspace/{RQ-ID}/02_coder_green.md`

테스트 파일 수정 금지를 프롬프트에 다시 적지 않아도 된다 — GREEN 단계의
`write_deny`에 `tests/**`가 있어 **물리적으로 불가능**하다. 다만 coder가 테스트가
틀렸다고 판단하면 보고하도록 돼 있고, 그 경로는 살아 있어야 한다.

완료 조건: 전체 스위트 Green 출력이 산출물에 존재. 테스트-스펙 모순 보고가
반환되면 중단하고 사용자 판단을 받는다.

## Phase 3: 독립 평가 — evaluator (별도 세션, opus)

`python harness/phase.py enter EVAL` → `Agent(subagent_type: "evaluator",
model: "opus")`. 프롬프트에는 **RQ-ID와 `_workspace/{RQ-ID}/` 경로만** 전달한다
— coder의 대화 내용·설명을 전달하지 않는다 (평가자는 파일과 코드만 본다).
산출: `_workspace/{RQ-ID}/03_evaluator_report.md` (PASS/FAIL/BLOCKED + 증거)

## Phase 4: 체크포인트 · 종합

먼저 **체크포인트**를 남긴다 — `checkpoint-resume` 스킬로 `session.json`의
`done`·`next`·`open_questions`를 갱신한다. 전이는 자동으로 불변 체크포인트를
`.harness/state/checkpoints/{RQ}/`에 쓰지만, **"왜"와 "다음"은 사람이 쓴 것만
들어간다.** 이 단계를 건너뛰면 다음 세션이 git 이력만으로 재개해야 한다.

- **PASS** → `python harness/phase.py enter REVIEW` → **`review-gate` 스킬을
  호출한다** (reviewer APPROVE가 머지의 필요조건). 사용자에게 테스트 출력
  증거와 함께 보고. 스펙 변경이 있으면 같은 PR에 포함.
- **FAIL** → `enter GREEN`으로 되돌아가 보고서를 입력으로 coder 1회 재호출 →
  evaluator 재평가. 다시 FAIL이면 자동 반복을 멈추고 보고서 첨부하여 사용자 보고.
  테스트 약화로 우회하지 않는다.
- **BLOCKED** → 환경 문제가 먼저다. 수정 대상(hook·`check.mjs`·러너)을 명시해 보고

## 데이터 전달 프로토콜

- 파일 기반: `_workspace/{RQ-ID}/{순번}_{에이전트}_{산출물}.md` + 반환값(요약만)
- 중간 파일은 삭제하지 않고 보존한다 (감사 추적·부분 재실행의 입력)

## 에러 핸들링

| 상황 | 처리 |
|---|---|
| 전이 거부 | 거부 메시지의 처방을 이행한 뒤 재전이. `force`로 넘기지 않는다 |
| 에이전트 실행 실패 (예외·미완성 반환) | 같은 입력으로 1회 재시도, 재실패 시 중단·보고 |
| coder가 테스트 수정을 요구 | 게이트가 이미 막는다. 모순 근거를 받아 사용자 판단으로 (스펙 개정은 같은 PR) |
| evaluator FAIL 2회 연속 | 자동 반복 중단 — 사람 개입 요청 |
| 스펙 모호 발견 (어느 Phase든) | 파이프라인 중단, 질문 목록 반환 (추측 구현 금지) |

## 테스트 시나리오

1. **정상 흐름**: "RQ-03 구현해줘" → 세션 선언 → `enter PLAN`→`RED` →
   test-writer가 GA-03 기반 실패 테스트 작성·커밋 → `enter GREEN`(가드 PASS)
   → coder가 최소 구현 → `enter EVAL` → evaluator PASS → 체크포인트 →
   `enter REVIEW`. 트랙 B GB-02의 auto rubric(unforced `RED→GREEN` + `red_evidence`
   통과)이 전이 기록만으로 충족된다.
2. **에러 흐름**: coder가 통과를 위해 테스트 기대값을 수정하려 함 →
   GREEN의 `write_deny`가 차단 → `blocked[]`에 기록(M8) → 사용자 개입.
   트랙 B GB-05가 "이제 구조적으로 불가능"이라고 부르는 지점이 여기다.
