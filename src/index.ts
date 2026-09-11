import { parseArgs } from 'node:util';
import * as readline from 'node:readline/promises';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import {
  loadConfig,
  saveConfig,
  configPath,
  maskedConfig,
  assertUrl,
  type Config,
} from './config.ts';
import { checkHealth, warmup, chatStream } from './client.ts';
import { History } from './history.ts';
import { clientId, deviceLogin } from './auth.ts';
import {
  buildGithubCredentials,
  deleteCredentials,
  loadCredentials,
  refreshAuthTokenIfNeeded,
  resolveAuthToken,
  saveCredentials,
  tryRefresh,
  type Credentials,
} from './credentials.ts';
import { AuthError } from './errors.ts';

const { stdin, stdout, stderr } = process;

// --- Node バージョンガード -------------------------------------------------
// 下の `if (import.meta.main)` は Node 22.18+ でしか真偽が定まらない。それ未満では
// import.meta.main が undefined になり、main() が走らず susumai が無言で exit 0 する
// （最悪の失敗様式）。
// 対策として `pathToFileURL(process.argv[1]) === import.meta.url` の可搬ガードにすれば
// 古い Node でも「動いて」しまうが、この CLI は engines=Node>=22.18 前提でしか型・挙動を
// 検証していない（undici の headersTimeout 既定・parseArgs・組み込み fetch 等）。未検証の
// ランタイムで黙って動かすより、要件を明示して分かりやすく落とす方を選ぶ。
function assertNodeVersion(): void {
  const m = /^(\d+)\.(\d+)/.exec(process.versions.node);
  const major = m ? Number(m[1]) : 0;
  const minor = m ? Number(m[2]) : 0;
  if (major < 22 || (major === 22 && minor < 18)) {
    stderr.write(`Node.js 22.18 以降が必要です（現在 v${process.versions.node}）\n`);
    process.exit(1);
  }
}
assertNodeVersion();

// __VERSION__ は tsup の define でビルド時に焼き込まれる。テストから src を直接 import した
// 経路では未定義になり得るので、その場合のフォールバックを持つ。
const VERSION: string =
  typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0-dev';

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const isTty = Boolean(stdout.isTTY);

const HELP = `susumai — セルフホスト DeepSeek R1 (Ollama) と話す CLI

使い方:
  susumai                        対話 REPL を開始
  susumai "<プロンプト>"          ワンショット: 1 回送って応答を表示して終了（パイプ可）
  susumai config set [オプション]  設定を更新（指定したキーだけ）
  susumai config get             現在の設定を表示（token はマスク）
  susumai config path             設定ファイルの絶対パスを表示
  susumai login                   GitHub アカウントでログイン（device flow）
  susumai logout                  保存した認証情報 (credentials.json) を削除
  susumai auth status             ログイン状態・トークン有効期限・自動更新の状態を表示

config set のオプション:
  --url <url>        トンネルの base URL（例 https://xxxx.trycloudflare.com）
  --model <name>     モデル名（既定 deepseek-r1:8b）
  --num-ctx <n>      コンテキスト長（既定 16384）
  --stream <bool>    ストリーム表示 true|false
  --token <token>    プロキシ用 Bearer トークン

全体オプション:
  --no-stream        今回だけストリームを無効化
  --help             このヘルプ
  --version          バージョン

REPL 中: .exit で終了 / 生成中の Ctrl-C で生成を中断 / プロンプト待ちの Ctrl-C で終了
`;

type CliValues = Record<string, string | boolean | undefined>;

