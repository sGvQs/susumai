import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { configHome, writeFileAtomic0600, readJsonFile } = await import('../src/xdg.ts');

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-xdg-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- configHome() ---------------------------------------------------------

test('configHome: XDG_CONFIG_HOME が設定されていればそれを絶対パス化して返す', () => {
  const prev = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-abs';
    assert.equal(configHome(), '/tmp/xdg-abs');
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test('configHome: 相対 XDG_CONFIG_HOME は resolve される', () => {
  const prev = process.env.XDG_CONFIG_HOME;
  try {
    process.env.XDG_CONFIG_HOME = 'rel/dir';
    assert.equal(configHome(), path.resolve('rel/dir'));
    assert.ok(path.isAbsolute(configHome()));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

test('configHome: XDG_CONFIG_HOME 未設定なら ~/.config', () => {
  const prev = process.env.XDG_CONFIG_HOME;
  try {
    delete process.env.XDG_CONFIG_HOME;
    assert.equal(configHome(), path.resolve(path.join(os.homedir(), '.config')));
  } finally {
    if (prev === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prev;
  }
});

// --- writeFileAtomic0600() ------------------------------------------------

test('writeFileAtomic0600: ファイルを 0600 で作る', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'a.json');
    writeFileAtomic0600(file, '{"x":1}\n');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"x":1}\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test('writeFileAtomic0600: 親ディレクトリを recursive に作成する', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'nested', 'deep', 'b.json');
    writeFileAtomic0600(file, 'hello');
    assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
});

test('writeFileAtomic0600: 既存ファイルを上書きし tmp を残さない', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'c.json');
    fs.writeFileSync(file, 'old', { mode: 0o644 });
    writeFileAtomic0600(file, 'new');
    assert.equal(fs.readFileSync(file, 'utf8'), 'new');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });
});

// --- readJsonFile() ------------------------------------------------------

test('readJsonFile: 存在しない → missing', () => {
  withTempDir((dir) => {
    const r = readJsonFile(path.join(dir, 'nope.json'));
    assert.equal(r.status, 'missing');
    assert.equal(r.value, undefined);
  });
});

test('readJsonFile: 不正な JSON → invalid-json', () => {
  withTempDir((dir) => {
    const file = path.join(dir, 'bad.json');
    fs.writeFileSync(file, '{ not json');
    const r = readJsonFile(file);
    assert.equal(r.status, 'invalid-json');
    assert.equal(r.value, undefined);
  });
});

test('readJsonFile: パース成功 → ok ＋ value（非オブジェクトでも ok を返す）', () => {
  withTempDir((dir) => {
    const obj = path.join(dir, 'obj.json');
    fs.writeFileSync(obj, JSON.stringify({ a: 1 }));
    assert.deepEqual(readJsonFile(obj), { status: 'ok', value: { a: 1 } });

    const arr = path.join(dir, 'arr.json');
    fs.writeFileSync(arr, '[]');
    const r = readJsonFile(arr);
    assert.equal(r.status, 'ok');
    assert.deepEqual(r.value, []);

    const num = path.join(dir, 'num.json');
    fs.writeFileSync(num, '42');
    assert.deepEqual(readJsonFile(num), { status: 'ok', value: 42 });
  });
});
