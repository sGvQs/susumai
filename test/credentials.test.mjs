import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  credentialsPath,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
  resolveAuthToken,
  shouldRefresh,
  buildGithubCredentials,
  isLockStale,
  TOKEN_REFRESH_SKEW_MS,
} = await import('../src/credentials.ts');

function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-cred-'));
  const prev = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  try {
    return fn(dir);
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRaw(dir, text) {
  const file = path.join(dir, 'susumai', 'credentials.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

test('credentialsPath: config.json と同じディレクトリの credentials.json', () => {
  withTempConfig((dir) => {
    assert.equal(credentialsPath(), path.resolve(path.join(dir, 'susumai', 'credentials.json')));
  });
});

test('loadCredentials: ファイル無し → null', () => {
  withTempConfig(() => {
    assert.equal(loadCredentials(), null);
  });
});

test('loadCredentials: 壊れた JSON → null（throw しない）', () => {
  withTempConfig((dir) => {
    writeRaw(dir, '{ broken');
    assert.equal(loadCredentials(), null);
  });
});

test('loadCredentials: 非オブジェクト JSON → null', () => {
  withTempConfig((dir) => {
    writeRaw(dir, '[]');
    assert.equal(loadCredentials(), null);
  });
});

test('saveCredentials → loadCredentials 往復、0600 で書かれる', () => {
  withTempConfig(() => {
    const creds = {
      github: { token: 'gho_abc123', login: 'octocat', id: 583231, obtainedAt: '2026-09-08T00:00:00.000Z' },
    };
    saveCredentials(creds);
    assert.equal(fs.statSync(credentialsPath()).mode & 0o777, 0o600);
    assert.deepEqual(loadCredentials(), creds);
  });
});

test('deleteCredentials: 削除する。ファイルが無くてもエラーにしない', () => {
  withTempConfig(() => {
    deleteCredentials(); // 無い状態でも例外なし
    saveCredentials({ github: { token: 't', login: 'l', id: 1, obtainedAt: 'x' } });
    assert.ok(fs.existsSync(credentialsPath()));
    deleteCredentials();
    assert.equal(fs.existsSync(credentialsPath()), false);
  });
});

test('resolveAuthToken: credentials に github.token があれば cfg.token を上書き', () => {
  withTempConfig(() => {
    saveCredentials({ github: { token: 'gho_new', login: 'l', id: 1, obtainedAt: 'x' } });
    const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'old-config-token' };
    resolveAuthToken(cfg);
    assert.equal(cfg.token, 'gho_new');
  });
});

test('resolveAuthToken: credentials が無ければ cfg.token は不変', () => {
  withTempConfig(() => {
    const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'keep-me' };
    resolveAuthToken(cfg);
    assert.equal(cfg.token, 'keep-me');

    const cfg2 = { model: 'm', numCtx: 4096, stream: true };
    resolveAuthToken(cfg2);
    assert.equal(cfg2.token, undefined);
  });
});

test('resolveAuthToken: 壊れた credentials でも cfg.token は不変（フォールバック）', () => {
  withTempConfig((dir) => {
    writeRaw(dir, '{ broken');
    const cfg = { model: 'm', numCtx: 4096, stream: true, token: 'config-token' };
    resolveAuthToken(cfg);
    assert.equal(cfg.token, 'config-token');
  });
});

// --- shouldRefresh（純関数）------------------------------------------

const NOW = new Date('2026-09-11T00:00:00.000Z');
const iso = (ms) => new Date(NOW.getTime() + ms).toISOString();

test('shouldRefresh: refreshToken 無し → false', () => {
  assert.equal(shouldRefresh({ token: 't', login: 'l', id: 1, obtainedAt: 'x', expiresAt: iso(60_000) }, NOW), false);
  assert.equal(shouldRefresh(undefined, NOW), false);
});

test('shouldRefresh: expiresAt 無し（旧形式）→ false', () => {
  assert.equal(shouldRefresh({ token: 't', login: 'l', id: 1, obtainedAt: 'x', refreshToken: 'r' }, NOW), false);
});

test('shouldRefresh: 期限が skew より遠い → false / skew 内 → true', () => {
  const base = { token: 't', login: 'l', id: 1, obtainedAt: 'x', refreshToken: 'r' };
  assert.equal(shouldRefresh({ ...base, expiresAt: iso(TOKEN_REFRESH_SKEW_MS + 60_000) }, NOW), false);
  assert.equal(shouldRefresh({ ...base, expiresAt: iso(TOKEN_REFRESH_SKEW_MS - 60_000) }, NOW), true);
  assert.equal(shouldRefresh({ ...base, expiresAt: iso(-1000) }, NOW), true); // 既に失効
});

test('shouldRefresh: refreshTokenExpiresAt が経過済み → false', () => {
  const gh = {
    token: 't', login: 'l', id: 1, obtainedAt: 'x', refreshToken: 'r',
    expiresAt: iso(-1000),
    refreshTokenExpiresAt: iso(-500),
  };
  assert.equal(shouldRefresh(gh, NOW), false);
});

test('shouldRefresh: 不正な expiresAt → false（refresh 判定できない）', () => {
  const base = { token: 't', login: 'l', id: 1, obtainedAt: 'x', refreshToken: 'r' };
  assert.equal(shouldRefresh({ ...base, expiresAt: 'not-a-date' }, NOW), false);
});

test('shouldRefresh: 壊れた refreshTokenExpiresAt はブロックしない（不明扱い）', () => {
  const base = { token: 't', login: 'l', id: 1, obtainedAt: 'x', refreshToken: 'r' };
  // expiresAt は skew 内 / 失効済み。refreshTokenExpiresAt が壊れていても refresh は止めない。
  assert.equal(
    shouldRefresh({ ...base, expiresAt: iso(-1000), refreshTokenExpiresAt: 'nope' }, NOW),
    true,
  );
  assert.equal(
    shouldRefresh({ ...base, expiresAt: iso(60_000), refreshTokenExpiresAt: '' }, NOW),
    true,
  );
});

// --- buildGithubCredentials（純関数）-------------------------------

test('buildGithubCredentials: 秒 → ISO 変換、grant に無いフィールドは省略、clientId 付与', () => {
  const gh = buildGithubCredentials(
    { token: 'gho_new', refreshToken: 'ghr_new', expiresIn: 28800, refreshTokenExpiresIn: 15897600 },
    { login: 'octocat', id: 583231 },
    NOW,
    'Ov23liTEST',
  );
  assert.deepEqual(gh, {
    token: 'gho_new',
    login: 'octocat',
    id: 583231,
    obtainedAt: NOW.toISOString(),
    refreshToken: 'ghr_new',
    expiresAt: iso(28800 * 1000),
    refreshTokenExpiresAt: iso(15897600 * 1000),
    clientId: 'Ov23liTEST',
  });

  const minimal = buildGithubCredentials({ token: 'gho' }, { login: 'l', id: 1 }, NOW);
  assert.deepEqual(minimal, { token: 'gho', login: 'l', id: 1, obtainedAt: NOW.toISOString() });
});

// --- isLockStale（純関数・境界値）--------------------------------

test('isLockStale: nowMs - mtimeMs が staleMs 超で true（境界は false）', () => {
  assert.equal(isLockStale(0, 15000, 15000), false); // ちょうど → not stale
  assert.equal(isLockStale(0, 15001, 15000), true);
  assert.equal(isLockStale(0, 14999, 15000), false);
});
