# 段階0：リハーサル環境構築＋ストリーミング疎通スパイク — 結果

実施日: 2026-09-03 / macOS arm64 (Apple M2, RAM 24GB), Node v24.13.0

## 環境

| 項目 | 値 |
| :--- | :--- |
| cloudflared | `2026.8.3` (built 2026-08-31T09:48:10Z, GOOS darwin/arm64, go1.27.0) |
| Ollama | 0.33.2 (`http://127.0.0.1:11434`、外部バインドせず) |
| モデル | `deepseek-r1:8b` (5.2GB, id 6995872bfe4c) |

### `ollama show deepseek-r1:8b` の要点

- architecture: `qwen3` / parameters: 8.2B / quantization: `Q4_K_M` / embedding length 4096
- **context length: 131072**（今回のスパイクは `num_ctx: 16384` を指定して使用）
- **Capabilities: `tools`, `thinking`, `completion`** → **thinking 対応あり**
- 既定 Parameters: `temperature 0.6`, `top_p 0.95`, stop に `<｜User｜>` / `<｜Assistant｜>` 等

## 構成

```
別PC ──HTTPS──> trycloudflare.com ──> cloudflared(quick tunnel) ──> :8787 proxy.mjs
                                                                      │ allowlist + Bearer
                                                                      ▼
                                                            127.0.0.1:11434 Ollama
```

- `rehearsal/proxy.mjs`: zero-dep (`node:http` / `node:crypto` / `node:fs`)。allowlist = `POST /api/chat`, `GET /api/tags` のみ透過。
  それ以外は 403、Bearer 欠落/不一致は 401、`SUSUMAI_TOKEN` 未設定なら起動時 `exit(1)`（フェイルクローズ）。
  Bearer 検証は両者を `sha256` 固定長ダイジェスト化して `crypto.timingSafeEqual`（非定数時間比較を排除）。
  スキーム名 `Bearer` は RFC 7235 に従い大小無視で受ける。上流へ転送する前に `authorization` ヘッダを削除。
  `req`/`res` の `error` を握って生 TCP リセット由来の未処理 error でのプロセス落ちを塞ぐ。
  最小アクセスログを `proxy.log` に 1 行ずつ追記（`<ISO時刻> <method> <path> -> <status>`）。
- `rehearsal/fetch-spike.mjs`: zero-dep (global `fetch` = undici)。NDJSON をバッファリングして `\n` 分割・行ごと `JSON.parse`。
  チャンク境界の multibyte 文字化けを避けるため `TextDecoder('utf-8')` の `decode(chunk,{stream:true})` で継ぎ、終了後に `decode()` フラッシュ。
  `--think` は `true`/`false` 以外、`--abort-after` は非有限数なら usage エラー（exit 2）。

トークン: セッション用に 32byte hex を生成して使用（id `3052cc…2d5a`）。スパイク終了後に破棄。

## スパイク結果

> 数値の出所は各スパイクの stdout（`fetch-spike.mjs` が整形 JSON を複数行で出力）。§6a/§6b の生 JSON は scratchpad の `spike-think-true.json` / `spike-think-false.json`。
> 認証・allowlist の観測は `proxy.log` に追加した最小アクセスログ（`<ISO> <method> <path> -> <status>`）で後から裏取り可能。
>
> **再実測の対応関係（2026-09-03、[要修正] 反映後）**:
> - トンネル: `uni-connections-share-circus.trycloudflare.com`、稼働 `00:36:17Z`〜`00:41:09Z`（`tunnel.log`）。
> - §5（allowlist / 認証）: `proxy.log` の `00:36:12`〜`00:36:35` エントリに対応。今回再実測。
> - §6a（think:true）: `proxy.log` `00:38:11Z POST /api/chat -> 200` に対応。経路 = トンネル→プロキシ→Ollama。今回再実測。
> - §6b（think:false）: `proxy.log` `00:39:16Z POST /api/chat -> 200` に対応。経路 = トンネル→プロキシ→Ollama。今回再実測。
> - §4（curl ベースライン）・§7（中断伝播）・§8（undici タイムアウト）: **前回セッションの観測。今回は再実行していない**（プロキシの abort 配線・undici 既定値に変更がなく、§6 の再実測でストリーム逐次性・NDJSON 健全性は裏付け済みのため）。`proxy.log` にこれらに対応する chat エントリは無い（アクセスログは今回セッションで追加したもの）。

