# ARCHITECTURE — susumai

この文書は構造の地図（図が主・説明は従）。手順は `QUICKSTART.md` / `HOSTING.md`、仕様の正は `rehearsal/proxy.mjs` 冒頭コメント。

- 使う側: `susumai` CLI（任意の PC / npm `susumai@0.2.0` / zero-dep）。ローカル LLM とチャットするだけ（道具なし・Claude Code ではない）。
- 認証: GitHub OAuth App（Device Authorization Grant / client_id `Ov23liuaEuBGcxLCPA3T` / Client Secret 不要）。access token 8h / refresh token 約6ヶ月。
- 詳細の正: proxy 仕様 = `rehearsal/proxy.mjs` 冒頭コメント / ホスト構築 = `ops/README.md` + Vault `50_Meta/Gamebook_susumai_auth` / 使う側 = `QUICKSTART.md` / ホスト運用 = `HOSTING.md`。

---

## 1. システム全体像 / リクエスト経路

CLI から Ollama までの経路と信頼境界。Bearer トークンは公開インターネット〜proxy まで運ばれ、proxy が上流 Ollama へは `authorization` ヘッダを伝播しない（そこで消える）。

```mermaid
flowchart LR
  subgraph pub["公開インターネット"]
    cli["susumai CLI<br/>任意の PC / npm susumai@0.2.0 / zero-dep"]
  end
  subgraph cf["Cloudflare エッジ"]
    edge["llm.susumai.net<br/>CNAME → named tunnel"]
  end
  subgraph host["ホスト機（macOS / launchd 常駐）"]
    cfd["cloudflared<br/>tunnel run susumai-prod<br/>UUID 486cfd8d-a204-4fd6-b480-68125b18cbdd"]
    subgraph lo["127.0.0.1 ループバック"]
      proxy["proxy :8787<br/>単一ソース rehearsal/proxy.mjs<br/>本番は ops/proxy-prod.mjs シム経由"]
      ollama["Ollama :11434<br/>127.0.0.1 に限定（OLLAMA_HOST を 0.0.0.0 にしない）"]
      model["deepseek-r1:8b<br/>DeepSeek R1 / 5.2GB / Q4_K_M / ctx 131072 / thinking 対応"]
    end
  end
  cli -- "HTTPS / Authorization: Bearer (GitHub トークン)" --> edge
  edge -- "named tunnel（アウトバウンド QUIC）" --> cfd
  cfd -- "http://localhost:8787" --> proxy
  proxy -- "認証・パス許可の通過分のみ / Bearer は伝播しない" --> ollama
  ollama --> model
```

> 経路上の env・キャッシュ TTL・拒否理由コードの正は `rehearsal/proxy.mjs` 冒頭コメント。

---

## 2. ログイン（Device Flow）のシーケンス

`susumai login`。CLI が自前で GitHub Device Authorization Grant を実行する（ブラウザ自動起動なし・URL とコードを表示するだけ）。

```mermaid
sequenceDiagram
  actor U as ユーザー
  participant C as susumai CLI
  participant B as ブラウザ
  participant GH as GitHub

  C->>GH: POST github.com/login/device/code (client_id)
  GH-->>C: device_code / user_code / verification_uri / interval / expires_in
  C-->>U: verification_uri と user_code を表示
  U->>B: verification_uri を開く
  B->>GH: user_code を入力して承認
  loop interval 秒ごと（expires_in まで / slow_down なら +5s）
    C->>GH: POST github.com/login/oauth/access_token (grant_type=device_code)
    GH-->>C: error=authorization_pending
  end
  GH-->>C: access_token (+ refresh_token / expires_in / refresh_token_expires_in)
  C->>GH: GET api.github.com/user (Bearer access_token)
  GH-->>C: login / id
  C->>C: $XDG_CONFIG_HOME/susumai/credentials.json に 0600 で保存
```

`credentials.json` の形（`github` キー配下）: `token` / `login` / `id` / `obtainedAt`、自動更新の実装で `refreshToken` / `expiresAt` / `refreshTokenExpiresAt` / `clientId` を追加。PAT フォールバックは `config.json` の `token`。

