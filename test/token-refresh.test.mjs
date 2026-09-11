import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { credentialsPath, loadCredentials, saveCredentials, refreshAuthTokenIfNeeded, tryRefresh, refreshAndPersist } =
  await import('../src/credentials.ts');
const { refreshAccessToken } = await import('../src/auth.ts');

const TOKEN_URL = 'https://github.com/login/oauth/access_token';

function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-refresh-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  return Promise.resolve(fn(dir)).finally(() => {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

/**
 * globalThis.fetch を差し替える。handler は (url, init) => { status?, json?, throwErr? } を返す。
 * TOKEN_URL 以外の fetch には落ちないよう明示エラーにする。返り値に calls 配列を持つ。
 */
function stubFetch(handler) {
  const real = globalThis.fetch;
  const state = { calls: [] };
  globalThis.fetch = async (url, init) => {
    state.calls.push({ url: String(url), body: init?.body ?? null });
    assert.equal(String(url), TOKEN_URL, `想定外の fetch: ${url}`);
    const r = handler(String(url), init);
    if (r.throwErr) throw r.throwErr;
    return new Response(JSON.stringify(r.json ?? {}), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  state.restore = () => {
    globalThis.fetch = real;
  };
  return state;
}

function nearExpiryCreds() {
  return {
    github: {
      token: 'gho_old',
      login: 'octocat',
      id: 583231,
      obtainedAt: new Date(Date.now() - 8 * 3600_000).toISOString(),
      refreshToken: 'ghr_old',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), // skew(10分) 内
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 3600_000).toISOString(),
      clientId: 'Ov23liTEST',
    },
  };
}

const OK_GRANT = {
  access_token: 'gho_new',
  refresh_token: 'ghr_new',
  expires_in: 28800,
  refresh_token_expires_in: 15897600,
  token_type: 'bearer',
};

test('refreshAuthTokenIfNeeded: 期限近接 → refresh・rotate 永続・cfg.token 更新・0600 維持', async () => {
  await withTempConfig(async () => {
    saveCredentials(nearExpiryCreds());
    const f = stubFetch(() => ({ json: OK_GRANT }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      await refreshAuthTokenIfNeeded(cfg);
      assert.equal(f.calls.length, 1);
      assert.match(f.calls[0].body, /grant_type=refresh_token/);
      assert.match(f.calls[0].body, /refresh_token=ghr_old/);
      assert.equal(cfg.token, 'gho_new');
      const saved = loadCredentials();
      assert.equal(saved.github.token, 'gho_new');
      assert.equal(saved.github.refreshToken, 'ghr_new'); // ローテート済み
      assert.equal(saved.github.login, 'octocat'); // GET /user は叩かず再利用
      assert.equal(saved.github.id, 583231);
      assert.ok(saved.github.expiresAt > new Date().toISOString());
      assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600);
    } finally {
      f.restore();
    }
  });
});

test('refreshAuthTokenIfNeeded: 旧形式（refreshToken 無し）→ no-op（fetch を呼ばない）', async () => {
  await withTempConfig(async () => {
    const old = { github: { token: 'gho_x', login: 'l', id: 1, obtainedAt: 'x' } };
    saveCredentials(old);
    const f = stubFetch(() => ({ json: OK_GRANT }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_x' };
      await refreshAuthTokenIfNeeded(cfg);
      assert.equal(f.calls.length, 0);
      assert.equal(cfg.token, 'gho_x');
      assert.deepEqual(loadCredentials(), old);
    } finally {
      f.restore();
    }
  });
});

test('refreshAuthTokenIfNeeded: refresh 401（bad_refresh_token）→ ファイル無傷・cfg.token 不変', async () => {
  await withTempConfig(async () => {
    const before = nearExpiryCreds();
    saveCredentials(before);
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const f = stubFetch(() => ({ status: 400, json: { error: 'bad_refresh_token' } }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      await refreshAuthTokenIfNeeded(cfg); // 警告を出して続行、throw しない
      assert.equal(cfg.token, 'gho_old');
      assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), raw); // 無傷
    } finally {
      f.restore();
    }
  });
});

test('refreshAuthTokenIfNeeded: ネットワークエラー → 非致命（ファイル無傷・cfg.token 不変）', async () => {
  await withTempConfig(async () => {
    saveCredentials(nearExpiryCreds());
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const f = stubFetch(() => ({ throwErr: Object.assign(new Error('boom'), { code: 'ENOTFOUND' }) }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      await refreshAuthTokenIfNeeded(cfg);
      assert.equal(cfg.token, 'gho_old');
      assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), raw);
    } finally {
      f.restore();
    }
  });
});

test('tryRefresh: refreshToken 無し → false（fetch を呼ばない）', async () => {
  await withTempConfig(async () => {
    saveCredentials({ github: { token: 't', login: 'l', id: 1, obtainedAt: 'x' } });
    const f = stubFetch(() => ({ json: OK_GRANT }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 't' };
      assert.equal(await tryRefresh(cfg), false);
      assert.equal(f.calls.length, 0);
    } finally {
      f.restore();
    }
  });
});

test('tryRefresh: 成功 → true ＋ 永続（期限が遠くても 401 起点なので force で refresh）', async () => {
  await withTempConfig(async () => {
    const creds = nearExpiryCreds();
    creds.github.expiresAt = new Date(Date.now() + 7 * 3600_000).toISOString(); // まだ遠い
    saveCredentials(creds);
    const f = stubFetch(() => ({ json: OK_GRANT }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      assert.equal(await tryRefresh(cfg), true);
      assert.equal(f.calls.length, 1);
      assert.equal(cfg.token, 'gho_new');
      assert.equal(loadCredentials().github.refreshToken, 'ghr_new');
    } finally {
      f.restore();
    }
  });
});

test('tryRefresh: invalid_grant → false ＋ ファイル無傷', async () => {
  await withTempConfig(async () => {
    saveCredentials(nearExpiryCreds());
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const f = stubFetch(() => ({ status: 400, json: { error: 'bad_refresh_token' } }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      assert.equal(await tryRefresh(cfg), false);
      assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), raw);
    } finally {
      f.restore();
    }
  });
});

test('refreshAccessToken: fetch タイムアウト（AbortSignal 発火）→ 例外', async () => {
  const real = globalThis.fetch;
  // signal を尊重して abort で reject するが、それ以外では永久に解決しない fetch。
  // AbortSignal.timeout() の内部タイマーは unref（プロセスを生かし続けない）なので、
  // このテストの間イベントループを維持する ref 付きタイマーを別途持つ。無いと、
  // 発火前に「イベントループが空」と判定されてテストごと cancel される
  // （Node 22 で再現。Node 24 では起きないバージョン依存の挙動）。
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const keepAlive = setInterval(() => {}, 1000);
      init.signal.addEventListener('abort', () => {
        clearInterval(keepAlive);
        reject(init.signal.reason ?? new Error('aborted'));
      });
    });
  try {
    await assert.rejects(
      refreshAccessToken('ghr_old', 'Ov23liTEST', 20),
      /到達できません/,
    );
  } finally {
    globalThis.fetch = real;
  }
});

