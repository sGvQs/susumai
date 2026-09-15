#!/bin/bash
#
# e2e/fixtures/mock-hosting.sh — ops/hosting.sh の「成功」シナリオ用モック。
#
# 本物の ops/hosting.sh・本番launchdサービスには一切触れない。dashboard.mjs から
# SUSUMAI_DASHBOARD_HOSTING_SH 経由でのみ呼び出される想定で、Playwright の
# e2e テストの中でだけ使う（テストディレクトリ内に閉じる）。
#
# dashboard.mjs が呼び出す3パターンにだけ応答すればよい:
#   status --target all --json   → handleStatus() が期待するJSON
#   down   --target proxy        → runStep('down', ...)
#   up     --target proxy        → runStep('up', ...)
set -uo pipefail

case "${1:-}" in
  status)
    cat <<'JSON'
{
  "targets": {
    "proxy": {"loaded": true, "state": "running", "pid": 11111, "healthy": true},
    "cloudflared": {"loaded": true, "state": "running", "pid": 22222, "healthy": true}
  },
  "overallHealthy": true
}
JSON
    exit 0
    ;;
  down)
    echo "[mock-hosting] down --target proxy: ok"
    exit 0
    ;;
  up)
    echo "[mock-hosting] up --target proxy: ok"
    exit 0
    ;;
  *)
    echo "mock-hosting.sh: unsupported args: $*" >&2
    exit 1
    ;;
esac
