import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mod = await import('../src/config.ts');

function withTempConfig(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-cfg-'));
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

test('設定欠損時は既定値を返す', () => {
  withTempConfig(() => {
    const cfg = mod.loadConfig();
    assert.equal(cfg.model, 'deepseek-r1:8b');
    assert.equal(cfg.numCtx, 16384);
    assert.equal(cfg.stream, true);
    assert.equal(cfg.url, undefined);
    assert.equal(cfg.token, undefined);
  });
});

test('saveConfig はファイルを 0600 で作る', () => {
  withTempConfig(() => {
    const cfg = mod.loadConfig();
    cfg.url = 'https://example.trycloudflare.com';
    mod.saveConfig(cfg);
    const mode = fs.statSync(mod.configPath()).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});

test('token はマスクされ、先頭4・末尾4だけ残る', () => {
  withTempConfig(() => {
    const cfg = mod.loadConfig();
    cfg.token = 'ABCD0123456789WXYZ';
    mod.saveConfig(cfg);
    const masked = mod.maskedConfig(mod.loadConfig());
    assert.equal(typeof masked.token, 'string');
    assert.ok(masked.token.startsWith('ABCD'));
    assert.ok(masked.token.endsWith('WXYZ'));
    assert.ok(!masked.token.includes('0123456789'));
    assert.equal(masked.token.length, cfg.token.length);
  });
});

function captureStderr(fn) {
  const orig = process.stderr.write.bind(process.stderr);
  let out = '';
  process.stderr.write = (s) => {
    out += s;
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = orig;
  }
  return out;
}

for (const [label, body] of [
  ['null', 'null'],
  ['配列', '[]'],
  ['数値', '42'],
]) {
  test(`壊れた設定（${label} — 妥当な JSON だが非オブジェクト）は警告して既定値`, () => {
    withTempConfig((dir) => {
      const file = path.join(dir, 'susumai', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
      let cfg;
      const err = captureStderr(() => {
        cfg = mod.loadConfig();
      });
      assert.match(err, /設定ファイルが壊れています/);
      assert.deepEqual(cfg, { ...mod.DEFAULT_CONFIG });
    });
  });
}

test('壊れた設定（不正な JSON）は警告して既定値', () => {
  withTempConfig((dir) => {
    const file = path.join(dir, 'susumai', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    let cfg;
    const err = captureStderr(() => {
      cfg = mod.loadConfig();
    });
    assert.match(err, /不正な JSON/);
    assert.deepEqual(cfg, { ...mod.DEFAULT_CONFIG });
  });
});

test('numCtx: 正の整数はそのまま受理', () => {
  withTempConfig((dir) => {
    const file = path.join(dir, 'susumai', 'config.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ numCtx: 8192 }));
    let cfg;
    const err = captureStderr(() => {
      cfg = mod.loadConfig();
    });
    assert.equal(cfg.numCtx, 8192);
    assert.equal(err, '');
  });
});

for (const bad of [0, -1, -4096, 3.5, 'abc']) {
  test(`numCtx: 不正値（${String(bad)}）は警告して既定 16384`, () => {
    withTempConfig((dir) => {
      const file = path.join(dir, 'susumai', 'config.json');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ numCtx: bad }));
      let cfg;
      const err = captureStderr(() => {
        cfg = mod.loadConfig();
      });
      assert.equal(cfg.numCtx, 16384);
      assert.match(err, /numCtx が不正/);
    });
  });
}

test('assertUrl は URL 未設定で throw、設定済みで通る', () => {
  const cfg = { ...mod.DEFAULT_CONFIG };
  assert.throws(() => mod.assertUrl(cfg), /URL 未設定/);
  cfg.url = 'https://x.trycloudflare.com';
  assert.doesNotThrow(() => mod.assertUrl(cfg));
});
