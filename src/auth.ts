/*
 * src/auth.ts — GitHub OAuth Device Authorization Grant を CLI が自前で実行する。
 * ----------------------------------------------------------------------------
 * ゼロ依存（node 組み込みの global fetch のみ）。ブラウザ自動起動（open / xdg-open）は
 * 入れない（zero-dep 方針）。client_id は publish 時に tsup の define で `__CLIENT_ID__` に
 * 焼き込む（実行時 env なしで `susumai login` が動く）。実行時 env override は clientId() が優先。
 *
 * 純関数（parseDeviceCodeResponse / classifyPollResponse / nextInterval /
 * toTokenGrant / classifyRefreshResponse）は test/auth.test.mjs から named import される。
 * deviceLogin / refreshAccessToken が副作用を持つ。
 */

import { describeErr, RefreshExpiredError } from './errors.ts';

/**
 * refresh の HTTP タイムアウト。`credentials.ts` の LOCK_STALE_MS より明確に短くする
 * （遅延した refresh を stale 奪取で二重に投げ、単回使用 refresh_token を焼く事故を防ぐ）。
 */
export const REFRESH_FETCH_TIMEOUT_MS = 10_000;

/** この repo の OAuth App の client_id。秘密ではない（公開情報）。 */
const DEFAULT_CLIENT_ID = 'Ov23liuaEuBGcxLCPA3T';

/**
 * client_id の解決（優先順）:
 *   1. 実行時 env `SUSUMAI_OAUTH_CLIENT_ID`（別 OAuth App を使うマシン向け override）
 *   2. `__CLIENT_ID__`（publish 時に tsup の define で焼き込まれるビルド時定数）
 *   3. ハードコード定数（テストで src を直接 import した経路では define が無いのでここに落ちる）
 * 焼き込みが常に入るので、ビルド済み配布物では実質「env || 焼き込み」。
 */
export function clientId(): string {
  if (process.env.SUSUMAI_OAUTH_CLIENT_ID) return process.env.SUSUMAI_OAUTH_CLIENT_ID;
  if (typeof __CLIENT_ID__ !== 'undefined' && __CLIENT_ID__) return __CLIENT_ID__;
  return DEFAULT_CLIENT_ID;
}

const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const USER_URL = 'https://api.github.com/user';
const UA = 'susumai';

// ============================================================================
// 純関数（HTTP を触らない。test/auth.test.mjs から named import）
// ============================================================================

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** ポーリング間隔（秒）。 */
  interval: number;
  /** コードの有効期限（秒）。 */
  expiresIn: number;
}

/**
 * `POST /login/device/code` のレスポンス JSON を検証して DeviceCode にする。
 * 必須フィールド欠落・`error` 応答は throw。`interval` / `expires_in` は
 * 妥当な数値でなければ GitHub の既定（5s / 900s）にフォールバックする。
 */
export function parseDeviceCodeResponse(json: unknown): DeviceCode {
  if (!json || typeof json !== 'object') {
    throw new Error('GitHub の device code 応答を解釈できませんでした');
  }
  const o = json as Record<string, unknown>;
  if (typeof o.error === 'string') {
    const detail = typeof o.error_description === 'string' ? o.error_description : o.error;
    throw new Error(`GitHub の device code 取得に失敗しました: ${detail}`);
  }
  const { device_code: dc, user_code: uc, verification_uri: vu } = o;
  if (typeof dc !== 'string' || typeof uc !== 'string' || typeof vu !== 'string') {
    throw new Error('GitHub の device code 応答に必須フィールドがありません');
  }
  const interval = typeof o.interval === 'number' && o.interval > 0 ? o.interval : 5;
  const expiresIn = typeof o.expires_in === 'number' && o.expires_in > 0 ? o.expires_in : 900;
  return { deviceCode: dc, userCode: uc, verificationUri: vu, interval, expiresIn };
}

/**
 * device flow / refresh 双方の「トークン発行」応答を正規化した形。
 * GitHub は refresh token を返さない設定（Expire user authorization tokens OFF）もあるので
 * token 以外はすべて optional。無ければ従来どおり `{ token }` だけになる。
 */
export interface TokenGrant {
  token: string;
  refreshToken?: string;
  /** access token の寿命（秒）。 */
  expiresIn?: number;
  /** refresh token の寿命（秒）。 */
  refreshTokenExpiresIn?: number;
}

/**
 * `access_token` を含む応答オブジェクトを {@link TokenGrant} にする（内部 DRY）。
 * `refresh_token` / `expires_in` / `refresh_token_expires_in` が無ければ省略する。
 */
export function toTokenGrant(o: Record<string, unknown>): TokenGrant {
  const grant: TokenGrant = { token: o.access_token as string };
  if (typeof o.refresh_token === 'string' && o.refresh_token) grant.refreshToken = o.refresh_token;
  if (typeof o.expires_in === 'number' && o.expires_in > 0) grant.expiresIn = o.expires_in;
  if (typeof o.refresh_token_expires_in === 'number' && o.refresh_token_expires_in > 0) {
    grant.refreshTokenExpiresIn = o.refresh_token_expires_in;
  }
  return grant;
}

