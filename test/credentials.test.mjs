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
