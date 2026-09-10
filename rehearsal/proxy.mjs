/*
 * susumai proxy — HTTP パス許可リストゲート ＋ 認証(OR) ＋ 公開耐性
 * ============================================================================
 * 役割:
 *   別PCから Cloudflare Tunnel 経由で Ollama (127.0.0.1:11434) にアクセスする前段
 *   ゲート。Ollama を外部バインドせず、この proxy (:8787) だけをトンネルへ晒す。
 *
 * HTTP パス許可リスト (isAllowed / これ以外はパス・メソッド問わず 403 deny:path):
 *   - POST /api/chat   … 推論ストリーミング
 *   - GET  /api/tags   … モデル一覧
 *   → /api/pull /api/delete /api/create /api/generate /api/copy /api/push 等は 403。
 *
 * 認証 (OR。どちらか通れば authentication OK。その後で必ず isAllowed を実行する):
 *   1. Authorization: Bearer <tok> を抽出（スキーム名は RFC 7235 に従い大小無視）。
 *   2. bearer モード (SUSUMAI_TOKEN 設定時):
 *        timingSafeEqual(sha256(tok), sha256(SUSUMAI_TOKEN)) 一致 → 認証OK(bearer)。
 *   3. 不一致で github モード (SUSUMAI_ALLOWLIST 設定時):
 *        形状プレフィルタ → 正キャッシュ → 負キャッシュ → per-IP レート制限
 *        → グローバル時間上限 → GET https://api.github.com/user → 許可リスト id 照合
 *      → 認証OK(github) / 401 / 403(deny:user) / 429(deny:ratelimit)
 *        / 503(deny:ghcap 上限超過 | deny:ghdown API到達不能・エラー)
 *   4. どちらのモードでもない（bearer 不一致かつ github モードでない）→ 401。
 *
 * isAllowed の位置: 認証 OK は authentication の確定であって、既存の
 *   isAllowed(method, path) をスキップしない。従来どおり認証の直後に実行する。
 *
 * 起動時 env 検証 (buildConfig / fail-closed):
 *   次の経路で buildConfig() は ConfigError を throw する（テスト可能にするため。
 *   process.exit(1) は呼ばない）: 両モード未設定 / SUSUMAI_ALLOWLIST が読めない /
 *   JSON 不正 / id 非整数 / 数値 env が非正数 / SUSUMAI_PROD=1 かつ SUSUMAI_TOKEN 設定 /
 *   SUSUMAI_PROD=1 かつ SUSUMAI_PROXY_LOG が未設定 または 親ディレクトリが無い・書けない。
 *   env 検証は startServer()（が呼ぶ buildConfig）に置く。startServer() が ConfigError を
 *   catch → stderr ＋ exit(1) に変換する。import.meta.main /（段階3で作る）
 *   ops/proxy-prod.mjs の両エントリポイントが明示的に startServer() を呼ぶ。
 *   import.meta.main ブロックには想定外の同期例外用 exit(1) フォールバックだけを足す。
 *
 * GitHub アカウント許可リスト (HTTP パス許可リスト isAllowed とは別物):
 *   組み込み既定 = id 97923717 / login sGvQs の1人（BUILTIN_ALLOWLIST）。
 *   SUSUMAI_ALLOWLIST でパス指定した JSON 配列（要素 {id, login, note}。照合は不変の
 *   数値 id）を組み込み既定に「追加」する。SUSUMAI_ALLOWLIST 未指定 → github モード OFF。
 *   起動時に1回だけロード。ホットリロードしない（変更は常駐サービス再起動で反映。
 *   mtime 監視の部分書き込み中ロックアウトを避けるため）。
 *
 * 公開耐性（すべて in-memory。ディスク永続なし。verdict はキャッシュせず identity のみ）:
 *   - レート制限キー = CF-Connecting-IP ヘッダのみ。無ければ単一共有バケット "local"。
 *     x-forwarded-for の先頭（偽装可能）も req.socket.remoteAddress（トンネル越しは
 *     常に 127.0.0.1）も使わない。対象は GitHub API 呼び出しを誘発するリクエスト
 *     （github モード＋正キャッシュミス）のみ。per-IP token bucket、超過は 429 deny:ratelimit。
 *   - api.github.com/user へのローリング1時間グローバル上限（in-memory）。超過時は
 *     正キャッシュ済みトークンだけ通し、ミスは 503 deny:ghcap。これがフェイルクローズの境界。
 *   - 正キャッシュ = sha256(tok) → {id, login, expiresAt}。identity だけ。許可判定は毎回。
 *   - 負キャッシュ = GitHub が 401 を返したときだけ、短時間。403/429/5xx/断／および
 *     「200 だが id が正整数でない不正応答」はキャッシュせず、短い backoff の後
 *     503 deny:ghdown（サーバ側起因なので 403 deny:user にはしない）。
 *
 * 本番モード (SUSUMAI_PROD=1 / 段階3 の ops/proxy-prod.mjs シムが立てる):
 *   - SUSUMAI_TOKEN が設定されていたら起動拒否 (ConfigError)。本番は github モードのみ。
 *   - SUSUMAI_PROXY_LOG（本番アクセスログのパス）が必須。未設定なら ConfigError。
 *     さらに親ディレクトリが存在しない・書き込めない場合も ConfigError（本番はログ分離が
 *     主目的なので、書けないまま黙って起動しない。plist 側で必ず有効なパスを渡す前提）。
 *   ログ／argv からの identity 分離は ops/proxy-prod.mjs 冒頭コメントを正とする。
 *
 * SUSUMAI_PROXY_LOG（本番モードでなくても有効）:
 *   設定するとアクセスログをそのパスへ。未設定なら従来どおり rehearsal/proxy.log。
 *
 * env（既定値 / env 名 / TTL の桁）:
 *   SUSUMAI_TOKEN                共有 Bearer（設定で bearer モード有効）
 *   SUSUMAI_ALLOWLIST           GitHub 許可リスト JSON のパス（設定で github モード有効）
 *   SUSUMAI_PROD=1              本番モード（github のみ許可 / SUSUMAI_PROXY_LOG 必須）
 *   SUSUMAI_PROXY_LOG          アクセスログの出力先パス（本番モードでは必須）
 *   SUSUMAI_RL_CAPACITY          = 20     per-IP token bucket 容量（バースト許容数）
 *   SUSUMAI_RL_REFILL_PER_MIN    = 10     per-IP 毎分補充トークン数
 *   SUSUMAI_GH_HOURLY_CAP       = 500    api.github.com/user へのローリング1時間上限
 *   SUSUMAI_POS_CACHE_TTL_SEC   = 3600   正キャッシュ TTL（秒 / 時間オーダー = 1h）
 *   SUSUMAI_NEG_CACHE_TTL_SEC   = 120    負キャッシュ TTL（秒 / 短時間 = 2min）
 *   SUSUMAI_GH_TIMEOUT_MS      = 8000   api.github.com/user のリクエストタイムアウト
 *   SUSUMAI_GH_BACKOFF_MS      = 500    GitHub エラー時に 503 を返す前の backoff
 *
 * listen ポートは既定 8787（本番 / rehearse は不変）。startServer({ port }) で上書き可能
 *   （テストが衝突回避のため port:0 = OS 割り当ての空きポートを使う）。
 *
 * アクセスログ (proxy.log へ 1 行追記。既存フォーマットにフィールドを足すだけ):
 *   `<ISO> <method> <path> -> <status> ip=<CF-Connecting-IP|local> auth=<bearer|github|-> [deny=<code>]`
 *
 * 透過: 認証済みなので上流(Ollama)へ authorization ヘッダを伝播させない。中断伝播
 *   （クライアントが途中で切断したときだけ上流を destroy）は不変。
 *
 * 落とし方: フォアグラウンドなら Ctrl+C。バックグラウンドなら kill <pid>。
 * 運用: トンネル稼働中はこの端末を無人にしない。Ollama は 127.0.0.1 のまま
 *   （OLLAMA_HOST=0.0.0.0 にしない）。セッション後は cloudflared と本 proxy の両方を落とす。
 * ----------------------------------------------------------------------------
 * 段階0 時点の仕様（履歴）: 共有 Bearer 1本のみ。SUSUMAI_TOKEN 未設定なら exit(1)。
 *   server.listen がモジュール先頭。import.meta.main ガードも server.on('error') も無し。
 * ============================================================================
 */

