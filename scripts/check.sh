#!/usr/bin/env bash
# 검증 일괄 스크립트 — ADR-0005 확정에 따라 실질화 (2026-07-17).
#   --fast : 파일 수정 직후 hook에서 호출. 예산 5초 — 변경된 TS 파일만 lint.
#   (없음) : 전체 검증 (lint + typecheck + test). CI 게이트와 동일. 예산 3분.
set -euo pipefail

if [ "${1:-}" = "--fast" ]; then
  # 클론 직후 등 node_modules 부재 시 조용히 통과 — 환경 문제는 전체 검증이 잡는다
  [ -d node_modules ] || exit 0
  CHANGED=$( { git diff --name-only HEAD -- '*.ts' 2>/dev/null;
               git ls-files --others --exclude-standard -- '*.ts'; } | sort -u )
  FILES=""
  for f in $CHANGED; do [ -f "$f" ] && FILES="$FILES $f"; done
  [ -z "$FILES" ] && exit 0
  # shellcheck disable=SC2086
  npx eslint --cache $FILES
  exit 0
fi

npx eslint .
npx tsc --noEmit
npx vitest run
