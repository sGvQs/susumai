# RUNBOOK — susumai 当日検証

> これは認証導入前の quick tunnel ＋ 共有 Bearer トークン経路の記録です。定常運用（GitHub アカウントでのログイン・固定 URL `llm.susumai.net`・cloudflared / proxy の launchd 常駐）は `[[50_Meta/Gamebook_susumai_auth]]` を正とします。以下は rehearse（検証）フロー向けで、§5 の1点訂正と §8 の追加（段階3）を除き本文はそのままです。

本線は **`npm run rehearse`**（`rehearsal/rehearse.mjs`）。end-to-end で通ることを確認済み。
この文書はその周辺だけを持つ: 全体像の理解／rehearse が止まって聞いてきたときの対処（§2）／rehearse.mjs 自体が壊れたときの手動フォールバック（§6）。

詳細はここに書き写さない。proxy の仕様は `rehearsal/proxy.mjs` 冒頭コメント、既知の挙動・go/no-go・タイムアウトの背景は `rehearsal/SPIKE_RESULTS.md`。

## 1. 検証する — `npm run rehearse`

当日の前提を 1 行ずつ確認する:

- `node -v` が `package.json` の `engines: node >=22.18` を満たす（唯一の必須要件。起動ガードが未満を弾く）
- `ollama list` に `deepseek-r1:8b` がある
- `cloudflared --version` が通る
- `curl -s http://127.0.0.1:11434/api/tags` が応答する

`npm run rehearse` を叩く。まず install / typecheck / test / build を数分回す（Phase 2・毎回無条件）→ probe（Ollama / proxy / cloudflared を検出、生きていれば再利用）→ proxy と cloudflared を起動 → 自動検証（ワンショット / パイプ / 死んだトンネル）→ Phase 5 で「REPL を目視確認して Enter」で待機する（最大 24h。**トンネル稼働中は端末を無人にしない**）。

REPL は別端末で叩く。rehearse が Phase 5 で起動コマンド（`XDG_CONFIG_HOME=… node …/dist/index.js`）を表示するので、別端末でそれを実行し、短い質問を 1 つ。thinking が淡色・本文が通常色・逐次表示、を確認して `.exit`。rehearse の端末に戻って `Enter` を押すと、自分が起動した分を撤収する。

> susumai は「ローカル LLM とチャットするだけ」の CLI。ファイル読み・コマンド実行などの道具は持たない（Claude Code ではない）。道具を持たせる「ハーネス」は別プロジェクト（`Gamebook_susumai_distribute.md` の対象外セクション）。

## 2. `npm run rehearse` が止まって聞いてきたら

| 言われたこと | 対処 |
| :--- | :--- |
| Ollama が応答しない | `ollama serve`（Ollama.app 起動でも可）。または `npm run rehearse -- --start-ollama` |
| モデルが無い | `ollama pull deepseek-r1:8b`（約 5.2GB） |
| `:8787` が別プロセスに使われている | その proxy を落とす／ポート事情を確認して再実行。**本番 proxy が launchd 常駐しているマシンでは先に §8**（`launchctl bootout` してから rehearse。`pkill` 不可） |
| 既存 proxy のトークンが不明・不一致 | その proxy を落として再実行（rehearse が新規トークンを発行し直す） |
| 既存トンネルの URL が復元できない | rehearse は per-run ログから復帰を試みる。ダメなら落として再実行 |
| Phase 2 の install / typecheck / test / build のいずれか失敗 | その出力を確認（rehearse のバグではなくコード側） |
| proxy は listening だが `:8787` が 200 を返さない | 上流 Ollama（トークン / モデル）を確認 |
| トンネル検証が上限（既定値は `REHEARSE_TUNNEL_WAIT_MS` 参照）で失敗、末尾が `ENOTFOUND` | ほぼ DNS ブロック → §4 |

## 3. 撤収

- `Ctrl+C` か Phase 5 の `Enter` で、rehearse が **自分が起動した分** を撤収する
- 手動: `npm run rehearse:teardown`（`-- --all` で `:8787` トンネルの cloudflared も落とす）
- トンネル稼働中は端末を無人にしない

