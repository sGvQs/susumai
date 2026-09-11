import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { configHome, readJsonFile, writeFileAtomic0600 } from './xdg.ts';
import { clientId, refreshAccessToken, type TokenGrant } from './auth.ts';
import { AUTH_HINT, describeErr, RefreshExpiredError } from './errors.ts';

/**
 * `credentials.json` の on-disk 形式。`config.json`（Config）とは別ファイル・別 mode 0600。
 * 認証情報だけを入れる「入れ物」で、誰が通れるかを決めるのは proxy（別段階）。
 *
 * 追加フィールドはすべて optional・加算的・後方互換。`version` フィールドは持たない。
 * - 旧フォーマット（`refreshToken` 無し）はそのまま読めて、refresh は発火しない。
 * - OAuth App の「Expire user authorization tokens」が OFF なら device flow が
 *   refresh_token / expires_in を返さないので、追加フィールドは載らず旧フォーマット扱い。
 */
export interface Credentials {
  github?: {
    token: string;
    login: string;
    id: number;
    /** ISO8601。トークン取得（および refresh）時刻。 */
    obtainedAt: string;
    /** GitHub の refresh token（単回使用・~6ヶ月）。 */
    refreshToken?: string;
    /** ISO8601。access token の失効時刻（obtainedAt + expires_in）。 */
    expiresAt?: string;
    /** ISO8601。refresh token の失効時刻（obtainedAt + refresh_token_expires_in）。 */
    refreshTokenExpiresAt?: string;
    /** このトークンを発行した client_id。refresh 時に使う（無ければ clientId() にフォールバック）。 */
    clientId?: string;
  };
}

/**
 * 事前更新（チャット起動時）の skew マージン。`expiresAt` がこの時間内なら refresh する。
 * 定数。env override は持たない（プランの決定）。
 */
export const TOKEN_REFRESH_SKEW_MS = 10 * 60 * 1000;

/**
 * これより古い lock dir は死んだ保持者とみなして奪取する。
 * refresh の HTTP タイムアウト（`REFRESH_FETCH_TIMEOUT_MS` = 10s）＋ 永続化・余裕より十分大きくする。
 * 短すぎると、GitHub が遅延応答した隙に別プロセスが lock を奪取し、同じ単回使用 refresh_token で
 * 二度目の refresh を投げてしまう（敗者が `invalid_grant` → 事前更新経路の誤警告）。
 */
const LOCK_STALE_MS = 30_000;
/**
 * 取得できなかった側のポーリング上限。lock 保持者が refresh を終える（成功・失敗・タイムアウト）
 * のを待てる長さが要る＝`REFRESH_FETCH_TIMEOUT_MS`（10s）をわずかに超える程度。対話ストールの
 * 最大値がこれで決まるので詰める。`LOCK_STALE_MS` は超えない。
 */
const LOCK_WAIT_MS = 12_000;
/** 待機側のポーリング間隔。 */
const LOCK_POLL_MS = 40;

/** `credentials.json` の絶対パス（`config.json` と同じディレクトリ）。 */
export function credentialsPath(): string {
  return path.resolve(path.join(configHome(), 'susumai', 'credentials.json'));
}

/** アドバイザリロックのパス（`credentials.json.lock` ディレクトリ）。 */
function lockPath(): string {
  return credentialsPath() + '.lock';
}

/**
 * 認証情報を読む。
 * - ファイルが無い / 壊れている（不正な JSON・非オブジェクト） → `null`（throw しない・stderr にも出さない）
 * - 妥当なオブジェクト → そのまま `Credentials` として返す（`github` が無ければ `{}` 相当）
 */
export function loadCredentials(): Credentials | null {
  const read = readJsonFile(credentialsPath());
  if (read.status !== 'ok') return null;
  const value = read.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Credentials;
}

/** 認証情報を 0600 で保存する（tmp + rename のアトミック書き込み）。 */
export function saveCredentials(c: Credentials): void {
  writeFileAtomic0600(credentialsPath(), JSON.stringify(c, null, 2) + '\n');
}

/** 認証情報ファイルを削除する。無くてもエラーにしない。ロックの残骸も掃除する。 */
export function deleteCredentials(): void {
  fs.rmSync(credentialsPath(), { force: true });
  fs.rmSync(lockPath(), { recursive: true, force: true });
}

