#!/usr/bin/env bash
# 배포 후 스모크 테스트 — 트랙 A 골든 케이스의 프로덕션 승격분.
# 새 테스트를 만들지 않는다: evals/golden/track-a-product.jsonl에서
# 핵심 케이스를 골라 실제 배포 환경에 대해 재실행하는 것이 원칙.
#
# 승격 대상 (스택 확정 후 구현):
#   - 헬스체크: 배포 URL 접속·응답 확인
#   - GA-01: room 격리 — room-A 메시지가 room-B 참여자에게 새지 않는다
#   - GA-04: global 전파 — 접속 중인 전원이 수신한다
# 이 스크립트가 실패하면 배포는 실패다 (deploy.yml의 smoke 잡이 붉어진다).
set -euo pipefail

BASE_URL="${1:-}"
if [ -z "$BASE_URL" ] || [ "$BASE_URL" = "unset" ]; then
  echo "[smoke] DEPLOY_URL 미설정 — 배포 대상(RQ-17) 확정 후 저장소 Variables에 등록하세요."
  echo "[smoke] 사용법: bash scripts/smoke.sh <BASE_URL>"
  exit 0  # 배포 골격 단계에서는 게이트를 막지 않는다. URL 등록 후 아래 TODO를 채우면 실검사로 전환.
fi

echo "[smoke] 대상: $BASE_URL"
# TODO(배포 대상 확정 후): 예)
#   curl -fsS "$BASE_URL/health" > /dev/null && echo "[smoke] 헬스체크 OK"
#   node scripts/smoke/ga01-room-isolation.mjs "$BASE_URL"
#   node scripts/smoke/ga04-global-broadcast.mjs "$BASE_URL"
echo "[smoke] 스모크 케이스 미구현 — GA-01/GA-04 승격 구현을 채우세요."
exit 0
