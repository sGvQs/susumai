#!/bin/bash
#
# ops/hosting.sh — susumai ホスト運用を「開始」「終了」の2コマンドに集約する。
#
# 使い方:
#   ops/hosting.sh up   --target {proxy|cloudflared|all} [--grace-timeout SEC] [--readiness-timeout SEC]
#   ops/hosting.sh down --target {proxy|cloudflared|all} [--grace-timeout SEC]
#
# 対象launchdジョブ（gui LaunchAgent, KeepAlive=true / RunAtLoad=true）:
#   com.susumai.proxy       :8787 固定, plist: ~/Library/LaunchAgents/com.susumai.proxy.plist
#   com.susumai.cloudflared named tunnel susumai-prod, plist: ~/Library/LaunchAgents/com.susumai.cloudflared.plist
# 公開URL: https://llm.susumai.net 。Ollama(:11434) はこのリポジトリの管轄外。
#
# 意図的に --restart は実装しない: 既にhealthyなサービスを強制的に作り直したい場合は
# 既存の `launchctl kickstart -k gui/$(id -u)/<label>` をそのまま使う（後藤さんの決定）。
#
# set -e は使わない: abort時に「途中状態」を表示するロジックが早期exitで壊れるため、
# 各ステップの成否を if で明示的に判定し、失敗時は result[] を記録して abort() を呼ぶ。
set -uo pipefail

UID_NUM=$(id -u)

# --- パラメータ化（環境変数で上書き可能。未設定時の既定値は本番向けと完全一致） ---
# 検証（テストフィクスチャ）向けの使い方は ops/test-fixture/README.md を参照。
# 事故防止の設計方針: 「指示で禁止する」のではなく、これらを1つでも設定し忘れると
# 本番の値にフォールバックする（＝別対象を明示的に指定しない限り本番に触れる）ため、
# テスト時は ops/test-fixture/run-against-fixture.sh 経由で全変数をまとめて設定すること。
PROXY_LABEL="${SUSUMAI_HOSTING_PROXY_LABEL:-com.susumai.proxy}"
CLOUDFLARED_LABEL="${SUSUMAI_HOSTING_CLOUDFLARED_LABEL:-com.susumai.cloudflared}"
PROXY_PORT="${SUSUMAI_HOSTING_PROXY_PORT:-8787}"
PUBLIC_HEALTH_URL="${SUSUMAI_HOSTING_HEALTH_URL:-https://llm.susumai.net/api/tags}"
PLIST_DIR="${SUSUMAI_HOSTING_PLIST_DIR:-$HOME/Library/LaunchAgents}"
CLOUDFLARED_MATCH="${SUSUMAI_HOSTING_CLOUDFLARED_MATCH:-cloudflared tunnel run susumai-prod}"

# NOTE: 連想配列(declare -A)は使わない。本番機の /bin/bash は macOS 標準の 3.2.57
# (Apple最終GPLv2版)で連想配列非対応のため、short名(proxy/cloudflared)からの
# 変換とラベルごとの結果記録は case 文ベースの関数で行う（bash 3.2 互換）。
label_for() {
  case "$1" in
    proxy) printf '%s' "$PROXY_LABEL" ;;
    cloudflared) printf '%s' "$CLOUDFLARED_LABEL" ;;
  esac
}
plist_for() {
  case "$1" in
    proxy) printf '%s' "$PLIST_DIR/${PROXY_LABEL}.plist" ;;
    cloudflared) printf '%s' "$PLIST_DIR/${CLOUDFLARED_LABEL}.plist" ;;
  esac
}

# result[L] 相当（no-op / recycled / stopped / FAILED(reason)）を short名ごとに保持。
RESULT_PROXY=""
RESULT_CLOUDFLARED=""
set_result() {
  case "$1" in
    proxy) RESULT_PROXY="$2" ;;
    cloudflared) RESULT_CLOUDFLARED="$2" ;;
  esac
}
get_result() {
  case "$1" in
    proxy) printf '%s' "${RESULT_PROXY:-(未処理)}" ;;
    cloudflared) printf '%s' "${RESULT_CLOUDFLARED:-(未処理)}" ;;
  esac
}

declare -a TARGET_LABELS=()

# query()/holder()/health() の戻り値の受け渡し用グローバル（bash関数は複数値を
# 返せないため、呼び出し規約として明示的にこれらの変数へ書き込む）。
QUERY_LOADED=""
QUERY_STATE=""
QUERY_PID=""
HOLDER_PIDS=""
BOOTOUT_ERR=""
BOOTSTRAP_ERR=""

