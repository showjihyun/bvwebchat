# 정책 표 — 생성물 (손으로 고치지 마라)

이 파일은 `node scripts/policy-lint.mjs --print` 가 `harness/policy/*.json`에서 생성한다.
손으로 고치면 다음 생성에서 지워진다. 표를 바꾸고 싶으면 **JSON을 바꾸고 다시 생성**하라 —
표와 정책이 어긋날 자리를 없애는 것이 이 파일이 생성물인 유일한 이유다.

> 갱신일을 여기 적지 않는다. 날짜는 `git log -1 --format=%cI -- harness/policy/README.md` 가 안다.

## 집행 수준

| 항목 | 값 |
|---|---|
| 기본 | `block` |
| 경고만(warn_only) | `SPEC` `PLAN` `RELEASE` `IDLE` |

`warn_only` 단계는 차단 대신 stderr 경고만 낸다. 게이트의 첫 주가 가장 위험하므로
(차단이 잦으면 `force`가 습관이 되고 그 순간 전체가 장식이 된다) 일부 단계를 유예한다.
**`force` 비율이 5%를 넘으면 에이전트가 아니라 이 매트릭스가 틀렸다는 신호다.**

## 단계 × 경로 (R1 — 로컬 변경)

기본값은 default-deny. `write_allow`에 걸리지 않으면 막힌다. `write_deny`는 메시지 품질용
명시 목록이다 — "왜 막혔는가"를 정확히 말하기 위해 존재한다.

| 단계 | 목적 | write_allow | write_deny |
|---|---|---|---|
| `IDLE` | 무작업. 상태 파일 부재·손상 시의 fail-closed 기본값 | `_workspace/**` `docs/progress.md` | — |
| `SPEC` | 요구사항·ADR·디자인 작성. 코드는 만들지 않는다 | `specs/**` `docs/adr/**` `docs/design/DESIGN.md` `docs/progress.md` `evals/golden/**` `_workspace/**` | `src/**` `tests/**` |
| `PLAN` | 탐색·계획. 원장 기입 | `_workspace/**` `docs/progress.md` | `src/**` `tests/**` `specs/**` `docs/adr/**` |
| `RED` | 실패하는 테스트만 만든다. 구현은 다음 단계다 | `tests/**` `_workspace/**` `docs/progress.md` | `src/**` `specs/**` `evals/golden/**` |
| `GREEN` | 테스트를 통과시키는 최소 구현 + 리팩토링. 테스트는 건드리지 않는다 | `src/**` `_workspace/**` `docs/progress.md` | `tests/**` `specs/**` `evals/golden/**` |
| `EVAL` | 독립 평가 보고서 작성. 코드를 고치지 않는다 | `_workspace/**` | `src/**` `tests/**` `specs/**` `docs/adr/**` `evals/golden/**` `.claude/**` `harness/**` `scripts/**` |
| `REVIEW` | 독립 리뷰 보고서 작성. 코드를 고치지 않는다 | `_workspace/**` | `src/**` `tests/**` `specs/**` `docs/adr/**` `evals/golden/**` `.claude/**` `harness/**` `scripts/**` |
| `HARNESS` | 하네스 변경 전용. CLAUDE.md의 '하네스·ADR 전용 PR' 카브아웃을 구조로 승격한 단계 — 기능 코드가 섞이는 것이 물리적으로 불가능하다 | `.claude/**` `harness/**` `scripts/**` `.github/**` `docs/harness/**` `evals/*.md` `evals/results/**` `_workspace/**` `docs/progress.md` `.gitignore` `CLAUDE.md` | `src/**` `tests/**` `specs/**` |
| `RELEASE` | 머지·배포. 원장과 changelog를 닫는다 | `docs/progress.md` `docs/harness/changelog.md` `_workspace/**` | `src/**` `tests/**` `specs/**` |

### 나가는 길 (exit_hint)

