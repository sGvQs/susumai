#!/bin/bash
#
# ops/test-fixture/run-against-fixture.sh — hosting.sh をテストフィクスチャに
# 向けて実行するための唯一の入口。
#
# 背景（なぜこれが必須か）:
#   ops/hosting.sh はラベル・ポート・URL 等を6つの環境変数で上書きできるが、
#   1つでも設定し忘れると本番の値にフォールバックする。個別に export させる運用は
#   人間のミスを構造的に防げない（実際に過去、検証コマンドが誤って本番へ実行され
#   本番 proxy が一時停止する事故が起きた）。
#   このスクリプトは6変数を「まとめて」テスト用の値に固定してから
#   ops/hosting.sh を呼ぶことで、個別の手打ちを一切不要にする。
#
# 使い方:
#   ops/test-fixture/run-against-fixture.sh up   --target all
#   ops/test-fixture/run-against-fixture.sh down --target all
#   ops/test-fixture/run-against-fixture.sh up   --target proxy --grace-timeout 3
#   （引数はすべてそのまま ops/hosting.sh に渡される）
#
# 前提: ops/test-fixture/README.md の手順でテスト用 plist を
#   com.susumai.proxy.test / com.susumai.cloudflared.test として
#   あらかじめ bootstrap 済みであること（bootstrap 自体はこのスクリプトの
#   責務ではない。up/down が操作するのはあくまで launchd 上のジョブの起動/停止）。
set -uo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"

export SUSUMAI_HOSTING_PROXY_LABEL="com.susumai.proxy.test"
export SUSUMAI_HOSTING_CLOUDFLARED_LABEL="com.susumai.cloudflared.test"
export SUSUMAI_HOSTING_PROXY_PORT="18787"
export SUSUMAI_HOSTING_HEALTH_URL="http://127.0.0.1:18787/api/tags"
export SUSUMAI_HOSTING_PLIST_DIR="$HOME/Library/LaunchAgents"
export SUSUMAI_HOSTING_CLOUDFLARED_MATCH="--tunnel-run susumai-test-tunnel"

echo "[run-against-fixture] 以下のテスト用設定で ops/hosting.sh を実行します:" >&2
echo "  SUSUMAI_HOSTING_PROXY_LABEL=$SUSUMAI_HOSTING_PROXY_LABEL" >&2
echo "  SUSUMAI_HOSTING_CLOUDFLARED_LABEL=$SUSUMAI_HOSTING_CLOUDFLARED_LABEL" >&2
echo "  SUSUMAI_HOSTING_PROXY_PORT=$SUSUMAI_HOSTING_PROXY_PORT" >&2
echo "  SUSUMAI_HOSTING_HEALTH_URL=$SUSUMAI_HOSTING_HEALTH_URL" >&2
echo "  SUSUMAI_HOSTING_PLIST_DIR=$SUSUMAI_HOSTING_PLIST_DIR" >&2
echo "  SUSUMAI_HOSTING_CLOUDFLARED_MATCH=$SUSUMAI_HOSTING_CLOUDFLARED_MATCH" >&2
echo "" >&2

exec "$REPO_DIR/ops/hosting.sh" "$@"
