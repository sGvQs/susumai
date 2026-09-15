#!/bin/bash
#
# e2e/fixtures/mock-hosting-degraded.sh — 「loaded=true だが healthy=false」を
# 返すステータス専用モック（ダッシュボードの色分け colorFor() が赤になる経路を
# status API のレベルだけで確認するため。down/up は呼ばれない想定なので未対応でよい）。
set -uo pipefail

case "${1:-}" in
  status)
    cat <<'JSON'
{
  "targets": {
    "proxy": {"loaded": true, "state": "running", "pid": 33333, "healthy": false},
    "cloudflared": {"loaded": true, "state": "running", "pid": 44444, "healthy": true}
  },
  "overallHealthy": false
}
JSON
    exit 0
    ;;
  *)
    echo "mock-hosting-degraded.sh: unsupported args: $*" >&2
    exit 1
    ;;
esac