| 단계 | 다음 |
|---|---|
| `IDLE` | 작업을 시작하려면: python harness/phase.py enter PLAN  (또는 SPEC / HARNESS) |
| `SPEC` | 스펙이 확정되면(🟡 0건) → python harness/phase.py enter PLAN |
| `PLAN` | 계획이 서면 → python harness/phase.py enter RED  (가드: 스펙 🟡 0건, 브랜치가 RQ와 일치, 워킹트리 clean) |
| `RED` | 테스트를 커밋한 뒤 → python harness/phase.py enter GREEN  (가드: tests/** 커밋 ≥1, 정당한 Red 증거) |
| `GREEN` | 전체 검증이 초록이면 → python harness/phase.py enter EVAL  (가드: check 전체 초록, 골든 커버리지) |
| `EVAL` | PASS면 → python harness/phase.py enter REVIEW / FAIL이면 → enter GREEN |
| `REVIEW` | APPROVE면 → python harness/phase.py enter RELEASE / REQUEST_CHANGES면 → enter GREEN |
| `HARNESS` | 하네스 변경 후 → python harness/phase.py enter REVIEW  (가드: 트랙 B 회귀 평가 아티팩트, changelog 동행) |
| `RELEASE` | 완료되면 → python harness/phase.py enter IDLE |

## 전이와 가드

합법적 간선도 **직전 단계만 만들 수 있는 산출물**을 요구한다.
단계를 뒤집는 것은 막을 수 없지만, 뒤집어도 얻는 게 없다.

| from | to | 가드 |
|---|---|---|
| `IDLE` | `SPEC` · `PLAN` · `HARNESS` | — |
| `SPEC` | `PLAN` | `no_pending_spec` |
| `SPEC` | `IDLE` | — |
| `PLAN` | `RED` | `no_pending_spec` `session_declared` `tree_clean` |
| `PLAN` | `SPEC` · `IDLE` | — |
| `RED` | `GREEN` | `tests_committed` `red_evidence` |
| `GREEN` | `EVAL` | `check_full_green` `golden_coverage` |
| `GREEN` | `RED` | — |
| `EVAL` | `REVIEW` | `evaluator_pass` |
| `EVAL` | `GREEN` | — |
| `REVIEW` | `RELEASE` | `reviewer_approve` |
| `REVIEW` | `GREEN` | — |
| `HARNESS` | `REVIEW` | `track_b_passing` `changelog_updated` |
| `HARNESS` | `IDLE` | — |
| `RELEASE` | `IDLE` | — |
| `*` | `IDLE` | — |

### 가드 정의

| 가드 | 종류 | 판정 대상 | 막혔을 때 |
|---|---|---|---|
| `no_pending_spec` | grep_count | `specs/requirements.md` | requirements.md에 PENDING(🟡) ${n}건이 남아 있다. specs/interview/question-bank.md로 인터뷰를 완료해 전부 ✅로 확정하라. 스펙이 모호한 상태의 구현은 추측이고, 추측은 재작업이 된다. |
| `session_declared` | state_field | `.harness/state/session.json` | session.json에 task.rq / goal / acceptance가 없다. checkpoint-resume 스킬로 세션을 선언하라. goal은 '무엇'이 아니라 '왜'를 적는다 — 무엇을 했는지는 git이 이미 안다. |
| `tree_clean` | git | `no_staged_or_unstaged_changes_in(src/**, tests/**)` | src/** 또는 tests/**에 커밋되지 않은 변경이 있다. RED 진입 전에 워킹트리를 정리하라 — 그래야 Red 증거가 이 단계에서 만들어진 것임이 증명된다. |
| `tests_committed` | git | `count(commits(HEAD ^merge-base(main)) touching tests/**) >= 1` | 이 브랜치에 tests/** 커밋이 없다. RED의 산출물은 '커밋된 실패 테스트'다. 커밋한 뒤 다시 전이하라. (M3 테스트 선행률이 이 전이에서 측정된다) |
| `red_evidence` | exec | `node scripts/check.mjs --red --rq ${rq}` | 정당한 Red가 아니다 (ADR-0005 결정3). 통과 조건: (a) 이름에 ${rq}를 포함한 테스트가 1건 이상 FAIL, (b) tsc 오류가 TS2307/TS2305(미구현 src 모듈 임포트)에만 국한. 테스트 파일 자체의 타입 오류는 '깨진 테스트'이므로 네가 고쳐야 한다 — 이 구분이 RQ-01에서 disconnect() 목 버그를 놓친 원인이었다. |
| `check_full_green` | exec | `node scripts/check.mjs` | 전체 검증(lint + tsc + vitest)이 초록이 아니다. 완료 주장에는 실행 출력이 증거로 필요하다(CLAUDE.md). 실패를 먼저 고쳐라 — 테스트를 약화시켜 우회하지 않는다. |
| `golden_coverage` | exec | `node scripts/golden-coverage.mjs --rq ${rq}` | ${rq}에 매핑된 GA-* 골든 중 테스트로 구현되지 않은 케이스가 있다(목록은 위 출력). 테스트가 전부 통과해도 골든 미커버는 완료가 아니다 — '사양 대조 없는 테스트 통과는 완료가 아니다'의 기계적 집행 지점이다. |
| `evaluator_pass` | file_contains | `_workspace/${rq}/03_evaluator_report.md` | evaluator PASS 보고서가 없거나, 보고서 작성 이후 src/**가 또 변경됐다. tdd-workflow Phase 3를 (재)실행하라. |
| `reviewer_approve` | file_contains | `_workspace/review/${branch_slug}.md` | reviewer APPROVE가 없다. review-gate 스킬을 실행하라. blocker가 있는데 급하다는 이유로 우회하면 이 게이트는 그날로 장식이 된다. |
| `track_b_passing` | exec | `node scripts/eval-b.mjs --verify-artifact` | 하네스를 바꿨는데 트랙 B 회귀 평가 결과가 없거나 실패했다. harness-audit 스킬을 실행해 evals/results/track-b/<sha>.json을 생성하라. 평가셋 없는 하네스 튜닝은 안티패턴 06이다. |
| `changelog_updated` | git | `changed_in_branch(docs/harness/changelog.md)` | 하네스를 바꿨는데 docs/harness/changelog.md가 이 브랜치에서 변경되지 않았다(CLAUDE.md: 하네스 변경 시 기록 의무). changelog가 07-20에 멈춰 있던 드리프트를 구조적으로 막는 게이트다. |

## 위험 등급 (도구)

축은 "가역성 × 경계 이탈"이다 — 파일 경로가 아니라 도구의 성질로 나눈다.

| 등급 | 이름 | 정의 | 정책 | 강제 주체 |
|---|---|---|---|---|
| **R0** | 관찰 | 상태 변경 없음, 외부 송신 없음. 저장소·환경·네트워크 중 어느 것도 바꾸지 않는다. | 모든 단계에서 항상 허용 | settings.json allow |
| **R1** | 로컬 변경 | 저장소 안에서 가역. 변경이 워킹트리·인덱스·로컬 커밋에 국한된다. | phase × path 매트릭스로 판정 (phase-matrix.json) | hooks/gate_phase.py |
| **R2** | 경계 이탈 | 비가역이거나 외부에 보인다. 원격 푸시·컨테이너·네트워크 설치·골든 정답·사람 판단이 필요한 것. | permissions.ask — 시도하면 권한 시스템이 사람에게 묻는다 | settings.json ask |
| **R3** | 금지 | 이력을 파괴하거나, 비밀을 노출하거나, 통제면 자체를 훼손한다. | permissions.deny — 프롬프트 없이 거부, 전 단계 공통 | settings.json deny |

### 파일 도구

| 등급 | 도구 |
|---|---|
| R0 | `Read` `Glob` `Grep` `NotebookRead` |
| R1 | `Write` `Edit` `MultiEdit` `NotebookEdit` |

### Bash 접두사

| 등급 | 접두사 |
|---|---|
| R0 | `git status` `git diff` `git log` `git show` `git branch` `git rev-parse` `git merge-base` `git ls-files` `git check-ignore` `git worktree list` `git blame` `gh pr view` `gh pr diff` `gh pr checks` `gh pr list` `node scripts/phase-audit.mjs` `node scripts/doc-freshness.mjs` `node scripts/golden-coverage.mjs` `node scripts/metrics.mjs` `node scripts/policy-lint.mjs` `node scripts/hooks-selftest.mjs` `python harness/phase.py show` `python harness/phase.py why` `ls` `cat` `wc` `head` `tail` `rg` `find` |
| R1 | `git add` `git commit` `git switch` `git checkout -b` `git restore` `git stash` `git revert` `node scripts/check.mjs` `bash scripts/check.sh` `npm test` `npm run` `npx vitest` `npx eslint` `npx tsc` `python harness/phase.py enter` `node scripts/resume-test.mjs` `mkdir` `touch` `cp` `mv` |
| R2 | `git push` `gh pr create` `gh pr merge` `gh release` `docker` `npm install` `npm ci` `npm publish` `python harness/phase.py force` `node scripts/eval-b.mjs` `git worktree add` `git worktree remove` |
| R3 | `rm -rf` `git push --force` `git push -f` `git reset --hard` `git rebase` `git filter-branch` `git clean -fdx` `curl` `wget` `chmod 777` |

미지의 접두사: **allow**

### 보호 경로 (리다이렉트 차단)

`.harness/state/` `evals/golden/` `.claude/settings.json` `harness/policy/`

Bash 리다이렉트(`> path` / `>> path`)로 통제면을 우회하는 시도를 **탐지**한다.
예방이 아니다 — `node -e "fs.writeFileSync(...)"` 같은 우회는 문자열 파싱으로 막을 수 없다.
사후 대조는 `node scripts/phase-audit.mjs`가 git 이력에서 독립적으로 수행한다.

