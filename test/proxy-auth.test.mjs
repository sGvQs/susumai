import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const {
  BUILTIN_ALLOWLIST,
  parseBearer,
  looksLikeToken,
  parseAllowlist,
  matchAllowlist,
  cacheFresh,
  tokenBucketStep,
  rollingCapStep,
  rateLimitKey,
  isAllowed,
  buildConfig,
  ConfigError,
  makeState,
  authenticate,
} = await import('../rehearsal/proxy.mjs');

// --- parseBearer ---------------------------------------------------------

test('parseBearer: Bearer トークンを抽出（スキーム名は大小無視）', () => {
  assert.equal(parseBearer('Bearer abc123'), 'abc123');
  assert.equal(parseBearer('bearer abc123'), 'abc123');
  assert.equal(parseBearer('  BEARER   tok  '), 'tok');
});

test('parseBearer: 欠落・別スキームは null', () => {
  assert.equal(parseBearer(undefined), null);
  assert.equal(parseBearer(''), null);
  assert.equal(parseBearer('Basic abc'), null);
  assert.equal(parseBearer('Bearer'), null);
});

// --- looksLikeToken（形状プレフィルタ）----------------------------------

test('looksLikeToken: classic PAT (40 hex) を受ける', () => {
  assert.equal(looksLikeToken('a'.repeat(40)), true);
  assert.equal(looksLikeToken('0123456789abcdef0123456789abcdef01234567'), true);
});

test('looksLikeToken: prefixed / fine-grained を受ける', () => {
  assert.equal(looksLikeToken('ghp_' + 'A'.repeat(36)), true);
  assert.equal(looksLikeToken('gho_' + 'a1B2'.repeat(9)), true);
  assert.equal(looksLikeToken('github_pat_' + 'A'.repeat(30)), true);
});

test('looksLikeToken: ghp_ ＋ PAT と同じ文字数・文字集合のランダム文字列は通す（自明経路検証を避ける）', () => {
  assert.equal(looksLikeToken('ghp_' + 'x9Kd2Lm4Np8Qr1St5Uv7Wx0Yz3Ab6Cd9Ef2G'), true);
  assert.equal(looksLikeToken('deadbeefcafebabe0123456789abcdefdeadbeef'), true);
});

test('looksLikeToken: garbage / 空白付き / 極端な長さは弾く', () => {
  assert.equal(looksLikeToken('garbage'), false);
  assert.equal(looksLikeToken(''), false);
  assert.equal(looksLikeToken('  ' + 'a'.repeat(40)), false);
  assert.equal(looksLikeToken('a'.repeat(40) + '  '), false);
  assert.equal(looksLikeToken('x'.repeat(300)), false);
  assert.equal(looksLikeToken('ABCDEF0123456789ABCDEF0123456789ABCDEF01'), false); // 大文字 hex は classic PAT 形ではない
  assert.equal(looksLikeToken(42), false);
});

// --- parseAllowlist -----------------------------------------------------

test('parseAllowlist: 正常な配列を正規化する', () => {
  const out = parseAllowlist('[{"id": 123, "login": "a", "note": "x"}, {"id": "456"}]');
  assert.deepEqual(out, [
    { id: 123, login: 'a', note: 'x' },
    { id: 456, login: '', note: '' },
  ]);
});

test('parseAllowlist: 空配列 OK', () => {
  assert.deepEqual(parseAllowlist('[]'), []);
});

test('parseAllowlist: 非配列・非整数 id・非オブジェクト要素は throw', () => {
  assert.throws(() => parseAllowlist('{}'));
  assert.throws(() => parseAllowlist('[{"id": "abc"}]'));
  assert.throws(() => parseAllowlist('[{"id": 0}]'));
  assert.throws(() => parseAllowlist('[{"id": -5}]'));
  assert.throws(() => parseAllowlist('[123]'));
  assert.throws(() => parseAllowlist('not json'));
});

// --- matchAllowlist ---------------------------------------------------