/**
 * credentials に GitHub トークンがあれば `cfg.token` を上書きする。それ以外は `cfg.token` を触らない。
 * `src/index.ts` のチャット経路で `loadConfig()` の直後に1回だけ呼ぶ。
 *
 * ※ この関数は段階1 で pin された挙動。一切変更しない（同期のまま）。
 */
export function resolveAuthToken(cfg: Config): void {
  const c = loadCredentials();
  if (c?.github?.token) cfg.token = c.github.token;
}

// ============================================================================
// 純関数（テスト境界）
// ============================================================================

/**
 * access token を（skew マージン付きで）更新すべきか。純関数・ネットワークに触れない。
 * false を返す条件:
 * - `gh` が無い / `refreshToken` が無い（旧フォーマット・refresh 不能）
 * - `expiresAt` が無い / 不正な日付
 * - `refreshTokenExpiresAt` が経過済み / 不正な日付（refresh しても失効するだけ）
 * - `expiresAt` までまだ skew マージンより余裕がある
 */
export function shouldRefresh(
  gh: Credentials['github'],
  now: Date,
  skewMs: number = TOKEN_REFRESH_SKEW_MS,
): boolean {
  if (!gh || !gh.refreshToken || !gh.expiresAt) return false;
  const exp = Date.parse(gh.expiresAt);
  if (Number.isNaN(exp)) return false;
  if (gh.refreshTokenExpiresAt) {
    // 壊れた失効日は「不明」＝ブロックしない（refresh を全面停止させない）。
    // 妥当な日付で、かつ既に経過しているときだけ false。
    const rexp = Date.parse(gh.refreshTokenExpiresAt);
    if (!Number.isNaN(rexp) && rexp <= now.getTime()) return false;
  }
  return exp - now.getTime() <= skewMs;
}

/**
 * {@link TokenGrant} と保存済みの user 情報から `credentials.json` の `github` オブジェクトを作る。
 * 純関数。`GET /user` は叩かない（login / id は再利用）。
 * grant に無いフィールド（refresh_token / expires_in 等）は省略する。
 */
export function buildGithubCredentials(
  grant: TokenGrant,
  user: { login: string; id: number },
  now: Date,
  clientIdValue?: string,
): NonNullable<Credentials['github']> {
  const gh: NonNullable<Credentials['github']> = {
    token: grant.token,
    login: user.login,
    id: user.id,
    obtainedAt: now.toISOString(),
  };
  if (grant.refreshToken) gh.refreshToken = grant.refreshToken;
  if (typeof grant.expiresIn === 'number' && grant.expiresIn > 0) {
    gh.expiresAt = new Date(now.getTime() + grant.expiresIn * 1000).toISOString();
  }
  if (typeof grant.refreshTokenExpiresIn === 'number' && grant.refreshTokenExpiresIn > 0) {
    gh.refreshTokenExpiresAt = new Date(
      now.getTime() + grant.refreshTokenExpiresIn * 1000,
    ).toISOString();
  }
  if (clientIdValue) gh.clientId = clientIdValue;
  return gh;
}

/** lock dir が stale（保持者が死んでいる）か。純関数。境界（ちょうど staleMs）は stale ではない。 */
export function isLockStale(
  mtimeMs: number,
  nowMs: number,
  staleMs: number = LOCK_STALE_MS,
): boolean {
  return nowMs - mtimeMs > staleMs;
}

// ============================================================================
// 副作用あり（refresh の配線）
// ============================================================================

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * ロックを取得する（`mkdir` のアトミック性を利用）。取れたら true。
 * EEXIST かつ stale なら古い dir を奪取する。
 */
function acquireLock(lock: string): boolean {
  try {
    fs.mkdirSync(lock);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(lock);
  } catch {
    // 直前に消えた → もう一度だけ取得を試みる
    try {
      fs.mkdirSync(lock);
      return true;
    } catch {
      return false;
    }
  }
  if (!isLockStale(st.mtimeMs, Date.now())) return false;
  try {
    fs.rmdirSync(lock);
    fs.mkdirSync(lock);
    return true;
  } catch {
    return false;
  }
}

function releaseLock(lock: string): void {
  try {
    fs.rmdirSync(lock);
  } catch {
    /* 既に消えている / 奪取された */
  }
}

