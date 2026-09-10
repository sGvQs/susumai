import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import { configHome, readJsonFile, writeFileAtomic0600 } from './xdg.ts';

/**
 * `credentials.json` の on-disk 形式。`config.json`（Config）とは別ファイル・別 mode 0600。
 * 認証情報だけを入れる「入れ物」で、誰が通れるかを決めるのは proxy（別段階）。
 */
export interface Credentials {
  github?: {
    token: string;
    login: string;
    id: number;
    /** ISO8601。トークン取得時刻。 */
    obtainedAt: string;
  };
}

/** `credentials.json` の絶対パス（`config.json` と同じディレクトリ）。 */
export function credentialsPath(): string {
  return path.resolve(path.join(configHome(), 'susumai', 'credentials.json'));
}

/**
 * 認証情報を読む。
 * - ファイルが無い / 壊れている（不正な JSON・非オブジェクト） → `null`（throw しない・stderr にも出さない）
 * - 妥当なオブジェクト → そのまま `Credentials` として返す（`github` が無ければ `{}` 相当）
 *
 * 「壊れていたら黙って null」なのは、credentials.json を壊しても CLI が落ちず
 * `config.json` の token にフォールバックできるようにするため。
 */
export function loadCredentials(): Credentials | null {
  const read = readJsonFile(credentialsPath());
  if (read.status !== 'ok') return null;
  const value = read.value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Credentials;
}

/** 認証情報を 0600 で保存する。 */
export function saveCredentials(c: Credentials): void {
  writeFileAtomic0600(credentialsPath(), JSON.stringify(c, null, 2) + '\n');
}

/** 認証情報ファイルを削除する。無くてもエラーにしない。 */
export function deleteCredentials(): void {
  fs.rmSync(credentialsPath(), { force: true });
}

/**
 * credentials に GitHub トークンがあれば `cfg.token` を上書きする。それ以外は `cfg.token` を触らない。
 * `src/index.ts` のチャット経路で `loadConfig()` の直後に1回だけ呼ぶ。
 */
export function resolveAuthToken(cfg: Config): void {
  const c = loadCredentials();
  if (c?.github?.token) cfg.token = c.github.token;
}
