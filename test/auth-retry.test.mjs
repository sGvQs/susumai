import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const { withAuthRetry, describeAuthStatus, resetAuthRetryState } = await import('../src/index.ts');
const { AuthError } = await import('../src/errors.ts');
const { saveCredentials } = await import('../src/credentials.ts');
const { chatStream, checkHealth } = await import('../src/client.ts');

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-retry-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function stubFetch(handler) {
  const real = globalThis.fetch;
  const state = { calls: 0, restore: () => (globalThis.fetch = real) };
  globalThis.fetch = async (url) => {
    state.calls += 1;
    assert.equal(String(url), TOKEN_URL);
    return new Response(JSON.stringify(handler()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return state;
}

function refreshableCreds() {
  return {
    github: {
      token: 'gho_old',
      login: 'octocat',
      id: 1,
      obtainedAt: new Date().toISOString(),
      refreshToken: 'ghr_old',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      clientId: 'Ov23liTEST',
    },
  };
}
const OK_GRANT = { access_token: 'gho_new', refresh_token: 'ghr_new', expires_in: 28800 };

// --- withAuthRetry -----------------------------------------------------

// withAuthRetry はプロセス内フラグ（refresh 最大1回）を持つ。テスト間でリセットする。
beforeEach(() => resetAuthRetryState());

test('withAuthRetry: 成功はそのまま透過（op は1回）', async () => {
  let calls = 0;
  const r = await withAuthRetry({ token: 't' }, async () => {
    calls += 1;
    return 42;
  });
  assert.equal(r, 42);
  assert.equal(calls, 1);
});

test('withAuthRetry: AuthError ＋ refresh 成功 → op を1回だけリトライ', async () => {
  await withTempConfig(async () => {
    saveCredentials(refreshableCreds());
    const f = stubFetch(() => OK_GRANT);
    try {
      const cfg = { model: 'm', numCtx: 1, stream: true, token: 'gho_old' };
      let calls = 0;
      const r = await withAuthRetry(cfg, async () => {
        calls += 1;
        if (calls === 1) throw new AuthError('認証に失敗しました (401)。');
        return `ok(${cfg.token})`;
      });
      assert.equal(calls, 2);
      assert.equal(r, 'ok(gho_new)');
      assert.equal(f.calls, 1);
    } finally {
      f.restore();
    }
  });
});

test('withAuthRetry: AuthError ＋ refresh 不能 → 元の AuthError を再送出（op は1回）', async () => {
  await withTempConfig(async () => {
    // credentials.json 無し → tryRefresh は false
    const cfg = { model: 'm', numCtx: 1, stream: true, token: 't' };
    let calls = 0;
    const err = new AuthError('boom-401');
    await assert.rejects(
      withAuthRetry(cfg, async () => {
        calls += 1;
        throw err;
      }),
      (e) => e === err,
    );
    assert.equal(calls, 1);
  });
});

test('withAuthRetry: AuthError 2連発 → リトライは1回で打ち止め（2度目の例外を伝播）', async () => {
  await withTempConfig(async () => {
    saveCredentials(refreshableCreds());
    const f = stubFetch(() => OK_GRANT);
    try {
      const cfg = { model: 'm', numCtx: 1, stream: true, token: 'gho_old' };
      let calls = 0;
      await assert.rejects(
        withAuthRetry(cfg, async () => {
          calls += 1;
          throw new AuthError(`fail#${calls}`);
        }),
        /fail#2/,
      );
      assert.equal(calls, 2);
    } finally {
      f.restore();
    }
  });
});

test('withAuthRetry: 401 持続時、1操作チェーン内で refresh POST は最大1回（起動シーケンスの3段が共有）', async () => {
  await withTempConfig(async () => {
    saveCredentials(refreshableCreds());
    const f = stubFetch(() => OK_GRANT);
    try {
      const cfg = { model: 'm', numCtx: 1, stream: true, token: 'gho_old' };
      const alwaysAuthFail = async () => {
        throw new AuthError('認証に失敗しました (401)。');
      };
      // 起動シーケンス（checkHealth → warmup → 初回ターン）は resetAuthRetryState を挟まない。
      // 1段目: refresh を1回試す → op 2回目も 401 → 伝播
      await assert.rejects(withAuthRetry(cfg, alwaysAuthFail), (e) => e instanceof AuthError);
      assert.equal(f.calls, 1);
      // 2段目（warmup 相当）: フラグ済み → refresh を試さず即 AuthError
      await assert.rejects(withAuthRetry(cfg, alwaysAuthFail), (e) => e instanceof AuthError);
      assert.equal(f.calls, 1, 'refresh POST は増えない');
      // 3段目（streamAnswer 相当）
      await assert.rejects(withAuthRetry(cfg, alwaysAuthFail), (e) => e instanceof AuthError);
      assert.equal(f.calls, 1);
    } finally {
      f.restore();
    }
  });
});

test('withAuthRetry: REPL の各ターンは独立した refresh 予算を持つ（resetAuthRetryState で回復）', async () => {
  await withTempConfig(async () => {
    saveCredentials(refreshableCreds());
    const f = stubFetch(() => OK_GRANT);
    try {
      const cfg = { model: 'm', numCtx: 1, stream: true, token: 'gho_old' };
      const alwaysAuthFail = async () => {
        throw new AuthError('認証に失敗しました (401)。');
      };
      // ターン1: refresh を1回試して失敗（op が 401 を吐き続ける）
      await assert.rejects(withAuthRetry(cfg, alwaysAuthFail), (e) => e instanceof AuthError);
      assert.equal(f.calls, 1);
      // ターン2: runRepl が各ターン先頭で呼ぶのと同じ。予算が戻る。
      resetAuthRetryState();
      await assert.rejects(withAuthRetry(cfg, alwaysAuthFail), (e) => e instanceof AuthError);
      assert.equal(f.calls, 2, 'ターン2 は独立に refresh を試す');
      // ターン3: 別シェルで susumai login 済みを想定 → refresh 成功でターンが通る
      resetAuthRetryState();
      let n = 0;
      const okOnRetry = async () => {
        n += 1;
        if (n === 1) throw new AuthError('認証に失敗しました (401)。');
        return `ok(${cfg.token})`;
      };
      assert.equal(await withAuthRetry(cfg, okOnRetry), 'ok(gho_new)');
      assert.equal(f.calls, 3);
    } finally {
      f.restore();
    }
  });
});

test('withAuthRetry: 非 AuthError → refresh せず即再送出', async () => {
  const f = stubFetch(() => OK_GRANT);
  try {
    const boom = new Error('not-auth');
    let calls = 0;
    await assert.rejects(
      withAuthRetry({ token: 't' }, async () => {
        calls += 1;
        throw boom;
      }),
      (e) => e === boom,
    );
    assert.equal(calls, 1);
    assert.equal(f.calls, 0);
  } finally {
    f.restore();
  }
});

// --- client 401 → AuthError -----------------------------------------

function start401Server() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"message":"unauthorized"}');
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

test('client: 401 は checkHealth / chatStream から AuthError で reject する', async () => {
  const srv = await start401Server();
  try {
    const cfg = { model: 'm', numCtx: 4096, stream: true, url: srv.url };
    await assert.rejects(checkHealth(cfg), (e) => e instanceof AuthError);
    await assert.rejects(
      (async () => {
        for await (const _ of chatStream(cfg, [{ role: 'user', content: 'hi' }])) void _;
      })(),
      (e) => e instanceof AuthError,
    );
  } finally {
    srv.close();
  }
});

// --- describeAuthStatus ---------------------------------------------

const NOW = new Date('2026-09-11T00:00:00.000Z');

test('describeAuthStatus: 未ログイン', () => {
  assert.deepEqual(describeAuthStatus(null, null, NOW), [
    'ログインしていません（`susumai login` でログインできます）',
    'config.json の token: なし',
  ]);
});

test('describeAuthStatus: refresh token あり（失効日つき）＋ config token あり', () => {
  const creds = {
    github: {
      token: 'gho', login: 'octocat', id: 583231, obtainedAt: 'x',
      refreshToken: 'ghr',
      expiresAt: new Date(NOW.getTime() + 8 * 3600_000).toISOString(),
      refreshTokenExpiresAt: '2027-03-10T00:00:00.000Z',
    },
  };
  assert.deepEqual(describeAuthStatus(creds, 'ghp_****abcd', NOW), [
    'ログイン済み: @octocat（id 583231）',
    `アクセストークン: ${creds.github.expiresAt} まで（残り約8時間）`,
    '自動更新: 有効（2027-03-10 まで）',
    'config.json の token: あり（ghp_****abcd）',
  ]);
});

test('describeAuthStatus: 旧形式（expiresAt / refreshToken 無し）', () => {
  const creds = { github: { token: 'gho', login: 'l', id: 1, obtainedAt: 'x' } };
  assert.deepEqual(describeAuthStatus(creds, null, NOW), [
    'ログイン済み: @l（id 1）',
    '有効期限: 不明（旧形式・再ログインで自動更新が有効になります）',
    '自動更新: なし（refresh token がありません）',
    'config.json の token: なし',
  ]);
});