### 4. curl ベースライン（トンネル越し `-N` ストリーム）— 前回セッションの観測（今回未再実行）

- 応答が逐次到達（`{"message":{"thinking":"…"},"done":false}` が 1 行ずつ流れる）。
- NDJSON 破損なし。最終行に `"done":true`, `done_reason":"stop"`, `eval_count":222` 等の統計。
- warm 状態で `total_duration` ≈ 12.7s。

### 5. allowlist / 認証

| リクエスト | 期待 | 実測 |
| :--- | :--- | :--- |
| `POST /api/pull`（トンネル越し, 認証あり） | 403 | **403** |
| `POST /api/delete`（トンネル越し, 認証あり） | 403 | **403** |
| `POST /api/create`（トンネル越し, 認証あり） | 403 | **403** |
| `POST /api/generate`（トンネル越し, 認証あり） | 403 | **403**（前回計測） |
| `GET /api/tags`（トンネル越し, 認証なし） | 401 | **401** |
| `GET /api/tags`（トンネル越し, 不正トークン） | 401 | **401** |
| `GET /api/tags`（トンネル越し, 認証あり） | 200 | 200 |
| `GET /api/tags`（ローカル, 認証あり, スキーム `bearer` 小文字） | 200 | 200 |

→ `/api/pull` `/api/delete` `/api/create` `/api/generate` 系はプロキシで遮断できている（今回 delete/create も個別に実測）。
  Bearer スキーム名は大小無視で受理（`authorization: bearer …` でも 200）。上記は `proxy.log` のアクセスログにも記録済み。

### 6. undici ストリームスパイク（本命, abort なし）

#### 6a. `think:true`（既定）— 2026-09-03 再実測（経路: トンネル→プロキシ→Ollama / `proxy.log` `00:38:11Z` / 生 JSON: `spike-think-true.json`）

```json
{
  "think": true,
  "headersMs": 4841,          // 送信〜レスポンスヘッダ（コールドなモデルロード込み）
  "firstChunkMs": 4841,       // 初トークン遅延（同上）
  "chunkCount": 1577,
  "chunkIntervalMaxMs": 203,
  "chunkIntervalMedianMs": 57,
  "totalBytes": 201794,
  "doneTrue": true,
  "ndjsonLines": 1430,
  "ndjsonParseErrors": 0,
  "thinkingFieldSeen": true,
  "thinkTagSeen": false,
  "wallMs": 90038,
  "httpStatus": 200
}
```

- **チャンク間隔 中央値 57ms / 最大 203ms** → トンネルは逐次フラッシュしている（一括バッファではない。
  一括なら中央値≒0 で末尾に巨大チャンクが 1 個出る形になるが、そうなっていない）。
- **NDJSON パースエラー 0**（チャンク境界は行に揃わないため `\n` バッファリングで分割）。
- **`done:true` 受信**。
- **`responseHead500` は文字化けなし**（`TextDecoder` ストリーミングデコードでチャンク境界の multibyte を継いだ結果、
  日本語の思考文・本文が `�` 無しで復元される）。
- 応答冒頭（生）: `message.thinking` に日本語の思考文が入り、`message.content` とは**別フィールド**。
  `<think>` / `</think>` タグは `content` に出現しない。

#### 6b. `think:false` — 2026-09-03 実測（前回未計測だった項目 / 経路: トンネル→プロキシ→Ollama / `proxy.log` `00:39:16Z` / 生 JSON: `spike-think-false.json`）