/** ポーリング応答の分類。{@link TokenGrant} は成功、それ以外は継続 / 中断のシグナル。 */
export type PollClassification =
  | 'pending'
  | 'slow_down'
  | 'expired'
  | 'denied'
  | TokenGrant;

/**
 * `POST /login/oauth/access_token` のレスポンス JSON を分類する。
 * - `access_token` あり              → {@link TokenGrant}（refresh_token 等があれば同梱）
 * - `error: authorization_pending`   → `'pending'`（継続）
 * - `error: slow_down`               → `'slow_down'`（interval を +5s して継続）
 * - `error: expired_token`           → `'expired'`（明示エラーで終了）
 * - `error: access_denied`           → `'denied'`（明示エラーで終了）
 * - それ以外                          → throw
 */
export function classifyPollResponse(json: unknown): PollClassification {
  if (!json || typeof json !== 'object') {
    throw new Error('GitHub の token ポーリング応答を解釈できませんでした');
  }
  const o = json as Record<string, unknown>;
  if (typeof o.access_token === 'string' && o.access_token) {
    return toTokenGrant(o);
  }
  switch (o.error) {
    case 'authorization_pending':
      return 'pending';
    case 'slow_down':
      return 'slow_down';
    case 'expired_token':
      return 'expired';
    case 'access_denied':
      return 'denied';
    default: {
      const detail =
        typeof o.error_description === 'string'
          ? o.error_description
          : typeof o.error === 'string'
            ? o.error
            : 'unknown';
      throw new Error(`GitHub 認証で予期しない応答: ${detail}`);
    }
  }
}

/** `slow_down` を受けたら interval を +5s。それ以外は据え置き。 */
export function nextInterval(current: number, slowDown: boolean): number {
  return slowDown ? current + 5 : current;
}

/**
 * `POST /login/oauth/access_token`（`grant_type=refresh_token`）のレスポンス JSON を分類する。
 * - `access_token` あり                         → {@link TokenGrant}（新 refresh_token 同梱）
 * - `error: bad_refresh_token` / `invalid_grant` / `unauthorized`
 *                                               → `'invalid_grant'`（refresh token 失効。要再ログイン）
 * - それ以外の予期しない応答                    → throw
 */
export function classifyRefreshResponse(json: unknown): TokenGrant | 'invalid_grant' {
  if (!json || typeof json !== 'object') {
    throw new Error('GitHub の token 更新応答を解釈できませんでした');
  }
  const o = json as Record<string, unknown>;
  if (typeof o.access_token === 'string' && o.access_token) {
    return toTokenGrant(o);
  }
  if (o.error === 'bad_refresh_token' || o.error === 'invalid_grant' || o.error === 'unauthorized') {
    return 'invalid_grant';
  }
  const detail =
    typeof o.error_description === 'string'
      ? o.error_description
      : typeof o.error === 'string'
        ? o.error
        : 'unknown';
  throw new Error(`GitHub のトークン更新で予期しない応答: ${detail}`);
}

/** 非対話 / CI 環境か（device flow はブラウザ操作が要るのでここでは実行できない）。 */
export function isNonInteractive(): boolean {
  if (process.env.CI) return true;
  return !process.stdin.isTTY;
}

// ============================================================================
// 副作用あり
// ============================================================================

export interface DeviceLoginResult {
  login: string;
  id: number;
  /** access token ＋（発行された場合）refresh token / 有効期限。 */
  grant: TokenGrant;
}