> 純関数の分類ロジックは `src/auth.ts`、保存は `src/credentials.ts`。設計の正は Vault `50_Meta/Gamebook_susumai_auth`。

---

## 3. トークン自動更新のシーケンス（実装進行中・設計承認済み）

事前更新（送信前に期限が近ければ refresh）と事後更新（proxy が 401 を返したら refresh して1回だけ再送）。`POST github.com/login/oauth/access_token`（`grant_type=refresh_token`）。refresh token は単回使用でローテート。同時実行は mkdir ロックで single-flight。

```mermaid
sequenceDiagram
  participant CLI as susumai CLI
  participant LK as mkdir ロック（single-flight）
  participant GH as GitHub
  participant PX as proxy（llm.susumai.net）

  Note over CLI: 事前更新（リクエスト送信前）
  CLI->>CLI: shouldRefresh?（expiresAt が 10分以内）
  alt 期限が近い
    CLI->>LK: ロック取得（mkdir）
    CLI->>GH: POST /login/oauth/access_token (grant_type=refresh_token)
    alt 成功
      GH-->>CLI: 新 access_token + 新 refresh_token（ローテート）
      CLI->>CLI: credentials.json に 0600 で保存
      CLI->>LK: ロック解放
    else invalid_grant（refresh token 失効）
      GH-->>CLI: error
      CLI->>CLI: RefreshExpiredError → 「susumai login」に戻る
    end
  end

  Note over CLI: 事後更新（proxy が 401）
  CLI->>PX: POST /api/chat (Bearer access_token)
  PX-->>CLI: 401
  CLI->>CLI: withAuthRetry が 401 を捕捉
  CLI->>GH: POST /login/oauth/access_token (grant_type=refresh_token)
  alt 成功
    GH-->>CLI: 新 access_token + 新 refresh_token
    CLI->>CLI: ローテート保存
    CLI->>PX: 同一リクエストを1回だけ再送
    PX-->>CLI: 200（ストリーム）
  else invalid_grant
    GH-->>CLI: error
    CLI->>CLI: 「susumai login」に戻る
  end
```

> refresh の HTTP は `src/auth.ts` の `refreshAccessToken`、401 リトライは `src/client.ts` の `withAuthRetry`（`src/errors.ts` の `RefreshExpiredError`）。設計の正は Vault `50_Meta/Gamebook_susumai_auth`。

---

## 4. proxy の認証判定フロー

Bearer 抽出 → 認証（OR）→ HTTP パス allowlist。各葉に拒否理由コードと HTTP ステータス。認証 OK でも `isAllowed(method, path)` はスキップしない。

```mermaid
flowchart TD
  start["リクエスト受信"] --> bearer{"Authorization: Bearer 抽出"}
  bearer -- "無し" --> e401["401 unauthorized"]
  bearer -- "有り" --> shared{"共有 Bearer と一致?<br/>timingSafeEqual(sha256)<br/>本番は無効（SUSUMAI_TOKEN 無し）"}
  shared -- "一致" --> pathchk
  shared -- "不一致 / bearer モード無し" --> gh{"github モード有効?<br/>SUSUMAI_ALLOWLIST"}
  gh -- "無効" --> e401
  gh -- "有効" --> shape{"形状プレフィルタ<br/>looksLikeToken"}
  shape -- "非トークン形状" --> e401
  shape -- "OK" --> pos{"正キャッシュ ヒット?<br/>identity のみ / TTL 1h"}
  pos -- "ヒット" --> idmatch
  pos -- "ミス" --> neg{"負キャッシュ ヒット?<br/>TTL 2min / GitHub 401 のときだけ記録"}
  neg -- "ヒット" --> e401
  neg -- "ミス" --> rl{"per-IP レート制限<br/>key=CF-Connecting-IP<br/>token bucket 20・+10/min"}
  rl -- "超過" --> e429["429 deny:ratelimit"]
  rl -- "OK" --> cap{"api.github.com/user へのローリング1h グローバル上限<br/>既定 500"}
  cap -- "超過" --> ghcap["503 deny:ghcap<br/>（正キャッシュ済みのみ通過）"]
  cap -- "OK" --> ghuser["GET https://api.github.com/user"]
  ghuser -- "到達不能・5xx・403・不正応答" --> ghdown["503 deny:ghdown（fail-closed）"]
  ghuser -- "401" --> neg2["負キャッシュに記録"] --> e401
  ghuser -- "200 + 正の id" --> pset["正キャッシュに記録"] --> idmatch{"許可リスト id 照合<br/>97923717 sGvQs / 130018210 su-goto1111 / 組み込み既定"}
  idmatch -- "不一致" --> denyuser["403 deny:user"]
  idmatch -- "一致" --> pathchk{"HTTP パス allowlist isAllowed<br/>POST /api/chat・GET /api/tags のみ"}
  pathchk -- "それ以外" --> denypath["403 deny:path"]
  pathchk -- "一致" --> fwd["上流 Ollama へ透過<br/>authorization ヘッダは伝播しない<br/>中断はクライアント切断時のみ上流へ"]
```