import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const LISTEN_PORT = 8787;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 11434;
const GH_WINDOW_MS = 3_600_000; // ローリング上限の窓 = 1 時間

// 組み込み既定の GitHub アカウント許可リスト。SUSUMAI_ALLOWLIST の内容はこれに追加される。
export const BUILTIN_ALLOWLIST = Object.freeze([
  Object.freeze({ id: 97923717, login: 'sGvQs', note: 'susumai owner (built-in default)' }),
]);

// ============================================================================
// 純関数（テスト対象。副作用なし。モジュール先頭に集約）
// ============================================================================

/** Authorization ヘッダから Bearer トークンを取り出す（スキーム名は大小無視）。無ければ null。 */
export function parseBearer(authHeader) {
  const m = /^\s*bearer\s+(.+?)\s*$/i.exec(authHeader || '');
  return m ? m[1] : null;
}

/**
 * 形状プレフィルタ: 明らかにトークンでない文字列を GitHub API に投げる前に弾く。
 * classic PAT (40 hex) / prefixed (ghp_ gho_ ghu_ ghs_ ghr_ + base62) /
 * fine-grained (github_pat_...) の形だけ受ける。
 * ※「ghp_ ＋ classic PAT と同じ文字数・文字集合のランダム文字列」は意図的に通す
 *   （プレフィルタの自明経路だけを見る検証はしないという約束のため）。
 */
