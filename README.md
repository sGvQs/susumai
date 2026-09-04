# susumai

セルフホストした Ollama（DeepSeek R1）に、Cloudflare トンネル越しで話すゼロ依存 CLI。

## インストール

```
npm i -g github:sGvQs/susumai
```

Node.js >= 22.18 が必要です。

このコマンドはリポジトリが public であることが前提です。private のままだと、インストールする各マシンに GitHub 認証（`gh auth` / SSH 鍵 / トークン）が必要になります。

install 時に `prepare` スクリプトでビルド（`tsup`）が走るため、devDependencies が入る環境である必要があります。`NODE_ENV=production` や `npm config get omit` に `dev` が入っている環境では、`npm i -g --include=dev github:sGvQs/susumai` のように `--include=dev` を付けるか、その設定を一時的に外してください。

特定のタグ／コミットに固定したい場合は `npm i -g github:sGvQs/susumai#<tag or sha>` と書けます。

## 設定

```
susumai config set --url https://<your-tunnel>.trycloudflare.com --token <bearer-token>
susumai config get     # 現在の設定（token はマスク表示）
susumai config path    # 設定ファイルの場所（$XDG_CONFIG_HOME/susumai/config.json、mode 0600）
```

その他のキー: `--model`（既定 `deepseek-r1:8b`）/ `--num-ctx`（既定 16384）/ `--stream true|false`。

## 使い方

```
susumai                       # 対話 REPL（.exit で終了。生成中の Ctrl-C で中断）
susumai "Rust の所有権を一言で"   # ワンショット
echo "要約して" | susumai       # パイプ入力
```

思考（thinking）はデフォルトで淡色表示、本文は通常色。会話履歴は直近 16 ターンのみ保持し、
超過分は Ollama 側が左トランケートします。

## サーバ（トンネル）の立て方

トンネルの立て方はリポジトリの `rehearsal/` を参照してください（公開パッケージには含まれません）。
`rehearsal/proxy.mjs` 冒頭のコメントを参照してください（allowlist + Bearer のゼロ依存プロキシ）。
`trycloudflare` の quick tunnel は検証用です（URL が揮発性・本番不可）。
`deepseek-r1:32b` は 24GB 単機では非推奨です（`deepseek-r1:8b` を推奨）。

`trycloudflare.com` のサブドメインは ISP や社内 DNS が丸ごとブロックすることがあります（`dig` で `REFUSED` や `not found` が返る。2026-09-04 に実際に踏みました）。
その場合はそのマシンの DNS リゾルバを `1.1.1.1` / `8.8.8.8` に変更するか、quick tunnel をやめて named tunnel を使ってください。

## リポジトリ

https://github.com/sGvQs/susumai

`dist/` は git に含めておらず、install 時に `prepare` でビルドされます。
