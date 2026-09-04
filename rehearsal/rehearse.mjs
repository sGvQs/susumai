/*
 * rehearsal/rehearse.mjs — RUNBOOK.md の当日検証手順を自動化する常駐スクリプト
 * ----------------------------------------------------------------------------
 * これは「2回目以降」用。初回は rehearsal/RUNBOOK.md を通読して全体像を掴むこと。
 * このファイルは仕様・値・背景を持たない（正典の分担）:
 *   - allowlist の内容            → rehearsal/proxy.mjs（3段チェーンで /api/pull→403 を1つ使うだけ）
 *   - タイムアウト値(10/60/300)   → src/client.ts ＋ rehearsal/SPIKE_RESULTS.md §8（ここに固定しない）
 *   - トークン運搬(手動/別PC)      → RUNBOOK §2
 *   - teardown 手順               → RUNBOOK §9（同じ pkill を使う）
 *   - URL の揮発性                → SPIKE_RESULTS.md（毎回採取し直す）
 *
 * 使い方:
 *   node rehearsal/rehearse.mjs [--start-ollama]   フル実行（フォアグラウンド常駐）
 *   node rehearsal/rehearse.mjs teardown [--all]   明示撤収
 *   node rehearsal/rehearse.mjs --help
 *
 * ゼロ依存（node 組み込みモジュールのみ）。src/ は変更しない。
 * ----------------------------------------------------------------------------
 */

import { spawn, spawnSync } from 'node:child_process';
import http from 'node:http';
import readline from 'node:readline';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import process from 'node:process';

// --- パス（すべて絶対）----------------------------------------------------------
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const REHEARSAL_DIR = path.join(REPO_ROOT, 'rehearsal');
const XDG_DIR = path.join(REHEARSAL_DIR, '.xdg'); // 隔離 config の XDG_CONFIG_HOME（絶対パス）
const ISOLATED_CONFIG = path.join(XDG_DIR, 'susumai', 'config.json');
const PROXY_SCRIPT = path.join(REHEARSAL_DIR, 'proxy.mjs');
const PROXY_LOG = path.join(REHEARSAL_DIR, 'proxy.log');
const DIST_INDEX = path.join(REPO_ROOT, 'dist', 'index.js');

const OLLAMA_URL = 'http://127.0.0.1:11434';
const PROXY_URL = 'http://127.0.0.1:8787';
const PROXY_PORT = 8787;
const TUNNEL_TARGET = 'http://localhost:8787';
// リハーサルの検証対象モデル（RUNBOOK / src/config.ts DEFAULT_CONFIG と同じ）。
const REHEARSAL_MODEL = 'deepseek-r1:8b';

// 無活動オートティアダウンの猶予（仕様で明示された値）。
const INACTIVITY_MS = 24 * 60 * 60 * 1000;

// 死んだトンネル検証の合否上限。検証対象はローカルに立てた「TCP は張れるがヘッダを一切
// 返さない」ブラックホールサーバ（SPIKE_RESULTS.md §8 が「危険」と名指しする形。DNS 不能な
// *.trycloudflare.com では再現しない＝あちらは ~100ms で ENOTFOUND）。src/client.ts は全 fetch に
// 明示 AbortController タイムアウトを付けている（同 §8「CLI 本体への申し送り」）ので、この形でも
// 接続確認 / 初トークン watchdog で失敗するはず。明示タイムアウトが外れると undici 既定（同 §8）
// まで待つ。この上限はその回帰を実際に captured するための天井であって、具体秒数（10/60/300）を
// このファイルに固定するものではない。env で調整可能。
const DEAD_TUNNEL_MAX_MS =
  Number.parseInt(process.env.REHEARSE_DEAD_TUNNEL_MAX_MS ?? '', 10) || 240_000;

// ============================================================================
// 純関数（HTTP・プロセスを触らない。test/rehearse.test.mjs から named import される）
// ============================================================================

/** trycloudflare quick tunnel の URL パターン。 */
export const TRYCLOUDFLARE_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * テキスト（複数行可）から最初の trycloudflare URL を返す。無ければ null。
 * 子プロセスの stdout/stderr を行イテレートしながら 1 行ずつ渡す使い方も、
 * 塊で渡す使い方も両方できる。
 */
export function extractTunnelUrl(text) {
  if (typeof text !== 'string') return null;
  const m = text.match(TRYCLOUDFLARE_URL_RE);
  return m ? m[0] : null;
}

/** 経過時間が閾値未満か（死んだトンネル検証の合否判定の芯）。非有限は false。 */
export function elapsedBelowThreshold(elapsedMs, thresholdMs) {
  return (
    Number.isFinite(elapsedMs) && Number.isFinite(thresholdMs) && elapsedMs < thresholdMs
  );
}

/**
 * 死んだトンネル検証の合否。検証対象は「TCP は張れるがヘッダを返さないサーバ」。
 * - CLI が成功(exit 0)したら不合格（応答しないサーバ相手に通ってはいけない）
 * - 失敗までの経過時間が閾値以上なら不合格（client.ts の明示タイムアウトが効いていない）
 */
export function judgeDeadTunnel({ exitCode, elapsedMs, thresholdMs }) {
  const shown = Number.isFinite(elapsedMs) ? `${Math.round(elapsedMs)}ms` : String(elapsedMs);
  if (exitCode === 0) {
    return {
      pass: false,
      reason: `ヘッダを返さないサーバ相手に CLI が成功した（exit 0、${shown}）`,
    };
  }
  if (!elapsedBelowThreshold(elapsedMs, thresholdMs)) {
    return {
      pass: false,
      reason: `失敗までに ${shown} かかった（閾値 ${thresholdMs}ms 未満で失敗すべき）`,
    };
  }
  return {
    pass: true,
    reason: `応答しないサーバ相手に ${shown} で失敗（閾値 ${thresholdMs}ms 未満）`,
  };
}

/**
 * トンネル検証のポーリング間隔（ms）。最初の 30 秒は 2 秒間隔、その後は 5 秒間隔。
 * 固定値はこのバックオフ形状に必要な最小限だけ（総待ち時間は verifyTunnel 側で env 上書き可）。
 */