export function looksLikeToken(tok) {
  if (typeof tok !== 'string') return false;
  if (tok !== tok.trim()) return false;
  if (tok.length < 20 || tok.length > 255) return false;
  if (/^[0-9a-f]{40}$/.test(tok)) return true;
  if (/^gh[pousr]_[A-Za-z0-9]{30,251}$/.test(tok)) return true;
  if (/^github_pat_[A-Za-z0-9_]{20,}$/.test(tok)) return true;
  return false;
}

/** GitHub 許可リスト JSON（配列）をパースして正規化する。不正なら throw。 */
export function parseAllowlist(text) {
  const raw = JSON.parse(text);
  if (!Array.isArray(raw)) throw new Error('allowlist は JSON 配列である必要があります');
  return raw.map((e, i) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      throw new Error(`allowlist[${i}] がオブジェクトではありません`);
    }
    const id = Number(e.id);
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`allowlist[${i}].id が正の整数ではありません: ${JSON.stringify(e.id)}`);
    }
    return {
      id,
      login: e.login == null ? '' : String(e.login),
      note: e.note == null ? '' : String(e.note),
    };
  });
}

/** 数値 id で許可リストを照合する。一致エントリ、無ければ null。 */
export function matchAllowlist(entries, id) {
  const nid = Number(id);
  if (!Number.isInteger(nid)) return null;
  for (const e of entries || []) {
    if (e && Number(e.id) === nid) return e;
  }
  return null;
}

/** キャッシュエントリが nowMs 時点で有効か（TTL 判定）。 */
export function cacheFresh(entry, nowMs) {
  return !!entry && typeof entry.expiresAt === 'number' && entry.expiresAt > nowMs;
}

/**
 * token bucket 1 ステップ。bucket = {tokens, ts} | undefined（初回は満杯扱い）。
 * 1 トークン消費できれば allowed:true。返り値の bucket を呼び出し側が保存する。
 */
export function tokenBucketStep(bucket, nowMs, { capacity, refillPerMs }) {
  const base = bucket || { tokens: capacity, ts: nowMs };
  const elapsed = Math.max(0, nowMs - base.ts);
  const tokens = Math.min(capacity, base.tokens + elapsed * refillPerMs);
  if (tokens >= 1) return { allowed: true, bucket: { tokens: tokens - 1, ts: nowMs } };
  return { allowed: false, bucket: { tokens, ts: nowMs } };
}

/**
 * ローリング時間窓カウンタ（api.github.com/user のグローバル上限）。
 * hits = 過去の呼び出し時刻(ms)の配列。窓内が limit 未満なら allowed:true で
 * nowMs を追加した配列（＝呼び出しを1つ記録）を返す。窓外の古い時刻は捨てる。
 */
export function rollingCapStep(hits, nowMs, windowMs, limit) {
  const kept = (hits || []).filter((t) => t > nowMs - windowMs);
  if (kept.length >= limit) return { allowed: false, hits: kept };
  return { allowed: true, hits: [...kept, nowMs] };
}

/** レート制限キー: CF-Connecting-IP のみ。無ければ共有バケット "local"。 */
export function rateLimitKey(headers) {
  const cf = headers && headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  return 'local';
}