COMMAND=""
TARGET=""
JSON_MODE="false"
# --grace-timeout / --readiness-timeout の既定値は未検証の初期値。
# ストリーミング応答中は proxy が grace_timeout 以内に自然終了しない可能性がある。
GRACE_TIMEOUT=15
READINESS_TIMEOUT=10

log_info()  { printf '[INFO] %s\n' "$*"; }
log_warn()  { printf '[WARN] %s\n' "$*" >&2; }
log_error() { printf '[ERROR] %s\n' "$*" >&2; }

usage() {
  cat <<'EOF'
使い方:
  ops/hosting.sh up     --target {proxy|cloudflared|all} [--grace-timeout SEC] [--readiness-timeout SEC]
  ops/hosting.sh down   --target {proxy|cloudflared|all} [--grace-timeout SEC]
  ops/hosting.sh status --target {proxy|cloudflared|all} [--json]

--target は必須（省略不可）。
status は read-only（launchctl print / curl による確認のみ）で、副作用を
一切持たない。引数が正しい限り常に exit 0 で終了し、個別ターゲットの異常
（未ロード・不健全等）は非ゼロ終了ではなく JSON/テキストのフィールドとして
表現する。
--grace-timeout      既定 15 秒（未検証の初期値。bootout 後の自然終了を待つ上限）
--readiness-timeout  既定 10 秒（未検証の初期値。up のみ。bootstrap 後の健全性待ち上限）

既にhealthyなサービスを作り直したいだけなら --restart ではなく
  launchctl kickstart -k gui/$(id -u)/<label>
を使う（本スクリプトはあえて --restart を持たない）。

環境変数（すべて省略可。未設定時は本番向けの既定値のまま動作する）:
  SUSUMAI_HOSTING_PROXY_LABEL        既定 com.susumai.proxy
  SUSUMAI_HOSTING_CLOUDFLARED_LABEL  既定 com.susumai.cloudflared
  SUSUMAI_HOSTING_PROXY_PORT         既定 8787
  SUSUMAI_HOSTING_HEALTH_URL         既定 https://llm.susumai.net/api/tags
  SUSUMAI_HOSTING_PLIST_DIR          既定 ~/Library/LaunchAgents
  SUSUMAI_HOSTING_CLOUDFLARED_MATCH  既定 "cloudflared tunnel run susumai-prod"

検証（本番に触れないテスト実行）の使い方は ops/test-fixture/README.md を参照。
EOF
}

# --- 副作用のないヘルパー ----------------------------------------------

# query(short): launchctl print の結果を QUERY_LOADED / QUERY_STATE / QUERY_PID に書く。
query() {
  local short="$1" label out rc
  label="$(label_for "$short")"
  out=$(launchctl print "gui/${UID_NUM}/${label}" 2>&1)
  rc=$?
  if (( rc != 0 )); then
    QUERY_LOADED="false"
    QUERY_STATE="not-loaded"
    QUERY_PID=""
    return 1
  fi
  QUERY_LOADED="true"
  QUERY_STATE=$(printf '%s\n' "$out" | awk -F'= ' '/^[[:space:]]*state = /{print $2; exit}')
  if [[ "$QUERY_STATE" == "running" ]]; then
    QUERY_PID=$(printf '%s\n' "$out" | awk -F'= ' '/^[[:space:]]*pid = /{print $2; exit}')
  else
    QUERY_PID=""
  fi
  return 0
}

# holder(short): その資源を現在握っている PID 集合を HOLDER_PIDS へ（空白/改行区切り、空もありうる）。
holder() {
  local short="$1"
  case "$short" in
    proxy)
      # -sTCP:LISTEN は必須。付けないと、公開URL経由でトラフィックが流れている間に
      # `lsof -ti :PORT` が cloudflared 側の ESTABLISHED 接続の PID まで拾ってしまい、
      # 正常稼働中でも up が誤って abort する flaky な不具合になる（実機検証済み）。
      HOLDER_PIDS=$(lsof -ti ":${PROXY_PORT}" -sTCP:LISTEN 2>/dev/null || true)
      ;;
    cloudflared)
      # rehearse の quick tunnel は `cloudflared tunnel --url ...` で文字列が異なるため
      # 誤マッチしないことを実機確認済み。
      HOLDER_PIDS=$(pgrep -f "$CLOUDFLARED_MATCH" 2>/dev/null || true)
      ;;
    *)
      HOLDER_PIDS=""
      ;;
  esac
}

