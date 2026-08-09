// ESLint flat config — ADR-0005 게이트 실질화.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules',
      'dist',
      'coverage',
      '.harness',
      '_workspace',
      // 클로드 디자인 export (생성 산출물, DESIGN.md만 tracked) — gitignore와 별개로 lint 제외
      'docs/design/Design handoff for webchat/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // 서버·클라이언트·테스트·설정이 한 저장소에 있으므로 node+browser 전역을 함께 둔다.
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    // ── ADR-0010 SRP 축 ── 함수 60줄 · 파일 250줄.
    //
    // 길이는 **대리 지표**다. 책임의 개수는 셀 수 없고, 길이는 책임이 늘 때 함께
    // 늘어나는 관측 가능한 축이다. 이 게이트를 통과했다고 SRP를 지킨 것은 아니다 —
    // 60줄 안에서 세 가지 책임을 지는 함수는 통과한다. 그 축은 reviewer가 본다.
    //
    // skipComments: true인 이유 — 이 저장소는 "왜"를 코드 옆에 길게 적는 관례를
    // 갖고 있고(room.ts 머리 주석이 그 예다), 주석을 세면 그 관례가 곧바로
    // 게이트와 충돌한다. 설명을 지워 초록을 사는 인센티브를 만들지 않는다.
    //
    // skipBlankLines는 **켜지 않았다**. 빈 줄도 읽는 사람이 스크롤해야 하는 길이다.
    // 한 번 켰다가 되돌렸는데, 그 사이 계수가 느슨해져 아래 예외 핀에 슬랙이
    // 생겼다 — 옵션과 핀은 반드시 같은 조건에서 재야 한다.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      'max-lines': ['error', { max: 250, skipComments: true }],
      'max-lines-per-function': ['error', { max: 60, skipComments: true }],
    },
  },
  {
    // ── ADR-0010 예외표 ── 부채이지 면제가 아니다.
    //
    // eslint-disable로 숨기지 않고 **현재값에 고정한 override**로 등재한다. 값을
    // 현재치에 박는 것이 핵심이다 — 그 파일은 더 자랄 수 없고(래칫), 부채를 갚으면
    // 블록을 통째로 **지워** 임계값이 조인다. 값을 올리는 방향의 수정은 ADR-0010을
    // 대체하는 새 ADR로만 한다. 게이트가 빨갛다는 이유로 임계값을 올리는 것은
    // 실패 테스트를 지우는 것과 같은 계열의 행위다.
    //
    // 6건이 전부 클라이언트고 서버 모듈은 0건이다 — 서버는 ADR-0007이 경계를
    // 정했고 클라이언트에는 그런 문서가 없다. 부채 상환 순서와 근거는
    // docs/progress.md 보류표에 있다(useChat.ts는 RQ-04 v1.2 세 번째 불릿의
    // 미이행 결함을 안고 있어 그 결함을 닫는 PR이 분해를 함께 가져간다).
    files: ['src/client/useChat.ts'],
    rules: {
      'max-lines': ['error', { max: 293, skipComments: true }],
      'max-lines-per-function': ['error', { max: 237, skipComments: true }],
    },
  },
  {
    files: ['src/client/components/ChatPane.tsx'],
    rules: { 'max-lines-per-function': ['error', { max: 75, skipComments: true }] },
  },
  {
    files: ['src/client/components/JoinRoomModal.tsx'],
    rules: { 'max-lines-per-function': ['error', { max: 64, skipComments: true }] },
  },
  {
    // ADR-0007 규칙3(순수 코어) 기계 강제 — state.ts·validation.ts는 전송 계층을
    // 알아서는 안 된다. 기본 no-restricted-imports는 `import type`도 함께 잡는데,
    // 순수성 주장에 타입 전용 간선까지 포함되므로 그게 의도한 동작이다.
    // patterns는 계층 역행(L1/L2가 상위 계층을 끌어오는 것)을 막는다.
    files: ['src/server/chat/state.ts', 'src/server/chat/validation.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'socket.io', message: '상태·규칙 모듈은 전송 계층을 알아서는 안 된다 (ADR-0007 규칙3).' },
            { name: 'socket.io-client', message: '상태·규칙 모듈은 전송 계층을 알아서는 안 된다 (ADR-0007 규칙3).' },
          ],
          patterns: ['./protocol', './broadcast', './session', './room', './departure', './connection'],
        },
      ],
    },
  },
  // ── ADR-0010 DIP 축 ── ADR-0007 결정2의 계층 그래프를 **전체로** 확장한다.
  //
  //   shared/types → validation·protocol → state → broadcast → session
  //                → room·departure → connection
  //
  // 2026-08-09까지 선언은 8층인데 집행은 위 블록의 **2층뿐**이었다. 실측한 import
  // 간선이 이 선언과 정확히 일치하므로(각 모듈의 import를 전수 확인) 이 확장에
  // 코드 변경은 필요하지 않다 — 즉 이 규칙들은 **오늘의 코드를 고치지 않고
  // 내일의 역행만 막는다**.
  //
  // 각 블록은 자기보다 **위** 계층만 막는다. 아래·같은 층은 정당한 간선이라
  // 나열하지 않는다(예: room이 protocol을 쓰는 것은 L6→L2로 정방향이다).
  {
    files: ['src/server/chat/protocol.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['./state', './broadcast', './session', './room', './departure', './connection'] },
      ],
    },
  },
  {
    files: ['src/server/chat/broadcast.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: ['./session', './room', './departure', './connection'] },
      ],
    },
  },
  {
    files: ['src/server/chat/session.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['./room', './departure', './connection'] }],
    },
  },
  {
    files: ['src/server/chat/room.ts', 'src/server/chat/departure.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: ['./connection'] }],
    },
  },
);