/**
 * ロック内で実際に refresh を行う。ローテーションは「成功時のみ・アトミック・使用前に永続化」:
 *   1. refreshAccessToken() でレスポンス検証
 *   2. buildGithubCredentials() で新オブジェクト構築（login / id は再利用）
 *   3. saveCredentials()（tmp + rename の 0600 書き込み）
 *   4. 成功して初めて cfg.token を差し替え
 * どの失敗でも credentials.json は書かない（旧ファイルは常に無傷）。
 *
 * @returns cfg.token が有効なトークン（新規 or 勝者の）になっていれば true
 */
async function doRefresh(cfg: Config, force: boolean): Promise<boolean> {
  const creds = loadCredentials();
  const gh = creds?.github;
  if (!gh || !gh.refreshToken) return false;

  // ロック待ちの間に別プロセスが既に refresh 済みなら、その新トークンを採用して終わる
  // （GitHub の refresh token は単回使用なので二度 refresh してはいけない）。
  const winnerRotated = gh.token !== cfg.token;
  if (winnerRotated || (!force && !shouldRefresh(gh, new Date()))) {
    cfg.token = gh.token;
    return true;
  }

  const grant = await refreshAccessToken(gh.refreshToken, gh.clientId);

  // fetch を await している間に `susumai logout` で credentials.json が消えた可能性がある。
  // ロック保持中なので窓は小さいが、消えていれば復活させずに bail する。
  if (!fs.existsSync(credentialsPath())) return false;

  const newGh = buildGithubCredentials(
    grant,
    { login: gh.login, id: gh.id },
    new Date(),
    gh.clientId ?? clientId(),
  );
  saveCredentials({ ...creds, github: newGh });
  cfg.token = newGh.token; // 永続化に成功して初めて差し替える
  return true;
}

/**
 * single-flight な refresh。事前更新・事後更新の両方がここを通る。
 * 最小アドバイザリロック（mkdir アトミック ＋ stale タイムアウト ＋ finally 解放）。
 * - 取得できた側: ロック内で再読 → 再判定 → refresh → 永続化 → finally 解放
 * - 取得できなかった側: 最大 LOCK_WAIT_MS ポーリングで解放待ち → refresh を呼ばず
 *   credentials.json を再読して勝者の新トークンを採用。タイムアウトしても現ファイルの
 *   トークンで best-effort 続行（エラーにしない）。
 */
export async function refreshAndPersist(cfg: Config, opts: { force?: boolean } = {}): Promise<boolean> {
  const lock = lockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  if (acquireLock(lock)) {
    try {
      return await doRefresh(cfg, opts.force ?? false);
    } finally {
      releaseLock(lock);
    }
  }

  // 待機側: 解放を待って勝者のトークンを採用する（refresh は呼ばない）。
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(LOCK_POLL_MS);
    if (!fs.existsSync(lock)) break;
  }
  const creds = loadCredentials();
  if (creds?.github?.token) {
    cfg.token = creds.github.token;
    return true;
  }
  return false;
}

/**
 * 事前更新（主）: チャット起動時に `expiresAt` を skew マージン付きで見て、近ければ refresh。
 * `shouldRefresh` のゲートなので期限が遠ければネットワークに触れない。
 * どの失敗も非致命（現トークンで続行。次の 401 で終端）。
 */
export async function refreshAuthTokenIfNeeded(cfg: Config): Promise<void> {
  const creds = loadCredentials();
  if (!shouldRefresh(creds?.github, new Date())) return;
  try {
    await refreshAndPersist(cfg, {});
  } catch (err) {
    if (err instanceof RefreshExpiredError) {
      process.stderr.write(`GitHub の認証が失効しています。${AUTH_HINT}\n`);
      return;
    }
    process.stderr.write(
      `GitHub トークンの更新に失敗しました（現在のトークンで続行します）: ${describeErr(err)}\n`,
    );
  }
}

/**
 * 事後更新（安全網）: proxy から 401 が来たときに withAuthRetry が呼ぶ。
 * @returns refresh に成功して（または勝者のトークンを採用して）リトライする価値があれば true
 */
export async function tryRefresh(cfg: Config): Promise<boolean> {
  const creds = loadCredentials();
  if (!creds?.github?.refreshToken) return false;
  try {
    return await refreshAndPersist(cfg, { force: true });
  } catch {
    // RefreshExpiredError / ネットワーク / FS エラー → リトライ不能。
    // withAuthRetry が元の AuthError を再送出する。
    return false;
  }
}