export function tunnelPollDelayMs(elapsedMs) {
  return elapsedMs < 30_000 ? 2_000 : 5_000;
}

/** 待っても直らない＝リトライを打ち切って HALT すべきトンネル応答か。 */
export function isTunnelFatalStatus(status) {
  return status === 401;
}

/** この run が書いた使い捨て cloudflared ログのファイル名か（`cloudflared.<pid>.<ts>.log`）。 */
export function isPerRunCloudflaredLog(filename) {
  return /^cloudflared\.\d+\.\d+\.log$/.test(filename);
}

/**
 * トンネル検証 1 回分の結果（fetch の cause code / HTTP ステータス / 本文先頭）を
 * 人間向けの短評にする純関数。各リトライ行と HALT メッセージの両方で使う。
 */
export function describeTunnelProbe({ errCode, status, bodyPrefix } = {}) {
  if (errCode) {
    const map = {
      ENOTFOUND: 'DNS 未伝播',
      EAI_AGAIN: 'DNS 一時失敗（未伝播）',
      ECONNREFUSED: '接続拒否（エッジ未確立?）',
      ECONNRESET: '接続リセット',
      UND_ERR_CONNECT_TIMEOUT: '接続タイムアウト',
      UND_ERR_HEADERS_TIMEOUT: 'ヘッダ応答なし',
      UND_ERR_SOCKET: 'ソケット切断',
      AbortError: 'タイムアウト（5s 応答なし）',
    };
    return `${errCode} — ${map[errCode] ?? '接続失敗'}`;
  }
  if (typeof status === 'number') {
    const note = {
      200: '応答形状が想定と異なる',
      401: 'トークン不一致?',
      403: 'allowlist で遮断?',
      404: 'パス不一致?',
      502: 'エッジは到達、上流待ち',
      503: 'エッジは到達、上流待ち',
      504: 'エッジは到達、上流タイムアウト',
      530: 'Cloudflare origin エラー',
    }[status];
    const b = bodyPrefix ? ` "${bodyPrefix}"` : '';
    return note ? `${status} — ${note}${b}` : `HTTP ${status}${b}`;
  }
  return '不明';
}

/** proxy 同一性チェーン 第1段: :8787 の LISTEN プロセスが rehearsal proxy か。 */
export function classifyProxyListener(psCommand) {
  const cmd = (psCommand || '').trim();
  if (!cmd) {
    return {
      ok: false,
      halt: true,
      reason: ':8787 の LISTEN プロセスを特定できません（lsof/ps が空）',
    };
  }
  if (cmd.includes('rehearsal/proxy.mjs')) {
    return { ok: true, reason: `:8787 の LISTEN は rehearsal proxy（${cmd}）` };
  }
  return {
    ok: false,
    halt: true,
    reason: `:8787 は別プロセスが占有しています（${cmd}）。落としてから再実行してください`,
  };
}

/** proxy 同一性チェーン 第2段: 認証付き GET /api/tags のステータス → 判定。 */
export function classifyProxyAuth(status, hasToken) {
  if (!hasToken) {
    return {
      ok: false,
      halt: true,
      reason:
        '既存 proxy のトークンが不明（隔離 config に token なし）。落として貼り直すか、トークンを入力してください',
    };
  }
  if (status === 200) return { ok: true, reason: '認証付き GET /api/tags → 200' };
  if (status === 401) {
    return {
      ok: false,
      halt: true,
      reason:
        '既存 proxy のトークンが不一致です (401)。落として貼り直すか、トークンを入力してください',
    };
  }
  if (typeof status === 'number' && status >= 500 && status <= 599) {
    return {
      ok: false,
      halt: true,
      reason: `proxy は生きていますが上流 Ollama が応答しません (HTTP ${status})`,
    };
  }
  return {
    ok: false,
    halt: true,
    reason: `認証付き GET /api/tags が予期しない HTTP ${status} を返しました`,
  };
}

/** proxy 同一性チェーン 第3段: 認証付き POST /api/pull は非 allowlist なので 403 のはず。 */
export function classifyProxyAllowlist(status) {
  if (status === 403) {
    return { ok: true, reason: '認証付き POST /api/pull → 403（非 allowlist が遮断されている）' };
  }
  return {
    ok: false,
    halt: true,
    reason: `:8787 のプロセスは rehearsal proxy と挙動が違います（POST /api/pull → HTTP ${status}、期待 403）`,
  };
}

/**
 * 3段チェーンの判定を組み立てる（HTTP は呼ばない）。
 * 入力: listenerPsCommand / hasToken / tagsStatus / pullStatus
 * 出力: { action: 'reuse' | 'halt', step, reason }
 */
export function decideProxyReuse({ listenerPsCommand, hasToken, tagsStatus, pullStatus }) {
  const s1 = classifyProxyListener(listenerPsCommand);
  if (!s1.ok) return { action: 'halt', step: 1, reason: s1.reason };
  const s2 = classifyProxyAuth(tagsStatus, hasToken);
  if (!s2.ok) return { action: 'halt', step: 2, reason: s2.reason };
  const s3 = classifyProxyAllowlist(pullStatus);
  if (!s3.ok) return { action: 'halt', step: 3, reason: s3.reason };
  return { action: 'reuse', step: 3, reason: '3段すべて成立 → 既存 proxy を再利用' };
}

/** cloudflared のコマンドラインが :8787 へのトンネルか（別用途の cloudflared を弾く）。 */
export function isPort8787TunnelCmd(cmd) {
  if (typeof cmd !== 'string') return false;
  return /(?:localhost|127\.0\.0\.1):8787(?:$|[^0-9])/.test(cmd);
}

/** /api/tags 応答（パース済み JSON）に want モデルが含まれるか。 */
export function tagsHasModel(json, want) {
  const models = json && Array.isArray(json.models) ? json.models : [];
  return models.some(
    (m) => m && typeof m === 'object' && (m.name === want || m.model === want),
  );
}

