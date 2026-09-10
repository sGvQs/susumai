import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * XDG のベース設定ディレクトリ（絶対パス）。
 * `XDG_CONFIG_HOME`（相対のこともある）を優先し、無ければ `~/.config`。
 *
 * repo 全体で `os.homedir()` を参照するのはこの関数だけ。ここ以外から
 * home ディレクトリを直参照しない（テストの隔離が壊れるため）。
 */
export function configHome(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.resolve(base);
}

/**
 * `file` を「同一ディレクトリの tmp に書く → rename → 0600 に矯正」で原子的に書く。
 * - 親ディレクトリは recursive に作成する。
 * - 非アトミック書き込みだと書き込み中の中断でファイルが破損する。同一 FS 上の
 *   rename はアトミックなのでそれを使う。
 * - rename 失敗時は tmp を掃除してから再送出する。
 * - 既存ファイルも 0600 に矯正する。
 *
 * `config.ts` の旧 `saveConfig()` の挙動をそのまま抽出したもの。
 */
export function writeFileAtomic0600(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  fs.chmodSync(file, 0o600);
}

/**
 * JSON ファイルを読む低レベルプリミティブ。
 * - ファイルが無い / 読めない        → `{ status: 'missing' }`
 * - 読めたが `JSON.parse` に失敗      → `{ status: 'invalid-json' }`
 * - パース成功                        → `{ status: 'ok', value }`
 *
 * 「JSON だが非オブジェクト（null・配列・数値…）」の判定はここでは**しない**。
 * それは呼び出し側（`config.ts`）の責務で、既存テストが文言まで pin している。
 */
export function readJsonFile(
  file: string,
): { status: 'missing' | 'invalid-json' | 'ok'; value?: unknown } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return { status: 'missing' };
  }
  try {
    return { status: 'ok', value: JSON.parse(raw) };
  } catch {
    return { status: 'invalid-json' };
  }
}