test('refreshAuthTokenIfNeeded: refresh タイムアウト（TimeoutError）→ 非致命・ファイル無傷・cfg.token 不変', async () => {
  await withTempConfig(async () => {
    saveCredentials(nearExpiryCreds());
    const raw = fs.readFileSync(credentialsPath(), 'utf8');
    const f = stubFetch(() => ({
      throwErr: Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    }));
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      await refreshAuthTokenIfNeeded(cfg); // throw しない
      assert.equal(cfg.token, 'gho_old');
      assert.equal(fs.readFileSync(credentialsPath(), 'utf8'), raw);
    } finally {
      f.restore();
    }
  });
});

test('doRefresh: fetch 中に logout（credentials.json 削除）→ 保存せず bail・ファイルは復活しない', async () => {
  await withTempConfig(async () => {
    saveCredentials(nearExpiryCreds());
    const f = stubFetch(() => {
      // GitHub 応答が返る直前に logout が起きたシナリオ
      fs.rmSync(credentialsPath(), { force: true });
      return { json: OK_GRANT };
    });
    try {
      const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      const result = await refreshAndPersist(cfg, { force: true });
      assert.equal(result, false);
      assert.equal(fs.existsSync(credentialsPath()), false, 'credentials.json は復活しない');
      assert.equal(cfg.token, 'gho_old', 'cfg.token は差し替えない');
      assert.equal(f.calls.length, 1);
    } finally {
      f.restore();
    }
  });
});

test('ロック競合: refreshAndPersist 2並走 → HTTP refresh はちょうど1回・両者同じ新トークン・rotate 済み', async () => {
  await withTempConfig(async () => {
    saveCredentials(nearExpiryCreds());
    let n = 0;
    const f = stubFetch(() => {
      n += 1;
      // 2回目以降が呼ばれたら（rotate 済み refresh token の再使用）検知できるよう別トークンを返す
      return {
        json: n === 1
          ? OK_GRANT
          : { access_token: `gho_dup${n}`, refresh_token: `ghr_dup${n}`, expires_in: 28800 },
      };
    });
    try {
      const cfg1 = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      const cfg2 = { model: 'm', numCtx: 4096, stream: true, token: 'gho_old' };
      await Promise.all([refreshAndPersist(cfg1, {}), refreshAndPersist(cfg2, {})]);
      assert.equal(f.calls.length, 1, 'HTTP refresh は1回だけ');
      assert.equal(cfg1.token, 'gho_new');
      assert.equal(cfg2.token, 'gho_new');
      const saved = loadCredentials();
      assert.equal(saved.github.token, 'gho_new');
      assert.equal(saved.github.refreshToken, 'ghr_new');
      assert.equal(fs.existsSync(credentialsPath() + '.lock'), false, 'ロックは解放済み');
    } finally {
      f.restore();
    }
  });
});