test('matchAllowlist: 数値 id で照合（文字列 id も coerce）', () => {
  const entries = [{ id: 10, login: 'x' }, { id: 20, login: 'y' }];
  assert.equal(matchAllowlist(entries, 20).login, 'y');
  assert.equal(matchAllowlist(entries, '20').login, 'y');
  assert.equal(matchAllowlist(entries, 999), null);
  assert.equal(matchAllowlist(entries, 'nope'), null);
  assert.equal(matchAllowlist(undefined, 10), null);
});

// --- cacheFresh -------------------------------------------------------

test('cacheFresh: expiresAt が nowMs より先なら true', () => {
  assert.equal(cacheFresh({ expiresAt: 1000 }, 999), true);
  assert.equal(cacheFresh({ expiresAt: 1000 }, 1000), false);
  assert.equal(cacheFresh({ expiresAt: 1000 }, 1001), false);
  assert.equal(cacheFresh(undefined, 0), false);
  assert.equal(cacheFresh({}, 0), false);
});

// --- tokenBucketStep -------------------------------------------------

test('tokenBucketStep: 初回は満杯から 1 消費', () => {
  const r = tokenBucketStep(undefined, 0, { capacity: 3, refillPerMs: 0 });
  assert.equal(r.allowed, true);
  assert.equal(r.bucket.tokens, 2);
});

test('tokenBucketStep: 使い切ると allowed:false', () => {
  const opts = { capacity: 2, refillPerMs: 0 };
  let b;
  let r = tokenBucketStep(b, 0, opts);
  r = tokenBucketStep(r.bucket, 0, opts);
  assert.equal(r.allowed, true);
  r = tokenBucketStep(r.bucket, 0, opts);
  assert.equal(r.allowed, false);
  assert.equal(r.bucket.tokens < 1, true);
});

test('tokenBucketStep: 時間経過で補充される（capacity で頭打ち）', () => {
  const opts = { capacity: 5, refillPerMs: 1 / 1000 }; // 毎秒 1
  let r = tokenBucketStep({ tokens: 0, ts: 0 }, 3000, opts); // 3s で 3 補充
  assert.equal(r.allowed, true);
  assert.equal(Math.round(r.bucket.tokens), 2);
  r = tokenBucketStep({ tokens: 0, ts: 0 }, 999999, opts);
  assert.equal(r.bucket.tokens, 4); // capacity-1 で頭打ち
});

// --- rollingCapStep -------------------------------------------------

test('rollingCapStep: limit 未満なら記録して allowed', () => {
  const r = rollingCapStep([100, 200], 1000, 3600_000, 5);
  assert.equal(r.allowed, true);
  assert.deepEqual(r.hits, [100, 200, 1000]);
});

test('rollingCapStep: limit 到達で allowed:false（記録しない）', () => {
  const r = rollingCapStep([1, 2, 3], 1000, 3600_000, 3);
  assert.equal(r.allowed, false);
  assert.deepEqual(r.hits, [1, 2, 3]);
});

test('rollingCapStep: 窓外の古い呼び出しは捨てる', () => {
  const now = 10_000_000;
  const r = rollingCapStep([1, 2, now - 10], now, 3600_000, 3);
  assert.equal(r.allowed, true);
  assert.deepEqual(r.hits, [now - 10, now]);
});

// --- rateLimitKey -------------------------------------------------

test('rateLimitKey: CF-Connecting-IP のみ使う。無ければ "local"', () => {
  assert.equal(rateLimitKey({ 'cf-connecting-ip': '203.0.113.7' }), '203.0.113.7');
  assert.equal(rateLimitKey({ 'x-forwarded-for': '1.2.3.4' }), 'local');
  assert.equal(rateLimitKey({}), 'local');
  assert.equal(rateLimitKey({ 'cf-connecting-ip': '  ' }), 'local');
});

// --- isAllowed（HTTP パス許可リスト。段階0 から不変）--------------------

test('isAllowed: chat / tags のみ', () => {
  assert.equal(isAllowed('POST', '/api/chat'), true);
  assert.equal(isAllowed('GET', '/api/tags'), true);
  assert.equal(isAllowed('POST', '/api/pull'), false);
  assert.equal(isAllowed('GET', '/api/chat'), false);
});