# health(short): running かつ公開URL経由で401が返ることを確認する。
health() {
  local short="$1" code
  query "$short"
  if [[ "$QUERY_STATE" != "running" ]]; then
    return 1
  fi
  # 後藤さんの決定: --target が proxy/cloudflared/all のいずれであっても、公開URL
  # (llm.susumai.net) 経由で一律に判定する。ローカル直 127.0.0.1:8787 は使わない。
  # 理由: 公開エンドポイントが実際に機能しているかどうかが唯一の関心事であり、
  # --target proxy 単体実行時でも cloudflared 側の異常を意図的に拾いたいため。
  # この結合により、--target proxy だけを対象にしても cloudflared 側が死んでいれば
  # FAILED 判定になり得る——これは既知の仕様（バグではない）。
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$PUBLIC_HEALTH_URL" 2>/dev/null || echo "000")
  [[ "$code" == "401" ]]
}

pid_cmdline() {
  local pid="$1"
  ps -o command= -p "$pid" 2>/dev/null || echo "(不明: プロセス消失)"
}

# holder_matches_pid(pid): 直前に holder() で取得した HOLDER_PIDS が
# ちょうど単一の pid と一致するかを判定する。
holder_matches_pid() {
  local pid="$1" trimmed
  [[ -z "$pid" ]] && return 1
  trimmed=$(printf '%s\n' "$HOLDER_PIDS" | tr -s ' \t\n' '\n' | sed '/^$/d' | sort -u)
  [[ "$trimmed" == "$pid" ]]
}

describe_holder() {
  local p out=""
  for p in $HOLDER_PIDS; do
    out+="PID=${p} CMD=$(pid_cmdline "$p"); "
  done
  [[ -z "$out" ]] && out="(空)"
  printf '%s' "$out"
}

# --- launchctl 操作 ------------------------------------------------------

do_bootout() {
  local short="$1" label err rc
  label="$(label_for "$short")"
  err=$(launchctl bootout "gui/${UID_NUM}/${label}" 2>&1)
  rc=$?
  if (( rc != 0 )); then
    BOOTOUT_ERR="$err"
    return 1
  fi
  return 0
}

do_bootstrap() {
  local short="$1" plist err rc
  plist="$(plist_for "$short")"
  err=$(launchctl bootstrap "gui/${UID_NUM}" "$plist" 2>&1)
  rc=$?
  if (( rc != 0 )); then
    BOOTSTRAP_ERR="$err"
    return 1
  fi
  return 0
}

# --- 待機ロジック（up/down で共有） --------------------------------------

# wait_for_release(short, pid_before, grace_timeout): bootout 後の自然終了を待つ。
# 真実源は holder(L) が空になったことのみ。state はログ表示用の参考情報であり、
# ループの終了条件には使わない（launchdのstateはbootout送信後ほぼ即座にrunningを
# 離脱するが、実プロセスはまだ生存し資源を保持し続けていることがあるため、
# stateだけで解消済みと判定すると誤って早期returnしてしまう）。
# holderが空になれば成功(0)。grace_timeout秒経過してもholderが空にならなければ
# timeout(1) を返し、呼び出し元の release_or_abort() の kill -9 分岐に処理を委ねる。
wait_for_release() {
  local short="$1" pid_before="$2" grace_timeout="$3" max_polls poll
  log_info "PID ${pid_before:-(不明)} の bootout を送信。最大 ${grace_timeout}s 待機"
  max_polls=$(( grace_timeout * 2 ))
  for (( poll=0; poll<=max_polls; poll++ )); do
    holder "$short"
    query "$short"
    if [[ -z "$HOLDER_PIDS" ]]; then
      return 0
    fi
    if (( poll < max_polls )); then
      sleep 0.5
    fi
  done
  return 1
}

# wait_for_health(short, readiness_timeout): bootstrap 直後の健全性待ち。
wait_for_health() {
  local short="$1" readiness_timeout="$2" max_polls poll
  max_polls=$(( readiness_timeout * 2 ))
  for (( poll=0; poll<=max_polls; poll++ )); do
    if health "$short"; then
      return 0
    fi
    if (( poll < max_polls )); then
      sleep 0.5
    fi
  done
  return 1
}

