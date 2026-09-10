/*
 * 段階3: 本番 proxy 化（SUSUMAI_PROD=1 対応 ＋ ops/proxy-prod.mjs シムの identity 分離）
 * ============================================================================
 *   - SUSUMAI_PROD=1 ＋ SUSUMAI_TOKEN            → ConfigError（本番は github のみ）
 *   - SUSUMAI_PROD=1 ＋ SUSUMAI_PROXY_LOG 未設定 → ConfigError
 *   - SUSUMAI_PROD=1 ＋ SUSUMAI_ALLOWLIST ＋ SUSUMAI_PROXY_LOG → github モードで buildConfig
 *     が通り、logPath が本番側（渡したパス）になる
 *   - ops/proxy-prod.mjs 経由起動時の `ps -o command=` 文字列が rehearse の
 *     classifyProxyListener で「rehearsal/proxy.mjs 非ヒット（＝本番と判定されない）」こと
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const { buildConfig, ConfigError } = await import('../rehearsal/proxy.mjs');
const { classifyProxyListener } = await import('../rehearsal/rehearse.mjs');

const REPO_DIR = fileURLToPath(new URL('..', import.meta.url));
const SHIM = path.join(REPO_DIR, 'ops', 'proxy-prod.mjs');
const EXAMPLE_ALLOWLIST = path.join(REPO_DIR, 'rehearsal', 'allowlist.example.json');

function withAllowlistFile(entries, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-prod-'));
  const file = path.join(dir, 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- buildConfig: 本番モードの fail-closed / 正常経路 -----------------------

test('buildConfig: SUSUMAI_PROD=1 ＋ SUSUMAI_TOKEN → ConfigError（本番は github のみ）', () => {
  assert.throws(
    () =>
      buildConfig({
        SUSUMAI_PROD: '1',
        SUSUMAI_TOKEN: 'shared-secret',
        SUSUMAI_PROXY_LOG: '/tmp/x.log',
      }),
    ConfigError,
  );
});

test('buildConfig: SUSUMAI_PROD=1 ＋ SUSUMAI_PROXY_LOG 未設定 → ConfigError', () => {
  withAllowlistFile([], (file) => {
    assert.throws(
      () => buildConfig({ SUSUMAI_PROD: '1', SUSUMAI_ALLOWLIST: file }),
      ConfigError,
    );
  });
});

test('buildConfig: SUSUMAI_PROD=1 ＋ SUSUMAI_ALLOWLIST ＋ SUSUMAI_PROXY_LOG → github モードで通り logPath が本番側', () => {
  withAllowlistFile([{ id: 555, login: 'teammate' }], (file) => {
    const logPath = path.join(os.tmpdir(), 'susumai-prod-access.log');
    const c = buildConfig({
      SUSUMAI_PROD: '1',
      SUSUMAI_ALLOWLIST: file,
      SUSUMAI_PROXY_LOG: logPath,
    });
    assert.equal(c.githubMode, true);
    assert.equal(c.bearerDigest, null);
    assert.equal(c.logPath, logPath);
  });
});

test('buildConfig: SUSUMAI_PROD=1 ＋ SUSUMAI_PROXY_LOG の親ディレクトリが存在しない → ConfigError', () => {
  withAllowlistFile([], (file) => {
    assert.throws(
      () =>
        buildConfig({
          SUSUMAI_PROD: '1',
          SUSUMAI_ALLOWLIST: file,
          SUSUMAI_PROXY_LOG: path.join(os.tmpdir(), 'susumai-no-such-dir-xyz', 'access.log'),
        }),
      ConfigError,
    );
  });
});

test('buildConfig: SUSUMAI_PROD=1 ＋ 書き込めない親ディレクトリ → ConfigError（非本番は無検査）', { skip: process.getuid?.() === 0 ? 'root は W_OK 検査を素通りする' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-ro-'));
  fs.chmodSync(dir, 0o500); // r-x------: 書き込み不可
  const logPath = path.join(dir, 'access.log');
  try {
    withAllowlistFile([], (file) => {
      assert.throws(
        () =>
          buildConfig({ SUSUMAI_PROD: '1', SUSUMAI_ALLOWLIST: file, SUSUMAI_PROXY_LOG: logPath }),
        ConfigError,
      );
      // 非本番（SUSUMAI_PROD なし）は親ディレクトリを検査しない
      const c = buildConfig({ SUSUMAI_TOKEN: 't', SUSUMAI_PROXY_LOG: logPath });
      assert.equal(c.logPath, logPath);
    });
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildConfig: SUSUMAI_PROXY_LOG は本番モードでなくても logPath に反映される（相対パスは絶対化）', () => {
  const c = buildConfig({ SUSUMAI_TOKEN: 't', SUSUMAI_PROXY_LOG: 'foo/bar.log' });
  assert.equal(c.logPath, path.resolve('foo/bar.log'));
});

test('buildConfig: SUSUMAI_PROXY_LOG 未設定なら logPath は null（従来どおり rehearsal/proxy.log）', () => {
  const c = buildConfig({ SUSUMAI_TOKEN: 't' });
  assert.equal(c.logPath, null);
});

// --- ops/proxy-prod.mjs シム ---------------------------------------------

test('ops/proxy-prod.mjs: SUSUMAI_PROXY_LOG 未設定なら exit(1) で起動拒否', () => {
  const r = spawnSync(process.execPath, [SHIM], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SUSUMAI_ALLOWLIST: EXAMPLE_ALLOWLIST },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SUSUMAI_PROXY_LOG/);
});

test('ops/proxy-prod.mjs 経由起動の ps コマンドラインは rehearse の classifyProxyListener に本番ヒットしない', async () => {
  const logPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-prod-')),
    'access.log',
  );
  const child = spawn(process.execPath, [SHIM], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: {
      PATH: process.env.PATH,
      SUSUMAI_ALLOWLIST: EXAMPLE_ALLOWLIST,
      SUSUMAI_PROXY_LOG: logPath,
    },
  });

  try {
    // プロセス起動直後の `ps -o command=` を数回ポーリングして拾う。
    let psCmd = '';
    for (let i = 0; i < 100 && !psCmd; i++) {
      const r = spawnSync('ps', ['-p', String(child.pid), '-o', 'command='], {
        encoding: 'utf8',
      });
      psCmd = (r.stdout || '').trim();
      if (!psCmd) await delay(20);
    }

    assert.ok(psCmd, `:${child.pid} の ps コマンドラインを取得できませんでした`);
    // 本質: dynamic import した rehearsal/proxy.mjs は argv に出ない。
    // 見えるのは起動直後なら "…/ops/proxy-prod.mjs"、process.title 反映後なら "susumai-proxy"。
    assert.doesNotMatch(psCmd, /rehearsal\/proxy\.mjs/);
    assert.ok(
      /ops\/proxy-prod\.mjs/.test(psCmd) || /susumai-proxy/.test(psCmd),
      `想定外の ps コマンドライン: ${psCmd}`,
    );

    // rehearse の第1段判定に食わせる: 「rehearsal proxy と判定されない」こと。
    const verdict = classifyProxyListener(psCmd);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.halt, true);
  } finally {
    child.kill('SIGKILL');
    await new Promise((res) => child.once('exit', res)).catch(() => {});
  }
});
