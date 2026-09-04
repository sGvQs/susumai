# RUNBOOK — susumai 当日検証手順（人間が端末で直接叩く版）

これは **後藤さんが自分の手で** 上から順に叩く当日チェックリスト。
AI 伴走版（Vault の `Gamebook_susumai_distribute.md`）とは別物。

- 各ステップに「確認」がある。確認が通らなければ先へ進まない。
- 詳細はこの md に書き写さない。プロキシの仕様は `rehearsal/proxy.mjs` 冒頭コメント、
  既知の挙動・go/no-go・タイムアウトの背景は `rehearsal/SPIKE_RESULTS.md` を見る。
- **2回目以降は `npm run rehearse` で自動化できる**（`rehearsal/rehearse.mjs`）。
  この手順書は初回に通読して全体像を掴むため＋自動化が「止まって聞いて」きたときの
  手動フォールバック。本文の各手順は正典としてそのまま維持する。
  撤収だけしたいときは `npm run rehearse:teardown`（`-- --all` でトンネルも）。

## 使う端末（先に全部開く）

| 端末 | 役割 | 検証中の状態 |
| :--- | :--- | :--- |
| **端末0** | `ollama serve` | 開けっ放し（Ollama.app 起動中なら不要） |
| **端末A** | 手順2でトークン生成 → 手順3で proxy 起動 | 開けっ放し |
| **端末B** | 手順4で cloudflared | 開けっ放し |
| **端末C** | 手順5〜7で susumai の用意・設定・検証 | 随時 |

**トークンは端末Aで 1 回だけ生成する。** 同じフル値を端末C（と別PC）へ貼り付けて使う。
各端末で `openssl` を叩き直してはいけない（別トークンになり proxy が 401 を返す）。

---

## 0. 前提（環境スナップショット）

下表は **2026-09-03 にこのマシンで確認した値**。検証当日にまず再確認する:
`node -v` / `npm -v` / `cloudflared --version` / `ollama --version` / `ollama list`。

| 項目 | 2026-09-03 時点の値 | 確認コマンド |
| :--- | :--- | :--- |
| Node | v24.13.0（volta 管理） | `node -v` |
| npm | 11.7.0 | `npm -v` |
| cloudflared | 2026.8.3（Homebrew、`/opt/homebrew/bin/cloudflared`） | `cloudflared --version` |
| Ollama | 0.33.2 | `ollama --version` |
| モデル | `deepseek-r1:8b` pull 済み（5.2GB） | `ollama list \| grep deepseek-r1` |
| Ollama 応答 | `127.0.0.1:11434` が `/api/tags` を返す | `curl -s http://127.0.0.1:11434/api/tags` |

**必須要件は `package.json` の `engines: node >=22.18` のみ**（`src/index.ts` の起動ガードが未満を弾く）。
表の他の値は「この環境で通った」というスナップショットで、多少バージョンが違っても大抵動く。

**LLM サーバはこのマシンで動かす前提**でこの手順を書いている。
別の Mac mini など他マシンに載せる場合は、そのマシンで先に
`ollama` をインストール＋`ollama pull deepseek-r1:8b` を済ませてから、以下を実行すること。

---

## 1. Ollama を serve 状態にする（端末0）

```
ollama serve
```

（Ollama.app が起動中なら serve 済みなので不要。二重起動するとポート衝突する。）

- **確認**: `curl -s http://127.0.0.1:11434/api/tags` の出力に `deepseek-r1:8b` が含まれる。
- **`OLLAMA_HOST` は触らない**（`127.0.0.1` のまま）。外部公開は proxy の役目。
  `OLLAMA_HOST=0.0.0.0` にすると Ollama 自体が LAN に晒され、allowlist を素通りされる。

---

## 2. トークンを作る（端末A）

**端末A で 1 回だけ**実行する:

```
export SUSUMAI_TOKEN=$(openssl rand -hex 32)
echo "$SUSUMAI_TOKEN"
```

- 表示されたフル値（64 桁の hex）を、この後 **端末C と別PC へ安全な経路で貼り付ける**
  （同じマシン内ならクリップボード等）。**`openssl` を再実行しない。**
- 手元のメモには **先頭4文字＋末尾4文字だけ**書き留める（例 `3a1f…4b2e`）。
  これは手順6の `susumai config get` の表示（`maskToken` = 先頭4＋マスク＋末尾4）と
  **突き合わせる照合用**であって、コマンドに入力する値ではない。入力にはフル値を使う。
- 検証終了後、フル値とこのメモの両方を破棄する。

---

## 3. proxy 起動（端末A・開けっ放し）

手順2と同じ端末Aで:

```
cd ~/Documents/Workspace/susumai
SUSUMAI_TOKEN=$SUSUMAI_TOKEN node rehearsal/proxy.mjs
```

- `:8787` で待受、`127.0.0.1:11434` へ透過。allowlist は **`POST /api/chat` と `GET /api/tags` のみ**、
  それ以外は 403。Bearer 欠落／不一致は 401。`SUSUMAI_TOKEN` 未設定なら即 `exit(1)`（fail-closed）。
  仕様の詳細は `rehearsal/proxy.mjs` 冒頭コメント。
- **確認**: 起動ログ
  `listening on :8787 → 127.0.0.1:11434 (allowlist: POST /api/chat, GET /api/tags)` が出る。
- ここでプロンプトが戻らず出しっぱなしが正常。この端末は閉じない。

---

## 4. cloudflared でトンネル（端末B・開けっ放し）

```
cloudflared tunnel --url http://localhost:8787
```