# release_or_abort(short, pid_before, grace_timeout): wait_for_release がtimeoutした
# 場合のみ、pid_before と一致するholderに限ってkillする。不一致ならkillせずabort。
release_or_abort() {
  local short="$1" pid_before="$2" grace_timeout="$3" detail
  if wait_for_release "$short" "$pid_before" "$grace_timeout"; then
    return 0
  fi
  holder "$short"
  if holder_matches_pid "$pid_before"; then
    log_warn "PID ${pid_before} (CMD: $(pid_cmdline "$pid_before")) が ${grace_timeout}s 以内に終了しなかったため強制終了します"
    kill -9 "$pid_before" 2>/dev/null || true
    return 0
  fi
  detail=$(describe_holder)
  log_error "PID ${pid_before} の bootout 後、想定外の holder を検出しました (${short}): ${detail}"
  set_result "$short" "FAILED(unrecognized holder: ${detail})"
  abort
}

# --- 1ラベル分の up/down --------------------------------------------------

process_up_label() {
  local short="$1" pid_before loaded detail

  query "$short"
  pid_before="$QUERY_PID"
  loaded="$QUERY_LOADED"

  if health "$short"; then
    set_result "$short" "no-op"
    return 0
  fi

  if [[ "$loaded" == "true" ]]; then
    if ! do_bootout "$short"; then
      log_error "bootout に失敗しました (${short}): ${BOOTOUT_ERR}"
      set_result "$short" "FAILED(bootout error: ${BOOTOUT_ERR})"
      abort
    fi
    release_or_abort "$short" "$pid_before" "$GRACE_TIMEOUT"
  fi

  # 占有解消の最終確認（not-loaded 経由の場合もここに合流）。
  # holder が空でなければ pid_before との一致有無にかかわらず kill せず abort する
  # （kill は release_or_abort の1回に限定し、ここでは二重にkillしない設計）。
  holder "$short"
  if [[ -n "$HOLDER_PIDS" ]]; then
    detail=$(describe_holder)
    log_error "占有解消を確認できませんでした (${short}): ${detail}"
    set_result "$short" "FAILED(unrecognized holder: ${detail})"
    abort
  fi

  if ! do_bootstrap "$short"; then
    log_error "bootstrap に失敗しました (${short}): ${BOOTSTRAP_ERR}"
    set_result "$short" "FAILED(bootstrap error: ${BOOTSTRAP_ERR})"
    abort
  fi

  if wait_for_health "$short" "$READINESS_TIMEOUT"; then
    set_result "$short" "recycled"
  else
    log_error "bootstrap 後、${READINESS_TIMEOUT}s 以内に healthy になりませんでした (${short})"
    set_result "$short" "FAILED(post-bootstrap unhealthy within ${READINESS_TIMEOUT}s)"
    abort
  fi
}

process_down_label() {
  local short="$1" pid_before loaded detail

  query "$short"
  pid_before="$QUERY_PID"
  loaded="$QUERY_LOADED"

  if [[ "$loaded" != "true" ]]; then
    set_result "$short" "no-op(already stopped)"
    return 0
  fi

  if ! do_bootout "$short"; then
    log_error "bootout に失敗しました (${short}): ${BOOTOUT_ERR}"
    set_result "$short" "FAILED(bootout error: ${BOOTOUT_ERR})"
    abort
  fi

  release_or_abort "$short" "$pid_before" "$GRACE_TIMEOUT"

  query "$short"
  holder "$short"
  if [[ "$QUERY_LOADED" == "true" || -n "$HOLDER_PIDS" ]]; then
    detail=$(describe_holder)
    log_error "停止を確認できませんでした (${short}): loaded=${QUERY_LOADED} holder=${detail}"
    set_result "$short" "FAILED(unrecognized holder: ${detail})"
    abort
  fi

  set_result "$short" "stopped"
}

# --- 表示 / abort ---------------------------------------------------------

print_results() {
  local short
  for short in "${TARGET_LABELS[@]}"; do
    printf '  %-12s %s\n' "$short" "$(get_result "$short")"
  done
}

abort() {
  local short healthy
  echo "" >&2
  echo "=== ABORT: 対象ラベルの現在状態 ===" >&2
  for short in "${TARGET_LABELS[@]}"; do
    query "$short"
    healthy="ng"
    health "$short" && healthy="ok"
    printf '  %-12s state=%-14s pid=%-8s health=%s\n' "$short" "$QUERY_STATE" "${QUERY_PID:-N/A}" "$healthy" >&2
  done
  echo "" >&2
  echo "=== 結果 ===" >&2
  print_results >&2
  exit 1
}

# --- コマンド --------------------------------------------------------------

