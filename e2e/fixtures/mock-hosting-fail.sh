#!/bin/bash
#
# e2e/fixtures/mock-hosting-fail.sh — CRITICAL バナー表示を確認するための
# 「down も up も失敗する」シナリオ専用モック。本物には一切触れない。
#
# computeOutcome(downOk, rehearseOk, upOk) は down と up の両方が失敗した場合
# 'CRITICAL_DOUBLE_FAILURE' を返す（ops/dashboard.mjs 側のロジックは変更していない）。
set -uo pipefail

case "${1:-}" in
  status)
    cat <<'JSON'
{
  "targets": {
    "proxy": {"loaded": false, "state": "not-loaded", "pid": null, "healthy": false},
    "cloudflared": {"loaded": false, "state": "not-loaded", "pid": null, "healthy": false}
  },
  "overallHealthy": false
}
JSON
    exit 0
    ;;
  down)
    echo "[mock-hosting-fail] down --target proxy: FAILING (意図的)"
    exit 1
    ;;
  up)
    echo "[mock-hosting-fail] up --target proxy: FAILING (意図的)"
    exit 1
    ;;
  *)
    echo "mock-hosting-fail.sh: unsupported args: $*" >&2
    exit 1
    ;;
esac