```json
{
  "think": false,
  "headersMs": 992,           // モデル warm 済み
  "firstChunkMs": 993,
  "chunkCount": 1059,
  "chunkIntervalMaxMs": 225,
  "chunkIntervalMedianMs": 57,
  "totalBytes": 135470,
  "doneTrue": true,
  "ndjsonLines": 956,
  "ndjsonParseErrors": 0,
  "thinkingFieldSeen": true,  // ← think:false でも thinking が出る（下記）
  "thinkTagSeen": false,
  "wallMs": 59551,
  "httpStatus": 200
}
```

- **重要（QA 指摘の実測結果）**: `deepseek-r1:8b` + Ollama 0.33.2 では **`think:false` を指定しても `message.thinking` が出続ける**。
  - 原因は Ollama サーバ側（プロキシのバグではない）: サーバログ `srv init: chat template, thinking = 1`。
    この gguf の chat template が `[completion thinking]` をハードコードしており、`think:false` が実質無視される
    （このモデル・このバージョンでは thinking を切れない）。プロキシは `think` パラメータを素通しするだけで加工しない。
  - `<think>` タグは `content` に出ない点は `think:true` と同じ。ストリーム逐次性・NDJSON 健全性も同じ。

### 7. 中断伝播（`--abort-after 4000`）— 前回セッションの観測（今回未再実行。プロキシの abort 配線に変更なし）

- fetch-spike: `aborted:true` / `failureMode:"AbortError"`。abort までに 53 チャンク / 7702 byte 受信。
- `llama-server`（Ollama の runner）CPU 実測:
  | t | CPU% |
  | :-- | :-- |
  | idle | 0.1 |
  | 2s | 71.9 |
  | 3–5s | 74–80（生成中） |
  | **6s** | **2.6** |
  | 7s 以降 | 0.2（idle） |
- abort は t≈4s。**その約 1–2 秒後に生成が停止**（CPU が idle に戻る）。
- `ollama ps` はモデルを resident 表示し続けるが（keep-alive による常駐であって生成ではない）、
  孤児の生成プロセスは残らない。
- プロキシ配線: `res.on('close')` で `!res.writableFinished` のとき `upstreamReq.destroy()` → Ollama 側が切断を検知して生成キャンセル。
  ※ `req.on('close')` は Node が「POST ボディ読み切り時」にも発火するため、無条件 `destroy()` にすると
    `/api/chat` が即 `ECONNRESET` になる。`!req.readableEnded` / `!res.writableFinished` でガードする実装にしてある。

### 8. undici タイムアウト挙動 — 前回セッションの観測（今回未再実行。undici 既定値に変更なし）

| ケース | 失敗形態 | 所要 |
| :--- | :--- | :--- |
| 存在しない `*.trycloudflare.com`（DNS 不能） | `fetch failed` / cause `ENOTFOUND` | **97ms** |
| ルーティング可・ポート閉（connection refused） | `fetch failed` / `ECONNREFUSED` | 13ms |
| プロキシ落ち（Cloudflare が 502 を返す） | HTTP 502（本文は CF のHTML） | 即時（1s 未満） |
| **TCP は張れるがヘッダを一切返さない（サイレント・ブラックホール）** | **`UND_ERR_HEADERS_TIMEOUT`** | **301,360ms ≒ 5分1秒** |

→ 接続時に失敗する種類は即座に返る。**危険なのはサイレント・ブラックホール**：undici の既定
`headersTimeout` = 300s まで待ってから失敗する（`bodyTimeout` も既定 300s）。無限ではないが CLI には長すぎる。

## go/no-go 判定

