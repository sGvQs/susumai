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

async function runOneShot(cfg: Config, prompt: string): Promise<void> {
  const history = new History();
  const ac = new AbortController();
  const onSigint = () => ac.abort();
  process.on('SIGINT', onSigint);
  try {
    await streamAnswer(cfg, history, prompt, ac.signal);
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

    generating = new AbortController();
    try {
      await streamAnswer(cfg, history, q, generating.signal);
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

  const cfg = loadConfig();
  if (values['no-stream']) cfg.stream = false;

  try {
    assertUrl(cfg);
    stderr.write('接続を確認中…\n');
    await checkHealth(cfg);
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
    await warmup(cfg);
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