> しきい値の env 名・既定値、fail-closed 境界の正は `rehearsal/proxy.mjs` 冒頭コメント。本番アクセスログは `~/Library/Logs/susumai/proxy-access.log`（`rehearsal/proxy.log` と分離）。

---

## 5. ホストのデプロイ構成

launchd LaunchAgent 2つ（`KeepAlive` / `RunAtLoad`、`launchctl kickstart -k` で1インスタンスに収束）。proxy には `SUSUMAI_TOKEN` を渡さない = github モードのみ。

```mermaid
flowchart TB
  subgraph la["launchd LaunchAgent（KeepAlive / RunAtLoad / kickstart -k）"]
    p["com.susumai.proxy<br/>ProgramArguments = NODE_BIN , REPO/ops/proxy-prod.mjs<br/>env: SUSUMAI_PROD=1（シムが設定） / SUSUMAI_ALLOWLIST / SUSUMAI_PROXY_LOG<br/>SUSUMAI_TOKEN は渡さない"]
    c["com.susumai.cloudflared<br/>ProgramArguments = cloudflared tunnel run susumai-prod<br/>（実常駐は cloudflared service install が作る LaunchDaemon）"]
  end
  subgraph hostfiles["ホスト機のファイル"]
    plist["~/Library/LaunchAgents/com.susumai.proxy.plist<br/>~/Library/LaunchAgents/com.susumai.cloudflared.plist<br/>（テンプレートは ops/*.plist.template / 実 plist は .gitignore）"]
    logs["~/Library/Logs/susumai/<br/>proxy-access.log / proxy-out.log / proxy-err.log / cloudflared-*.log"]
    allow["rehearsal/allowlist.prod.json（.gitignore 済み）"]
    cfyml["~/.cloudflared/config.yml<br/>ingress: llm.susumai.net → http://localhost:8787"]
  end
  subgraph clientpc["使う側 PC"]
    creds["$XDG_CONFIG_HOME/susumai/credentials.json（0600）"]
  end
  subgraph cfside["Cloudflare 側"]
    tunnel["named tunnel susumai-prod<br/>UUID 486cfd8d-a204-4fd6-b480-68125b18cbdd"]
    cname["CNAME llm.susumai.net → UUID.cfargotunnel.com"]
  end
  p --> src["startServer() を dynamic import<br/>単一ソース rehearsal/proxy.mjs"]
  p -. reads .-> allow
  p -. writes .-> logs
  c --> tunnel
  c -. reads .-> cfyml
  cname --> tunnel
  src --> up["Ollama 127.0.0.1:11434 → deepseek-r1:8b"]
  creds -. "Bearer で接続" .-> tunnel
```

> 構築手順（`cloudflared tunnel create` / `route dns` / `service install` / `launchctl`）は `ops/README.md` と Vault `50_Meta/Gamebook_susumai_auth`。運用は `HOSTING.md`。検証は `npm run rehearse`（`rehearsal/rehearse.mjs`、quick tunnel ＋ 共有 Bearer の開発用。本番 proxy 稼働中は `:8787` 占有として HALT）。

---

この文書は構造の地図。手順は QUICKSTART / HOSTING、仕様の正は proxy.mjs 冒頭コメント。