## 4. `trycloudflare.com` が DNS で引けない（2026-09-04 に実際に踏んだ）

- **症状**: `dig <url>` が `status: REFUSED` / `not found`、`npm run rehearse` がトンネル検証で `ENOTFOUND` のまま上限（既定値は `REHEARSE_TUNNEL_WAIT_MS` 参照）失敗する
- **原因**: ISP や社内の DNS が `*.trycloudflare.com` を丸ごとブロックしている（フィッシング／マルウェア悪用対策）。**マシンではなく、そのネットワークの DNS の問題**
- **対処**: そのマシンの DNS を `1.1.1.1` / `8.8.8.8` に変える（システム設定 → ネットワーク → DNS）。または quick tunnel をやめて named tunnel（自分のドメイン）にする。別マシンから使う側も同じ

## 5. 別マシンから使う

- susumai は npm 公開済み: `npm i -g susumai`（主経路）。`dist/index.js` はリポジトリにコミット済みで `files: ["dist"]` に入るので、**registry・git 直インストール（`npm i -g github:sGvQs/susumai`）のどちらでも `bin` が解決される**。`prepare` などのインストール時ビルドは無い（devDependencies 不要）。Volta 環境でも通る
- `susumai config set --url <トンネルURL> --token <トークン>` → `susumai`
- トークンは `npm run rehearse` の Phase 5 が表示するフル値。`susumai config get` の先頭 4／末尾 4（`config.ts` の `maskToken`）で照合する
- 会社 Windows 等ガチガチの環境の懸念（Node が入れられない・ファイアウォールが `trycloudflare` を遮断・EDR/DLP）は環境依存。持ち込んで試すしかない

## 6. 手動フォールバック（`rehearse.mjs` 自体が壊れているとき）

rehearse が壊れているなら、直すのは rehearse であって proxy.mjs を手で起動することではない。あくまで最小限の応急手当:

- **端末A**: `cd ~/Documents/Workspace/susumai` → `SUSUMAI_TOKEN=$(openssl rand -hex 32); echo "$SUSUMAI_TOKEN"`（フル値を控える・再実行しない）→ `SUSUMAI_TOKEN=$SUSUMAI_TOKEN node rehearsal/proxy.mjs`（`listening on :8787 …` が出れば OK）
- **端末B**: `cloudflared tunnel --url http://localhost:8787` → `https://<...>.trycloudflare.com` を控える
- **端末C**: `npm i -g susumai`（または `node dist/index.js`）→ `susumai config set --url <URL> --token <端末Aと同じフル値>` → `susumai`
- **撤収**: 端末B `Ctrl+C`、端末A `Ctrl+C` → 残れば `pkill -f "rehearsal/proxy.mjs"`、`unset SUSUMAI_TOKEN`
- 確認ポイントの詳細は `proxy.mjs` 冒頭コメント / `SPIKE_RESULTS.md`

## 7. 詰まったら

- `rehearsal/proxy.log`: `401` が並ぶ＝トークン不一致 / `403`＝allowlist 外 / chat が来ない＝トンネルか URL 設定
- `502`（Cloudflare の HTML が返る）＝ proxy が落ちている
- `rehearsal/SPIKE_RESULTS.md`: go/no-go、`think:false` でも thinking が出る件、タイムアウトの背景（§8）

## 8. 本番 proxy が常駐しているとき（rehearse の前に停止する）

段階3 で本番 proxy を launchd 常駐させたマシン（当面 MacBook Pro、将来 Mac mini）で
`npm run rehearse` を回すときは、先に本番 proxy を降ろす。放置しても rehearse は本番を
再利用・kill せず `:8787` 占有として正しく HALT する（本番を巻き込まない設計）が、
rehearse を通したいなら本番を止める:

```sh
ops/hosting.sh down --target proxy   # 停止
npm run rehearse                     # 検証
ops/hosting.sh up   --target proxy   # 復帰
```

`pkill` は使わない。`KeepAlive=true` なので launchd が即 respawn し、収束にならない。
本番 proxy のインスタンス化・パスは `ops/README.md` を正とする。
