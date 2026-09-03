# susumai

セルフホストした Ollama（DeepSeek R1）に、Cloudflare トンネル越しで話すゼロ依存 CLI。

## インストール

```
npm i -g susumai
```

Node.js >= 22.18 が必要です。

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

## リポジトリ

`package.json` の `repository`（`github:susum/susumai`）は未作成の可能性があります。
