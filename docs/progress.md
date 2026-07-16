# 진행 원장 (Progress Ledger)

> **규칙 (최상위)**: 모든 개발 작업은 시작 전 이 파일에서 요구사항·참조 파일을
> 확인하고 상태를 🔄로 바꾼 뒤 진행한다. 완료 시 ✅ + 산출물/PR을 기록한다.
> 원장에 없는 작업은 먼저 행을 추가한다 — 원장 밖 작업 금지.
> 상태: ⬜ 대기 · 🔄 진행중 · ✅ 완료 · ⛔ 차단(사유 병기)

## Phase 로드맵

- [ ] **Phase 1 — Deep Interview**: 🟡 8건 → 0건
      (참조: `specs/interview/question-bank.md`, `specs/requirements.md`)
- [ ] **Phase 2 — 스펙 동결**: PENDING 0 확인 후 v1 태그
- [ ] **Phase 3 — ADR-0001~0005 승인** (참조: `docs/adr/README.md`, 템플릿 `docs/adr/0000-template.md`)
- [ ] **Phase 3.5 — DESIGN.md 확보**: 클로드 디자인 산출물 → `docs/design/DESIGN.md` 커밋
- [ ] **게이트 실질화**: `scripts/check.sh`, `ci.yml` TODO, `deploy.yml` 배포 스텝, `scripts/smoke.sh`
      (참조: ADR-0001/0005, RQ-17)
- [ ] **Phase 4~5 — RQ 구현**: 아래 작업 원장 (스펙 동결 게이트 해제 후 착수 가능)

## 작업 원장 — RQ 구현

> 착수 시 `tdd-workflow` 스킬 사용 (Red→Green→평가→review-gate). 브랜치 `feat/RQ-XX-*`.
> 참조 컬럼의 ADR-0001~0005는 Phase 3에서 승인 예정 — 현재 미작성 (docs/adr/README.md 예약표 참조).

| RQ | 내용 | 상태 | 참조 파일 | 산출물/PR |
|---|---|---|---|---|
| RQ-01 | room 참여 → 수신자 등록 | ⬜ | requirements.md §1, GA-05, ADR-0001/0004 | |
| RQ-02 | room 메시지 격리 전달 | ⬜ | requirements.md §1, GA-01/02/06/10, ADR-0001 | |
| RQ-03 | 퇴장 후 수신 차단 | ⬜ | requirements.md §1, GA-03, GB-02 | |
| RQ-04 | global 전체 전달 | ⬜ | requirements.md §1, GA-04, ADR-0004 | |
| RQ-05 | 7/31 배포 가능 | ⬜ | deploy.yml, smoke.sh, RQ-17 | |
| RQ-10~17 | 스펙 미확정 | ⛔ 인터뷰 대기 | question-bank.md A~E | |

## 하네스 작업 이력 (완료분)

- [x] 2026-07-16 — 하네스 구축·게이트·CD 골격·원장 체계 (PR #1~#6)
      상세: `docs/harness/changelog.md`