// --- buildConfig -------------------------------------------------

function withAllowlistFile(entries, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-al-'));
  const file = path.join(dir, 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify(entries));
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('buildConfig: bearer のみ → bearerDigest あり / github モード OFF', () => {
  const c = buildConfig({ SUSUMAI_TOKEN: 'shhh' });
  assert.equal(Buffer.isBuffer(c.bearerDigest), true);
  assert.equal(c.githubMode, false);
  assert.deepEqual(c.allowlist, []);
});

test('buildConfig: SUSUMAI_ALLOWLIST 指定 → 組み込み既定 ＋ ファイルをマージ', () => {
  withAllowlistFile([{ id: 555, login: 'extra', note: 'teammate' }], (file) => {
    const c = buildConfig({ SUSUMAI_ALLOWLIST: file });
    assert.equal(c.githubMode, true);
    assert.equal(c.bearerDigest, null);
    assert.equal(matchAllowlist(c.allowlist, BUILTIN_ALLOWLIST[0].id).login, 'sGvQs');
    assert.equal(matchAllowlist(c.allowlist, 555).login, 'extra');
  });
});

test('buildConfig: env override（TTL / 上限）が効く', () => {
  const c = buildConfig({ SUSUMAI_TOKEN: 't', SUSUMAI_GH_HOURLY_CAP: '7', SUSUMAI_POS_CACHE_TTL_SEC: '10' });
  assert.equal(c.limits.ghHourlyCap, 7);
  assert.equal(c.limits.posTtlMs, 10_000);
});

// --- buildConfig: fail-closed 経路（process.exit ではなく ConfigError を throw）---

test('buildConfig fail-closed: 両モード未設定 → ConfigError', () => {
  assert.throws(() => buildConfig({}), ConfigError);
});

test('buildConfig fail-closed: allowlist が不正 JSON → ConfigError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-al-'));
  const file = path.join(dir, 'allowlist.json');
  fs.writeFileSync(file, '{ not json');
  try {
    assert.throws(() => buildConfig({ SUSUMAI_ALLOWLIST: file }), ConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildConfig fail-closed: allowlist の id が非整数 → ConfigError', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-al-'));
  const file = path.join(dir, 'allowlist.json');
  fs.writeFileSync(file, JSON.stringify([{ id: 'not-a-number', login: 'x' }]));
  try {
    assert.throws(() => buildConfig({ SUSUMAI_ALLOWLIST: file }), ConfigError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildConfig fail-closed: allowlist ファイルが読めない → ConfigError', () => {
  assert.throws(
    () => buildConfig({ SUSUMAI_ALLOWLIST: '/no/such/path/allowlist.json' }),
    ConfigError,
  );
});

test('buildConfig fail-closed: 数値 env が非正数 → ConfigError', () => {
  assert.throws(
    () => buildConfig({ SUSUMAI_TOKEN: 't', SUSUMAI_GH_HOURLY_CAP: '-1' }),
    ConfigError,
  );
});

// --- authenticate（OR ロジック / 公開耐性。fetchUser を注入して疎通）--------

const LIMITS = {
  rlCapacity: 3,
  rlRefillPerMs: 0,
  ghHourlyCap: 5,
  posTtlMs: 3600_000,
  negTtlMs: 120_000,
  ghTimeoutMs: 8000,
  ghBackoffMs: 0,
};

function ghConfig(allowlist) {
  return { bearerDigest: null, githubMode: true, allowlist, limits: LIMITS };
}

// bearer 用 config を作るヘルパ（sha256 は proxy と同じ）
const crypto = (await import('node:crypto')).default;
function bearerCfg(token, githubMode = false, allowlist = []) {
  return {
    bearerDigest: crypto.createHash('sha256').update(token, 'utf8').digest(),
    githubMode,
    allowlist,
    limits: LIMITS,
  };
}

const noDeps = (fetchUser) => ({ now: () => 1_000_000, sleep: async () => {}, fetchUser });

test('authenticate: bearer 一致 → ok(bearer)', async () => {
  const v = await authenticate(bearerCfg('secret'), makeState(), { authorization: 'Bearer secret' }, noDeps());
  assert.deepEqual(v, { ok: true, mode: 'bearer' });
});

