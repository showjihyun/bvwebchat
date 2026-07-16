# 진행 원장 (Progress Ledger)

> **규칙 (최상위)**: 모든 개발 작업은 시작 전 이 파일에서 요구사항·참조 파일을
> 확인하고 상태를 🔄로 바꾼 뒤 진행한다. 완료 시 ✅ + 산출물/PR을 기록한다.
> 원장에 없는 작업은 먼저 행을 추가한다 — 원장 밖 작업 금지.
> 상태: ⬜ 대기 · 🔄 진행중 · ✅ 완료 · ⛔ 차단(사유 병기)

## Phase 로드맵

- [x] ✅ **Phase 1 — Deep Interview**: 🟡 8건 → 0건 (2026-07-17 완료,
      결과: `specs/interview/answers.md`)
- [ ] 🔄 **Phase 2 — 스펙 동결**: requirements v1 확정 — 이 PR 머지 + v1 태그로 완료
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
| RQ-10 | 닉네임 식별·자동 접미사·새로고침 유지 | ⬜ | requirements §2, GA-09/11, ADR-0003(예정) | |
| RQ-11 | 입장 시 최근 50개 히스토리 (인메모리) | ⬜ | requirements §2, GA-08, ADR-0002(예정) | |
| RQ-12 | room 자유 생성 + 빈 room 자동 삭제 | ⬜ | requirements §2 | |
| RQ-13 | room 목록 공개·이름 고유 | ⬜ | requirements §2 | |
| RQ-14 | room 내 순서 보장 | ⬜ | requirements §2, GA-07, ADR-0001(예정) | |
| RQ-15 | 참여자 목록 표시 | ⬜ | requirements §2 | |

> RQ-16(동시 100명)·RQ-17(사내망 단일 서버)은 독립 구현 항목이 아니라
> ADR-0001과 "게이트 실질화"(deploy.yml·smoke.sh)의 제약 조건으로 반영한다.

## 하네스 작업 이력 (완료분)

- [x] 2026-07-16 — 하네스 구축·게이트·CD 골격·원장 체계 (PR #1~#6)
      상세: `docs/harness/changelog.md`