| # | 判定項目 | 結果 | 根拠 |
| :-- | :--- | :--: | :--- |
| 1 | トンネル越しにストリーミングが逐次届き NDJSON が壊れない | **○** | 2026-09-03 再実測（§6a/§6b、いずれもトンネル→プロキシ→Ollama、`proxy.log` `00:38:11`/`00:39:16`）でチャンク 1577 個（think:true）/ 1059 個（think:false）、間隔 中央値 57ms（一括バッファの兆候なし）、パースエラー 0、`done:true` 受信。`responseHead500` に `�` なし（TextDecoder ストリーミング化後）。curl `-N` での 1 行ずつ到達は前回セッションで確認済（§4）。 |
| 2 | 中断が上流に伝播する | **○** | `AbortController.abort()` の約 1–2 秒後に `llama-server` CPU が生成中(~80%)から idle(~0.2%)へ低下。孤児プロセスなし。プロキシは `res 'close' + !writableFinished` で上流を destroy。 |
| 3 | R1 の生出力形状が判明（thinking 分離 or `<think>` タグ） | **○** | **`message.thinking` フィールドに思考が逐次入り、`message.content` と分離**。`content` に `<think>` タグは出ない（モデルが `thinking` capability を持つため Ollama がタグを分離）。**訂正**: 前回「`think:false` 指定時は `thinking` フィールドが出ない」と書いたが、今回実測すると `deepseek-r1:8b` + Ollama 0.33.2 では `think:false` でも `message.thinking` が出続けた（§6b）。判定は ○ のまま（出力形状は判明。CLI は `thinking` を常に別扱いすればよく、`think:false` に依存しない）。 |
| 4 | 死んだトンネルで無限待ちにならない | **△** | DNS 不能・接続拒否・502 は 100ms 未満で失敗。ただし「TCP は通るがヘッダ無応答」のブラックホールは undici 既定 `headersTimeout` の **約301秒**待ってから `UND_ERR_HEADERS_TIMEOUT`。無限ではないが長すぎる。 |

### CLI 本体への申し送り

- **必須**: リクエストごとに明示タイムアウト（`AbortController` + `setTimeout`）を持たせる。
  初トークン待ちで 30–60s、全体でモデル/プロンプト長に応じた上限。undici 既定の 300s には依存しない。
- プロキシで上流を切るのは「クライアントが途中で切断したとき」に限定する
  （`!req.readableEnded` / `!res.writableFinished` ガード。無条件 destroy は `/api/chat` を壊す）。
- R1 のストリームは `message.thinking` と `message.content` を分けて扱えばよい（`<think>` パース不要）。
  ただし `content` にタグが出るモデル/経路もあり得るので、CLI 側はタグ除去のフォールバックも持つと堅い。
- **`think:false` で thinking を抑止できると当てにしない**（`deepseek-r1:8b` は無視。§6b）。
  thinking の表示 ON/OFF は CLI 側の責務（受信は常にあり得る前提でパースし、既定では隠す等）。
- ストリームのテキスト化はチャンク単位の即時デコード禁止。`TextDecoder({stream:true})` で継ぐ（multibyte 化け対策）。
- allowlist プロキシ + Bearer(`timingSafeEqual`) + `authorization` 非伝播 + Ollama 127.0.0.1 バインドのままで、外部からのモデル改変系は塞げている。

## 運用メモ

- トンネル稼働中は端末を無人にしない。セッション後は **必ず** `cloudflared` と `proxy.mjs` を落とす（本スパイクでは停止確認済み）。
- `SUSUMAI_TOKEN` は先頭6+末尾4のみ記録（今回のセッション: `3052cc…2d5a`）。使用後に破棄。
- trycloudflare URL は揮発性（今回: `uni-connections-share-circus.trycloudflare.com`）。毎回変わる。
- `proxy.log` に最小アクセスログ（`<ISO時刻> <method> <path> -> <status>`）を追記するようにした。403/401・チャンク観測の裏取り用。
- このマシンの `node` はバージョンマネージャの shim で、実体 node を子プロセスとして起動する
  （`pgrep -fl proxy.mjs` が 2 プロセス見える）。`pkill -f "rehearsal/proxy.mjs"` で両方落ちる。
- モデル `deepseek-r1:8b` は後続段階で使うため残置。