function dim(s: string): string {
  return isTty ? `${DIM}${s}${RESET}` : s;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown): never {
  stderr.write(errMessage(err) + '\n');
  process.exit(1);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * user 発話を送って応答を逐次表示し、成功したラウンドだけを history に確定させる。
 *
 * ラウンドは「user 発話 → 非空の応答成功」で初めて確定する（QA 2巡目 提案3）。
 * - frag.error で throw する経路・応答が空文字の経路では user／assistant いずれも積まない
 *   （失敗した user ターンだけが履歴に残り次リクエストで再送される問題を防ぐ）。
 * - history には userText を渡す前の messages() ＋ 今回の user だけを送る。
 */
export async function streamAnswer(
  cfg: Config,
  history: History,
  userText: string,
  signal: AbortSignal,
): Promise<void> {
  const messages = [...history.messages(), { role: 'user' as const, content: userText }];
  let assistant = '';
  let sawThinking = false;
  let sawContent = false;
  try {
    for await (const frag of chatStream(cfg, messages, { signal })) {
      if (frag.error) {
        // Ollama がストリーム途中で返したランタイムエラー（OOM 等）。1 行で表面化させる。
        throw new Error(`サーバがエラーを返しました: ${frag.error}`);
      }
      if (frag.thinking) {
        sawThinking = true;
        stdout.write(isTty ? `${DIM}${frag.thinking}${RESET}` : frag.thinking);
      }
      if (frag.content) {
        if (!sawContent && sawThinking) stdout.write('\n');
        sawContent = true;
        stdout.write(frag.content);
        assistant += frag.content;
      }
      if (frag.done) break;
    }
  } finally {
    stdout.write('\n');
  }
  if (signal.aborted) stderr.write('[中断しました]\n');
  // 応答が空（空ストリーム／throw 前で content 未達）なら、このラウンドは確定させない。
  if (assistant !== '') {
    history.pushRound(userText, assistant);
  }
}

/**
 * 「1操作チェーン」内で refresh を1回試したかどうか。`checkHealth` / `warmup` / `streamAnswer`
 * がそれぞれ `withAuthRetry` を持つため、401 が持続すると各段で forced refresh が走りうる。
 * 単回使用の refresh_token を何度も焼かないよう、1チェーンあたり refresh は最大1回に絞る
 * （事前更新 `refreshAuthTokenIfNeeded` の分は別カウント）。
 *
 * チェーンの境界:
 * - 起動シーケンス（`checkHealth` → `warmup` → 初回 `runOneShot` / REPL 初回ターン）は1予算を共有。
 * - REPL の2ターン目以降は各ターン開始時に {@link resetAuthRetryState} で予算を戻す
 *   （別シェルでの `susumai login`・8時間跨ぎの再失効・別プロセスのローテートを次ターンで拾えるように）。
 */
let authRefreshAttempted = false;

/** 操作チェーンの refresh 予算を戻す。REPL の各ターン開始時とテストから呼ぶ。 */
export function resetAuthRetryState(): void {
  authRefreshAttempted = false;
}

/**
 * 事後更新（安全網）。`op()` が proxy の 401（{@link AuthError}）で落ちたら、refresh して
 * **1回だけ**リトライする。旧フォーマット credentials・長時間 REPL の8時間跨ぎ・スリープ /
 * 時計ずれ・proxy 正キャッシュ経由の一時通過後の失効・revoke を拾う。
 *
 * - `AuthError` 以外                       → 即再送出
 * - 既にこのチェーンで refresh を試した     → 再試行せず元の `AuthError` を再送出
 * - refresh 不能（refreshToken 無し / 失効） → 元の `AuthError` を再送出
 * - リトライは1回だけ。2度目の例外は無条件伝播（`op()` は最大2回）。
 */
export async function withAuthRetry<T>(cfg: Config, op: () => Promise<T>): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (!(e instanceof AuthError)) throw e;
    if (authRefreshAttempted) throw e;
    authRefreshAttempted = true;
    if (!(await tryRefresh(cfg))) throw e;
    return await op();
  }
}

