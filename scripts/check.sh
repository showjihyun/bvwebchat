#!/usr/bin/env bash
# scripts/check.mjs 로의 shim — 구현체는 하나다. 인자는 그대로 전달된다.
exec node "$(dirname "$0")/check.mjs" "$@"