set_target_labels() {
  local target="$1" cmd="$2"
  case "$target" in
    proxy) TARGET_LABELS=(proxy) ;;
    cloudflared) TARGET_LABELS=(cloudflared) ;;
    all)
      if [[ "$cmd" == "up" ]]; then
        TARGET_LABELS=(proxy cloudflared)
      else
        TARGET_LABELS=(cloudflared proxy)
      fi
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

cmd_up() {
  local short
  for short in "${TARGET_LABELS[@]}"; do
    process_up_label "$short"
  done
  echo "=== up 完了 ==="
  print_results
  exit 0
}

cmd_down() {
  local short
  for short in "${TARGET_LABELS[@]}"; do
    process_down_label "$short"
  done
  echo "=== down 完了 ==="
  print_results
  exit 0
}

# --- status（read-only。abort() は一切呼ばず、query()/health() のみを使う） ----

# json_escape(str): ダブルクォート/バックスラッシュのみエスケープする。
# state 文字列は launchctl print の "state = X" 行由来の英単語のみなので
# これで十分（制御文字混入は想定しない）。
json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  printf '%s' "$s"
}

# ts_now(): ローカルタイムゾーン付き ISO8601 (例: 2026-09-13T21:03:00+09:00)。
# BSD date の %z はコロン無し(+0900)を返すため、コロンを挿入して整形する。
ts_now() {
  local raw
  raw=$(date +'%Y-%m-%dT%H:%M:%S%z')
  printf '%s:%s\n' "${raw:0:22}" "${raw:22:2}"
}

cmd_status() {
  local short healthy_all="true" first="true" pid_json state_json healthy_json loaded_json

  if [[ "$JSON_MODE" == "true" ]]; then
    printf '{\n  "ts": "%s",\n  "targets": {\n' "$(ts_now)"
  else
    echo "=== status ==="
  fi

  for short in "${TARGET_LABELS[@]}"; do
    if health "$short"; then
      healthy_json="true"
    else
      healthy_json="false"
      healthy_all="false"
    fi
    loaded_json="$QUERY_LOADED"
    state_json="$(json_escape "$QUERY_STATE")"
    if [[ -n "$QUERY_PID" ]]; then
      pid_json="$QUERY_PID"
    else
      pid_json="null"
    fi

    if [[ "$JSON_MODE" == "true" ]]; then
      if [[ "$first" != "true" ]]; then
        printf ',\n'
      fi
      first="false"
      printf '    "%s": {"loaded": %s, "state": "%s", "pid": %s, "healthy": %s}' \
        "$short" "$loaded_json" "$state_json" "$pid_json" "$healthy_json"
    else
      printf '  %-12s loaded=%-5s state=%-14s pid=%-8s healthy=%s\n' \
        "$short" "$loaded_json" "$QUERY_STATE" "${QUERY_PID:-N/A}" "$healthy_json"
    fi
  done

  if [[ "$JSON_MODE" == "true" ]]; then
    printf '\n  },\n  "overallHealthy": %s\n}\n' "$healthy_all"
  else
    printf 'overallHealthy: %s\n' "$healthy_all"
  fi
  exit 0
}

main() {
  if [[ $# -lt 1 ]]; then
    usage
    exit 1
  fi
  COMMAND="$1"
  shift
  case "$COMMAND" in
    up|down|status) ;;
    *)
      usage
      exit 1
      ;;
  esac

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --target)
        TARGET="${2:-}"
        shift 2
        ;;
      --grace-timeout)
        GRACE_TIMEOUT="${2:-}"
        shift 2
        ;;
      --readiness-timeout)
        READINESS_TIMEOUT="${2:-}"
        shift 2
        ;;
      --json)
        JSON_MODE="true"
        shift
        ;;
      *)
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "$TARGET" ]]; then
    usage
    exit 1
  fi
  case "$TARGET" in
    proxy|cloudflared|all) ;;
    *)
      usage
      exit 1
      ;;
  esac
  if ! [[ "$GRACE_TIMEOUT" =~ ^[0-9]+$ ]]; then
    usage
    exit 1
  fi
  if [[ "$COMMAND" == "up" ]] && ! [[ "$READINESS_TIMEOUT" =~ ^[0-9]+$ ]]; then
    usage
    exit 1
  fi

  if [[ "$COMMAND" == "status" ]]; then
    set_target_labels "$TARGET" "up"
    cmd_status
  elif [[ "$COMMAND" == "up" ]]; then
    set_target_labels "$TARGET" "$COMMAND"
    cmd_up
  else
    set_target_labels "$TARGET" "$COMMAND"
    cmd_down
  fi
}

main "$@"