async function runConfig(rest: string[], values: CliValues): Promise<void> {
  const sub = rest[0];
  if (sub === 'path') {
    stdout.write(configPath() + '\n');
    return;
  }
  if (sub === 'get') {
    stdout.write(JSON.stringify(maskedConfig(loadConfig()), null, 2) + '\n');
    return;
  }
  if (sub === 'set') {
    const cfg = loadConfig();
    let touched = false;
    if (typeof values.url === 'string') {
      cfg.url = values.url;
      touched = true;
    }
    if (typeof values.model === 'string') {
      cfg.model = values.model;
      touched = true;
    }
    if (typeof values['num-ctx'] === 'string') {
      const n = Number(values['num-ctx']);
      if (!Number.isInteger(n) || n <= 0) fail(new Error('--num-ctx は正の整数で指定してください'));
      cfg.numCtx = n;
      touched = true;
    }
    if (typeof values.stream === 'string') {
      if (values.stream !== 'true' && values.stream !== 'false') {
        fail(new Error('--stream は true か false を指定してください'));
      }
      cfg.stream = values.stream === 'true';
      touched = true;
    }
    if (typeof values.token === 'string') {
      cfg.token = values.token;
      touched = true;
    }
    if (!touched) {
      // 認識できるオプションが 1 つも無い → config を書かない（no-op 書き込みを避ける）。
      stderr.write('config set: 認識できるオプションがありません（--url/--model/--num-ctx/--stream/--token）\n\n' + HELP);
      process.exit(2);
    }
    saveConfig(cfg);
    stdout.write('設定を保存しました → ' + configPath() + '\n');
    return;
  }
  // サブコマンド無し／未知サブコマンド。未知フラグ（exit 2）と一貫させる。
  stderr.write(
    (sub ? `config: 未知のサブコマンド「${sub}」` : 'config: サブコマンドを指定してください') +
      '（set / get / path）\n\n' +
      HELP,
  );
  process.exit(2);
}

/** `susumai login` — GitHub device flow を実行し credentials.json に保存する。 */
async function runLogin(): Promise<void> {
  try {
    const { login, id, grant } = await deviceLogin();
    saveCredentials({
      github: buildGithubCredentials(grant, { login, id }, new Date(), clientId()),
    });
    stdout.write(`ログインしました（@${login}）\n`);
  } catch (err) {
    fail(err);
  }
}

/** `susumai logout` — credentials.json を削除する。config.json の token は触らない。 */
function runLogout(): void {
  deleteCredentials();
  stdout.write(
    'credentials を削除しました。config.json の token は、設定されていれば有効なままです。\n',
  );
}

/**
 * `susumai auth status` の表示行を組み立てる純関数。
 * - ログイン済み / 未ログイン
 * - アクセストークンの有効期限（旧形式なら「不明」案内）
 * - 自動更新（refresh token）の有無と失効日
 * - config.json の token（マスク済み）の有無
 */
export function describeAuthStatus(
  creds: Credentials | null,
  configToken: string | null,
  now: Date,
): string[] {
  const lines: string[] = [];
  const gh = creds?.github;
  if (gh?.token) {
    lines.push(`ログイン済み: @${gh.login}（id ${gh.id}）`);
    if (gh.expiresAt) {
      const exp = Date.parse(gh.expiresAt);
      if (Number.isNaN(exp)) {
        lines.push('アクセストークン: 有効期限を解釈できません（日付が不正）');
      } else if (exp <= now.getTime()) {
        lines.push(`アクセストークン: ${gh.expiresAt}（失効済み）`);
      } else {
        const hours = Math.round((exp - now.getTime()) / 3_600_000);
        lines.push(`アクセストークン: ${gh.expiresAt} まで（残り約${hours}時間）`);
      }
    } else {
      lines.push('有効期限: 不明（旧形式・再ログインで自動更新が有効になります）');
    }
    if (gh.refreshToken) {
      lines.push(
        gh.refreshTokenExpiresAt
          ? `自動更新: 有効（${gh.refreshTokenExpiresAt.slice(0, 10)} まで）`
          : '自動更新: 有効',
      );
    } else {
      lines.push('自動更新: なし（refresh token がありません）');
    }
  } else {
    lines.push('ログインしていません（`susumai login` でログインできます）');
  }
  lines.push(
    configToken ? `config.json の token: あり（${configToken}）` : 'config.json の token: なし',
  );
  return lines;
}

/** `susumai auth status` — ログイン状態・有効期限・自動更新・config.json token を表示する。 */
function runAuthStatus(rest: string[]): void {
  const sub = rest[0];
  // `config` 経路（未知サブコマンドは exit 2）と揃える。`susumai auth` 単独は status 扱いで許容。
  if (sub !== undefined && sub !== 'status') {
    stderr.write(`auth: 未知のサブコマンド「${sub}」（status）\nusage: susumai auth status\n`);
    process.exit(2);
  }
  const creds = loadCredentials();
  const masked = maskedConfig(loadConfig());
  const configToken = typeof masked.token === 'string' ? masked.token : null;
  for (const line of describeAuthStatus(creds, configToken, new Date())) {
    stdout.write(line + '\n');
  }
}

