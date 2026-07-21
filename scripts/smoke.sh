#!/usr/bin/env bash
# 배포 후 스모크 테스트 — 트랙 A 골든 케이스의 프로덕션 승격분 (RQ-05/ADR-0006).
# 새 테스트를 만들지 않는다: evals/golden/track-a-product.jsonl의 핵심 케이스를
# 실제 배포 환경(BASE_URL)에 대해 socket.io-client로 재실행한다.
#   - 헬스체크: 배포 URL /health 응답
#   - GA-01: room 격리 — room-A 메시지가 room-B 참여자에게 새지 않는다
#   - GA-04: global 전파 — 접속 중인 전원이 수신한다
# 이 스크립트가 실패하면 배포는 실패다 (deploy.yml의 smoke 잡이 붉어진다).
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ] || [ "$BASE_URL" = "unset" ]; then
  echo "[smoke] BASE_URL 미설정 — 사용법: bash scripts/smoke.sh <BASE_URL>"
  echo "[smoke] (deploy.yml은 CI에서 컨테이너를 기동한 뒤 그 URL로 이 스크립트를 호출한다.)"
  exit 2
fi

echo "[smoke] 대상: $BASE_URL"

# 1) 헬스체크 — 서버가 뜨고 정적 서빙 준비됐는지.
if curl -fsS "$BASE_URL/health" > /dev/null; then
  echo "[smoke] 헬스체크 OK"
else
  echo "[smoke] FAIL — 헬스체크 응답 없음 ($BASE_URL/health)"
  exit 1
fi

# 2) 골든 승격 — 실제 소켓 동작 검증. 하나라도 실패하면 set -e로 전체 실패.
node scripts/smoke/ga01-room-isolation.mjs "$BASE_URL"
node scripts/smoke/ga04-global-broadcast.mjs "$BASE_URL"

echo "[smoke] 전체 통과 — 배포 아티팩트가 GA-01·GA-04를 프로덕션에서 충족"
