# susumai

セルフホストした Ollama（DeepSeek R1）に、Cloudflare トンネル越しで話すゼロ依存 CLI。

クイックに使うなら [QUICKSTART.md](QUICKSTART.md)、ホスト運用は [HOSTING.md](HOSTING.md)。

## インストール

主経路（registry、**0.2.0 以降**）:

```
npm i -g susumai
```

Node.js >= 22.18 が必要です。ビルド済みの `dist/` を同梱しているので、インストール時にビルドは走りません（devDependencies も不要）。

`susumai login` / `susumai logout` / `susumai auth status`（GitHub アカウントでのログイン）は **0.2.0 以降**の機能です。主経路の `npm i -g susumai` で 0.2.0（login 入り）が普通に入ります。

registry を使いたくない、または特定のタグ／コミットに固定して入れたい場合は、GitHub リポジトリから直接入れる副経路もあります:

```
npm i -g github:sGvQs/susumai            # 最新
npm i -g github:sGvQs/susumai#<tag/sha>  # タグ／コミット固定
```

`dist/` はコミット済み・`files: ["dist"]` なので、registry・git 直インストールのどちらでも `bin` が解決されます。git 経路はリポジトリが public であることが前提です（private の場合は各マシンに GitHub 認証が必要）。

## 設定

接続先とログイン:

```
susumai config set --url https://llm.susumai.net   # 接続先（固定 URL）
susumai login                                      # GitHub アカウントでログイン（device flow）
```

`susumai login` は GitHub の Device Authorization Grant を実行します。表示された URL をブラウザで開き、コードを入力するとログインが完了し、認証情報が `credentials.json`（mode 0600、`config.json` とは別ファイル）に保存されます。以後のリクエストはこのトークンを自動で使います。手動でのトークンのコピペは不要です。

企業マシンなどで device flow がネットワーク的に塞がれている場合は、GitHub の classic personal access token（`ghp_…`。fine-grained ではなく classic 推奨）を作って貼るフォールバックがあります:

```
susumai config set --token ghp_xxxxxxxxxxxx
```

`susumai logout` で `credentials.json` を削除します（`config.json` の token は残っていれば有効なまま）。`susumai auth status` でログイン状態を確認できます。

```
susumai config get     # 現在の設定（token はマスク表示）
susumai config path    # 設定ファイルの場所（$XDG_CONFIG_HOME/susumai/config.json、mode 0600）
```

その他のキー: `--model`（既定 `deepseek-r1:8b`）/ `--num-ctx`（既定 16384）/ `--stream true|false`。

サーバ側（proxy）が認証を拒否すると CLI は 401 を報告し、`susumai login`（device flow）と classic PAT フォールバック（`susumai config set --token ghp_…`）の両経路を案内します。誰が通れるかを決めるのは proxy 側の GitHub アカウント許可リストです。

## 使い方

```
susumai                       # 対話 REPL（.exit で終了。生成中の Ctrl-C で中断）
susumai "Rust の所有権を一言で"   # ワンショット
echo "要約して" | susumai       # パイプ入力
```

思考（thinking）はデフォルトで淡色表示、本文は通常色。会話履歴は CLI 側で直近 16 ターンのみ保持します。
そのうえで `--num-ctx` のトークン上限を超えた分は Ollama 側が左トランケートします。

## サーバ（トンネル）の立て方

### 定常運用

named tunnel（固定 URL `https://llm.susumai.net`）＋ cloudflared / proxy の launchd 常駐です。
手順・インスタンス化・plist はリポジトリ内の `ops/README.md` を正とします（設計の経緯は作者の Vault 内 `Gamebook_susumai_auth` にあります）。
proxy は GitHub アカウント許可リストで認証します。`deepseek-r1:32b` は 24GB 単機では非推奨です（`deepseek-r1:8b` を推奨）。

### 開発時にローカルで試すとき（参考）

quick tunnel でトンネルを一時的に立てる場合の参考です。定常運用には使いません。

- トンネルの立て方はリポジトリの `rehearsal/` を参照してください（公開パッケージには含まれません）。
- `rehearsal/proxy.mjs` 冒頭のコメントを参照してください（allowlist + Bearer のゼロ依存プロキシ）。
- `trycloudflare` の quick tunnel は検証用です（URL が揮発性・本番不可）。
- `trycloudflare.com` のサブドメインは ISP や社内 DNS が丸ごとブロックすることがあります（`dig` で `REFUSED` や `not found` が返る。2026-09-04 に実際に踏みました）。その場合はそのマシンの DNS リゾルバを `1.1.1.1` / `8.8.8.8` に変更するか、quick tunnel をやめて named tunnel を使ってください。

## リポジトリ

https://github.com/sGvQs/susumai

`package.json` の `repository` フィールド（`github:sGvQs/susumai`）と一致します。

`dist/index.js` はコミット済みで、`files: ["dist"]` によって公開パッケージにも含まれます。`prepare` などのインストール時ビルドはありません。ソースを変更したら `npm run build` で `dist/` を更新してコミットします。
