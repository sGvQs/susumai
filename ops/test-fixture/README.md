# ops/test-fixture/ — hosting.sh を本番に一切触れずに検証するためのフィクスチャ

## 目的

`ops/hosting.sh` は本番 launchd サービス（`com.susumai.proxy` : `:8787`、
`com.susumai.cloudflared` : named tunnel `susumai-prod`、公開URL
`https://llm.susumai.net`）を起動/停止する運用スクリプトである。

過去に、`hosting.sh` の引数バリデーションを検証するつもりのコマンドが
環境変数を何も設定しないまま実行され、そのまま本番 `com.susumai.proxy` に
実行されて一時停止する事故が起きた。

このディレクトリは、**「指示で禁止する」のではなく「別対象を明示的に指定
しない限り本番には物理的に触れない」** という設計を実現するためのテスト
フィクスチャである。`hosting.sh` はラベル・ポート・URL・plist配置先・
cloudflared識別文字列をすべて環境変数で上書きできるようになっており
（`ops/hosting.sh --help` 相当の usage 表示を参照）、ここではそれらを
本番とは構造的に別物の値に固定したモック一式を提供する。

| ものが | 本番 | フィクスチャ |
| :--- | :--- | :--- |
| proxy ラベル | `com.susumai.proxy` | `com.susumai.proxy.test` |
| cloudflared ラベル | `com.susumai.cloudflared` | `com.susumai.cloudflared.test` |
| proxy ポート | `8787` | `18787` |
| 健全性確認URL | `https://llm.susumai.net/api/tags` | `http://127.0.0.1:18787/api/tags` |
| cloudflared 識別文字列 | `cloudflared tunnel run susumai-prod` | `--tunnel-run susumai-test-tunnel` |
| 実体プロセス | `ops/proxy-prod.mjs` → `rehearsal/proxy.mjs` / 本物の `cloudflared` | `mock-proxy.mjs` / `mock-cloudflared.sh` |

## 本番を巻き込まないことの保証根拠

`ops/hosting.sh` は6つの環境変数（`SUSUMAI_HOSTING_PROXY_LABEL` /
`SUSUMAI_HOSTING_CLOUDFLARED_LABEL` / `SUSUMAI_HOSTING_PROXY_PORT` /
`SUSUMAI_HOSTING_HEALTH_URL` / `SUSUMAI_HOSTING_PLIST_DIR` /
`SUSUMAI_HOSTING_CLOUDFLARED_MATCH`）で対象を切り替えられるが、**1つでも
設定し忘れると本番の値にフォールバックする**（これが安全装置ではなく、
むしろ「デフォルトが本番」という設計そのものの帰結である）。つまり検証者が
6つの変数を個別に手打ちする運用では、1つのタイポ・1つの export 忘れが
即座に本番操作に化ける。

これを構造的に防ぐため、検証には必ず `run-against-fixture.sh` を経由する。
このスクリプトは6変数すべてを内部で一括 export してから `ops/hosting.sh`
を呼ぶだけのラッパーであり、**個別に環境変数を手打ちさせない**。検証者が
することは `run-against-fixture.sh up --target all` のようにコマンドを
叩くことだけであり、環境変数を意識する必要すらない。

## セットアップ手順

### 1. テスト用 plist を実ファイル化する

テンプレートの `__PLACEHOLDER__` を実際の絶対パスに置き換えて
`~/Library/LaunchAgents/` に配置する（本番の `ops/README.md` の
インスタンス化手順と同じ考え方）。

```sh
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"   # susumai リポジトリの絶対パス
NODE_BIN="$(node -e 'console.log(process.execPath)')"
LOG_DIR="$HOME/Library/Logs/susumai-test-fixture"
mkdir -p "$LOG_DIR"

sed -e "s|__NODE_BIN__|$NODE_BIN|g" \
    -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__MOCK_PROXY_PORT__|18787|g" \
    -e "s|__MOCK_PROXY_SHUTDOWN_DELAY_MS__|0|g" \
    -e "s|__STDOUT_LOG__|$LOG_DIR/proxy-out.log|g" \
    -e "s|__STDERR_LOG__|$LOG_DIR/proxy-err.log|g" \
    ops/test-fixture/com.susumai.proxy.test.plist.template \
    > "$HOME/Library/LaunchAgents/com.susumai.proxy.test.plist"

sed -e "s|__REPO_DIR__|$REPO_DIR|g" \
    -e "s|__CF_STDOUT_LOG__|$LOG_DIR/cloudflared-out.log|g" \
    -e "s|__CF_STDERR_LOG__|$LOG_DIR/cloudflared-err.log|g" \
    ops/test-fixture/com.susumai.cloudflared.test.plist.template \
    > "$HOME/Library/LaunchAgents/com.susumai.cloudflared.test.plist"

chmod +x ops/test-fixture/mock-cloudflared.sh
```

### 2. テスト用ジョブを bootstrap する

```sh
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.susumai.proxy.test.plist"
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/com.susumai.cloudflared.test.plist"
```

`RunAtLoad=false` にしてあるため、上記を明示的に実行するまでは何も起動しない
（ログイン時に勝手に立ち上がることはない）。

## hosting.sh をテスト対象に向けて実行する

**個別に環境変数を export してはいけない。** 必ず `run-against-fixture.sh`
経由で実行する。

```sh
# up（no-op / recycled 判定を含めて一連の起動ロジックを検証）
ops/test-fixture/run-against-fixture.sh up --target all

# down（grace-timeout 経由の強制 kill を試すなら短いタイムアウトを指定）
ops/test-fixture/run-against-fixture.sh down --target all --grace-timeout 2
```

grace-timeout の強制 kill 経路を試したい場合は、あらかじめ
`com.susumai.proxy.test.plist` の `MOCK_PROXY_SHUTDOWN_DELAY_MS` を
`--grace-timeout` より大きい値（例: shutdown delay 10000ms に対し
`--grace-timeout 2`）にしておくと、bootout 後にモックが自然終了せず、
`hosting.sh` が `kill -9` で強制終了する経路を再現できる。

readiness-timeout や health() の検証は `--target proxy` のみ、あるいは
`--grace-timeout` / `--readiness-timeout` を明示的に指定して同様に行う。

もし個別に環境変数を確認したい場合でも、`run-against-fixture.sh` の中身を
読めば6変数の対応がすべて書いてある。手打ちで export するのではなく、
このスクリプトを直接呼ぶこと。

## クリーンアップ

検証が終わったら、テスト用ラベルを launchd から外す。

```sh
launchctl bootout gui/$(id -u)/com.susumai.proxy.test
launchctl bootout gui/$(id -u)/com.susumai.cloudflared.test
rm -f "$HOME/Library/LaunchAgents/com.susumai.proxy.test.plist" \
      "$HOME/Library/LaunchAgents/com.susumai.cloudflared.test.plist"
```

（`com.susumai.proxy.test` / `com.susumai.cloudflared.test` はいずれも
本番ラベルと文字列として完全に別物であり、本番の `com.susumai.proxy` /
`com.susumai.cloudflared` には一切影響しない。）