async function runOneShot(cfg: Config, prompt: string): Promise<void> {
  const history = new History();
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on('SIGINT', onSigint);
  try {
    await withAuthRetry(cfg, () => streamAnswer(cfg, history, prompt, ac.signal));
  } catch (err) {
    fail(err);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

async function runRepl(cfg: Config): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const history = new History(() => {
    stderr.write(dim('※ 古い履歴を1件切り捨てました（直近16ターンのみ保持）') + '\n');
  });

  let generating: AbortController | null = null;
  rl.on('SIGINT', () => {
    if (generating) generating.abort(); // 生成中の Ctrl-C → 生成中断
    else rl.close(); // プロンプト待ちの Ctrl-C → 終了
  });

  stdout.write('susumai REPL — .exit で終了。生成中の Ctrl-C で中断。\n');

  // 初回ターンは起動シーケンス（checkHealth → warmup）と refresh 予算を共有する。
  let firstTurn = true;
  for (;;) {
    let line: string;
    try {
      line = await rl.question('› ');
    } catch {
      break; // rl.close() 由来
    }
    const q = line.trim();
    if (!q) continue;
    if (q === '.exit') break;

    // 2ターン目以降は各ターンが独立した refresh 予算を持つ（長時間セッションの回復のため）。
    if (!firstTurn) resetAuthRetryState();
    firstTurn = false;

    const ac = new AbortController();
    generating = ac;
    try {
      await withAuthRetry(cfg, () => streamAnswer(cfg, history, q, ac.signal));
    } catch (err) {
      stderr.write('\n' + errMessage(err) + '\n');
    } finally {
      generating = null;
    }
  }

  rl.close();
  stdout.write('bye\n');
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        help: { type: 'boolean' },
        version: { type: 'boolean' },
        'no-stream': { type: 'boolean' },
        url: { type: 'string' },
        model: { type: 'string' },
        'num-ctx': { type: 'string' },
        stream: { type: 'string' },
        token: { type: 'string' },
      },
    });
  } catch (err) {
    stderr.write(errMessage(err) + '\n\n' + HELP);
    process.exit(2);
  }

  const values = parsed.values as CliValues;
  const positionals = parsed.positionals;

  if (values.version) {
    stdout.write(VERSION + '\n');
    return;
  }
  if (values.help) {
    stdout.write(HELP);
    return;
  }

  if (positionals[0] === 'config') {
    await runConfig(positionals.slice(1), values);
    return;
  }
  if (positionals[0] === 'login') {
    await runLogin();
    return;
  }
  if (positionals[0] === 'logout') {
    runLogout();
    return;
  }
  if (positionals[0] === 'auth') {
    runAuthStatus(positionals.slice(1));
    return;
  }

  const cfg = loadConfig();
  // credentials.json に GitHub トークンがあれば cfg.token を上書きする（1回だけ・
  // assertUrl / checkHealth より前）。config サブコマンド経路は通らない。
  resolveAuthToken(cfg);
  // 事前更新（主）: access token の期限が近ければ、ここで refresh してから進む。
  // 期限が遠ければネットワークに触れない（shouldRefresh のゲート）。
  await refreshAuthTokenIfNeeded(cfg);
  if (values['no-stream']) cfg.stream = false;

  try {
    assertUrl(cfg);
    stderr.write('接続を確認中…\n');
    await withAuthRetry(cfg, () => checkHealth(cfg));
  } catch (err) {
    fail(err);
  }

  let oneShot: string | null = null;
  if (positionals.length > 0) {
    oneShot = positionals.join(' ');
  } else if (!stdin.isTTY) {
    const piped = (await readStdin()).trim();
    if (piped) oneShot = piped;
  }

  try {
    stderr.write('モデル読み込み中…\n');
    await withAuthRetry(cfg, () => warmup(cfg));
  } catch (err) {
    fail(err);
  }

  if (oneShot !== null) await runOneShot(cfg, oneShot);
  else await runRepl(cfg);
}

// テストが src/index.ts を import しても CLI が走らないようにガードする。
// import.meta.main は Node 22.18+（先頭の assertNodeVersion() でそれ未満を弾いている）。
if (import.meta.main) {
  main().catch((err) => fail(err));
}