export interface DeviceLoginOptions {
  /** ユーザー向けメッセージの出力先（既定 stderr）。 */
  log?: (msg: string) => void;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const NON_INTERACTIVE_MESSAGE =
  '非対話 / CI 環境では `susumai login`（GitHub device flow）を実行できません。\n' +
  'ブラウザでコードを入力する必要があるためです。\n' +
  'フォールバック: classic PAT（`ghp_...`）を作成し `susumai config set --token ghp_...` で設定してください\n' +
  '（fine-grained ではなく classic を推奨）。';

/**
 * GitHub Device Authorization Grant を実行して access token と login / id を返す。
 * ブラウザ自動起動はしない（verification_uri と user_code を表示するだけ）。
 * 非対話 / CI では即明示エラー。
 */
export async function deviceLogin(opts: DeviceLoginOptions = {}): Promise<DeviceLoginResult> {
  const emit = opts.log ?? ((m: string) => process.stderr.write(m + '\n'));
  const sleep = realSleep;

  if (isNonInteractive()) {
    throw new Error(NON_INTERACTIVE_MESSAGE);
  }

  const id = clientId();

  // 1. device code
  let dcRes: Response;
  try {
    dcRes = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({ client_id: id }).toString(),
    });
  } catch (err) {
    throw new Error(`GitHub (${DEVICE_CODE_URL}) に到達できません: ${describeErr(err)}`);
  }
  if (!dcRes.ok) {
    void dcRes.body?.cancel().catch(() => {});
    throw new Error(
      `GitHub のデバイスコード発行に失敗しました（HTTP ${dcRes.status}）。` +
        'SUSUMAI_OAUTH_CLIENT_ID が正しいか、GitHub 側の障害でないか確認してください。',
    );
  }
  const dc = parseDeviceCodeResponse(await dcRes.json().catch(() => null));

  // 2. 表示するだけ（ブラウザ自動起動はしない）
  emit(`ブラウザで ${dc.verificationUri} を開いて、コード ${dc.userCode} を入力してください`);

  // 3. ポーリング
  let interval = dc.interval;
  const deadline = Date.now() + dc.expiresIn * 1000;
  for (;;) {
    await sleep(interval * 1000);
    if (Date.now() >= deadline) {
      throw new Error(
        'GitHub 認証がタイムアウトしました（コードの有効期限切れ）。もう一度 `susumai login` を実行してください。',
      );
    }
    let pollRes: Response;
    try {
      pollRes = await fetch(ACCESS_TOKEN_URL, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        body: new URLSearchParams({
          client_id: id,
          device_code: dc.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      });
    } catch (err) {
      throw new Error(`GitHub (${ACCESS_TOKEN_URL}) に到達できません: ${describeErr(err)}`);
    }
    // Accept: application/json のとき GitHub は pending / slow_down でも 200＋JSON を返す。
    // 非 2xx かつ本文が JSON オブジェクトでない（5xx で HTML 等）ケースだけ、
    // HTTP ステータス付きのフォールバックエラーにする。JSON なら classifyPollResponse に委ねる。
    const pollText = await pollRes.text().catch(() => '');
    let pollJson: unknown = null;
    try {
      pollJson = JSON.parse(pollText);
    } catch {
      /* 非 JSON */
    }
    if (!pollRes.ok && (pollJson === null || typeof pollJson !== 'object')) {
      throw new Error(
        `GitHub のトークン取得に失敗しました（HTTP ${pollRes.status}）。時間をおいて再実行してください。`,
      );
    }
    const verdict = classifyPollResponse(pollJson);
    if (typeof verdict === 'object') {
      const user = await fetchGitHubUser(verdict.token);
      return { login: user.login, id: user.id, grant: verdict };
    }
    if (verdict === 'pending') continue;
    if (verdict === 'slow_down') {
      interval = nextInterval(interval, true);
      continue;
    }
    if (verdict === 'expired') {
      throw new Error(
        'GitHub のコードが期限切れになりました。もう一度 `susumai login` を実行してください。',
      );
    }
    // denied
    throw new Error('GitHub 側で認証が拒否されました（access_denied）。');
  }
}

/**
 * refresh token を使って access token を更新する（副作用: HTTP）。
 * `POST github.com/login/oauth/access_token`、body は `client_id` / `grant_type=refresh_token`
 * / `refresh_token`。GitHub の refresh token は単回使用なので、成功応答には新しい
 * refresh_token が必ず入る（呼び出し側が使用前に永続化する責任を持つ）。
 *
 * - `'invalid_grant'`（refresh token 失効） → {@link RefreshExpiredError}
 * - ネットワーク断・予期しない応答          → 通常の Error（呼び出し側で非致命に扱う）
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientIdOverride?: string,
  timeoutMs: number = REFRESH_FETCH_TIMEOUT_MS,
): Promise<TokenGrant> {
  const id = clientIdOverride || clientId();
  let res: Response;
  try {
    res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': UA,
      },
      body: new URLSearchParams({
        client_id: id,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`GitHub (${ACCESS_TOKEN_URL}) に到達できません: ${describeErr(err)}`);
  }
  const text = await res.text().catch(() => '');
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok && (json === null || typeof json !== 'object')) {
    throw new Error(
      `GitHub のトークン更新に失敗しました（HTTP ${res.status}）。時間をおいて再実行してください。`,
    );
  }
  const verdict = classifyRefreshResponse(json);
  if (verdict === 'invalid_grant') {
    throw new RefreshExpiredError('GitHub の refresh token が失効しています（再ログインが必要です）');
  }
  return verdict;
}

async function fetchGitHubUser(token: string): Promise<{ login: string; id: number }> {
  let res: Response;
  try {
    res = await fetch(USER_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': UA,
      },
    });
  } catch (err) {
    throw new Error(`GitHub (${USER_URL}) に到達できません: ${describeErr(err)}`);
  }
  if (!res.ok) {
    throw new Error(`GitHub ユーザー情報の取得に失敗しました (HTTP ${res.status})`);
  }
  const j = (await res.json().catch(() => null)) as { login?: unknown; id?: unknown } | null;
  if (!j || typeof j.login !== 'string' || typeof j.id !== 'number') {
    throw new Error('GitHub ユーザー情報の応答を解釈できませんでした');
  }
  return { login: j.login, id: j.id };
}