// ============================================================================
// ここから下は副作用あり（import しても実行されない: `if (import.meta.main)` ガード）
// ============================================================================

class Halt extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'Halt';
    this.code = code;
  }
}
/** 手順を止める（前提不成立・要人間判断）。終了コード 2。 */
function halt(msg) {
  throw new Halt(msg, 2);
}
/** 自動検証の不合格。終了コード 1。 */
function fail(msg) {
  throw new Halt(msg, 1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const state = {
  startedProxy: false,
  startedCloudflared: false,
  startedOllama: false,
  reusedProxyPid: null,
  reusedCloudflaredPid: null,
  autoVerifyPassed: false,
  toreDown: false,
  // トンネル伝播待ち HALT のときだけ true: 起動した子と隔離 .xdg を残して次回再利用させる。
  keepStartedProcesses: false,
};

/** 自分が spawn した子だけをメモリ配列で保持（永続台帳なし）。 */
const children = [];

function log(msg) {
  process.stdout.write(msg + '\n');
}
function warn(msg) {
  process.stderr.write(msg + '\n');
}

function describeErr(e) {
  return String(e?.cause?.code ?? e?.code ?? e?.message ?? e ?? 'unknown');
}
function isConnRefused(e) {
  return (e?.cause?.code ?? e?.code) === 'ECONNREFUSED';
}

function childEnv(extra = {}) {
  // 全子プロセスに隔離 XDG_CONFIG_HOME（絶対パス）を渡す。ユーザーの実 config には触れない。
  return { ...process.env, XDG_CONFIG_HOME: XDG_DIR, ...extra };
}

/** dist/index.js を実体 node（volta shim を挟まず）で叩く。 */
function runSusumai(args, opts = {}) {
  return spawnSync(process.execPath, [DIST_INDEX, ...args], {
    cwd: REPO_ROOT,
    env: childEnv(),
    encoding: 'utf8',
    // thinking 込みの冗長な応答でも切れないよう既定 1MB を広げる（切れると誤判定になる）。
    maxBuffer: 16 * 1024 * 1024,
    ...opts,
  });
}

// --- HTTP（組み込み fetch）----------------------------------------------------
async function httpReq(method, url, headers = {}, timeoutMs = 5000, body) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers, body, signal: ac.signal });
    const text = await res.text().catch(() => '');
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON はそのまま */
    }
    return { status: res.status, text, json };
  } finally {
    clearTimeout(t);
  }
}
function bearer(token) {
  return token
    ? { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    : { 'content-type': 'application/json' };
}
async function statusOrHalt(method, url, token, body) {
  try {
    return (await httpReq(method, url, bearer(token), 5000, body)).status;
  } catch (e) {
    halt(`${method} ${url} に到達できません: ${describeErr(e)}`);
  }
}

// --- プロセス探索（自分の起動分の誤検出を避けるための限定検索）-----------------
function pgrepF(pattern) {
  const r = spawnSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  if (r.status !== 0 || !r.stdout) return [];
  return r.stdout
    .trim()
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
}
function psCommand(pid) {
  const r = spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
}
function listenerPid(port) {
  const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return null;
  const first = (r.stdout || '').trim().split(/\s+/)[0];
  const n = Number(first);
  return Number.isInteger(n) && n > 0 ? n : null;
}
/** :8787 トンネルに限定した cloudflared 検出（bare `pgrep -f cloudflared` は使わない）。 */
function findPort8787Cloudflared() {
  return pgrepF('cloudflared tunnel')
    .map((pid) => ({ pid, cmd: psCommand(pid) }))
    .filter((x) => isPort8787TunnelCmd(x.cmd));
}

// --- 隔離 config の読み取り --------------------------------------------------
function readIsolatedConfig() {
  try {
    return JSON.parse(fs.readFileSync(ISOLATED_CONFIG, 'utf8'));
  } catch {
    return null;
  }
}
function isolatedToken() {
  const c = readIsolatedConfig();
  return c && typeof c.token === 'string' && c.token ? c.token : null;
}

/** .xdg/ 直下の使い捨てログ（proxy.*.log / cloudflared.*.log 等）を消す。config.json は残す。 */
function cleanXdgLogs() {
  try {
    for (const f of fs.readdirSync(XDG_DIR)) {
      if (f.endsWith('.log')) fs.rmSync(path.join(XDG_DIR, f), { force: true });
    }
  } catch {
    /* .xdg 無し */
  }
}

/**
 * .xdg/ に残っている使い捨て cloudflared ログから trycloudflare URL を復帰する。
 * keep-HALT（伝播待ちで止めた run）が残した per-run ログ用。共有 tunnel.log は見ない。
 * 複数あれば mtime が新しいものを優先。無ければ null。
 */
function urlFromCloudflaredLogs() {
  let files;
  try {
    files = fs
      .readdirSync(XDG_DIR)
      .filter(isPerRunCloudflaredLog)
      .map((f) => path.join(XDG_DIR, f))
      .sort((a, b) => statSig(b).mtimeMs - statSig(a).mtimeMs);
  } catch {
    return null;
  }
  for (const p of files) {
    try {
      const u = extractTunnelUrl(fs.readFileSync(p, 'utf8'));
      if (u) return u;
    } catch {
      /* skip */
    }
  }
  return null;
}

// --- 子プロセス管理 --------------------------------------------------------
function spawnTracked(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    cwd: REPO_ROOT,
    detached: false, // グループ kill はしない
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts,
  });
  children.push({ name, child });
  // 'error'（ENOENT 等）は非同期イベント。ここで throw するとハンドラ外の未捕捉例外に
  // なるので、フラグに退避して待機ループ側（checkChildAlive / captureTunnelUrl）で拾う。
  child.on('error', (e) => {
    child._spawnError = e;
    warn(`  ${name} の起動に失敗: ${e.message}`);
  });
  return child;
}

/**
 * autoTeardown — 自動経路（Enter / Ctrl+C / エラー / 正常完了 / 24h 無活動）共通。
 * メモリ保持 PID（自分の起動分）だけを kill する。pkill は呼ばない。
 * 隔離 .xdg/ の削除は「この run が proxy を新規起動した場合のみ」。
 */