- 出力の中の `https://<ランダム>.trycloudflare.com` を控える（**起動ごとに変わる**）。
- これは quick tunnel（検証用）。永続化（named tunnel）は今回やらない。
- **確認**: `https://<...>.trycloudflare.com` の行が出て、以降ログにエラーが流れ続けていない。
- この端末も閉じない。トンネル稼働中は端末を無人にしない。

---

## 5. susumai を用意（端末C）

```
cd ~/Documents/Workspace/susumai
npm install            # 初回のみ
npm run typecheck && npm test && npm run build
npm link               # susumai を PATH に載せる
```

- **確認**: `typecheck` / `test` / `build` がすべて緑（非ゼロ終了なし）。
- **確認**: `which susumai` がパスを返す。`susumai --help` が使い方を表示する。
- **volta 環境の注意**: volta 配下ではグローバル shim が作られず `which susumai` が
  解決しないことがある。その場合は以降 `susumai` の代わりに `node dist/index.js` を使う
  （例: `node dist/index.js config get`、`node dist/index.js "質問"`）。引数は同じ。

---

## 6. 設定（端末C）

トークンは **手順2で端末Aから運んできたフル値**を貼り付ける（`$SUSUMAI_TOKEN` は端末Cには無い）:

```
susumai config set --url https://<トンネル>.trycloudflare.com --token <端末Aのフル値を貼付>
susumai config get
susumai config path
```

- キー名は `--url` / `--token`（他に `--model` 既定 `deepseek-r1:8b`、`--num-ctx` 既定 16384、`--stream true|false`）。
- **確認**: `config get` で `url` が設定したトンネル URL。`token` は `先頭4文字＋マスク＋末尾4文字`
  形式で表示される。この先頭4・末尾4が手順2で控えたメモと一致すること。
- **確認**: `config path` が設定ファイルの絶対パスを表示（`$XDG_CONFIG_HOME/susumai/config.json`、
  無ければ `~/.config/susumai/config.json`、mode 0600）。

---

## 7. 検証（端末C）

1. **REPL**: `susumai` で対話開始。短い質問を 1 つ（例「Rust の所有権を一言で」）。
   - **確認**: `接続を確認中…` → `モデル読み込み中…` の後、応答が**逐次**表示される。
     thinking は淡色、本文は通常色で、両者が分かれて出る。`.exit` で終了。
2. **ワンショット**: `susumai "1 足す 1 は？"`
   - **確認**: 1 回送って応答を表示して終了する。
3. **パイプ**: `echo "この文を10字で要約して: ..." | susumai`
   - **確認**: 標準入力を読んで応答して終了する。
4. **（任意）死んだトンネルでタイムアウト**: `config set --url` を、いま生きていない
   `https://does-not-exist-xxxx.trycloudflare.com` に一時的に差し替えて `susumai "test"`。
   - **確認**: 300 秒待たずに失敗して終わる。接続確認は約 10 秒、初トークンのウォッチドッグは
     60 秒（どちらも `src/client.ts` のハードコード既定値。なぜ明示タイムアウトが要るか＝
     undici 既定の約 300 秒に依存しない理由は `SPIKE_RESULTS.md §8` が背景）。
   - **終わったら URL を本物のトンネルに戻す**（`config set --url https://<トンネル>.trycloudflare.com`）。

---

## 8. 別 PC から（あれば）

- 別 PC に susumai を入れる。配布方法は未定。当面は `npm pack` で作った tarball
  （`susumai-0.1.0.tgz`）を渡して、その PC で `npm i -g ./susumai-0.1.0.tgz` する等でよい。
  正式な配布方法は Gamebook 段階3 で決める。
- その PC で **同じトンネル URL＋手順2の同じフル値**を設定:

  ```
  susumai config set --url https://<トンネル>.trycloudflare.com --token <端末Aのフル値を貼付>
  susumai
  ```

  （トークンは端末Aのフル値。6+4 メモではない。`config get` の先頭4・末尾4 で照合。）
- **確認**: 別 PC からの短い質問に応答が返る。端末A の `rehearsal/proxy.log` に
  `POST /api/chat -> 200` が追記される。

---

## 9. 片付け（重要）

1. 端末B で `Ctrl+C` → cloudflared 停止。
2. 端末A で `Ctrl+C` → proxy 停止。残っていたら:

   ```
   pkill -f "rehearsal/proxy.mjs"
   ```

   （volta の shim 経由で `pgrep -fl proxy.mjs` が 2 プロセス見えることがある。`pkill -f` で両方落ちる。）
3. 端末0 の `ollama serve` は `Ctrl+C`（後続段階で使うので落とさなくてもよい）。
4. **トンネル稼働中は端末を無人にしない。** セッション後は cloudflared と proxy の両方を必ず落とす。
5. トークンを片付ける:

   ```
   unset SUSUMAI_TOKEN
   ```

   端末A のフル値、端末C／別PC に貼った値、手元の先頭4+末尾4メモ、すべて破棄する。
6. （任意）`npm unlink -g susumai` で PATH から外す。

---

## 10. 詰まったら

- `rehearsal/proxy.log` — アクセスログ `<ISO時刻> <method> <path> -> <status>`。
  401 が並ぶ＝トークン不一致（各端末で `openssl` を叩き直していないか。フル値を貼れているか）。
  403＝allowlist 外のパスを叩いている。chat が来ていない＝トンネルか URL 設定を疑う。
- `rehearsal/SPIKE_RESULTS.md` — 既知の挙動、go/no-go 判定、タイムアウトの背景（§8）、
  `think:false` でも thinking が出る件などの運用メモ。
- 502（Cloudflare の HTML が返る）＝ proxy が落ちている。端末A を確認。
