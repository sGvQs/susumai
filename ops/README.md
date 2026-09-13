# ops/ — 本番常駐（段階3）

本番 proxy と cloudflared を launchd で常駐させるためのファイル。
**コミットするのは placeholder 入りテンプレートだけ。** 実 home パスで埋めた
`*.plist` と本番ログは `.gitignore` 済み。

インフラ操作（`cloudflared tunnel create` / `route dns` / `launchctl`）は
後藤さん本人が行う。ここにあるのはコミット可能なファイルのみ。
（`cloudflared service install` は tunnel 作成直後の一時的な動作確認にのみ
使うことがあり、常駐には使わない。実際の常駐は下記の通り gui LaunchAgent
`com.susumai.cloudflared` として稼働している。）

## ファイル

| ファイル | 役割 |
| :--- | :--- |
| `proxy-prod.mjs` | launchd から起動する本番 proxy のシム。`SUSUMAI_PROD=1` を立てて単一ソース `../rehearsal/proxy.mjs` の `startServer()` を dynamic import で呼ぶだけ。`SUSUMAI_PROXY_LOG` 未設定なら起動拒否。 |
| `com.susumai.proxy.plist.template` | 本番 proxy の LaunchAgent テンプレート。 |
| `com.susumai.cloudflared.plist.template` | named tunnel `susumai-prod` の常駐テンプレート。実際にこのテンプレートから生成した gui LaunchAgent `com.susumai.cloudflared` として常駐している（`cloudflared service install` は使っていない）。 |

## placeholder 一覧

| placeholder | 埋める値 | 例 |
| :--- | :--- | :--- |
| `__NODE_BIN__` | node **実体**の絶対パス（下の Volta 注意を参照） | `/opt/homebrew/bin/node` |
| `__REPO_DIR__` | この susumai リポジトリの絶対パス | `/Users/susum/Documents/Workspace/susumai` |
| `__PROD_LOG__` | 本番アクセスログの出力先 | `/Users/susum/Library/Logs/susumai/proxy-access.log` |
| `__ALLOWLIST_JSON__` | 本番 GitHub アカウント許可リスト JSON の絶対パス（`.gitignore` 済みの実ファイル） | `/Users/susum/Documents/Workspace/susumai/rehearsal/allowlist.prod.json` |
| `__STDOUT_LOG__` / `__STDERR_LOG__` | proxy の stdout / stderr | `/Users/susum/Library/Logs/susumai/proxy-out.log` |
| `__CLOUDFLARED_BIN__` | cloudflared 実行ファイルの絶対パス | `/opt/homebrew/bin/cloudflared` |
| `__CF_STDOUT_LOG__` / `__CF_STDERR_LOG__` | cloudflared の stdout / stderr | `/Users/susum/Library/Logs/susumai/cloudflared-out.log` |
| `__TUNNEL_NAME__` | named tunnel 名 | `susumai-prod` |

将来 Mac mini へ移すときは上の値を差し替えるだけ。テンプレートは環境非依存。

**Volta 環境の注意（Mac mini 移設時のハマりどころ）:** `command -v node` は Volta の
シム（`~/.volta/bin/node`）を返すことがあり、launchd 下ではシムがうまく解決できない。
`__NODE_BIN__` には**実体の node バイナリ**（例
`~/.volta/tools/image/node/<version>/bin/node`）を入れる。`node -e 'console.log(process.execPath)'`
で実体パスを確認できる。

## インスタンス化（sed ワンライナー）

```sh
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(node -e 'console.log(process.execPath)')"   # 実体パス（Volta シムを避ける）
CLOUDFLARED_BIN="$(command -v cloudflared)"
TUNNEL_NAME="susumai-prod"
LOG_DIR="$HOME/Library/Logs/susumai"
mkdir -p "$LOG_DIR"

sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__PROD_LOG__|$LOG_DIR/proxy-access.log|g" \
    -e "s|__ALLOWLIST_JSON__|$REPO_DIR/rehearsal/allowlist.prod.json|g" \
    -e "s|__STDOUT_LOG__|$LOG_DIR/proxy-out.log|g" \
    -e "s|__STDERR_LOG__|$LOG_DIR/proxy-err.log|g" \
    ops/com.susumai.proxy.plist.template \
    > "$HOME/Library/LaunchAgents/com.susumai.proxy.plist"

sed -e "s|__CLOUDFLARED_BIN__|$CLOUDFLARED_BIN|g" \
    -e "s|__TUNNEL_NAME__|$TUNNEL_NAME|g" \
    -e "s|__CF_STDOUT_LOG__|$LOG_DIR/cloudflared-out.log|g" \
    -e "s|__CF_STDERR_LOG__|$LOG_DIR/cloudflared-err.log|g" \
    ops/com.susumai.cloudflared.plist.template \
    > "$HOME/Library/LaunchAgents/com.susumai.cloudflared.plist"
```

## ロード / 収束 / 撤収

```sh
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.susumai.proxy.plist
launchctl kickstart -k gui/$(id -u)/com.susumai.proxy   # 1 インスタンスに収束
launchctl bootout gui/$(id -u)/com.susumai.proxy         # 撤収
```

`npm run rehearse` を回す前に本番 proxy を止める手順は `rehearsal/RUNBOOK.md` を参照。
`pkill` は使わない（`KeepAlive=true` で即 respawn する）。