test('authenticate: bearer 不一致で github モードでない → 401', async () => {
  const v = await authenticate(bearerCfg('secret'), makeState(), { authorization: 'Bearer wrong' }, noDeps());
  assert.equal(v.ok, false);
  assert.equal(v.status, 401);
});

test('authenticate: Authorization 欠落 → 401', async () => {
  const v = await authenticate(ghConfig([]), makeState(), {}, noDeps());
  assert.equal(v.status, 401);
});

test('authenticate: github・許可リストにある id → ok(github) ＋ 正キャッシュに載る', async () => {
  const st = makeState();
  const cfg = ghConfig([{ id: 97923717, login: 'sGvQs' }]);
  let calls = 0;
  const fetchUser = async () => {
    calls++;
    return { kind: 'response', status: 200, body: JSON.stringify({ id: 97923717, login: 'sGvQs' }) };
  };
  const tok = 'ghp_' + 'A'.repeat(36);
  let v = await authenticate(cfg, st, { authorization: `Bearer ${tok}` }, noDeps(fetchUser));
  assert.deepEqual(v, { ok: true, mode: 'github' });
  // 2 回目は正キャッシュから（fetchUser を呼ばない）
  v = await authenticate(cfg, st, { authorization: `Bearer ${tok}` }, noDeps(fetchUser));
  assert.equal(v.ok, true);
  assert.equal(calls, 1);
});

test('authenticate: github・許可リスト外の id → 403 deny:user', async () => {
  const cfg = ghConfig([{ id: 97923717, login: 'sGvQs' }]);
  const fetchUser = async () => ({ kind: 'response', status: 200, body: JSON.stringify({ id: 1, login: 'stranger' }) });
  const v = await authenticate(cfg, makeState(), { authorization: `Bearer ${'a'.repeat(40)}` }, noDeps(fetchUser));
  assert.equal(v.status, 403);
  assert.equal(v.code, 'deny:user');
});

test('authenticate: github・形状プレフィルタ落ち → 401（API を叩かない）', async () => {
  let called = false;
  const fetchUser = async () => {
    called = true;
    return { kind: 'response', status: 200, body: '{}' };
  };
  const v = await authenticate(ghConfig([]), makeState(), { authorization: 'Bearer garbage' }, noDeps(fetchUser));
  assert.equal(v.status, 401);
  assert.equal(called, false);
});

test('authenticate: GitHub 401 → 401 ＋ 負キャッシュ（2 回目は API を叩かない）', async () => {
  const st = makeState();
  const cfg = ghConfig([]);
  let calls = 0;
  const fetchUser = async () => {
    calls++;
    return { kind: 'response', status: 401, body: '{"message":"Bad credentials"}' };
  };
  const tok = 'ghp_' + 'B'.repeat(36);
  let v = await authenticate(cfg, st, { authorization: `Bearer ${tok}` }, noDeps(fetchUser));
  assert.equal(v.status, 401);
  v = await authenticate(cfg, st, { authorization: `Bearer ${tok}` }, noDeps(fetchUser));
  assert.equal(v.status, 401);
  assert.equal(calls, 1);
});

test('authenticate: GitHub 到達不能 → 503 deny:ghdown（キャッシュしない）', async () => {
  const st = makeState();
  const cfg = ghConfig([{ id: 5, login: 'x' }]);
  const fetchUser = async () => ({ kind: 'error' });
  const tok = 'ghp_' + 'C'.repeat(36);
  const v = await authenticate(cfg, st, { authorization: `Bearer ${tok}` }, noDeps(fetchUser));
  assert.equal(v.status, 503);
  assert.equal(v.code, 'deny:ghdown');
  assert.equal(st.posCache.size, 0);
  assert.equal(st.negCache.size, 0);
});

test('authenticate: GitHub 5xx → 503 deny:ghdown', async () => {
  const fetchUser = async () => ({ kind: 'response', status: 502, body: '' });
  const v = await authenticate(ghConfig([]), makeState(), { authorization: `Bearer ${'d'.repeat(40)}` }, noDeps(fetchUser));
  assert.equal(v.status, 503);
  assert.equal(v.code, 'deny:ghdown');
});

