/*
 * 段階2「達成の確認」(c) 公開耐性 / (d) 障害注入 の HTTP レベル統合テスト。
 *
 * 実 proxy プロセスに一番近い形で検証する:
 *   - `startServer({ port: 0 })` を実際に起動して OS 割り当ての空きポートに bind
 *     （github モードのみ）。既定 8787 を使わないのは、稼働中の本番/rehearse proxy が
 *     :8787 を握ったまま `npm test` が回っても衝突しないようにするため。
 *     クライアントは `server.address().port` の実ポートに向ける。
 *   - リクエストは本物の HTTP で proxy に投げ、本物の authenticate → isAllowed →
 *     forward パイプラインを通す。
 *   - `api.github.com` は叩かない: `https.request` をプロセス内で差し替え、api.github.com
 *     宛だけをローカルの「偽 GitHub」HTTP サーバへ向ける（/etc/hosts は使わない）。
 *     偽サーバ側で呼び出し回数をカウントし、到達不能（接続拒否）も再現する。
 *   - 上流 Ollama は 127.0.0.1:11434（実 Ollama が居ればそれ、居なければ偽を立てる）。
 *
 * 拒否理由コード（deny:ratelimit / deny:ghcap / deny:ghdown）は HTTP ボディには出ず
 * アクセスログ（rehearsal/proxy.log）にのみ出るため、追記分を読んで確認する。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { once } from 'node:events';

const { startServer } = await import('../rehearsal/proxy.mjs');

const LOG_URL = new URL('../rehearsal/proxy.log', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const OWNER_ID = 97923717; // 組み込み既定 allowlist の id（BUILTIN_ALLOWLIST）
const GOOD_TOKEN = 'ghp_' + 'A'.repeat(36); // well-shaped。偽 GitHub がオーナー id を返す

// ghp_ ＋ classic PAT と同じ文字数・文字集合の「ランダムだが well-shaped」なトークン。
// （`garbage` のような自明な非トークンではない = 形状プレフィルタを通過する）
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function b62(buf) {
  let s = '';
  for (const x of buf) s += B62[x % 62];
  return s;
}
function randTok(i) {
  const buf = crypto.createHash('sha512').update('susumai-integration-tok-' + i).digest();
  return i % 2 === 0 ? 'ghp_' + b62(buf).slice(0, 36) : buf.toString('hex').slice(0, 40);
}

// --- 偽 GitHub サーバ ---------------------------------------------------
const ghState = { calls: 0, mode: 'ok' }; // mode: 'ok' | '401'
let ghServer = null;
let ghTarget = { host: '127.0.0.1', port: 0 };

function ghHandler(req, res) {
  ghState.calls++;
  if (ghState.mode === '401') {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"message":"Bad credentials"}');
    return;
  }
  const tok = String(req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
  const body = tok === GOOD_TOKEN ? { id: OWNER_ID, login: 'sGvQs' } : { id: 1, login: 'stranger' };
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function fakeGitHubUp() {
  if (!(ghServer && ghServer.listening)) {
    ghServer = http.createServer(ghHandler);
    await new Promise((res, rej) => {
      ghServer.once('error', rej);
      ghServer.listen(0, '127.0.0.1', res);
    });
    ghTarget = { host: '127.0.0.1', port: ghServer.address().port };
  }
  ghState.calls = 0;
  ghState.mode = 'ok';
}
async function fakeGitHubDown() {
  if (ghServer && ghServer.listening) {
    await new Promise((r) => ghServer.close(r));
    ghServer.closeAllConnections?.();
  }
  // ghTarget は落ちたポートを指したまま → 接続拒否（ECONNREFUSED）
}

// --- https.request 差し替え（api.github.com 宛だけ偽サーバへ）-----------
let realHttpsRequest = null;
function ghOverride(a, b, c) {
  const urlStr = typeof a === 'string' ? a : (a && a.href) || '';
  if (!urlStr.includes('api.github.com')) return realHttpsRequest.call(https, a, b, c);
  const options = typeof b === 'function' ? {} : b || {};
  const cb = typeof b === 'function' ? b : c;
  return http.request(
    {
      host: ghTarget.host,
      port: ghTarget.port,
      method: options.method || 'GET',
      path: '/user',
      headers: options.headers || {},
      timeout: options.timeout,
    },
    cb,
  );
}

// --- 上流 Ollama（11434 が空いていれば偽を立てる。実 Ollama が居れば任せる）---
let fakeOllama = null;
function ensureUpstream() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'deepseek-r1:8b', model: 'deepseek-r1:8b' }] }));
    });
    s.once('error', () => resolve(null)); // EADDRINUSE = 実 Ollama 等が居る
    s.listen(11434, '127.0.0.1', () => resolve(s));
  });
}

// --- proxy 起動制御（サブテストごとにフレッシュな in-memory 状態にする）---
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'susumai-int-'));
const ALLOWLIST_FILE = path.join(tmpDir, 'allowlist.json');
const BASE_ENV = {
  SUSUMAI_ALLOWLIST: ALLOWLIST_FILE,
  SUSUMAI_RL_CAPACITY: '3',
  SUSUMAI_RL_REFILL_PER_MIN: '1', // テスト実行中に実質補充されない
  SUSUMAI_GH_HOURLY_CAP: '5',
  SUSUMAI_POS_CACHE_TTL_SEC: '3600',
  SUSUMAI_NEG_CACHE_TTL_SEC: '120',
  SUSUMAI_GH_TIMEOUT_MS: '1500',
  SUSUMAI_GH_BACKOFF_MS: '1',
};

let proxy = null;
let proxyPort = 0;
async function closeProxy() {
  if (!proxy) return;
  const p = proxy;
  proxy = null;
  proxyPort = 0;
  await new Promise((r) => {
    p.close(r);
    p.closeAllConnections?.();
  });
}
async function freshProxy(extra = {}) {
  await closeProxy();
  // port:0 = OS 割り当ての空きポート。:8787 を握った本番/rehearse proxy と衝突しない。
  proxy = startServer({ env: { ...BASE_ENV, ...extra }, port: 0 });
  if (!proxy.listening) await once(proxy, 'listening');
  proxyPort = proxy.address().port;
}

function reqProxy(method, pathname, { token, ip } = {}) {
  return new Promise((resolve, reject) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (ip) headers['cf-connecting-ip'] = ip;
    const url = `http://127.0.0.1:${proxyPort}${pathname}`;
    const r = http.request(url, { method, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    r.on('error', reject);
    r.end();
  });
}

// --- アクセスログ（追記分だけ読む）------------------------------------
function logSize() {
  try {
    return fs.statSync(LOG_URL).size;
  } catch {
    return 0;
  }
}
function readLogFrom(off) {
  try {
    const fd = fs.openSync(LOG_URL, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.max(0, size - off);
      const buf = Buffer.alloc(len);
      if (len) fs.readSync(fd, buf, 0, len, off);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}
async function assertLogHas(sinceOffset, needles, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  let seen = '';
  while (Date.now() < deadline) {
    seen = readLogFrom(sinceOffset);
    if (needles.every((n) => seen.includes(n))) return;
    await sleep(40);
  }
  assert.fail(`アクセスログに ${needles.join(' / ')} が現れませんでした。追記分:\n${seen}`);
}

before(async () => {
  process.setMaxListeners(50);
  // proxy は port:0 で起動するので :8787 の占有チェックは不要（衝突しない）。
  fs.writeFileSync(ALLOWLIST_FILE, '[]\n'); // 組み込み既定（オーナー1人）だけで十分
  realHttpsRequest = https.request;
  https.request = ghOverride;
  await fakeGitHubUp();
  fakeOllama = await ensureUpstream();
});

after(async () => {
  if (realHttpsRequest) https.request = realHttpsRequest;
  await closeProxy();
  if (ghServer && ghServer.listening) await new Promise((r) => ghServer.close(r));
  if (fakeOllama) await new Promise((r) => fakeOllama.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// (c) 公開耐性
// ============================================================================

test('(c) 同一 CF-Connecting-IP で well-shaped トークンを連打 → per-IP 上限で 429 deny:ratelimit', async () => {
  await fakeGitHubUp();
  await freshProxy();
  const ip = '198.51.100.10';
  const off = logSize();
  const res = [];
  for (let i = 0; i < 4; i++) res.push(await reqProxy('GET', '/api/tags', { token: randTok(i), ip }));

  // RL_CAPACITY=3 → 最初の3件は偽 GitHub まで到達（許可外 id=1 → 403）
  for (let i = 0; i < 3; i++) {
    assert.equal(res[i].status, 403, `req ${i} は 403 のはず: ${JSON.stringify(res[i])}`);
  }
  // 4件目はレート上限で弾かれる（偽 GitHub まで到達しない）
  assert.equal(res[3].status, 429, `req 3: ${JSON.stringify(res[3])}`);
  assert.match(res[3].body, /rate limited/);
  assert.equal(ghState.calls, 3, `偽 GitHub 呼び出しは 3 のはず（実際 ${ghState.calls}）`);
  await assertLogHas(off, ['deny=deny:ratelimit']);
});

test('(c) ローリング1時間グローバル上限到達後 → 未キャッシュは 503 deny:ghcap、偽 GitHub へのアウトバウンドが増えない', async () => {
  await fakeGitHubUp();
  await freshProxy();
  const off = logSize();
  const res = [];
  // IP を分散させて per-IP 上限は踏まない。GH_HOURLY_CAP=5。
  for (let i = 0; i < 8; i++) {
    res.push(await reqProxy('GET', '/api/tags', { token: randTok(100 + i), ip: `10.10.0.${i + 1}` }));
  }
  assert.equal(ghState.calls, 5, `偽 GitHub 呼び出しは 5 で頭打ちのはず（実際 ${ghState.calls}）`);
  for (let i = 0; i < 5; i++) assert.equal(res[i].status, 403, `req ${i}: ${JSON.stringify(res[i])}`);
  for (let i = 5; i < 8; i++) {
    assert.equal(res[i].status, 503, `req ${i}: ${JSON.stringify(res[i])}`);
    assert.match(res[i].body, /hourly cap/);
  }
  await assertLogHas(off, ['deny=deny:ghcap']);

  // 上限到達後にさらに叩いてもアウトバウンドは増えない
  const callsAtCap = ghState.calls;
  await reqProxy('GET', '/api/tags', { token: randTok(200), ip: '10.10.9.9' });
  assert.equal(ghState.calls, callsAtCap, 'グローバル上限中は api.github.com を叩かない');
});

test('(c) 正キャッシュ済みの正トークンは、グローバル上限超過中でも 200 のまま（アウトバウンドを誘発しない）', async () => {
  await fakeGitHubUp();
  await freshProxy();

  // 1) 正トークンで一度通す → identity が正キャッシュに載る
  const primed = await reqProxy('GET', '/api/tags', { token: GOOD_TOKEN, ip: '172.16.0.1' });
  assert.equal(primed.status, 200, `prime: ${JSON.stringify(primed)}`);
  assert.equal(ghState.calls, 1);

  // 2) ランダムトークンでグローバル上限（5）を使い切る（good 1 + 4 = 5）
  for (let i = 0; i < 8; i++) {
    await reqProxy('GET', '/api/tags', { token: randTok(300 + i), ip: `172.16.1.${i + 1}` });
  }
  assert.equal(ghState.calls, 5, `実際 ${ghState.calls}`);
  const callsAfterCap = ghState.calls;

  // 3) 正トークンは上限超過中でも 200（正キャッシュ経由。GitHub を叩かない）
  const again = await reqProxy('GET', '/api/tags', { token: GOOD_TOKEN, ip: '172.16.0.1' });
  assert.equal(again.status, 200, `cached-during-cap: ${JSON.stringify(again)}`);
  assert.equal(ghState.calls, callsAfterCap, 'キャッシュヒットなのでアウトバウンドは増えない');

  // 4) 未キャッシュの新規トークンは 503 deny:ghcap
  const miss = await reqProxy('GET', '/api/tags', { token: randTok(999), ip: '172.16.9.9' });
  assert.equal(miss.status, 503, `miss: ${JSON.stringify(miss)}`);
  assert.match(miss.body, /hourly cap/);
});

// ============================================================================
// (d) 障害注入
// ============================================================================

test('(d) 偽 GitHub 到達不能 → 未キャッシュは 503 deny:ghdown（401 を返さない・正キャッシュに載せない）', async () => {
  await fakeGitHubUp();
  await freshProxy();
  await fakeGitHubDown();
  const off = logSize();
  const tok = randTok(500);

  const r1 = await reqProxy('GET', '/api/tags', { token: tok, ip: '192.0.2.5' });
  assert.equal(r1.status, 503, `r1: ${JSON.stringify(r1)}`);
  assert.match(r1.body, /unreachable/);
  assert.notEqual(r1.status, 401, '到達不能を 401 にしない');
  await assertLogHas(off, ['deny=deny:ghdown']);

  // 同じトークンをもう一度 → 依然 503（正キャッシュにも負キャッシュにも載っていない）
  const r2 = await reqProxy('GET', '/api/tags', { token: tok, ip: '192.0.2.5' });
  assert.equal(r2.status, 503, `r2: ${JSON.stringify(r2)}`);
  assert.match(r2.body, /unreachable/);
});

test('(d) 偽 GitHub 到達不能でも、正キャッシュ済みユーザーは 200 で通る', async () => {
  await fakeGitHubUp();
  await freshProxy();

  const primed = await reqProxy('GET', '/api/tags', { token: GOOD_TOKEN, ip: '192.0.2.20' });
  assert.equal(primed.status, 200, `prime: ${JSON.stringify(primed)}`);
  const calls1 = ghState.calls;

  await fakeGitHubDown();

  const cached = await reqProxy('GET', '/api/tags', { token: GOOD_TOKEN, ip: '192.0.2.20' });
  assert.equal(cached.status, 200, `outage-cached: ${JSON.stringify(cached)}`);
  assert.equal(ghState.calls, calls1, '障害中でもキャッシュヒットならアウトバウンドしない');

  const miss = await reqProxy('GET', '/api/tags', { token: randTok(600), ip: '192.0.2.21' });
  assert.equal(miss.status, 503, `miss: ${JSON.stringify(miss)}`);
  assert.match(miss.body, /unreachable/);
});

test('(d) 到達不能(503 deny:ghdown) と 本物の認証失敗(401) が区別されている', async () => {
  await fakeGitHubUp();
  await freshProxy();

  // A: 偽 GitHub が 401 を返す = 本物の認証失敗 → proxy も 401
  ghState.mode = '401';
  const a = await reqProxy('GET', '/api/tags', { token: randTok(700), ip: '203.0.113.70' });
  assert.equal(a.status, 401, `A: ${JSON.stringify(a)}`);

  // B: 偽 GitHub 到達不能 → proxy は 503 deny:ghdown（401 ではない）
  ghState.mode = 'ok';
  await fakeGitHubDown();
  const off = logSize();
  const b = await reqProxy('GET', '/api/tags', { token: randTok(701), ip: '203.0.113.71' });
  assert.equal(b.status, 503, `B: ${JSON.stringify(b)}`);
  assert.match(b.body, /unreachable/);
  assert.notEqual(b.status, 401);
  await assertLogHas(off, ['deny=deny:ghdown']);
});