async function autoTeardown() {
  if (state.toreDown) return;
  state.toreDown = true;

  // トンネル伝播待ち HALT: 起動した子も隔離 .xdg も残す（次回 probe が再利用する）。
  if (state.keepStartedProcesses) {
    const kept = children
      .filter((c) => c.child.exitCode == null && c.child.signalCode == null)
      .map((c) => `${c.name} PID ${c.child.pid}`);
    if (kept.length) {
      warn(`  稼働継続: ${kept.join(' / ')}（伝播待ち。再実行で再利用）`);
    }
    warn(`  ${path.relative(REPO_ROOT, XDG_DIR)}/ は残置（同じトークンで再開するため）`);
    warn('  完全撤収は `npm run rehearse:teardown -- --all`');
    return;
  }

  const alive = children.filter(
    (c) => c.child.exitCode == null && c.child.signalCode == null,
  );
  for (const c of alive) {
    warn(`  ${c.name} (PID ${c.child.pid}) に SIGTERM`);
    try {
      c.child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (alive.length) {
    await sleep(2000);
    for (const c of alive) {
      if (c.child.exitCode == null && c.child.signalCode == null) {
        try {
          c.child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    }
  }

  if (state.startedProxy) {
    try {
      fs.rmSync(XDG_DIR, { recursive: true, force: true });
      warn(`  ${path.relative(REPO_ROOT, XDG_DIR)}/ を削除`);
    } catch (e) {
      warn(`  .xdg 削除に失敗: ${e.message}`);
    }
  } else if (fs.existsSync(XDG_DIR)) {
    // .xdg（config.json）は残す（再利用 proxy を壊さない）が、使い捨てログは掃除する。
    // 自分が spawn しなかった（＝proxy も cloudflared も再利用した）run では children が
    // 空なので、前 run が残した .xdg/*.log も含めて glob で消す。
    cleanXdgLogs();
    warn(`  ${path.relative(REPO_ROOT, XDG_DIR)}/ は残置（再利用 proxy を壊さないため。*.log は掃除）`);
  }

  const survivors = [];
  if (!state.startedProxy && state.reusedProxyPid) {
    survivors.push(`proxy PID ${state.reusedProxyPid}`);
  }
  if (!state.startedCloudflared && state.reusedCloudflaredPid) {
    survivors.push(`cloudflared PID ${state.reusedCloudflaredPid}`);
  }
  if (survivors.length) {
    warn(
      `稼働継続中: ${survivors.join(' / ')}。完全撤収は ` +
        '`npm run rehearse:teardown -- --all`',
    );
  }
}

let exiting = false;
async function teardownAndExit(code) {
  if (exiting) return;
  exiting = true;
  try {
    await autoTeardown();
  } catch (e) {
    warn(describeErr(e));
  }
  process.exit(code);
}

// ============================================================================
// Phase 1: ライブ probe（読み取りのみ）
// ============================================================================
async function probeOllama(flags) {
  log(`  Ollama probe: GET ${OLLAMA_URL}/api/tags`);
  let r;
  try {
    r = await httpReq('GET', `${OLLAMA_URL}/api/tags`, {}, 5000);
  } catch (e) {
    if (isConnRefused(e)) {
      if (!flags.startOllama) {
        halt(
          'Ollama (127.0.0.1:11434) に接続できません。端末0で `ollama serve` を起動するか、' +
            '--start-ollama を付けて再実行してください',
        );
      }
      log('  Ollama 未起動(ECONNREFUSED) → --start-ollama 指定により `ollama serve` を起動');
      // stderr も捨てる: 誰も読まない pipe を放置すると OS パイプバッファが埋まって
      // ollama が write でブロックし、透過リクエストごと固まる。
      const child = spawnTracked('ollama', 'ollama', ['serve'], {
        env: childEnv(),
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      state.startedOllama = true;
      await waitOllamaHealthy(child);
      return;
    }
    halt(`Ollama probe が失敗しました: ${describeErr(e)}`);
  }
  if (r.status !== 200) halt(`Ollama /api/tags が HTTP ${r.status} を返しました`);
  if (!tagsHasModel(r.json, REHEARSAL_MODEL)) {
    halt(
      `Ollama は稼働中ですが ${REHEARSAL_MODEL} がありません。` +
        `\`ollama pull ${REHEARSAL_MODEL}\` を実行してから再実行してください（自動 pull はしません）`,
    );
  }
  log('  Ollama OK（稼働中・モデルあり）');
}

async function waitOllamaHealthy(child) {
  for (let i = 1; i <= 30; i++) {
    checkChildAlive(child, 'ollama serve', 'ollama がインストールされているか確認してください');
    try {
      const r = await httpReq('GET', `${OLLAMA_URL}/api/tags`, {}, 3000);
      if (r.status === 200) {
        if (!tagsHasModel(r.json, REHEARSAL_MODEL)) {
          halt(
            `起動した Ollama に ${REHEARSAL_MODEL} がありません。` +
              `\`ollama pull ${REHEARSAL_MODEL}\` を実行してください`,
          );
        }
        log(`  ollama serve 応答 OK (${i})`);
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(1000);
  }
  halt('起動した ollama serve が 127.0.0.1:11434 で応答しません');
}

/** spawn 直後の子が ENOENT / 即クラッシュしていないか。していれば halt。 */
function checkChildAlive(child, label, hint) {
  if (!child) return;
  if (child._spawnError) {
    const e = child._spawnError;
    halt(`\`${label}\` を起動できません（${e.code || e.message}）。${hint}`);
  }
  if (child.exitCode != null || child.signalCode != null) {
    halt(`\`${label}\` が起動直後に終了しました (exit ${child.exitCode ?? child.signalCode})。${hint}`);
  }
}

async function probeProxy() {
  const pid = listenerPid(PROXY_PORT);
  if (pid == null) {
    log('  :8787 は空き → proxy を新規起動します');
    return { action: 'start' };
  }
  log(`  :8787 に LISTEN あり (PID ${pid}) → 同一性チェーンを検証`);
  const psCmd = psCommand(pid);
  const token = isolatedToken();

  let tagsStatus = null;
  let pullStatus = null;
  if (classifyProxyListener(psCmd).ok) {
    tagsStatus = await statusOrHalt('GET', `${PROXY_URL}/api/tags`, token);
    if (token && tagsStatus === 200) {
      pullStatus = await statusOrHalt('POST', `${PROXY_URL}/api/pull`, token, '{}');
    }
  }

  const decision = decideProxyReuse({
    listenerPsCommand: psCmd,
    hasToken: Boolean(token),
    tagsStatus,
    pullStatus,
  });
  if (decision.action === 'halt') {
    halt(`proxy 同一性チェーン 第${decision.step}段で不一致: ${decision.reason}`);
  }
  log(`  ${decision.reason}`);
  return { action: 'reuse', pid };
}

/**
 * :8787 トンネルの cloudflared を解決する（Phase 1 で確定させる。build を数分回す前に
 * halt/対話入力を済ませるため）。
 * - 既存なし                       → { action: 'start' }（Phase 3 で自分が起動）
 * - 既存あり・per-run ログに URL 有  → { action: 'given', url, pid }（keep-HALT からの再開）
 * - 既存あり・ログ無し・TTY          → その場で URL を対話入力
 * - 既存あり・ログ無し・非 TTY        → halt
 */
async function resolveCloudflared() {
  const existing = findPort8787Cloudflared();
  if (existing.length === 0) {
    log('  :8787 トンネルの既存 cloudflared なし → 新規起動します');
    return { action: 'start' };
  }
  const list = existing.map((x) => `PID ${x.pid} (${x.cmd})`).join(', ');
  warn(`  既存の :8787 cloudflared を検出: ${list}`);

  // keep-HALT（伝播待ちで止めた前 run）が残した使い捨てログから URL を復帰する。
  // 共有 tunnel.log は見ない（過去 URL 混入の元）。自分が書いた単一 URL のログだけ。
  const fromLog = urlFromCloudflaredLogs();
  if (fromLog) {
    log(`  前 run の cloudflared ログから URL を復帰: ${fromLog}`);
    return { action: 'given', url: fromLog, pid: existing[0].pid };
  }

  warn('  （共有 tunnel.log は見ません。URL を貼るか、落として再実行してください）');
  if (!process.stdin.isTTY) {
    halt('既存トンネルの URL を貼るか、落として再実行してください（非 TTY のため対話入力できません）');
  }
  const ans = await promptLine(
    '  既存トンネルの trycloudflare URL を貼り付け（Ctrl+C で中断）: ',
  );
  const u = extractTunnelUrl(ans);
  if (!u) halt('trycloudflare URL として解釈できませんでした');
  return { action: 'given', url: u, pid: existing[0].pid };
}

// ============================================================================
// Phase 2: susumai 用意（毎回無条件。skip マーカーは持たない）
// ============================================================================
function runBuild() {
  const steps = [
    ['npm', ['install', '--prefer-offline', '--no-audit', '--no-fund']],
    ['npm', ['run', 'typecheck']],
    ['npm', ['test']],
    ['npm', ['run', 'build']],
  ];
  for (const [cmd, args] of steps) {
    log(`  $ ${cmd} ${args.join(' ')}`);
    const r = spawnSync(cmd, args, {
      cwd: REPO_ROOT,
      env: childEnv(),
      stdio: 'inherit',
    });
    if (r.status !== 0) {
      halt(
        `\`${cmd} ${args.join(' ')}\` が失敗しました (exit ${r.status ?? r.signal}). ` +
          '上の出力を確認してください',
      );
    }
  }
}

// ============================================================================
// Phase 3: 設定と起動
// ============================================================================
/**
 * 子の stdout/stderr を「この run 専用の新規ファイル」に落として spawn する。
 * pipe にすると親 exit で読み手が消え、子が fd1/2 への write で SIGPIPE 死する（Go の既定挙動）。
 * それだと伝播待ち HALT で proxy / cloudflared を「残して次回再利用」できない。ファイルなら
 * 親が消えても書き続けられる。共有 tunnel.log は使わない（過去 URL 混入の元）。使い捨て
 * ファイル（.xdg/ 配下・撤収で掃除）なので過去の実行の出力は混ざらない。
 */
function spawnToLogFile(name, cmd, args, extraEnv = {}) {
  fs.mkdirSync(XDG_DIR, { recursive: true });
  const logPath = path.join(XDG_DIR, `${name}.${process.pid}.${Date.now()}.log`);
  const fd = fs.openSync(logPath, 'w'); // 新規作成＝空
  const child = spawnTracked(name, cmd, args, {
    env: childEnv(extraEnv),
    stdio: ['ignore', fd, fd],
  });
  fs.closeSync(fd);
  child._logPath = logPath;
  return child;
}

/**
 * child._logPath を timeoutMs までポーリング tail し、新着行を `[name]` 付きで表示しつつ
 * match(text) が truthy を返したらそれを返す。
 * 判定順は「URL 抽出（match）→ 生存確認」。子が URL 出力直後に exit してもログの URL を拾える。
 */
async function pollLog(child, name, match, timeoutMs, hint) {
  const deadline = Date.now() + timeoutMs;
  let shown = 0;
  for (;;) {
    let text = '';
    try {
      text = fs.readFileSync(child._logPath, 'utf8');
    } catch {
      /* まだ無い */
    }
    if (text.length > shown) {
      for (const line of text.slice(shown).split('\n')) {
        if (line.trim()) log(`  [${name}] ${line.trim()}`);
      }
      shown = text.length;
    }
    const hit = match(text);
    if (hit) return hit;
    // ENOENT（未インストール）/ 即クラッシュ（EADDRINUSE 等）はここで halt。
    checkChildAlive(child, name, hint);
    if (Date.now() >= deadline) {
      halt(
        `${name} が ${Math.round(timeoutMs / 1000)}s 以内に期待状態になりませんでした（${path.relative(REPO_ROOT, child._logPath)} を確認）`,
      );
    }
    await sleep(500);
  }
}

function startProxy(token) {
  return spawnToLogFile('proxy', process.execPath, [PROXY_SCRIPT], { SUSUMAI_TOKEN: token });
}

async function waitProxyHealthy(child, token) {
  // 起動ログを待つ。proxy.mjs には server.on('error') が無く EADDRINUSE / SUSUMAI_TOKEN 不正で
  // 即クラッシュするが、pollLog / checkChildAlive がログと exit を拾う（10s フル待たない）。
  await pollLog(
    child,
    'proxy',
    (t) => /listening on :8787\b/.test(t),
    10_000,
    '別プロセスが :8787 を掴んでいないか確認してください',
  );
  // 透過先（Ollama）まで通っているかを HTTP で最終確認。
  for (let i = 1; i <= 10; i++) {
    checkChildAlive(child, 'proxy', '別プロセスが :8787 を掴んでいないか確認してください');
    try {
      const r = await httpReq('GET', `${PROXY_URL}/api/tags`, bearer(token), 3000);
      if (r.status === 200) {
        log('  proxy 応答 OK');
        return;
      }
    } catch {
      /* retry */
    }
    await sleep(500);
  }
  halt('proxy は listening ですが :8787 が 200 を返しません（トークン / 上流 Ollama を確認）');
}

function startCloudflared() {
  return spawnToLogFile('cloudflared', 'cloudflared', ['tunnel', '--url', TUNNEL_TARGET]);
}

function captureTunnelUrl(child, timeoutMs = 30_000) {
  return pollLog(
    child,
    'cloudflared',
    (t) => extractTunnelUrl(t),
    timeoutMs,
    'cloudflared がインストールされているか確認してください',
  );
}

function promptLine(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve((ans || '').trim());
    });
  });
}

/**
 * トンネル越し GET /api/tags が 200＋期待形状になるまで待つ。
 * cloudflared quick tunnel はエッジに伝播するまで初回リクエストが通らない。
 * 2026-09-04 の実機テストで、30s 窓では初回 200 に届かず Phase 3b が2連続 HALT した。
 * 上限は既定 180s（env REHEARSE_TUNNEL_WAIT_MS で上書き可）。間隔は tunnelPollDelayMs のバックオフ。
 * sleep は最大 5s なので SIGINT はその範囲で効く（3分ブロックにはならない）。
 */
async function verifyTunnel(url, token) {
  const budgetMs = Number.parseInt(process.env.REHEARSE_TUNNEL_WAIT_MS ?? '', 10) || 180_000;
  const budgetS = Math.round(budgetMs / 1000);
  const start = Date.now();
  let attempt = 0;

  for (;;) {
    attempt++;
    let errCode = null;
    let status = null;
    let bodyPrefix = null;
    let shaped = false;
    try {
      const r = await httpReq('GET', `${url}/api/tags`, bearer(token), 5000);
      status = r.status;
      bodyPrefix = (r.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      shaped =
        status === 200 &&
        r.json &&
        Array.isArray(r.json.models) &&
        tagsHasModel(r.json, REHEARSAL_MODEL);
    } catch (e) {
      errCode = e?.cause?.code || e?.code || e?.name || 'ERR';
    }

    const elapsed = Date.now() - start;
    const elapsedS = Math.round(elapsed / 1000);

    if (shaped) {
      log(`  トンネル検証 OK (${elapsedS}s / ${attempt} 回目)`);
      return;
    }

    const desc = describeTunnelProbe({ errCode, status, bodyPrefix });

    // 401 は待っても直らない（トークン不一致）。即打ち切り。
    if (status !== null && isTunnelFatalStatus(status)) {
      log(`  トンネル検証 ${elapsedS}s (${desc})`);
      haltTunnelUnpropagated(url, token, `トンネル検証で ${desc}（待っても直りません）`);
    }

    if (elapsed >= budgetMs) {
      haltTunnelUnpropagated(
        url,
        token,
        `トンネル越し GET /api/tags が上限 ${budgetS}s 以内に 200＋期待形状になりませんでした（最後: ${desc}）`,
      );
    }

    log(`  トンネル検証待ち ${elapsedS}s / 上限 ${budgetS}s (${desc})`);
    await sleep(tunnelPollDelayMs(elapsed));
  }
}

/**
 * トンネル検証だけの特別 HALT: proxy↔Ollama はローカルで OK・エッジ伝播待ちの可能性が高いので、
 * 起動した proxy / cloudflared と隔離 .xdg を残したまま止める（次回 `npm run rehearse` が
 * probe で生きている proxy を再利用 → 同じトークンで続行できる）。
 */
function haltTunnelUnpropagated(url, token, reason) {
  state.keepStartedProcesses = true;
  warn('');
  warn(`  採取した URL: ${url}`);
  warn('  伝播したかの確認（200 が返れば OK）:');
  warn(`    curl -sS -H "Authorization: Bearer ${token}" ${url}/api/tags`);
  warn('  200 になってから `npm run rehearse` を再実行してください。');
  warn('  （proxy / cloudflared は稼働継続。probe が生きている proxy を再利用し同じトークンで続行します）');
  throw new Halt(reason, 2);
}

// ============================================================================
// Phase 4: 自動検証
// ============================================================================
async function autoVerify() {
  // 1) ワンショット
  {
    const r = runSusumai(['1 足す 1 は？'], { timeout: 600_000 });
    if (r.status !== 0 || !(r.stdout || '').trim()) {
      fail(
        `ワンショットが失敗しました (exit ${r.status ?? r.signal})\n` +
          `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      );
    }
    log('  ワンショット OK（exit 0・出力非空）');
  }

  // 2) パイプ
  {
    const r = runSusumai([], {
      input: '次の文を10字以内で要約して: 猫はソファの上で丸くなって眠っている。',
      timeout: 600_000,
    });
    if (r.status !== 0 || !(r.stdout || '').trim()) {
      fail(
        `パイプ入力が失敗しました (exit ${r.status ?? r.signal})\n` +
          `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      );
    }
    log('  パイプ OK（exit 0・出力非空）');
  }

  // 3) 死んだトンネル（ブラックホール）
  await verifyDeadTunnelFailsFast(isolatedToken());

  state.autoVerifyPassed = true;
  log('自動検証すべて通過');
}

/**
 * 「TCP は張れるがヘッダを一切返さない」ローカルサーバを立て、それを url にした CLI が
 * DEAD_TUNNEL_MAX_MS 未満で失敗することを確認する（SPIKE_RESULTS.md §8 の危険形の再現）。
 * 本番の隔離 config には一切触らない: 使い捨ての XDG ディレクトリに blackhole url ＋ 同じ
 * トークンの config を書いて、そこを XDG_CONFIG_HOME にして CLI を叩く。
 * サーバも使い捨て XDG も try/finally で必ず片付ける。
 */
async function verifyDeadTunnelFailsFast(token) {
  const server = http.createServer(() => {
    /* 応答しない: ソケットは張るがヘッダを返さない */
  });
  // keep-alive ソケットで close が待たされないよう、接続は即無効化する。
  server.on('connection', (s) => s.on('error', () => {}));
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const { port } = server.address();

  const probeXdg = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-deadtunnel-'));
  try {
    fs.mkdirSync(path.join(probeXdg, 'susumai'), { recursive: true });
    // url と token だけ書く。model/numCtx/stream の既定値は src/config.ts の DEFAULT_CONFIG が
    // 正典なので再エンコードしない（loadConfig() が既定で埋める。CLI は checkHealth で先に落ちる）。
    fs.writeFileSync(
      path.join(probeXdg, 'susumai', 'config.json'),
      JSON.stringify({ url: `http://127.0.0.1:${port}`, ...(token ? { token } : {}) }, null, 2) +
        '\n',
      { mode: 0o600 },
    );

    const t0 = Date.now();
    const r = spawnSync(process.execPath, [DIST_INDEX, 'ブラックホール到達性テスト'], {
      cwd: REPO_ROOT,
      env: { ...process.env, XDG_CONFIG_HOME: probeXdg },
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: DEAD_TUNNEL_MAX_MS + 60_000,
      killSignal: 'SIGKILL',
    });
    const elapsed = Date.now() - t0;
    const judged = judgeDeadTunnel({
      exitCode: r.status,
      elapsedMs: elapsed,
      thresholdMs: DEAD_TUNNEL_MAX_MS,
    });
    if (!judged.pass) fail(`死んだトンネル（ブラックホール）検証 NG: ${judged.reason}`);
    log(`  死んだトンネル OK: ${judged.reason}`);
  } finally {
    server.close();
    server.closeAllConnections?.();
    fs.rmSync(probeXdg, { recursive: true, force: true });
  }
}

// ============================================================================
// Phase 5: 手動確認（TTY のみ。ここでのみ 24h 無活動オートティアダウンが有効）
// ============================================================================
function statSig(f) {
  try {
    const s = fs.statSync(f);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { mtimeMs: 0, size: -1 };
  }
}

async function manualPhase({ tunnelUrl, token }) {
  log('');
  log('REPL を1回叩いて、thinking の淡色・本文の色分け・逐次表示を目視確認してください:');
  log(`  XDG_CONFIG_HOME=${XDG_DIR} \\`);
  log(`  ${process.execPath} ${DIST_INDEX}`);
  log('');
  log('別 PC 用（1行・トークンはフル値。RUNBOOK §2/§8 の運搬手順に従うこと）:');
  log(`  URL=${tunnelUrl} TOKEN=${token}`);
  log('');

  if (!process.stdin.isTTY) {
    warn('非 TTY のため手動確認はスキップされます。撤収へ進みます。');
    return;
  }

  log('目視確認が終わったら Enter を押してください（Ctrl+C でも撤収します）。');
  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    let lastActivity = Date.now();
    let logSig = statSig(PROXY_LOG);
    const poll = setInterval(() => {
      const cur = statSig(PROXY_LOG);
      if (cur.mtimeMs !== logSig.mtimeMs || cur.size !== logSig.size) {
        logSig = cur;
        lastActivity = Date.now();
      }
      if (Date.now() - lastActivity >= INACTIVITY_MS) {
        warn('');
        warn('24時間 無活動のため自動撤収しました');
        clearInterval(poll);
        rl.close();
        resolve();
      }
    }, 60_000);
    rl.on('line', () => {
      lastActivity = Date.now();
      clearInterval(poll);
      rl.close();
      resolve();
    });
  });
}

// ============================================================================
// teardown サブコマンド（明示撤収。RUNBOOK §9 と同じ pkill を既定にする）
// ============================================================================
async function teardownCommand(flags) {
  log('明示撤収 (teardown' + (flags.all ? ' --all' : '') + ')');

  const r = spawnSync('pkill', ['-f', 'rehearsal/proxy.mjs'], { encoding: 'utf8' });
  if (r.error) {
    log(`  pkill を実行できませんでした: ${r.error.message}`);
  } else if (r.status === 0) {
    log('  proxy (rehearsal/proxy.mjs) を停止しました');
  } else {
    log('  停止対象の proxy プロセスはありませんでした');
  }

  if (flags.all) {
    const tuns = findPort8787Cloudflared();
    if (tuns.length === 0) {
      log('  :8787 の cloudflared トンネルはありませんでした');
    }
    for (const { pid, cmd } of tuns) {
      try {
        process.kill(pid, 'SIGTERM');
        log(`  cloudflared PID ${pid} に SIGTERM (${cmd})`);
      } catch (e) {
        log(`  cloudflared PID ${pid} の停止に失敗: ${e.message}`);
      }
    }
  }

  try {
    if (fs.existsSync(XDG_DIR)) {
      fs.rmSync(XDG_DIR, { recursive: true, force: true });
      log(`  ${path.relative(REPO_ROOT, XDG_DIR)}/ を削除しました`);
    } else {
      log(`  ${path.relative(REPO_ROOT, XDG_DIR)}/ は存在しません`);
    }
  } catch (e) {
    log(`  .xdg 削除に失敗: ${e.message}`);
  }

  log('撤収完了。Ollama は対象外です（必要なら手動で停止してください）。');
}

// ============================================================================
// エントリポイント
// ============================================================================
const USAGE = `rehearse.mjs — RUNBOOK.md の当日検証手順を自動化する（フォアグラウンド常駐）

使い方:
  node rehearsal/rehearse.mjs [--start-ollama]   フル実行
      probe(読取のみ) → build → 設定(隔離) → 自動検証 → 手動待ち → 撤収
  node rehearsal/rehearse.mjs teardown [--all]   明示撤収
  node rehearsal/rehearse.mjs --help

フラグ:
  --start-ollama  Ollama が未起動(ECONNREFUSED)のときだけ \`ollama serve\` を起動する
                  （probe が 200 を返す＝Ollama.app 稼働中なら何もしない）
  teardown        pkill -f "rehearsal/proxy.mjs" ＋ rehearsal/.xdg/ を削除
  teardown --all  加えて :8787 の cloudflared トンネルも停止（Ollama は対象外）

背景・仕様は rehearsal/RUNBOOK.md ／ rehearsal/proxy.mjs ／ rehearsal/SPIKE_RESULTS.md。
`;

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        'start-ollama': { type: 'boolean' },
        all: { type: 'boolean' },
        help: { type: 'boolean' },
        h: { type: 'boolean' },
      },
    });
  } catch (e) {
    warn(describeErr(e) + '\n\n' + USAGE);
    process.exit(2);
  }

  const flags = {
    startOllama: Boolean(parsed.values['start-ollama']),
    all: Boolean(parsed.values.all),
  };
  const sub = parsed.positionals[0];

  if (parsed.values.help || parsed.values.h) {
    process.stdout.write(USAGE);
    return;
  }

  if (sub === 'teardown') {
    await teardownCommand(flags);
    return;
  }
  if (sub) {
    warn(`未知のサブコマンド「${sub}」\n\n` + USAGE);
    process.exit(2);
  }

  // --- フル実行 ---
  process.on('SIGINT', () => {
    warn('\n中断信号 (SIGINT) を受信。撤収します。');
    teardownAndExit(state.autoVerifyPassed ? 0 : 130);
  });
  process.on('SIGTERM', () => {
    warn('\n中断信号 (SIGTERM) を受信。撤収します。');
    teardownAndExit(state.autoVerifyPassed ? 0 : 143);
  });
  process.on('exit', () => {
    // 最後の砦（同期・ベストエフォート）。追跡 PID にだけ SIGTERM。
    // 伝播待ち HALT のときは残す（次回再利用のため）。
    if (state.keepStartedProcesses) return;
    for (const { child } of children) {
      if (child.exitCode == null && child.signalCode == null) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* ignore */
        }
      }
    }
  });

  try {
    log(`susumai リハーサル自動化`);
    log(`  repo:          ${REPO_ROOT}`);
    log(`  隔離 config:   XDG_CONFIG_HOME=${XDG_DIR}`);

    log('\n=== Phase 1: ライブ probe（読み取りのみ）===');
    await probeOllama(flags);
    const proxyPlan = await probeProxy();
    const cfPlan = await resolveCloudflared();

    log('\n=== Phase 2: susumai 用意（install / typecheck / test / build を無条件）===');
    runBuild();

    log('\n=== Phase 3: 設定（隔離）と起動 ===');
    fs.mkdirSync(XDG_DIR, { recursive: true });

    let token;
    if (proxyPlan.action === 'start') {
      // 新規トークン生成は proxy を新起動するときだけ。
      token = crypto.randomBytes(32).toString('hex');
      const set = runSusumai(['config', 'set', '--token', token]);
      if (set.status !== 0) halt(`config set --token に失敗しました\n${set.stderr}`);
      state.startedProxy = true;
      const proxyChild = startProxy(token);
      await waitProxyHealthy(proxyChild, token);
      log('  proxy を新規起動しました（新規トークン生成・隔離 config へ保存）');
    } else {
      // 再利用パス: 隔離 config の既存トークンを読むだけ（生成しない）。
      token = isolatedToken();
      if (!token) halt('再利用する proxy のトークンを隔離 config から読めませんでした');
      state.reusedProxyPid = proxyPlan.pid;
      log(`  既存 proxy を再利用します (PID ${proxyPlan.pid})`);
    }

    let tunnelUrl;
    if (cfPlan.action === 'start') {
      state.startedCloudflared = true;
      tunnelUrl = await captureTunnelUrl(startCloudflared());
      log(`  cloudflared 起動、URL 採取: ${tunnelUrl}`);
    } else {
      // resolveCloudflared() が Phase 1 で対話入力済み。
      tunnelUrl = cfPlan.url;
      state.reusedCloudflaredPid = cfPlan.pid;
      log(`  既存トンネルを使用: ${tunnelUrl}`);
    }

    const setUrl = runSusumai(['config', 'set', '--url', tunnelUrl]);
    if (setUrl.status !== 0) halt(`config set --url に失敗しました\n${setUrl.stderr}`);

    log('\n=== Phase 3b: トンネル検証（エッジ伝播待ち・上限 180s）===');
    await verifyTunnel(tunnelUrl, token);

    log('\n=== Phase 4: 自動検証（ワンショット / パイプ / 死んだトンネル）===');
    await autoVerify();

    log('\n=== Phase 5: 手動確認 ===');
    await manualPhase({ tunnelUrl, token });

    log('\n=== Phase 6: 撤収 ===');
    await autoTeardown();
    process.exit(0);
  } catch (e) {
    if (e instanceof Halt) {
      warn(`\n${e.code === 1 ? '[FAIL] 自動検証に失敗' : '[HALT] 手順を止めます'}: ${e.message}`);
    } else {
      warn('\n[ERROR] ' + (e?.stack || describeErr(e)));
    }
    await autoTeardown();
    process.exit(e instanceof Halt ? e.code : 1);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    warn('[ERROR] ' + (e?.stack || describeErr(e)));
    process.exit(1);
  });
}
