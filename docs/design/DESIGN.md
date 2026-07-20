# DESIGN.md — 웹 채팅 앱 디자인 가이드 (v1)

> 진실 공급원. 근거: `docs/design/handoff-brief.md` §1~§3 (2026-07-20 hand-off).
> 시각 목업: `Webchat.dc.html` (입장 / 메인 / room 생성 / 상태).

## 1. 디자인 원칙

1. **대화가 주인공** — UI 크롬은 회색조로 물러나고, 색은 상태 표시에만 쓴다.
2. **컴팩트 밀도** — 한 화면에 많은 메시지. 행 높이·여백은 스케일 하한을 쓴다.
3. **액센트는 한 곳** — 선택·활성·포커스·주요 버튼에만. 장식적 사용 금지.
4. **표시는 조용히** — 안 읽음은 굵기+점, global은 목록에서만. 배너·카운트 금지.
5. **모션 최소** — hover/상태 전환 120ms ease-out만. 새 메시지 애니메이션 없음.

## 2. 컬러 팔레트 (시맨틱 토큰 · 라이트 전용, 다크 확장 가능 구조)

| 토큰 | 값 | 용도 | 대비 (vs 배경) |
|---|---|---|---|
| `--color-bg-app` | `#F5F5F6` | 사이드바·패널 배경 | — |
| `--color-bg-surface` | `#FFFFFF` | 채팅 영역·모달·입력창 | — |
| `--color-bg-hover` | `#ECEDEF` | 리스트 hover | — |
| `--color-bg-selected` | `#E5EAFB` | 선택된 room (액센트 틴트) | — |
| `--color-border` | `#D9DCE1` | 구분선·입력창 테두리 | 비텍스트 |
| `--color-text-primary` | `#1F2328` | 본문·이름 | 16.2:1 (AA·AAA) |
| `--color-text-secondary` | `#5B616B` | 부가 텍스트·헤딩 라벨 | 6.4:1 (AA) |
| `--color-text-muted` | `#6E7681` | 시간·placeholder·시스템 행 | 4.7:1 (AA) |
| `--color-accent` | `#3B5BDB` | 선택 텍스트·버튼·포커스·안읽음 점 | 6.0:1 on `#FFF` (AA) |
| `--color-accent-contrast` | `#FFFFFF` | 액센트 위 텍스트 | 6.0:1 (AA) |
| `--color-danger` | `#B42318` | 에러 텍스트·에러 테두리 | 6.5:1 (AA) |
| `--color-focus-ring` | `#3B5BDB` | 키보드 포커스 링 (2px, offset 2px) | 비텍스트 3:1 충족 |

이니셜 아바타 자동 색 8종 (닉네임 해시 → index, 흰 이니셜 대비 전부 ≥4.5:1):
`#3B5BDB #0B7285 #2B8A3E #9C36B5 #C2255C #E8590C #6741D9 #495057`

## 3. 타이포 스케일

폰트 스택 (웹폰트·CDN 없음):
`"Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`

한글 기준: 본문 `line-height: 1.5` 이상, `letter-spacing: -0.01em`, `word-break: keep-all`.

| 토큰 | 크기/굵기/줄높이 | 용도 |
|---|---|---|
| `--type-title` | 18px / 700 / 1.4 | 입장 화면 제목·모달 제목 |
| `--type-heading` | 15px / 700 / 1.45 | 채팅 헤더 room 이름 |
| `--type-body` | 14px / 400 / 1.5 | 메시지 본문·입력창 |
| `--type-body-strong` | 14px / 600 / 1.5 | 발신자 이름·안읽음 room |
| `--type-list` | 13px / 400 / 1.5 | room·참여자 목록 |
| `--type-caption` | 12px / 400 / 1.45 | 시간·라벨·시스템 행·에러 |
| `--type-overline` | 11px / 600 / 1.4 / +0.04em | 섹션 라벨 ("채널", "참여자") |

## 4. 레이아웃

뷰포트 우선순위: **데스크톱 우선** (사내 업무 환경). 최소 지원 1024px.
1024px 미만은 v1 비대응 (모바일 앱은 스코프 밖 — requirements §3).

```
┌ 240px ──┬─ flex(1, min 480px) ─┬─ 200px ┐
│ room목록 │ 채팅 (헤더/리스트/입력) │ 참여자  │  높이 100vh
└─────────┴──────────────────────┴────────┘
```

