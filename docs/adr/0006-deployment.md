# ADR-0006: 배포 — Docker 단일 컨테이너 (정적 클라이언트 + Socket.IO 단일 서버)

- 상태: 승인
- 날짜: 2026-07-21
- 관련 스펙: RQ-05(7/31 배포), RQ-16(동시 100명), RQ-17(사내망 단일 서버)
  (입력: 사용자 결정 2026-07-21 — "Docker 단일 컨테이너")

## 맥락

RQ-05는 7/31까지 "동작하는 상태로 배포 가능"을, RQ-17은 사내망/로컬 단일
서버(HTTPS 선택)를 요구한다. dev는 Vite(:5173)가 클라이언트를, tsx가
Socket.IO(:3001)를 띄우고 `/socket.io`를 프록시한다. 프로덕션은 이 이원
구조를 하나의 서버로 합쳐야 한다(사내망 단일 서버·CORS 회피).

제약: GitHub Actions 러너는 사내망에 접근할 수 없다 — CI에서 사내 서버로의
직접 배포는 불가능하다.

## 결정

1. **단일 서버·단일 포트**: 프로덕션 서버(`src/server/main.ts`)가 빌드된
   클라이언트(`dist/client`)를 정적 서빙하고 동일 http 서버에 Socket.IO를
   붙인다. `PORT` 환경변수(기본 3001) 하나로 노출한다. `createChatServer`는
   선택적 `requestListener`를 받아 정적 핸들러를 주입받는다(기존 계약·테스트
   무변경 — 인자 없으면 현행과 동일).
2. **서버 번들**: 서버 소스는 확장자 없는 import(Bundler 방식)라 Node에서
   직접 실행 불가 → **esbuild**로 `dist/server/main.js`(ESM) 단일 번들, socket.io는
   external(런타임 설치). 클라이언트는 기존 `vite build`.
3. **Docker 단일 컨테이너**: 멀티스테이지 — builder(전체 의존성으로 client·server
   빌드) → runtime(프로덕션 의존성 + `dist`만, `node dist/server/main.js`).
   `node:24-slim` 계열, 비루트 사용자, `PORT` 노출. 이 이미지 하나가 RQ-17의
   "단일 서버"다. (node:24 = npm 11 — lockfile의 dev 마커를 정확히 처리해
   `npm ci --omit=dev`가 런타임 의존성을 socket.io 트리로 슬리밍한다. node:22의
   npm 10.9.8은 이 프룬을 하지 않는다. engines `>=22` 충족.)
4. **스모크 = 골든의 프로덕션 승격**: `scripts/smoke.sh`가 기동된 인스턴스에
   대해 헬스체크 + **GA-01(room 격리)** + **GA-04(global 전파)**를 실제
   socket.io-client로 재실행한다. 스모크 실패 = 배포 실패(deploy.yml smoke 잡).
   새 테스트를 만들지 않고 트랙 A 골든을 승격한다.
5. **CI 역할**: `deploy.yml`은 이미지를 빌드하고 컨테이너를 기동해 스모크로
   **아티팩트가 골든을 통과함을 증명**한다. 사내망 실배포는 CI가 도달 불가하므로
   문서화된 수동 절차(`docs/deploy.md`)로 둔다 — 검증된 이미지를 사내 서버에서
   `docker run`.

## 근거

- 단일 컨테이너는 RQ-17 "단일 서버"와 1:1, 환경 재현성이 높고 사내 반입이
  이미지 하나로 끝난다. esbuild 번들은 런타임 의존성을 socket.io로 최소화한다.
- 스모크를 골든 승격으로 두면 "프로세스가 떴다"가 아니라 "실제 격리·전파가
  된다"를 배포 성공 기준으로 삼는다(하네스 원칙).
- 버린 대안: **직접 Node(Docker 없음)** — 재현성·반입 편의 약함. **PaaS(Fly/
  Vercel)** — RQ-17 사내망과 모순. **tsx 런타임 실행** — 프로덕션에 devDeps·TS
  소스 반입, 이미지 비대.

## 결과

- 런타임 의존성에 socket.io만 남기려면 esbuild external 관리가 필요(빌드
  스크립트에 명시). esbuild는 빌드 전용 devDependency로 추가.
- 인메모리 상태(ADR-0002/0003)는 컨테이너 재시작 시 소실 — 사내 데모 수용.
- HTTPS는 사내망 리버스 프록시(선택)에 위임 — 컨테이너는 평문 HTTP 단일 포트.
- 동시 100명(RQ-16)은 단일 프로세스 이벤트 루프로 충분(ADR-0001 전제) —
  스모크는 기능 검증이며 부하 검증은 범위 밖.
