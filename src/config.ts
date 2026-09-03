import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface Config {
  /** トンネルの base URL（未設定可）。 */
  url?: string;
  model: string;
  numCtx: number;
  stream: boolean;
  /** プロキシ用 Bearer トークン（未設定可）。 */
  token?: string;
}

export const DEFAULT_CONFIG: Config = {
  model: 'deepseek-r1:8b',
  numCtx: 16384,
  stream: true,
};

/**
 * 設定ファイルの絶対パス。
 * win32 分岐は入れない（決定済み）。XDG_CONFIG_HOME を優先。
 */
export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  // XDG_CONFIG_HOME が相対パスのこともある。HELP は「絶対パス」と明記しているので resolve する。
  return path.resolve(path.join(base, 'susumai', 'config.json'));
}

/** 壊れた設定ファイルを検知したときの共通経路: stderr に警告して既定値を返す。 */
function warnBrokenConfig(reason: string): Config {
  process.stderr.write(
    `※ 設定ファイルが壊れています（${reason}）。既定値で続行します: ${configPath()}\n`,
  );
  return { ...DEFAULT_CONFIG };
}

/**
 * 設定を読む。
 * - ファイルが無い → 既定値（黙って）
 * - ファイルはあるが壊れている → 既定値 ＋ stderr に警告（黙って戻さない）
 *   「壊れている」＝不正な JSON、または JSON としては妥当でも中身が
 *   オブジェクトでない（null・配列・数値・文字列・真偽値）もの。
 */
export function loadConfig(): Config {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath(), 'utf8');
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return warnBrokenConfig('不正な JSON');
  }
  // `null`（typeof は 'object'）・配列・非オブジェクトを弾く。ここを通さないと
  // 下の `parsed.url` 参照が `null` で TypeError になり、生の英語エラーで落ちる。
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return warnBrokenConfig('JSON オブジェクトではありません');
  }
  const parsedObj = parsed as Partial<Config>;
  const cfg: Config = { ...DEFAULT_CONFIG };
  if (typeof parsedObj.url === 'string' && parsedObj.url) cfg.url = parsedObj.url;
  if (typeof parsedObj.model === 'string' && parsedObj.model) cfg.model = parsedObj.model;
  if (parsedObj.numCtx !== undefined) {
    // `config set --num-ctx`（src/index.ts）と同じ「正の整数」検証に揃える。
    // 負数・0・小数・非数値は警告して既定 16384 にフォールバックする。
    if (
      typeof parsedObj.numCtx === 'number' &&
      Number.isInteger(parsedObj.numCtx) &&
      parsedObj.numCtx > 0
    ) {
      cfg.numCtx = parsedObj.numCtx;
    } else {
      process.stderr.write(
        `※ 設定の numCtx が不正です（正の整数が必要）。既定 ${DEFAULT_CONFIG.numCtx} を使います: ${configPath()}\n`,
      );
    }
  }
  if (typeof parsedObj.stream === 'boolean') cfg.stream = parsedObj.stream;
  if (typeof parsedObj.token === 'string' && parsedObj.token) cfg.token = parsedObj.token;
  return cfg;
}

/** 設定を保存する。ディレクトリを掘ってから 0600 で書く（既存ファイルも 0600 に矯正）。 */
export function saveConfig(cfg: Config): void {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body: Record<string, unknown> = {
    model: cfg.model,
    numCtx: cfg.numCtx,
    stream: cfg.stream,
  };
  if (cfg.url) body.url = cfg.url;
  if (cfg.token) body.token = cfg.token;
  // 非アトミック書き込みだと、書き込み中の中断で config が破損する。
  // 同一ディレクトリの temp に書いてから rename（同一 FS 上ではアトミック）。
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.chmodSync(file, 0o600);
}

function maskToken(token: string): string {
  if (token.length <= 8) return '*'.repeat(token.length);
  return `${token.slice(0, 4)}${'*'.repeat(token.length - 8)}${token.slice(-4)}`;
}

/** 表示用に token を伏せた設定。token 以外はそのまま。 */
export function maskedConfig(cfg: Config): Record<string, unknown> {
  const out: Record<string, unknown> = {
    model: cfg.model,
    numCtx: cfg.numCtx,
    stream: cfg.stream,
  };
  if (cfg.url) out.url = cfg.url;
  if (typeof cfg.token === 'string' && cfg.token) out.token = maskToken(cfg.token);
  return out;
}

/** url が未設定/空なら throw（呼び出し側が catch して exit 1）。 */
export function assertUrl(cfg: Config): void {
  if (!cfg.url || !cfg.url.trim()) {
    throw new Error('URL 未設定。`susumai config set --url <tunnel-url>` を実行してください');
  }
}
