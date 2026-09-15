// e2e/dashboard-harness.mjs — Playwright テストから ops/dashboard.mjs を安全に
// 起動/停止するためのヘルパー。
//
// ============================================================================
// 安全設計（過去に2回、類似の事故が起きているための最重要事項）:
//   - HOSTING_SH / REHEARSE_CMD は必ず e2e/fixtures/ 配下のモックを指す
//     （本物の ops/hosting.sh・npm run rehearse は絶対に指さない）。
//   - 監査ログ・CRITICALバナー状態ファイルは、リポジトリの ops/ 配下ではなく
//     os.tmpdir() 配下に都度作成する一時ディレクトリに書く（後藤さんが対話端末で
//     稼働させているかもしれない本物の dashboard.mjs と状態ファイルを共有しない）。
//   - ポートは SUSUMAI_DASHBOARD_PORT で本番既定の 4787 とは無関係なランダムな
//     高位ポートを都度払い出す。
//   - 層2（ブラウザプロセス確認）は SUSUMAI_DASHBOARD_EXTRA_BROWSER_PROCESSES で
//     Playwright 同梱ブラウザの実プロセス名だけを一時的に許可する。この環境変数は
//     ここ（テストハーネス）以外では絶対に設定してはならない。
// ============================================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..');
const DASHBOARD_MJS = path.join(REPO_ROOT, 'ops', 'dashboard.mjs');

export const MOCK_HOSTING_OK = path.join(HERE, 'fixtures', 'mock-hosting.sh');
export const MOCK_HOSTING_FAIL = path.join(HERE, 'fixtures', 'mock-hosting-fail.sh');
export const MOCK_HOSTING_DEGRADED = path.join(HERE, 'fixtures', 'mock-hosting-degraded.sh');
export const MOCK_REHEARSE_CMD = `${process.execPath} ${path.join(HERE, 'fixtures', 'mock-rehearse.mjs')}`;

// Playwright バンドル版ブラウザが実際にTCPソケットを保持する際の comm 名
// （実機観測済み。ops/dashboard.mjs の BROWSER_PROCESS_ALLOWLIST 付近のコメント参照）。
const PLAYWRIGHT_BROWSER_PROCESS_NAMES = [
  'chrome-headless-shell', // Chromium, headless（既定）
  'Google Chrome for Testing Helper', // Chromium, headed
  'com.apple.WebKit.Networking.Development', // WebKit（headless/headed とも）
].join(',');

function randomPort() {
  // 本番既定の 4787 や rehearsal 関連ポートと衝突しない高位ポート帯から適当に選ぶ。
  return 20000 + Math.floor(Math.random() * 20000);
}

const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

/**
 * ops/dashboard.mjs をモック環境に向けて起動する。
 * @param {{hostingSh?: string, rehearseCmd?: string}} opts
 * @returns {Promise<{url: string, port: number, tmpDir: string, stop: () => Promise<void>, stderr: () => string}>}
 */
export async function startDashboard(opts = {}) {
  const hostingSh = opts.hostingSh ?? MOCK_HOSTING_OK;
  const rehearseCmd = opts.rehearseCmd ?? MOCK_REHEARSE_CMD;
  const port = randomPort();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-dashboard-e2e-'));
  const auditLog = path.join(tmpDir, 'dashboard-audit.log');
  const lastCritical = path.join(tmpDir, 'dashboard-last-critical.json');

  // TTYゲート回避: dashboard.mjs は対話端末以外からの起動を拒否する（弱いUXフリクション
  // であり、セキュリティ境界ではないと dashboard.mjs 自身のコメントに明記されている）。
  // その回避策として `script -q /dev/null <cmd>` を使うことも、dashboard.mjs の
  // コメント内で名指しされている想定された迂回方法である。
  const child = spawn('script', ['-q', '/dev/null', process.execPath, DASHBOARD_MJS], {
    cwd: REPO_ROOT,
    detached: true, // プロセスグループを分離し、テスト終了時にまとめて確実に止める。
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SUSUMAI_DASHBOARD_PORT: String(port),
      SUSUMAI_DASHBOARD_HOSTING_SH: hostingSh,
      SUSUMAI_DASHBOARD_REHEARSE_CMD: rehearseCmd,
      SUSUMAI_DASHBOARD_AUDIT_LOG: auditLog,
      SUSUMAI_DASHBOARD_LAST_CRITICAL: lastCritical,
      SUSUMAI_DASHBOARD_EXTRA_BROWSER_PROCESSES: PLAYWRIGHT_BROWSER_PROCESS_NAMES,
    },
  });

  let output = '';
  let stopped = false;

  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`dashboard.mjs 起動待ちタイムアウト。出力:\n${output}`));
    }, START_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timer);
      child.stdout.off('data', onData);
      child.stderr.off('data', onData);
      child.off('exit', onExit);
    }
    function onData(buf) {
      output += buf.toString('utf8');
      const m = output.match(/susumai dashboard: (http:\/\/127\.0\.0\.1:\d+\/\?t=[0-9a-f]+)/);
      if (m) {
        cleanup();
        resolve(m[1]);
      }
    }
    function onExit(code) {
      cleanup();
      reject(new Error(`dashboard.mjs が起動前に終了しました (code=${code})。出力:\n${output}`));
    }
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', onExit);
  });

  async function stop() {
    if (stopped) return;
    stopped = true;
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // 既に終了している場合などは無視。
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // 既に終了していれば無視。
        }
        resolve();
      }, STOP_TIMEOUT_MS);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ベストエフォート。
    }
  }

  return { url, port, tmpDir, stop, stderr: () => output };
}
