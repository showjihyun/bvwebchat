#!/usr/bin/env bash
# 검증 일괄 스크립트 — 스택 확정(ADR-0001~0004) 전까지는 no-op.
# 확정 후: lint, typecheck, test를 여기에 채운다.
#   --fast : 파일 수정 직후 hook에서 호출됨. 수 초 내에 끝나는 것만.
#   (없음) : CI/수동 전체 검증.
set -euo pipefail

if [ "${1:-}" = "--fast" ]; then
  # TODO(스택 확정 후): 예) npx eslint --cache <변경파일> / ruff check
  exit 0
fi

echo "[check] 스택 미확정 — ADR-0001 승인 후 lint/test 명령을 채우세요."
# TODO(스택 확정 후): 예)
#   npm run lint
#   npm test -- --reporter=dot
exit 0