test('authenticate: GitHub 200 だが id 欠落/不正 → 503 deny:ghdown（403 deny:user にしない・キャッシュしない）', async () => {
  const cfg = ghConfig([{ id: 97923717, login: 'sGvQs' }]);
  const tok = 'ghp_' + 'H'.repeat(36);
  for (const body of ['{"login":"x"}', '{"id":null,"login":"x"}', '{"id":0}', '{"id":"abc"}', '{"id":-3}']) {
    const st = makeState(); // 経路ごとに独立させる（レート制限の巻き込みを避ける）
    const v = await authenticate(
      cfg,
      st,
      { authorization: `Bearer ${tok}` },
      noDeps(async () => ({ kind: 'response', status: 200, body })),
    );
    assert.equal(v.status, 503, `body=${body}`);
    assert.equal(v.code, 'deny:ghdown', `body=${body}`);
    assert.equal(st.posCache.size, 0, `body=${body} は正キャッシュに載せない`);
    assert.equal(st.negCache.size, 0, `body=${body} は負キャッシュに載せない`);
  }
});

test('authenticate: グローバル時間上限超過 → 未キャッシュは 503 deny:ghcap / 正キャッシュ済みは通す', async () => {
  const cfg = ghConfig([{ id: 42, login: 'ok' }]);
  const st = makeState();
  // 正キャッシュを 1 件仕込む
  const goodTok = 'ghp_' + 'G'.repeat(36);
  const goodKey = crypto.createHash('sha256').update(goodTok, 'utf8').digest('hex');
  st.posCache.set(goodKey, { id: 42, login: 'ok', expiresAt: 2_000_000 });
  // 時間窓を上限まで埋める
  st.ghHits = Array.from({ length: LIMITS.ghHourlyCap }, (_, i) => 1_000_000 - i);
  const fetchUser = async () => {
    throw new Error('should not call GitHub when cap reached');
  };
  // 未キャッシュ → deny:ghcap
  let v = await authenticate(cfg, st, { authorization: `Bearer ${'e'.repeat(40)}` }, noDeps(fetchUser));
  assert.equal(v.status, 503);
  assert.equal(v.code, 'deny:ghcap');
  // 正キャッシュ済み → ok
  v = await authenticate(cfg, st, { authorization: `Bearer ${goodTok}` }, noDeps(fetchUser));
  assert.equal(v.ok, true);
});

test('authenticate: 同一 CF-Connecting-IP のレート超過 → 429 deny:ratelimit', async () => {
  const cfg = ghConfig([{ id: 9, login: 'z' }]);
  const st = makeState();
  const fetchUser = async () => ({ kind: 'response', status: 200, body: JSON.stringify({ id: 9, login: 'z' }) });
  const headersFor = (n) => ({
    authorization: `Bearer ghp_${String(n).padStart(36, '0')}`,
    'cf-connecting-ip': '198.51.100.5',
  });
  // capacity=3 → 3 回は通る（毎回別トークンで cache miss）
  for (let i = 0; i < LIMITS.rlCapacity; i++) {
    const v = await authenticate(cfg, st, headersFor(i), noDeps(fetchUser));
    assert.equal(v.ok, true, `call ${i} should pass`);
  }
  const v = await authenticate(cfg, st, headersFor(99), noDeps(fetchUser));
  assert.equal(v.status, 429);
  assert.equal(v.code, 'deny:ratelimit');
});

test('authenticate: bearer モード＋github モード併用。bearer 不一致でも gh トークンで通る', async () => {
  const cfg = bearerCfg('shared', true, [{ id: 7, login: 'gh' }]);
  const fetchUser = async () => ({ kind: 'response', status: 200, body: JSON.stringify({ id: 7, login: 'gh' }) });
  const v = await authenticate(cfg, makeState(), { authorization: `Bearer ${'f'.repeat(40)}` }, noDeps(fetchUser));
  assert.deepEqual(v, { ok: true, mode: 'github' });
});
