/*
 * src/errors.ts — 認証まわりの共通文言・例外型・小さなヘルパ（葉モジュール・他 src を import しない）。
 * client.ts / auth.ts / credentials.ts / index.ts から参照される。
 */

/** 401 系エラーの共通 tail。ログイン方法を案内する。 */
export const AUTH_HINT =
  '`susumai login` でログインするか、classic PAT を `susumai config set --token ghp_...` で設定してください';

/** proxy が 401 を返したときに client.ts が throw する。withAuthRetry がこれだけを拾う。 */
export class AuthError extends Error {}

/** refresh token の失効 / revoke（`bad_refresh_token` 等）を auth.ts が throw する。 */
export class RefreshExpiredError extends Error {}

/** fetch の失敗理由を一行にする（cause.code → code → message → String）。 */
export function describeErr(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { cause?: { code?: string }; code?: string; name?: string; message?: string };
    return String(e.cause?.code ?? e.code ?? e.name ?? e.message ?? err);
  }
  return String(err);
}