/** HTTP パス許可リスト（認証とは別物。段階0 から不変）。 */
export const ALLOWLIST = new Set(['POST /api/chat', 'GET /api/tags']);
export function isAllowed(method, path) {
  return ALLOWLIST.has(`${method} ${path}`);
}

// ============================================================================
// 設定・状態（in-memory）
// ============================================================================

/**
 * 起動時の設定エラー（fail-closed）。buildConfig() が throw し、エントリポイント側
 * （startServer / import.meta.main フォールバック）が catch → stderr ＋ exit(1) に変換する。
 * これにより 7 つの fail-closed 経路（両モード未設定 / allowlist 不正JSON / id 非整数 /
 * ファイル読めない / env が非正数 / SUSUMAI_PROD=1 かつ SUSUMAI_TOKEN 設定 /
 * SUSUMAI_PROD=1 かつ SUSUMAI_PROXY_LOG の書き込み先が不備）をユニットテストで検証できる。
 */
export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

function envPosNum(env, name, def) {
  const v = env[name];
  if (v == null || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ConfigError(`env ${name} は正の数である必要があります: ${JSON.stringify(v)}`);
  }
  return n;
}

/**
 * env から設定を組み立てる。fatal なら ConfigError を throw（fail-closed）。
 * エントリポイント（startServer / import.meta.main）が catch → stderr ＋ exit(1)。
 * bearer / github どちらのモードも無効なら ConfigError。
 */
export function buildConfig(env = process.env) {
  const token = env.SUSUMAI_TOKEN;
  const allowlistPath = env.SUSUMAI_ALLOWLIST;
  const prod = env.SUSUMAI_PROD === '1';
  const proxyLog = env.SUSUMAI_PROXY_LOG;
  const bearerMode = !!token;
  const githubMode = !!allowlistPath;

  // 本番モード（段階3）: bearer 禁止・ログパス必須（fail-closed）。
  if (prod && bearerMode) {
    throw new ConfigError(
      'SUSUMAI_PROD=1 のとき SUSUMAI_TOKEN は設定できません。本番は github モードのみです (fail-closed)。',
    );
  }
  if (prod && !proxyLog) {
    throw new ConfigError(
      'SUSUMAI_PROD=1 のとき SUSUMAI_PROXY_LOG（本番アクセスログのパス）が必須です。\n' +
        '  本番ログを rehearsal/proxy.log に混ぜないための保証です。launchd の EnvironmentVariables で渡してください。',
    );
  }
  if (prod) {
    // 本番はログ分離が主目的。書き込み先が不備なら黙って起動しない（fail-closed）。
    const dir = path.dirname(path.resolve(proxyLog));
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch {
      throw new ConfigError(
        `SUSUMAI_PROD=1: SUSUMAI_PROXY_LOG (${proxyLog}) の親ディレクトリに書き込めません: ${dir}\n` +
          '  ディレクトリを作成し書き込み権限を与えてください（本番はログ分離が主目的です）。',
      );
    }
  }

  if (!bearerMode && !githubMode) {
    throw new ConfigError(
      'SUSUMAI_TOKEN も SUSUMAI_ALLOWLIST も未設定です。起動を中止します (fail-closed)。\n' +
        '  bearer モード:  SUSUMAI_TOKEN=<token> node rehearsal/proxy.mjs\n' +
        '  github モード:  SUSUMAI_ALLOWLIST=<path/to/allowlist.json> node rehearsal/proxy.mjs',
    );
  }

  let allowlist = [];
  if (githubMode) {
    let fileEntries;
    try {
      fileEntries = parseAllowlist(fs.readFileSync(allowlistPath, 'utf8'));
    } catch (err) {
      throw new ConfigError(
        `SUSUMAI_ALLOWLIST (${allowlistPath}) を読めません: ${err.message}\n` +
          '  github モードは許可リストが健全でないと起動しません (fail-closed)。',
      );
    }
    // 組み込み既定 ＋ ファイル。数値 id で重複排除（ファイル側を優先）。
    const byId = new Map(BUILTIN_ALLOWLIST.map((e) => [e.id, e]));
    for (const e of fileEntries) byId.set(e.id, e);
    allowlist = [...byId.values()];
  }

  const limits = {
    rlCapacity: envPosNum(env, 'SUSUMAI_RL_CAPACITY', 20),
    rlRefillPerMs: envPosNum(env, 'SUSUMAI_RL_REFILL_PER_MIN', 10) / 60000,
    ghHourlyCap: envPosNum(env, 'SUSUMAI_GH_HOURLY_CAP', 500),
    posTtlMs: envPosNum(env, 'SUSUMAI_POS_CACHE_TTL_SEC', 3600) * 1000,
    negTtlMs: envPosNum(env, 'SUSUMAI_NEG_CACHE_TTL_SEC', 120) * 1000,
    ghTimeoutMs: envPosNum(env, 'SUSUMAI_GH_TIMEOUT_MS', 8000),
    ghBackoffMs: envPosNum(env, 'SUSUMAI_GH_BACKOFF_MS', 500),
  };

  return {
    bearerDigest: bearerMode
      ? crypto.createHash('sha256').update(token, 'utf8').digest()
      : null,
    githubMode,
    allowlist,
    limits,
    // アクセスログの出力先。未設定なら startServer が既定の rehearsal/proxy.log を使う。
    logPath: proxyLog ? path.resolve(proxyLog) : null,
  };
}