- room 목록: `--color-bg-app`, global 상단 고정, 하단에 "새 room" 진입점.
- 채팅: surface 흰색. 헤더 44px / 메시지 리스트(스크롤) / 입력창 하단 고정.
- 참여자 패널: 상시 노출, 토글 없음 (D16).
- 재연결 배너: 채팅 헤더 아래 28px 슬림 바 — 대화를 밀지 않고 위에 얹지도 않음.

## 5. 컴포넌트 명세

**메시지 (플랫 리스트)** — 행 `padding: 3px 20px`, hover `--color-bg-hover`.
그룹 첫 행: 아바타 26px 원형 + 이름(body-strong) + 시간(caption·muted) + 본문.
같은 발신자 연속 메시지는 이름·아바타 생략(들여쓰기 유지). 본인 메시지는
정렬 변화 없이 이름 옆 **「나」 배지**(11px, 액센트 틴트 배경 + 액센트 텍스트)로 구분.
시스템 행(입장/퇴장): caption·muted, 아바타 없음.

**이니셜 아바타** — 26px 원형, 닉네임 첫 글자(한글 포함) 1자, 자동 색상(§2), 흰 텍스트 12px/600.

**room 목록 항목** — 32px 행, `# 이름`(list). 상태: 기본 / hover(bg-hover) /
선택(bg-selected + 액센트 텍스트 600) / **안 읽음: 이름 600 + 우측 6px 액센트 점**.
숫자 배지 없음. global은 최상단 고정, 삭제 UI 없음.

**global 알림** — global 안 읽음 표시만 (위 안 읽음 스타일). 현재 대화에
삽입·배너 금지 (D14).

**입력창** — 기본: border `--color-border`, radius 6, 내부 8×12px.
포커스: 액센트 border + 포커스 링. 전송 불가(재연결 중): bg-app 배경,
muted placeholder "재연결 중에는 보낼 수 없습니다", 버튼 비활성(38% 불투명).
전송 버튼: 액센트 배경, radius 6.

**room 생성 모달** — 360px, 제목 + 입력 + 취소/만들기. 에러 시 입력 테두리
`--color-danger` + 아래 caption 에러 문구:
중복 "이미 있는 이름입니다 — 다른 이름을 입력하세요" /
예약 "'global'은 예약된 이름입니다".

**입장 화면** — 빈 surface 중앙 320px 폼: 제목 "닉네임으로 입장" + 입력 +
버튼 하나. 마케팅 문구 없음. 닉네임 자동 접미사 시 입장 직후 시스템 행으로
"'alice'는 사용 중이라 **alice-2**로 입장했습니다" 고지 (부여된 이름 노출 — RQ-10).
닉네임 미입력: 버튼 비활성 + caption 안내.

**재연결 배너** — 슬림 바, bg-app 배경 + caption "연결이 끊겼습니다 — 재연결 중…".
복구 시 즉시 제거 (애니메이션 없음).

**전송 실패** (디자인 추론 — 스펙 근거 없음) — 실패한 메시지 행은 리스트에 유지하되
본문을 `--color-text-muted`로, 시간 자리 없이 아래에 caption
"전송하지 못했습니다" (`--color-danger`) + **다시 시도** (액센트 링크) + 삭제 (muted 링크).
대화 흐름을 밀어내는 토스트·배너 금지.

**빈 room (생성 직후)** — 메시지 리스트 중앙에 body-strong "# {이름}이 만들어졌습니다"
+ list·muted 안내 "아직 메시지가 없습니다. 마지막 참여자가 나가면 room은 자동으로
사라집니다." (RQ-12의 자동 소멸이 정상 동작임을 사전 고지). 일러스트 없음.

## 6. 간격 체계

`--space-1..7` = 2 / 4 / 8 / 12 / 16 / 20 / 24 px (컴팩트 기준).
행 높이: room 항목 32px, 참여자 항목 28px, 메시지 행 min 26px.
radius: 입력·버튼 6px, 모달 10px, 아바타 원형.
포커스 링: `outline: 2px solid var(--color-focus-ring); outline-offset: 2px` — 모든 인터랙티브 요소.

## 스코프 밖 (재확인)

다크 모드 · 숫자 배지 · 프로필 이미지 · 랜딩 · DM · 파일 전송 · 온라인/타이핑 표시.
