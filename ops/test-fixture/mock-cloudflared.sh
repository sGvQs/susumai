#!/bin/bash
#
# ops/test-fixture/mock-cloudflared.sh — hosting.sh 検証用のモック cloudflared（本番とは無関係）。
#
# 目的:
#   ops/hosting.sh の holder(cloudflared) は `pgrep -f "cloudflared tunnel run susumai-prod"`
#   で本番プロセスを識別する。このモックは固定引数 `--tunnel-run susumai-test-tunnel` で
#   起動し、`ps`/`pgrep -f` 越しにこの文字列が本番の "cloudflared tunnel run susumai-prod"
#   と絶対に混同されないことを保証する。依存なし。
#
# 起動:
#   ops/test-fixture/mock-cloudflared.sh --tunnel-run susumai-test-tunnel
#
# 挙動:
#   sleep infinity 相当で起動し続け、SIGTERM を受けたら即終了する（trap）。
set -uo pipefail

log() { printf '[mock-cloudflared] %s\n' "$*"; }

log "起動: $0 $* (pid=$$)"

term() {
  log "SIGTERM 受信、終了します"
  exit 0
}
trap term TERM
trap term INT

# NOTE: `sleep infinity` は GNU coreutils 専用で、本番機の BSD sleep (macOS 標準)
# では "usage: sleep number[unit]" エラーになり使えない。十分に長い秒数
# （2147483647 = 32bit 上限、約68年）で代用する。
# `wait` で任意のシグナルに即座に反応できるようにする（sleep単体をforegroundで
# 待つと、子プロセスの終了待ちでシグナル反応が遅れることがあるため、バックグラウンドで
# sleep させて親側で wait する）。
sleep 2147483647 &
wait $!
