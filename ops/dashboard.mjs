#!/usr/bin/env node
/*
 * ops/dashboard.mjs — susumai 運用状況を可視化し、本番再起動シーケンス
 * （down → rehearse → up）をボタン操作で実行するローカル専用 Web ダッシュボード。
 * ----------------------------------------------------------------------------
 * Planning_Team（Architect⇄Critic、3往復）＋後藤さんの最終決定を反映。
 *
 * 使い方: npm run dashboard （毎回手動起動。常駐化しない）
 *
 * ゼロ依存（node 組み込みモジュールのみ）。新規 npm パッケージは追加しない。
 *
 * セキュリティモデル（2層。いずれも本ツールが「対話端末から後藤さん本人が手動起動する
 * ローカル専用ツール」であることを前提にした多層防御であり、単体では完全ではない）:
 *   層1: viewToken（起動時に生成する32byteランダム値。URLの ?t= に埋め込む）
 *        + Origin/Hostヘッダ検証
 *        ただし GET /api/critical-banner と POST /api/ack-critical は意図的に
 *        Origin/Host検証を適用しない（viewTokenのみ）。両者とも過去の実行結果の
 *        確認・既読化に留まり、本番機材（proxy等）に対する新規操作を一切引き起こ
 *        さないため、withAuth 呼び出し側で originHost を渡していない
 *        （詳細は各ルーティング箇所のコメント参照）。
 *   層2: ブラウザプロセス確認（同一マシン上の他プロセスからの fetch/curl を弾く）
 *
 * 2026-09-14 後藤さんの明示的な決定: 確認文字列のタイプ入力による誤爆防止層は完全に
 * 廃止した（同日、実際に本番を誤操作する事故が2回発生したことを承知の上での判断。
 * 「入力作業を極力無くし、ボタン一つで完結させたい」という明示的な要望による）。
 * これに伴い、確認文字列と一体だった prepare/run の2段階・execTokenの発行/単回使用
 * 機構も不要と判断し廃止した。POST /api/execute/run 一発でシーケンスを開始する。
 * viewToken・Origin/Hostヘッダ検証・層2（ブラウザプロセス確認）は、いずれもユーザーの
 * 手入力を伴わない構造的な仕組みであり「安全装置の削除」の対象ではないため維持する。
 * ----------------------------------------------------------------------------
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

// --- パス（すべて絶対）----------------------------------------------------------
const REPO_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// HOSTING_SH: 本番相当の既定値は `ops/hosting.sh`（変更なし）。
// SUSUMAI_DASHBOARD_HOSTING_SH が設定されている場合のみ、それを絶対パスとして使う。
// **この環境変数は Playwright などのテストハーネスが、リポジトリ外に用意した
// モックスクリプトを指すためだけに使うこと。** 未設定時の挙動は従来と1バイトも
// 変えない（本番運用ではこの変数を設定しないこと）。
const HOSTING_SH = process.env.SUSUMAI_DASHBOARD_HOSTING_SH || path.join(REPO_ROOT, 'ops', 'hosting.sh');

// AUDIT_LOG_PATH / LAST_CRITICAL_PATH も同様にテストハーネス専用の上書きを許す。
// 既定値（本番相当）は従来通り ops/ 配下の固定パス。これが無いと、テストで起動する
// dashboard.mjs が、後藤さんが対話端末で稼働させている可能性のある本物の
// dashboard.mjs プロセスと同じ監査ログ/CRITICALバナー状態ファイルを共有してしまい、
// 書き込みの競合や本物のCRITICAL状態の意図しない上書き・削除につながるため。
const AUDIT_LOG_PATH = process.env.SUSUMAI_DASHBOARD_AUDIT_LOG || path.join(REPO_ROOT, 'ops', 'dashboard-audit.log');
const LAST_CRITICAL_PATH =
  process.env.SUSUMAI_DASHBOARD_LAST_CRITICAL || path.join(REPO_ROOT, 'ops', 'dashboard-last-critical.json');

// REHEARSE_CMD: 本番相当の既定値は `npm run rehearse`（変更なし）。
// SUSUMAI_DASHBOARD_REHEARSE_CMD が設定されている場合のみ、空白区切りで
// コマンド+引数として解釈し直す（例: "node /path/to/mock-rehearse.mjs"）。
// **この環境変数もテストハーネス専用。** 未設定時の挙動は従来と1バイトも変えない。
const REHEARSE_CMD = (() => {
  const override = process.env.SUSUMAI_DASHBOARD_REHEARSE_CMD;
  if (!override) return { cmd: 'npm', args: ['run', 'rehearse'] };
  const parts = override.trim().split(/\s+/).filter((s) => s.length > 0);
  return { cmd: parts[0], args: parts.slice(1) };
})();

const PORT = Number.parseInt(process.env.SUSUMAI_DASHBOARD_PORT ?? '', 10) || 4787;

// ============================================================================
// 0. TTYゲート（起動シーケンス手順1）
// ----------------------------------------------------------------------------
// これはセキュリティ境界ではない。`script -q /dev/null node ops/dashboard.mjs`
// のような意図的な PTY 偽装で自明に迂回される。あくまで cron 等の素朴な非対話実行が
// 気づかずこのツールを起動してしまう事故への、弱い UX フリクションに過ぎない。
// ============================================================================
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  process.stderr.write(
    'susumai dashboard: 対話端末（TTY）からの手動起動のみを想定しています。終了します。\n' +
      '（これはセキュリティ境界ではありません。script -q 等の意図的な PTY 偽装で迂回できます。\n' +
      ' cron 等の非対話実行が誤ってこれを起動する事故を防ぐための軽い摩擦です）\n',
  );
  process.exit(1);
}

// ============================================================================
// 1. viewToken 生成・URL 表示（起動シーケンス手順2）
// ============================================================================
const viewToken = crypto.randomBytes(32).toString('hex');

// ============================================================================
// 状態（プロセス内メモリのみ。永続化するのは監査ログと critical バナーだけ）
// ============================================================================
let currentStep = null; // null=アイドル / 'down' | 'rehearse' | 'up' 実行中はロックも兼ねる
let shutdownRequested = false;
let lastCriticalCache = null; // dashboard-last-critical.json の内容のミラー（無ければ null）
const sseClients = new Set();

// ============================================================================
// 監査ログ（JSON Lines・追記専用・ローテーションなし）
// ============================================================================
function appendAudit(event, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...fields });
  try {
    fs.appendFileSync(AUDIT_LOG_PATH, line + '\n');
  } catch (err) {
    // 監査ログ書き込み失敗は握り潰さず標準エラーに出す（が、リクエスト処理は止めない）。
    process.stderr.write(`[dashboard] 監査ログ書き込みに失敗: ${String(err?.message ?? err)}\n`);
  }
}

// ============================================================================
// CRITICALバナー（ops/dashboard-last-critical.json とメモリキャッシュを同期させる）
// ============================================================================
function loadLastCritical() {
  try {
    const text = fs.readFileSync(LAST_CRITICAL_PATH, 'utf8');
    lastCriticalCache = JSON.parse(text);
  } catch {
    lastCriticalCache = null;
  }
}

function writeLastCritical(data) {
  lastCriticalCache = data;
  fs.writeFileSync(LAST_CRITICAL_PATH, JSON.stringify(data, null, 2) + '\n');
}

function clearLastCritical() {
  lastCriticalCache = null;
  try {
    fs.unlinkSync(LAST_CRITICAL_PATH);
  } catch {
    // 既に無ければ何もしない。
  }
}

// ============================================================================
// SSE（Server-Sent Events）配信
// ============================================================================
function formatSSE(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcastSSE(event, data) {
  const payload = formatSSE(event, data);
  for (const client of sseClients) {
    client.write(payload);
  }
}

// ============================================================================
// トークン比較（timing-safe）
// ============================================================================
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) {
    // 長さが違うと timingSafeEqual は例外を投げるため、ダミー比較で時間差を均してから false。
    crypto.timingSafeEqual(bufB, bufB);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ============================================================================
// Origin / Host 検証
// ----------------------------------------------------------------------------
// ブラウザは同一オリジンの GET（EventSource 含む）では Origin ヘッダを付けない
// ことが多いため、Origin が無い場合は Host ヘッダへフォールバックする（両方とも
// 127.0.0.1:<PORT> 固定である必要がある。このサーバは 127.0.0.1 にしか listen
// しないため、他ホスト名で届くことは本来ない）。
// ============================================================================
function validateOriginHost(req) {
  const expected = `127.0.0.1:${PORT}`;
  const origin = req.headers['origin'];
  if (origin !== undefined) {
    if (origin === `http://${expected}`) return { ok: true };
    return { ok: false, reason: 'bad-origin' };
  }
  const host = req.headers['host'];
  if (host === expected) return { ok: true };
  return { ok: false, reason: 'bad-host' };
}

// ============================================================================
// 層2: ブラウザプロセス確認
// ----------------------------------------------------------------------------
// リクエストのローカル接続元（req.socket.remotePort、サーバ視点では「相手のポート」＝
// クライアント側の実際のローカルポート番号）を特定し、`lsof -nP -iTCP:<port>` で
// そのポートを保持している実プロセスの PID を求め、`ps -o comm= -p <pid>` で
// プロセス名を得て許可リストと突き合わせる。
//
// **この確認は必ず、レスポンス送信前の同期区間（execFileSync）で行う。**
// 非同期化してレスポンス後に検証する設計は取らない（層2をレスポンス後に確認しても
// 実行の可否判定には反映できず、意味をなさないため）。
//
// 同期呼び出しによるイベントループのブロックは許容されたトレードオフである
// （低頻度・単一ユーザー・手動起動前提のダッシュボードであり、実害はないと判断）。
//
// 許可リストはプレースホルダとして仮の値を置いている。実装後、実機で各ブラウザから
// 実際にこのダッシュボードへ fetch を送り、その瞬間に `lsof -i :<port> -n -P` を
// 実行してソケットを保持する実プロセスの comm 名を観測し、その観測結果だけで
// 構築し直すこと。メインアプリのバイナリ名（`Google Chrome` や `Safari`）ではなく、
// ネットワークを実際に処理する子プロセス（Chrome なら `Google Chrome Helper` 系、
// Safari/WebKit なら `com.apple.WebKit.Networking`）が対象。Firefox は未検証のため、
// 確認するまで許可リストに含めないこと。
// lsof/ps の出力が空・パース不能・許可リスト外の場合はすべて fail-closed（403）とする。
// ============================================================================
const BROWSER_PROCESS_ALLOWLIST = [
  // --- プレースホルダ。実機観測結果で置き換えること（上記コメント参照） ---
  'Google Chrome Helper',
  'Google Chrome Helper (Renderer)',
  'Google Chrome Helper (GPU)',
  'com.apple.WebKit.Networking',
  // SUSUMAI_DASHBOARD_EXTRA_BROWSER_PROCESSES（カンマ区切り）で一時的に追加できる。
  //
  // **この環境変数は Playwright 等のテストハーネス以外では絶対に設定しないこと。**
  // 本番運用時にこれが設定されていると、意図しない自動化ツール（本物のブラウザでは
  // ない何か）からのアクセスを層2の確認なしに通してしまう。既定は空文字列であり、
  // 何も追加されない。
  //
  // 値は実機で `lsof -nP -iTCP:<port>` → `ps -o comm= -p <pid>` を実行し、実際に
  // ソケットを保持したプロセスの comm 名（basename）を観測した上で設定すること。
  // Playwright バンドル版ブラウザで実機確認済みの値（2026-09-14 時点、macOS arm64）:
  //   - Chromium（headless、既定の `chromium.launch()` / @playwright/test 既定モード）:
  //     'chrome-headless-shell'
  //   - Chromium（headed、`--headed` / `headless:false`）:
  //     'Google Chrome for Testing Helper'
  //   - WebKit（headless/headed とも）: 'com.apple.WebKit.Networking.Development'
  //     （本番Safariの 'com.apple.WebKit.Networking' とは別プロセス名なので要注意）
  ...(process.env.SUSUMAI_DASHBOARD_EXTRA_BROWSER_PROCESSES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0),
];

function checkBrowserProcessSync(req) {
  const remotePort = req.socket?.remotePort;
  if (!remotePort) return false;

  let lsofOut;
  try {
    lsofOut = execFileSync('lsof', ['-nP', `-iTCP:${remotePort}`], {
      encoding: 'utf8',
      timeout: 2000,
    });
  } catch {
    return false; // fail-closed
  }

  const lines = lsofOut.split('\n').slice(1).filter((l) => l.trim().length > 0);
  let matchedPid = null;
  for (const line of lines) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 9) continue;
    const pid = cols[1];
    // NAME列（アドレス）の直後にSTATE列（例: (ESTABLISHED) / (LISTEN)）が付く場合と
    // 付かない場合の両方がある（例: "127.0.0.1:54321->127.0.0.1:4787 (ESTABLISHED)" /
    // "127.0.0.1:54321->127.0.0.1:4787"）。最終列が "(" で始まればSTATE列なので、
    // その手前（最後から2番目）をアドレス列として採用する。
    let addrCol = cols[cols.length - 1];
    if (addrCol.startsWith('(')) {
      addrCol = cols[cols.length - 2];
    }
    if (!addrCol) continue;
    const localPart = addrCol.split('->')[0];
    if (!localPart) continue;
    const localPort = localPart.split(':').pop();
    if (localPort === String(remotePort)) {
      matchedPid = pid;
      break;
    }
  }
  if (!matchedPid) return false; // fail-closed（該当ソケットが見つからない）

  let comm;
  try {
    comm = execFileSync('ps', ['-o', 'comm=', '-p', matchedPid], {
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
  } catch {
    return false; // fail-closed
  }
  if (!comm) return false;

  const base = path.basename(comm);
  return BROWSER_PROCESS_ALLOWLIST.includes(base);
}

// ============================================================================
// outcome算定
// ============================================================================
function computeOutcome(downOk, rehearseOk, upOk) {
  if (downOk && upOk) {
    if (rehearseOk) return { outcome: 'full-success', severity: 'INFO' };
    return { outcome: 'rehearse-failed-recovered', severity: 'NOTICE' };
  }
  if (!downOk && !upOk) {
    return { outcome: 'CRITICAL_DOUBLE_FAILURE', severity: 'CRITICAL' };
  }
  // down/up のどちらか一方だけが失敗。
  return { outcome: 'up-attempt-did-not-recover', severity: 'WARNING' };
}

// ============================================================================
// 実行シーケンスの1ステップ（down / rehearse / up 共通）
// ----------------------------------------------------------------------------
// 最重要（後藤さんの決定）: stdio は必ず ['ignore', 'pipe', 'pipe'] とし、
// pty は絶対に使用しない。npm run rehearse（rehearsal/rehearse.mjs）は
// stdin が非TTYであることを検出して Phase 5（手動確認、最大24時間の無活動監視待ち）を
// 自動スキップする設計になっている。pty を割り当てるとこの非TTY前提が崩れ、
// Phase 5 が最大24時間ブロックしうる（本番proxyが down 済み・up 未実行のまま
// 気づかれず固まる、というこのツールの目的を裏切る重大な故障モード）。
// ============================================================================
function runStep(step, cmd, args) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: REPO_ROOT,
        detached: true, // 独立プロセスグループに置く。Ctrl+C が直接子に届かないようにするため。
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const errMsg = String(err?.message ?? err);
      appendAudit('step_result', { step, ok: false, exitCode: null, signal: null, durationMs, error: errMsg });
      resolve({ ok: false, exitCode: null, signal: null, error: errMsg });
      return;
    }

    let spawnError = null;
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split('\n')) {
        if (line.length === 0) continue;
        broadcastSSE('log', { step, line });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => {
      spawnError = err;
    });
    child.on('close', (code, signal) => {
      const ok = !spawnError && code === 0;
      const durationMs = Date.now() - startedAt;
      appendAudit('step_result', {
        step,
        ok,
        exitCode: code,
        signal,
        durationMs,
        ...(spawnError ? { error: String(spawnError.message ?? spawnError) } : {}),
      });
      resolve({ ok, exitCode: code, signal });
    });
  });
}

// ============================================================================
// 実行シーケンス本体（down → rehearse → up 固定。呼び出し元が currentStep='down' を
// 予約済みの状態で呼ばれる）
// ============================================================================
async function runSequence() {
  const seqStart = Date.now();
  appendAudit('sequence_start', {});

  // 後藤さんの決定: 新しいシーケンスの実行を開始した時点で、既存の未ack CRITICALバナーを
  // 自動的にack済みにする（「復旧を妨げない」）。確認モーダル側で警告は既に見せた後なので
  // ここで黙って消してよい。
  if (lastCriticalCache) {
    clearLastCritical();
    appendAudit('critical_ack', { reason: 'superseded-by-new-execution' });
    broadcastSSE('critical-cleared', {});
  }

  broadcastSSE('step', { step: currentStep }); // 'down'（呼び出し元が既に予約済み）

  const downResult = await runStep('down', HOSTING_SH, ['down', '--target', 'proxy']);

  // down/rehearse の結果に関わらず必ずここまで進む。
  currentStep = 'rehearse';
  broadcastSSE('step', { step: currentStep });
  const rehearseResult = await runStep('rehearse', REHEARSE_CMD.cmd, REHEARSE_CMD.args);

  currentStep = 'up';
  broadcastSSE('step', { step: currentStep });
  const upResult = await runStep('up', HOSTING_SH, ['up', '--target', 'proxy']);

  currentStep = null;
  broadcastSSE('step', { step: null });

  const { outcome, severity } = computeOutcome(downResult.ok, rehearseResult.ok, upResult.ok);
  const durationMs = Date.now() - seqStart;
  appendAudit('sequence_end', { outcome, severity, durationMs });
  broadcastSSE('sequence-end', { outcome, severity, durationMs });

  if (severity === 'CRITICAL' || severity === 'WARNING') {
    writeLastCritical({
      ts: new Date().toISOString(),
      outcome,
      severity,
      results: { down: downResult, rehearse: rehearseResult, up: upResult },
    });
    broadcastSSE('critical-banner', lastCriticalCache);
  }

  if (shutdownRequested) {
    gracefulShutdown();
  }
}

// ============================================================================
// HTTP ユーティリティ
// ============================================================================
function respondJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// rejectAuth: 監査ログには「どのエンドポイントへのアクセスが拒否されたか」を必ず
// endpoint フィールドで残す。event 名を一律 'execute_rejected' にすると、例えば
// 単なる GET /api/status のポーリングが古いトークンで弾かれただけの場合でも
// 「本番再起動の実行が拒否された」ように読めてしまい、事故調査時の誤解釈を招くため
// （QAレビュー指摘）、event 名はエンドポイントに依存しない 'auth_rejected' に統一し、
// 実際に拒否が発生したエンドポイントは endpoint フィールドで明示する。
function rejectAuth(res, reason, endpoint) {
  appendAudit('auth_rejected', { endpoint, reason });
  respondJSON(res, 403, { error: 'forbidden', reason });
}

// withAuth: viewToken（必須）+ 任意で Origin/Host・ブラウザプロセス確認を行い、
// 通過した場合のみ next() を呼ぶ。失敗時は監査ログ記録込みで自前応答する。
// endpoint（url.pathname）は呼び出し元ごとに変えず、この関数内で url から一意に
// 取り出して rejectAuth に渡す（呼び出し側での指定漏れ・書き間違いを防ぐため）。
function withAuth(req, res, url, opts, next) {
  const endpoint = url.pathname;
  const token = url.searchParams.get('t');
  if (!safeEqual(token, viewToken)) {
    return rejectAuth(res, 'bad-token', endpoint);
  }
  if (opts.originHost) {
    const check = validateOriginHost(req);
    if (!check.ok) return rejectAuth(res, check.reason, endpoint);
  }
  if (opts.browserCheck) {
    if (!checkBrowserProcessSync(req)) return rejectAuth(res, 'non-browser-caller', endpoint);
  }
  return next();
}

// ============================================================================
// 各エンドポイントのハンドラ
// ============================================================================
function handleStatus(res) {
  execFile(HOSTING_SH, ['status', '--target', 'all', '--json'], { cwd: REPO_ROOT, timeout: 10_000 }, (err, stdout, stderr) => {
    if (err) {
      respondJSON(res, 500, { error: 'hosting.sh status failed', detail: String(err.message ?? err), stderr: String(stderr ?? '') });
      return;
    }
    // ops/hosting.sh status --target all --json の出力をそのまま返す（加工しない）。
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(stdout);
  });
}

function handleCriticalBanner(res) {
  respondJSON(res, 200, lastCriticalCache ?? null);
}

function handleSSE(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':connected\n\n');
  sseClients.add(res);
  // 接続直後に現在の実行ステップと未ack CRITICALバナーを同期する（途中参加のブラウザ対策）。
  res.write(formatSSE('step', { step: currentStep }));
  if (lastCriticalCache) {
    res.write(formatSSE('critical-banner', lastCriticalCache));
  }
  req.on('close', () => {
    sseClients.delete(res);
  });
}

// handleExecuteRun: 確認文字列のタイプ入力は要求しない（後藤さんの決定により廃止済み）。
// リクエストボディも取らない。currentStep のロック確認のみを行い、通過したら
// 即座にシーケンスを開始する（ボタン一つで完結させるための単一エンドポイント）。
function handleExecuteRun(res) {
  if (currentStep !== null) {
    appendAudit('execute_rejected', { reason: 'already-running' });
    respondJSON(res, 409, { error: 'already running' });
    return;
  }

  // ここまでで全チェック通過。次の await より前に同期的にロックを予約する
  // （このブロック内に await が無いため、他リクエストの割り込みは発生しない）。
  currentStep = 'down';
  respondJSON(res, 202, { ok: true, status: 'started' });

  runSequence().catch((err) => {
    // runSequence 内の各ステップは例外を自前で処理する設計なので、ここに来るのは
    // 想定外のバグのみ。ロックを固着させないよう必ず解放する。
    process.stderr.write(`[dashboard] runSequence内で想定外のエラー: ${err?.stack ?? err}\n`);
    currentStep = null;
    broadcastSSE('step', { step: null });
    if (shutdownRequested) gracefulShutdown();
  });
}

function handleAckCritical(res) {
  if (lastCriticalCache) {
    clearLastCritical();
    appendAudit('critical_ack', { reason: 'manual' });
    broadcastSSE('critical-cleared', {});
  }
  respondJSON(res, 200, { ok: true });
}

function serveIndex(req, res, url) {
  const token = url.searchParams.get('t');
  if (!safeEqual(token, viewToken)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden: 無効な view token です。ターミナルに表示されたURLをそのまま使ってください。\n');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(INDEX_HTML);
}

// ============================================================================
// ルーティング
// ============================================================================
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const { pathname } = url;
  const { method } = req;

  if (method === 'GET' && pathname === '/') return serveIndex(req, res, url);

  if (method === 'GET' && pathname === '/api/status') {
    return withAuth(req, res, url, { originHost: true }, () => handleStatus(res));
  }
  if (method === 'GET' && pathname === '/api/critical-banner') {
    // originHost を渡していないのは意図的（ヘッダコメント「セキュリティモデル」参照）。
    return withAuth(req, res, url, {}, () => handleCriticalBanner(res));
  }
  if (method === 'GET' && pathname === '/api/events') {
    return withAuth(req, res, url, { originHost: true, browserCheck: true }, () => handleSSE(req, res));
  }
  if (method === 'POST' && pathname === '/api/execute/run') {
    return withAuth(req, res, url, { originHost: true, browserCheck: true }, () => handleExecuteRun(res));
  }
  if (method === 'POST' && pathname === '/api/ack-critical') {
    // originHost を渡していないのは意図的（ヘッダコメント「セキュリティモデル」参照）。
    return withAuth(req, res, url, {}, () => handleAckCritical(res));
  }

  respondJSON(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  Promise.resolve()
    .then(() => handleRequest(req, res))
    .catch((err) => {
      try {
        respondJSON(res, 500, { error: String(err?.message ?? err) });
      } catch {
        // レスポンスヘッダ送信済みなら何もできない。
      }
    });
});

// ============================================================================
// シグナル処理
// ----------------------------------------------------------------------------
// SIGKILL は捕捉不能。対策なし（明記のみ）。
// ============================================================================
function gracefulShutdown() {
  appendAudit('dashboard_stop', {});
  for (const client of sseClients) {
    try {
      client.end();
    } catch {
      // 既に切断済みなら無視。
    }
  }
  server.close(() => process.exit(0));
  // SSE接続等でclose()のcallbackが遅延する可能性への保険。
  setTimeout(() => process.exit(0), 2000).unref();
}

function onSignal(sig) {
  if (currentStep !== null) {
    shutdownRequested = true;
    process.stderr.write(
      `[dashboard] シーケンス実行中(${currentStep})のため終了を保留します。up の完了までお待ちください（${sig}）\n`,
    );
    return;
  }
  gracefulShutdown();
}
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('SIGTERM', () => onSignal('SIGTERM'));

// ============================================================================
// フロントエンド（単一HTMLページ。インラインCSS/JS、外部依存なし）
// ============================================================================
const INDEX_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>susumai 運用ダッシュボード</title>
<style>
  /* ==========================================================================
   * Mac OS X (Tiger〜Leopard, 2005〜2008頃) の管理画面（Disk Utility 相当）の
   * 「アプリウィンドウの中身」を再現するスキン。壁紙・デスクトップ演出は無し。
   * このページ自体がウィンドウの中身としてビューポート全体を占める。
   * 見た目の装飾のみ。バックエンドの挙動・DOM の id/class 契約は変更しない。
   * ======================================================================== */
  :root { color-scheme: light; }
  * { box-sizing: border-box; }

  html, body { height: 100%; }
  body {
    margin: 0; padding: 0; color: #1a1a1a;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Sans", "Helvetica Neue", Arial, sans-serif;
    background: #ececec;
    overflow: hidden;
  }

  /* --- ウィンドウ全体（＝ビューポート全体。壁紙・浮遊シャドウは持たない） -------- */
  .os-window {
    height: 100vh;
    display: flex; flex-direction: column;
    background: #ececec;
  }

  /* --- ツールバー: アプリ名 + 実行状況（プログレスバー）を置く ----------------
   * タイトルバー（信号機ボタン + 中央タイトル）は廃止し、アプリ名テキストは
   * このツールバー左端に .os-toolbar-title として移設した。 */
  .os-toolbar {
    flex: 0 0 auto;
    display: flex; align-items: center; gap: 10px; padding: 8px 14px;
    background: linear-gradient(180deg, #eef2f7 0%, #dde4ec 100%);
    border-bottom: 1px solid rgba(0,0,0,0.2);
  }
  .os-toolbar-title {
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.4px;
    color: #33465c;
    text-shadow: 0 1px 0 rgba(255,255,255,0.6);
    white-space: nowrap;
    margin-right: 10px;
  }
  .toolbar-spacer { flex: 1; }

  .banner {
    flex: 0 0 auto;
    background: linear-gradient(180deg, #ff8f7e 0%, #e5493a 55%, #c0281a 100%);
    color: #fff; padding: 10px 16px;
    display: flex; justify-content: space-between; align-items: center;
    gap: 12px; border-bottom: 1px solid #8f1c11;
    box-shadow: 0 1px 0 rgba(255,255,255,0.4) inset;
    text-shadow: 0 1px 1px rgba(0,0,0,0.25);
  }
  /* [hidden] は author の display 宣言（同じ normal 優先度）に負けて無効化されうるため、
     hidden 属性側にも明示的な display:none を与えて確実に隠す。 */
  .banner[hidden] { display: none; }
  #ack-critical-btn {
    position: relative; overflow: hidden; isolation: isolate;
    background: linear-gradient(180deg, #ffffff 0%, #f4f5f6 45%, #dfe3e7 100%);
    color: #b71c1c; border: 1px solid rgba(0,0,0,0.25);
    padding: 6px 12px; border-radius: 999px; cursor: pointer; font-weight: 700;
    box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 1px 2px rgba(0,0,0,0.15);
  }
  #ack-critical-btn::before {
    content: ''; position: absolute; left: 2px; right: 2px; top: 1px; height: 45%;
    border-radius: 999px / 100%;
    background: linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 100%);
    pointer-events: none;
  }
  #ack-critical-btn:hover { filter: brightness(1.04); }
  #ack-critical-btn:active { box-shadow: 0 1px 2px rgba(0,0,0,0.2) inset; transform: translateY(1px); }
  #ack-critical-btn:active::before { opacity: 0.6; }

  /* --- 本体: 左サイドバー + 右ペイン（Disk Utility の左右2ペイン構成） --------- */
  .os-body {
    flex: 1; min-height: 0;
    display: flex;
  }

  .os-sidebar {
    flex: 0 0 200px; overflow-y: auto;
    padding: 10px 8px;
    background: linear-gradient(180deg, #eef1f5 0%, #dde3ea 100%);
    border-right: 1px solid rgba(0,0,0,0.18);
  }
  .sidebar-item {
    display: flex; align-items: center; gap: 8px;
    padding: 6px 10px; margin-bottom: 2px; border-radius: 6px;
    font-size: 12px; color: #33465c; cursor: pointer;
  }
  .sidebar-item:hover { background: rgba(255,255,255,0.55); }
  .sidebar-item.selected {
    background: linear-gradient(180deg, #6fb6ee 0%, #2f7fd0 55%, #1c62ad 100%);
    color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,0.25);
    box-shadow: 0 1px 0 rgba(255,255,255,0.4) inset;
  }
  .sidebar-dot {
    width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto;
    background: #9e9e9e;
    box-shadow: 0 0 0 1px rgba(0,0,0,0.25) inset;
  }

  .os-mainpane { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .os-mainpane-scroll { flex: 1; min-height: 0; overflow-y: auto; padding: 16px 16px 8px; }
  .os-mainpane-footer {
    flex: 0 0 auto;
    padding: 10px 16px; display: flex; justify-content: flex-end;
    background: linear-gradient(180deg, #f6f7f9 0%, #eceef1 100%);
    border-top: 1px solid rgba(0,0,0,0.15);
  }

  .card {
    background: linear-gradient(180deg, #ffffff 0%, #f3f5f8 100%);
    border-radius: 8px; padding: 16px; margin-bottom: 16px;
    border: 1px solid #cdd4dd;
    box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 1px 0 rgba(255,255,255,0.6) inset;
  }
  .card h2 {
    font-size: 12px; margin: 0 0 12px; color: #4a5a6d; font-weight: 700;
    text-transform: uppercase; letter-spacing: 0.03em;
  }
  #diagram { width: 100%; height: auto; }
  /* --- アーキテクチャ図の矢印: 常時接続表示（connected/disconnectedの2状態のみ）。
   * 構造的プロパティ（線幅・fill:none）だけを共通ベースクラスに残し、
   * 色・破線・矢じり・アニメーションは各状態クラスに持たせる（冗長な二重定義を避ける）。 */
  #diagram .diagram-arrow {
    stroke-width: 2;
    fill: none;
    transition: stroke 0.3s ease;
  }
  #diagram .diagram-arrow.disconnected {
    stroke: #9e9e9e;
    stroke-dasharray: 4 3;
    marker-end: url(#marker-arrow-disconnected);
    animation: none;
  }
  #diagram .diagram-arrow.connected {
    stroke: #2f7fd0;
    stroke-dasharray: 6 4;
    marker-end: url(#marker-arrow-connected);
    animation: diagram-arrow-flow 700ms linear infinite;
  }
  @keyframes diagram-arrow-flow {
    from { stroke-dashoffset: 10; }
    to   { stroke-dashoffset: 0; }
  }
  .step-chips { display: flex; gap: 8px; margin-top: 12px; align-items: center; }
  .chip {
    padding: 4px 12px; border-radius: 999px; background: #dfe4ea; font-size: 11px;
    border: 1px solid #c3ccd6; color: #56626f;
    box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset;
  }
  .chip.active {
    background: linear-gradient(180deg, #ffd27a, #f5a623);
    color: #5a3600; font-weight: 700; border-color: #c97f00;
    box-shadow: 0 1px 0 rgba(255,255,255,0.5) inset, 0 0 6px rgba(245,166,35,0.6);
  }

  /* --- 詳細情報バー: Disk Utility 下部の「Mount Point / Format / ...」相当。
     「現在の状況が分かりづらい」というフィードバックに直接応えるための核心部分。 --- */
  .kv-row { display: flex; flex-wrap: wrap; border: 1px solid #cdd4dd; border-radius: 6px; overflow: hidden; }
  .kv-item {
    flex: 1 1 110px; padding: 8px 12px;
    background: linear-gradient(180deg, #fdfefe, #eef1f4);
    border-right: 1px solid #dfe4ea; border-bottom: 1px solid #dfe4ea;
  }
  .kv-item:last-child { border-right: none; }
  .kv-label {
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.03em;
    color: #7a8794; margin-bottom: 3px;
  }
  .kv-value { font-size: 13px; color: #1a2733; font-weight: 600; font-family: ui-monospace, "SF Mono", monospace; }

  /* --- Aqua 風プログレスバー（実行中インジケータ） ------------------------------ */
  .aqua-progress-track {
    flex: 1; height: 14px; border-radius: 999px; margin-left: 4px;
    background: linear-gradient(180deg, #d6dbe0, #eef0f2);
    border: 1px solid #b7bec6;
    box-shadow: 0 1px 2px rgba(0,0,0,0.15) inset;
    overflow: hidden; position: relative;
  }
  .aqua-progress-fill {
    position: absolute; inset: 0; width: 0%; border-radius: 999px;
    background: linear-gradient(180deg, #bfe2ff 0%, #4fa3e8 45%, #1c6fc2 100%);
    box-shadow: 0 1px 0 rgba(255,255,255,0.6) inset;
    transition: width 0.3s ease;
  }
  /* 紫系にしているのは、アーキテクチャ図の矢印「接続中」表現に新たに青い
     バーバーポールを導入したため、同じ青系のままだと両者が視覚的に混同するため。 */
  .aqua-progress-track.running .aqua-progress-fill {
    width: 100%;
    background-image:
      linear-gradient(180deg, rgba(255,255,255,0.55) 0%, rgba(255,255,255,0) 50%),
      repeating-linear-gradient(45deg, #9c6ade 0 14px, #7e3ff2 14px 28px);
    animation: aqua-barberpole 900ms linear infinite;
  }
  @keyframes aqua-barberpole {
    from { background-position: 0 0, 0 0; }
    to { background-position: 0 0, 28px 0; }
  }
  /* シーケンス完了時: 一瞬満タン（緑）にしてから幅0%へフェードし、「完了した」ことを
     進捗バー自体で表現する（sequence-end受信時にJS側で .complete → .complete.fade-out
     の順にクラスを付け替える）。 */
  .aqua-progress-track.complete .aqua-progress-fill {
    width: 100%; animation: none;
    background: linear-gradient(180deg, #b6f2b0 0%, #4caf50 45%, #2e7d32 100%);
  }
  .aqua-progress-track.complete.fade-out .aqua-progress-fill {
    width: 0%;
  }

  #log-panel {
    background: linear-gradient(180deg, #17181a, #0c0d0e);
    color: #ddd; font-family: ui-monospace, "SF Mono", monospace; font-size: 12px;
    padding: 12px; border-radius: 8px; height: 180px; overflow-y: auto; white-space: pre-wrap;
    border: 1px solid #000; box-shadow: 0 2px 4px rgba(0,0,0,0.4) inset;
  }
  .log-down { color: #ffab91; }
  .log-rehearse { color: #90caf9; }
  .log-up { color: #a5d6a7; }

  /* --- Aqua「ジェリービーンズ」ボタン ------------------------------------------
   * 2000年代初期 Mac OS X の標準ダイアログボタン（例: Cancel/Open）を参照した
   * 質感強化。色相（本番操作である危険性を示す赤系統）は変更せず、上半分に
   * ガラス玉・水滴のような強いハイライトを重ね、下半分にかけて彩度を上げることで
   * 「ぷっくりした」立体感を表現する（後藤さんフィードバック 2026-09-15）。
   * ::before はハイライト層のみを描画する装飾用で、DOM の id/class 契約・
   * クリック挙動には影響しない（pointer-events: none）。 --- */
  button.primary {
    position: relative; overflow: hidden; isolation: isolate;
    background: linear-gradient(180deg, #ffcabd 0%, #ff8069 22%, #e5493a 55%, #b8230f 100%);
    color: #fff; border: 1px solid #7a160c; padding: 10px 20px; border-radius: 999px;
    font-size: 13px; cursor: pointer; font-weight: 700;
    box-shadow: 0 1px 0 rgba(255,255,255,0.4) inset, 0 2px 4px rgba(0,0,0,0.25), 0 0 0 1px rgba(255,90,70,0.35);
    text-shadow: 0 1px 1px rgba(0,0,0,0.35);
  }
  button.primary::before {
    content: ''; position: absolute; left: 2px; right: 2px; top: 1px; height: 56%;
    border-radius: 999px / 100%;
    background: linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.35) 65%, rgba(255,255,255,0) 100%);
    pointer-events: none;
  }
  button.primary:hover { filter: brightness(1.04); }
  button.primary:active { box-shadow: 0 1px 2px rgba(0,0,0,0.3) inset; transform: translateY(1px); }
  button.primary:active::before { opacity: 0.6; }
  button.primary:disabled { background: #b7bec6; color: #eee; border-color: #99a1a9; cursor: not-allowed; box-shadow: none; }
  button.primary:disabled::before { display: none; }

  .modal-overlay {
    position: fixed; inset: 0; background: rgba(10,20,35,0.55);
    display: flex; align-items: center; justify-content: center;
  }
  /* .banner[hidden] と同じ理由。hidden 属性のみでは display:flex に負けるため明示する。 */
  .modal-overlay[hidden] { display: none; }
  .modal {
    background: linear-gradient(180deg, #fbfcfd 0%, #e7ebf0 100%);
    border-radius: 10px; padding: 0; width: 440px; max-width: 90vw;
    border: 1px solid rgba(0,0,0,0.35);
    box-shadow: 0 30px 70px rgba(0,0,10,0.5);
    overflow: hidden;
  }
  .modal h3 {
    margin: 0; padding: 12px 20px; font-size: 13px; text-align: center;
    background: linear-gradient(180deg, #f4f7fb 0%, #dbe4ee 45%, #b9c8dc 100%);
    border-bottom: 1px solid rgba(0,0,0,0.3);
    color: #33465c; text-shadow: 0 1px 0 rgba(255,255,255,0.6);
  }
  .modal > *:not(h3) { padding-left: 20px; padding-right: 20px; }
  .modal .actions { padding-bottom: 18px; }
  .modal .warn { color: #b71c1c; font-size: 12px; font-weight: 600; }
  .modal .actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 16px; }
  .modal .actions button {
    position: relative; overflow: hidden; isolation: isolate;
    padding: 8px 16px; border-radius: 999px; border: 1px solid rgba(0,0,0,0.3); cursor: pointer;
    font-size: 12px; font-weight: 700; box-shadow: 0 1px 0 rgba(255,255,255,0.5) inset;
  }
  /* .modal .actions button::before はハイライト層のみを描画する装飾用（button.primary
     と同じ手法）。DOM の id/class 契約・クリック挙動には影響しない。 */
  .modal .actions button::before {
    content: ''; position: absolute; left: 2px; right: 2px; top: 1px; height: 50%;
    border-radius: 999px / 100%;
    pointer-events: none;
  }
  .modal .cancel-btn {
    background: linear-gradient(180deg, #ffffff 0%, #f4f5f6 45%, #dfe3e7 100%);
    color: #333; border-color: rgba(0,0,0,0.25);
    box-shadow: 0 1px 0 rgba(255,255,255,0.7) inset, 0 1px 2px rgba(0,0,0,0.12);
  }
  .modal .cancel-btn::before {
    background: linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(255,255,255,0) 100%);
  }
  /* #ack-critical-btn と同系統（白〜グレーのジェリービーンズ）のため、押下時の
     沈み込み影も #ack-critical-btn:active と同じ濃さで揃える。 */
  .modal .cancel-btn:active { box-shadow: 0 1px 2px rgba(0,0,0,0.2) inset; }
  .modal .run-btn {
    background: linear-gradient(180deg, #ffcabd 0%, #ff8069 22%, #e5493a 55%, #b8230f 100%);
    color: #fff; text-shadow: 0 1px 1px rgba(0,0,0,0.35); border-color: #7a160c;
    box-shadow: 0 1px 0 rgba(255,255,255,0.4) inset, 0 2px 3px rgba(0,0,0,0.2), 0 0 0 1px rgba(255,90,70,0.35);
  }
  .modal .run-btn::before {
    background: linear-gradient(180deg, rgba(255,255,255,0.95) 0%, rgba(255,255,255,0.35) 65%, rgba(255,255,255,0) 100%);
  }
  /* button.primary と同系統（赤のジェリービーンズ）のため、押下時の沈み込み影も
     button.primary:active と同じ濃さで揃える。 */
  .modal .run-btn:active { box-shadow: 0 1px 2px rgba(0,0,0,0.3) inset; }
  .modal .actions button:hover { filter: brightness(1.04); }
  .modal .actions button:active { transform: translateY(1px); }
  .modal .actions button:active::before { opacity: 0.6; }
  .modal button:disabled { opacity: 0.5; cursor: not-allowed; }
  .modal button:disabled::before { display: none; }
</style>
</head>
<body>
  <div class="os-window">
    <div class="os-toolbar">
      <span class="os-toolbar-title">susumai</span>
      <div class="toolbar-spacer"></div>
      <div class="aqua-progress-track" id="progress-track">
        <div class="aqua-progress-fill"></div>
      </div>
    </div>

    <div id="critical-banner" class="banner" hidden>
      <span id="critical-banner-text"></span>
      <button id="ack-critical-btn">確認済みにする</button>
    </div>

    <div class="os-body">
      <div class="os-sidebar" id="os-sidebar">
        <div class="sidebar-item" id="sidebar-item-proxy" data-target="proxy">
          <span class="sidebar-dot" id="sidebar-dot-proxy"></span><span>proxy :8787</span>
        </div>
        <div class="sidebar-item" id="sidebar-item-cloudflared" data-target="cloudflared">
          <span class="sidebar-dot" id="sidebar-dot-cloudflared"></span><span>cloudflared</span>
        </div>
        <div class="sidebar-item" id="sidebar-item-ollama" data-target="ollama">
          <span class="sidebar-dot" id="sidebar-dot-ollama"></span><span>Ollama</span>
        </div>
      </div>

      <div class="os-mainpane">
        <div class="os-mainpane-scroll">
          <div class="card">
            <h2>構成</h2>
            <svg id="diagram" viewBox="0 0 840 210" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <marker id="marker-arrow-connected" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#2f7fd0" />
                </marker>
                <marker id="marker-arrow-disconnected" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#9e9e9e" />
                </marker>
              </defs>
              <line id="arrow-cli-proxy"          class="diagram-arrow disconnected" x1="130" y1="45" x2="176" y2="45" />
              <line id="arrow-proxy-cloudflared"  class="diagram-arrow disconnected" x1="290" y1="45" x2="336" y2="45" />
              <line id="arrow-cloudflared-edge"   class="diagram-arrow disconnected" x1="450" y1="45" x2="496" y2="45" />
              <line id="arrow-edge-public"        class="diagram-arrow disconnected" x1="620" y1="45" x2="666" y2="45" />
              <line id="arrow-proxy-ollama"       class="diagram-arrow disconnected" x1="235" y1="70" x2="235" y2="116" />

              <rect x="20" y="20" width="110" height="50" rx="8" fill="#1565c0" />
              <text x="75" y="50" text-anchor="middle" fill="#fff" font-size="13">CLI</text>

              <rect id="rect-proxy" x="180" y="20" width="110" height="50" rx="8" fill="#757575" />
              <text x="235" y="50" text-anchor="middle" fill="#fff" font-size="13">proxy :8787</text>

              <rect id="rect-cloudflared" x="340" y="20" width="110" height="50" rx="8" fill="#757575" />
              <text x="395" y="50" text-anchor="middle" fill="#fff" font-size="13">cloudflared</text>

              <rect x="500" y="20" width="120" height="50" rx="8" fill="#1565c0" />
              <text x="560" y="50" text-anchor="middle" fill="#fff" font-size="12">Cloudflare Edge</text>

              <rect id="rect-public" x="670" y="20" width="140" height="50" rx="8" fill="#757575" />
              <text x="740" y="45" text-anchor="middle" fill="#fff" font-size="11">llm.susumai.net</text>
              <text x="740" y="60" text-anchor="middle" fill="#fff" font-size="10">(公開URL)</text>

              <rect x="180" y="120" width="110" height="50" rx="8" fill="#1565c0" />
              <text x="235" y="150" text-anchor="middle" fill="#fff" font-size="13">Ollama</text>
            </svg>

            <div class="step-chips">
              <span class="chip" id="chip-down">down</span>
              <span class="chip" id="chip-rehearse">rehearse</span>
              <span class="chip" id="chip-up">up</span>
            </div>
          </div>

          <div class="card">
            <h2>詳細情報: <span id="detail-target-name">proxy :8787</span></h2>
            <div class="kv-row" id="detail-kv"></div>
          </div>

          <div class="card">
            <h2>実行ログ</h2>
            <div id="log-panel"></div>
          </div>
        </div>

        <div class="os-mainpane-footer">
          <button class="primary" id="open-modal-btn">本番再起動</button>
        </div>
      </div>
    </div>
  </div>
  <!-- /.os-window -->

  <div class="modal-overlay" id="modal-overlay" hidden>
    <div class="modal">
      <h3>本番再起動の確認</h3>
      <div id="modal-current-status" style="font-size:13px; color:#555; margin:12px 0 8px;"></div>
      <div id="modal-superseded-warning" class="warn" hidden>
        前回の失敗（未確認）の上に実行しようとしています。実行を開始すると、その前回の失敗表示は
        自動的に確認済み扱いになります。
      </div>
      <p style="font-size:13px;">本番の proxy を一旦停止し、rehearse 完了後に再起動します。よろしいですか？</p>
      <div id="modal-status" style="font-size:12px; color:#777;"></div>
      <div class="actions">
        <button class="cancel-btn" id="cancel-btn">キャンセル</button>
        <button class="run-btn" id="run-btn">実行</button>
      </div>
    </div>
  </div>

<script>
(function () {
  var VIEW_TOKEN = ${JSON.stringify(viewToken)};
  var currentCriticalBanner = null;
  var lastStatusData = null;
  var selectedTarget = 'proxy';
  var TARGETS = ['proxy', 'cloudflared', 'ollama'];

  function apiUrl(p) {
    var u = new URL(p, location.origin);
    u.searchParams.set('t', VIEW_TOKEN);
    return u.toString();
  }

  function targetLabel(target) {
    if (target === 'proxy') return 'proxy :8787';
    if (target === 'cloudflared') return 'cloudflared';
    if (target === 'ollama') return 'Ollama';
    return target;
  }

  // Ollama はこのリポジトリ（/api/status）の管轄外。取得できる情報がないため、
  // 選択時は常に「不明」として詳細情報バーに表示する。
  function targetData(target) {
    if (target === 'ollama') return null;
    if (!lastStatusData || !lastStatusData.targets) return null;
    return lastStatusData.targets[target] || null;
  }

  function colorFor(t) {
    if (!t || t.loaded !== true) return '#757575';
    return t.healthy ? '#2e7d32' : '#c62828';
  }

  function dotColorFor(target) {
    var t = targetData(target);
    return t ? colorFor(t) : '#9e9e9e';
  }

  function renderSidebar() {
    TARGETS.forEach(function (target) {
      document.getElementById('sidebar-item-' + target).classList.toggle('selected', target === selectedTarget);
      document.getElementById('sidebar-dot-' + target).style.background = dotColorFor(target);
    });
  }

  function fieldText(t, field) {
    if (!t) return '不明';
    if (field === 'pid') return t.pid == null ? 'N/A' : String(t.pid);
    return String(t[field]);
  }

  function renderDetail() {
    document.getElementById('detail-target-name').textContent = targetLabel(selectedTarget);
    var t = targetData(selectedTarget);
    var wrap = document.getElementById('detail-kv');
    wrap.innerHTML = '';
    ['loaded', 'state', 'pid', 'healthy'].forEach(function (field) {
      var item = document.createElement('div');
      item.className = 'kv-item';
      var label = document.createElement('div');
      label.className = 'kv-label';
      label.textContent = field;
      var value = document.createElement('div');
      value.className = 'kv-value';
      value.setAttribute('data-field', field);
      value.textContent = fieldText(t, field);
      item.appendChild(label);
      item.appendChild(value);
      wrap.appendChild(item);
    });
  }

  function selectTarget(target) {
    selectedTarget = target;
    renderSidebar();
    renderDetail();
  }

  TARGETS.forEach(function (target) {
    document.getElementById('sidebar-item-' + target).addEventListener('click', function () {
      selectTarget(target);
    });
  });

  // renderArrows: アーキテクチャ図の矢印5本を connected/disconnected に振り分ける。
  // 引数なしで呼ぶと全て非connected（安全側デフォルト）になる。renderStatus内で
  // 既に計算済みの proxy/cf/overallHealthy をそのまま渡し、data.targets.* を
  // ここで再取得しない。
  //
  // 注（③ cloudflared-edge の判定について）: 当初案では
  // 「cf.loaded === true && cf.healthy === true」を検討したが、ops/hosting.sh の
  // health() はどのターゲットでも同一の公開URLをcurlする実装のため、cf.healthy は
  // 実質 overallHealthy（④の判定式）とほぼ同じ信号になってしまい、
  // 「cf.loaded && cf.healthy」は cf.healthy 単独とほぼ同値になる
  // （healthy=true は内部で state=="running" を要求するため loaded=true を含意する）。
  // そのため③は cf.loaded のみを使うことに確定した。これにより①②③は
  // 「プロセスが構造的に起動しているか」という共通軸、④だけが
  // 「外形疎通（公開URL全体）」という別軸、という一貫した設計になっている。
  function renderArrows(proxy, cf, overallHealthy) {
    proxy = proxy || {};
    cf = cf || {};
    var states = {
      'cli-proxy': proxy.loaded === true,
      'proxy-cloudflared': cf.loaded === true,
      'cloudflared-edge': cf.loaded === true, // 注: cf.healthyは含めない（上記コメント参照）
      'edge-public': overallHealthy === true,
      'proxy-ollama': false, // Ollamaはops/hosting.sh管轄外。データが無いため常に非connected固定。
    };
    Object.keys(states).forEach(function (id) {
      var el = document.getElementById('arrow-' + id);
      el.classList.toggle('connected', states[id]);
      el.classList.toggle('disconnected', !states[id]);
    });
  }

  function renderStatus(data) {
    if (!data || !data.targets) return;
    lastStatusData = data;
    var proxy = data.targets.proxy || {};
    var cf = data.targets.cloudflared || {};
    document.getElementById('rect-proxy').setAttribute('fill', colorFor(proxy));
    document.getElementById('rect-cloudflared').setAttribute('fill', colorFor(cf));
    document.getElementById('rect-public').setAttribute('fill', data.overallHealthy ? '#2e7d32' : '#c62828');
    renderArrows(proxy, cf, data.overallHealthy);
    renderSidebar();
    renderDetail();
  }

  function pollStatus() {
    fetch(apiUrl('/api/status')).then(function (res) {
      if (!res.ok) return null;
      return res.json();
    }).then(function (data) {
      if (!data) return;
      renderStatus(data);
    }).catch(function () { /* 次回のpollで再試行 */ });
  }
  pollStatus();
  setInterval(pollStatus, 3000);
  renderArrows();  // 引数なし＝安全側デフォルト（全て非connected）。HTML初期状態のdisconnectedクラスと一致させる。
  renderSidebar();
  renderDetail();

  function renderCriticalBanner(data) {
    currentCriticalBanner = data;
    var el = document.getElementById('critical-banner');
    el.hidden = !data;
    if (data) {
      document.getElementById('critical-banner-text').textContent =
        '[' + data.severity + '] ' + data.outcome + '（' + data.ts + '）未確認の失敗があります。';
    }
  }

  function loadCriticalBanner() {
    fetch(apiUrl('/api/critical-banner')).then(function (res) { return res.json(); })
      .then(renderCriticalBanner).catch(function () {});
  }
  loadCriticalBanner();

  document.getElementById('ack-critical-btn').addEventListener('click', function () {
    fetch(apiUrl('/api/ack-critical'), { method: 'POST' }).then(function () {
      renderCriticalBanner(null);
    });
  });

  function setChipActive(step) {
    ['down', 'rehearse', 'up'].forEach(function (s) {
      document.getElementById('chip-' + s).classList.toggle('active', s === step);
    });
    document.getElementById('progress-track').classList.toggle('running', step !== null);
  }

  // down→rehearse→up完了時、進捗バーを一瞬満タン(緑)にしてからフェードさせ、
  // ログを読まなくても完了を視覚的に把握できるようにする。
  function flashProgressComplete() {
    var track = document.getElementById('progress-track');
    track.classList.remove('fade-out');
    track.classList.add('complete');
    setTimeout(function () {
      track.classList.add('fade-out');
      setTimeout(function () {
        track.classList.remove('complete', 'fade-out');
      }, 350);
    }, 550);
  }

  function appendLog(entry) {
    var panel = document.getElementById('log-panel');
    var line = document.createElement('div');
    line.className = 'log-' + entry.step;
    line.textContent = '[' + entry.step + '] ' + entry.line;
    panel.appendChild(line);
    panel.scrollTop = panel.scrollHeight;
  }

  var es = new EventSource(apiUrl('/api/events'));
  es.addEventListener('log', function (ev) { appendLog(JSON.parse(ev.data)); });
  es.addEventListener('step', function (ev) {
    var data = JSON.parse(ev.data);
    setChipActive(data.step);
  });
  es.addEventListener('sequence-end', function () {
    document.getElementById('modal-status').textContent = '';
    flashProgressComplete();
  });
  es.addEventListener('critical-banner', function (ev) { renderCriticalBanner(JSON.parse(ev.data)); });
  es.addEventListener('critical-cleared', function () { renderCriticalBanner(null); });

  function openModal() {
    document.getElementById('modal-overlay').hidden = false;
    document.getElementById('run-btn').disabled = false;
    document.getElementById('modal-status').textContent = '';
    var proxy = (lastStatusData && lastStatusData.targets && lastStatusData.targets.proxy) || {};
    document.getElementById('modal-current-status').textContent =
      '現在の proxy: loaded=' + proxy.loaded + ' state=' + proxy.state + ' healthy=' + proxy.healthy;
    document.getElementById('modal-superseded-warning').hidden = !currentCriticalBanner;
  }
  function closeModal() { document.getElementById('modal-overlay').hidden = true; }

  document.getElementById('open-modal-btn').addEventListener('click', openModal);
  document.getElementById('cancel-btn').addEventListener('click', closeModal);

  // 確認文字列のタイプ入力は要求しない（後藤さんの決定により廃止済み）。
  // 「実行」クリック一つで POST /api/execute/run のみを呼び、シーケンスを開始する。
  document.getElementById('run-btn').addEventListener('click', function () {
    document.getElementById('run-btn').disabled = true;
    fetch(apiUrl('/api/execute/run'), { method: 'POST' }).then(function (res) {
      if (res.status === 202) {
        closeModal();
        document.getElementById('log-panel').textContent = '';
        return;
      }
      document.getElementById('modal-status').textContent =
        res.status === 409 ? '既に実行中です。' : '実行開始に失敗しました。';
      document.getElementById('run-btn').disabled = false;
    }).catch(function () {
      document.getElementById('modal-status').textContent = '実行開始に失敗しました。';
      document.getElementById('run-btn').disabled = false;
    });
  });
})();
</script>
</body>
</html>
`;

// ============================================================================
// 起動シーケンス
// ============================================================================
// 手順3: シグナルハンドラは上で登録済み。
// 手順4: dashboard_start を監査ログに記録。
appendAudit('dashboard_start', { port: PORT });
// 手順5: 起動時に critical バナーがあれば読み込んでおく。
loadLastCritical();

// **`127.0.0.1` に固定で listen し、`0.0.0.0` には絶対に listen しない。**
server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?t=${viewToken}`;
  process.stdout.write(`susumai dashboard: ${url}\n`);
});