/** リクエスト間で共有する in-memory 状態（キャッシュ・バケット・時間窓）。 */
export function makeState() {
  return {
    posCache: new Map(), // sha256(tok) hex -> { id, login, expiresAt }
    negCache: new Map(), // sha256(tok) hex -> { expiresAt }
    buckets: new Map(), // ip -> { tokens, ts }
    ghHits: [], // api.github.com/user 呼び出し時刻(ms) のローリング配列
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function digestHex(tok) {
  return crypto.createHash('sha256').update(tok, 'utf8').digest('hex');
}

/** api.github.com/user を叩く。zero-dep（node:https）。到達不能・タイムアウトは kind:'error'。 */
function fetchGitHubUser(token, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.request(
      'https://api.github.com/user',
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${token}`,
          'user-agent': 'susumai-proxy',
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
        timeout: timeoutMs,
      },
      (r) => {
        let body = '';
        r.setEncoding('utf8');
        r.on('data', (c) => {
          body += c;
          if (body.length > 65536) r.destroy();
        });
        r.on('end', () => resolve({ kind: 'response', status: r.statusCode || 0, body }));
        r.on('error', () => resolve({ kind: 'error' }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve({ kind: 'error' }));
    req.end();
  });
}

/**
 * 認証（OR ロジック）。authentication のみを確定する。isAllowed(method,path) は
 * 呼び出し側が従来位置で別途実行する。
 * 返り値: { ok:true, mode } | { ok:false, mode, status, code?, message }
 * deps: { now, sleep, fetchUser } はテスト用に注入可能。
 */
export async function authenticate(config, state, headers, deps = {}) {
  const now = deps.now || (() => Date.now());
  const nap = deps.sleep || sleep;
  const fetchUser = deps.fetchUser || fetchGitHubUser;

  const tok = parseBearer(headers['authorization']);
  if (!tok) return { ok: false, mode: '-', status: 401, message: 'unauthorized' };

  // 1) bearer モード
  if (config.bearerDigest) {
    const got = crypto.createHash('sha256').update(tok, 'utf8').digest();
    if (crypto.timingSafeEqual(got, config.bearerDigest)) {
      return { ok: true, mode: 'bearer' };
    }
  }

  // 2) github モード（bearer 不一致 or bearer モードでない）
  if (config.githubMode) {
    const L = config.limits;

    // 形状プレフィルタ
    if (!looksLikeToken(tok)) {
      return { ok: false, mode: 'github', status: 401, message: 'unauthorized' };
    }

    const key = digestHex(tok);
    const t = now();

    // 正キャッシュ（identity のみ。許可判定は毎リクエスト）
    const cached = state.posCache.get(key);
    if (cacheFresh(cached, t)) {
      return matchAllowlist(config.allowlist, cached.id)
        ? { ok: true, mode: 'github' }
        : {
            ok: false,
            mode: 'github',
            status: 403,
            code: 'deny:user',
            message: 'forbidden: account not in allowlist',
          };
    }

    // 負キャッシュ（GitHub が 401 を返したときだけ）
    if (cacheFresh(state.negCache.get(key), t)) {
      return { ok: false, mode: 'github', status: 401, message: 'unauthorized' };
    }

    // per-IP レート制限（GitHub API 呼び出しを誘発するリクエストのみ対象）
    const ipKey = rateLimitKey(headers);
    const rl = tokenBucketStep(state.buckets.get(ipKey), t, {
      capacity: L.rlCapacity,
      refillPerMs: L.rlRefillPerMs,
    });
    state.buckets.set(ipKey, rl.bucket);
    if (!rl.allowed) {
      return {
        ok: false,
        mode: 'github',
        status: 429,
        code: 'deny:ratelimit',
        message: 'rate limited',
      };
    }

    // ローリング1時間グローバル上限（超過時は正キャッシュ済みのみ通す＝上の cache 分岐）
    const cap = rollingCapStep(state.ghHits, t, GH_WINDOW_MS, L.ghHourlyCap);
    if (!cap.allowed) {
      return {
        ok: false,
        mode: 'github',
        status: 503,
        code: 'deny:ghcap',
        message: 'github api hourly cap reached',
      };
    }
    state.ghHits = cap.hits;

    // api.github.com/user
    const resp = await fetchUser(tok, L.ghTimeoutMs);
    if (resp.kind === 'error') {
      await nap(L.ghBackoffMs);
      return {
        ok: false,
        mode: 'github',
        status: 503,
        code: 'deny:ghdown',
        message: 'github api unreachable',
      };
    }
    if (resp.status === 200) {
      let id;
      let login;
      try {
        const j = JSON.parse(resp.body);
        id = j.id;
        login = j.login;
      } catch {
        await nap(L.ghBackoffMs);
        return {
          ok: false,
          mode: 'github',
          status: 503,
          code: 'deny:ghdown',
          message: 'github api bad response',
        };
      }
      // 200 でも id が正整数でない = サーバ側起因の不正応答。到達不能と同じ扱い
      //（正キャッシュに書かず、backoff の後 503 deny:ghdown）。403 deny:user にはしない。
      if (!Number.isInteger(Number(id)) || Number(id) <= 0) {
        await nap(L.ghBackoffMs);
        return {
          ok: false,
          mode: 'github',
          status: 503,
          code: 'deny:ghdown',
          message: 'github api response missing id',
        };
      }
      state.posCache.set(key, {
        id: Number(id),
        login: String(login || ''),
        expiresAt: t + L.posTtlMs,
      });
      return matchAllowlist(config.allowlist, id)
        ? { ok: true, mode: 'github' }
        : {
            ok: false,
            mode: 'github',
            status: 403,
            code: 'deny:user',
            message: 'forbidden: account not in allowlist',
          };
    }
    if (resp.status === 401) {
      state.negCache.set(key, { expiresAt: t + L.negTtlMs });
      return { ok: false, mode: 'github', status: 401, message: 'unauthorized' };
    }
    // 403 / 429 / 5xx など → キャッシュせず short backoff 後 503
    await nap(L.ghBackoffMs);
    return {
      ok: false,
      mode: 'github',
      status: 503,
      code: 'deny:ghdown',
      message: 'github api error',
    };
  }

  // 3) どちらのモードでもない
  return { ok: false, mode: '-', status: 401, message: 'unauthorized' };
}

// ============================================================================
// HTTP サーバ（副作用。import.meta.main / ops/proxy-prod.mjs から startServer() 経由でのみ実行）
// ============================================================================

function deny(res, code, msg) {
  if (res.headersSent) return;
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

/** 認証・パス許可を通過したリクエストを上流 Ollama へ透過する（段階0 から不変）。 */
function forward(req, res, method) {
  const headers = { ...req.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  // プロキシで認証済み。上流(Ollama)へ秘密を伝播させない。
  delete headers.authorization;

  const upstreamReq = http.request(
    { host: UPSTREAM_HOST, port: UPSTREAM_PORT, method, path: req.url, headers },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    },
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) deny(res, 502, `upstream error: ${err.code || 'unknown'}`);
    else res.destroy();
  });

  // 中断伝播: クライアントが「途中で」切断したときだけ上流を破棄する。
  //   - req 'close': ボディを最後まで受け取る前に閉じた = アップロード中断
  //   - res 'close': レスポンスを最後まで書き切る前に閉じた = ダウンロード中断
  // 正常完了(req.readableEnded / res.writableFinished)では destroy しない。
  req.on('close', () => {
    if (!req.readableEnded) upstreamReq.destroy();
  });
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  // ボディがある時だけ pipe。空ボディの GET 等は明示的に end する。
  if (req.headers['content-length'] || req.headers['transfer-encoding']) {
    req.pipe(upstreamReq);
  } else {
    upstreamReq.end();
  }
}

/**
 * サーバを起動する。env 検証（fail-closed / exit(1)）を含む唯一のエントリポイント。
 * `if (import.meta.main)` ブロックと ops/proxy-prod.mjs（段階3）の両方が明示的に呼ぶ。
 * opts.port: listen ポート。既定は 8787（本番 / rehearse 経路は不変）。テストだけが
 *   衝突回避のため 0（OS 割り当ての空きポート）を渡す。実ポートは戻り値の
 *   `server.address().port` で取れる。
 */
export function startServer(opts = {}) {
  const env = opts.env || process.env;
  const listenPort = opts.port ?? LISTEN_PORT;

  let config;
  try {
    config = buildConfig(env);
  } catch (err) {
    // ConfigError（fail-closed）: stderr ＋ exit(1) に変換。EADDRINUSE は server.on('error') 側。
    process.stderr.write(`FATAL: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }

  const state = makeState();

  // 最小アクセスログ（既存フォーマットにフィールドを足すだけ）。
  // SUSUMAI_PROXY_LOG があればそのパスへ（本番）。無ければ従来どおり rehearsal/proxy.log。
  const logTarget = config.logPath || new URL('./proxy.log', import.meta.url);
  const accessLog = fs.createWriteStream(logTarget, { flags: 'a' });
  accessLog.on('error', () => {}); // ログ書き込み失敗でプロセスを落とさない
  const logAccess = (rec) => {
    const d = rec.deny ? ` deny=${rec.deny}` : '';
    accessLog.write(
      `${new Date().toISOString()} ${rec.method} ${rec.path} -> ${rec.status} ` +
        `ip=${rec.ip} auth=${rec.mode}${d}\n`,
    );
  };

  const server = http.createServer((req, res) => {
    const method = req.method || 'GET';
    const path = (req.url || '/').split('?')[0];
    const ip = rateLimitKey(req.headers);
    let mode = '-';
    let denyCode = '';

    // アクセスログは応答クローズ時に最終ステータスで 1 行。
    res.on('close', () =>
      logAccess({ method, path, status: res.statusCode, ip, mode, deny: denyCode }),
    );
    // 生 TCP リセット等で write が投げても未処理 error でプロセスを落とさない。
    req.on('error', () => {});
    res.on('error', () => {});

    authenticate(config, state, req.headers)
      .then((verdict) => {
        mode = verdict.mode || '-';
        if (!verdict.ok) {
          denyCode = verdict.code || '';
          return deny(res, verdict.status, verdict.message);
        }
        // 認証OK は authentication の確定。既存の isAllowed を従来位置でスキップせず実行する。
        if (!isAllowed(method, path)) {
          denyCode = 'deny:path';
          return deny(res, 403, 'forbidden: path/method not in allowlist');
        }
        forward(req, res, method);
      })
      .catch(() => {
        if (!res.headersSent) deny(res, 500, 'internal error');
      });
  });

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      process.stderr.write(
        `FATAL: :${listenPort} は既に使用中です。rehearse か別の proxy が動いていませんか。\n`,
      );
    } else {
      process.stderr.write(`FATAL: server error: ${err && err.message ? err.message : err}\n`);
    }
    process.exit(1);
  });

  server.listen(listenPort, () => {
    const actualPort = server.address().port;
    const modes = [config.bearerDigest && 'bearer', config.githubMode && 'github']
      .filter(Boolean)
      .join('+');
    process.stdout.write(
      `listening on :${actualPort} → ${UPSTREAM_HOST}:${UPSTREAM_PORT} ` +
        `(auth: ${modes}; allowlist: POST /api/chat, GET /api/tags)\n`,
    );
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      server.close(() => process.exit(0));
    });
  }

  return server;
}

if (import.meta.main) {
  try {
    startServer();
  } catch (err) {
    // startServer は ConfigError を自前で exit(1) に変換する。ここに来るのは想定外の
    // 同期例外のみ（fail-closed のフォールバック）。
    process.stderr.write(`FATAL: ${err && err.message ? err.message : err}\n`);
    process.exit(1);
  }
}
