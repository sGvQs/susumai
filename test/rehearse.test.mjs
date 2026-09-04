import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractTunnelUrl,
  TRYCLOUDFLARE_URL_RE,
  elapsedBelowThreshold,
  judgeDeadTunnel,
  classifyProxyListener,
  classifyProxyAuth,
  classifyProxyAllowlist,
  decideProxyReuse,
  isPort8787TunnelCmd,
  tagsHasModel,
} from '../rehearsal/rehearse.mjs';

// --- trycloudflare URL 抽出 -------------------------------------------------

test('extractTunnelUrl: 行中のヒットを取り出す', () => {
  const line = '2026-09-04T00:00:00Z INF |  https://uni-connections-share-circus.trycloudflare.com  |';
  assert.equal(extractTunnelUrl(line), 'https://uni-connections-share-circus.trycloudflare.com');
});

test('extractTunnelUrl: 非ヒットは null', () => {
  assert.equal(extractTunnelUrl('INF Registered tunnel connection'), null);
  assert.equal(extractTunnelUrl('https://example.com/foo'), null);
  assert.equal(extractTunnelUrl(''), null);
  assert.equal(extractTunnelUrl(undefined), null);
});

test('extractTunnelUrl: 複数行から最初のヒットを返す', () => {
  const text = [
    'noise line',
    'first  https://aaa-bbb-ccc.trycloudflare.com  here',
    'second https://ddd-eee-fff.trycloudflare.com  here',
  ].join('\n');
  assert.equal(extractTunnelUrl(text), 'https://aaa-bbb-ccc.trycloudflare.com');
});

test('TRYCLOUDFLARE_URL_RE は大文字サブドメインを弾く', () => {
  assert.equal(TRYCLOUDFLARE_URL_RE.test('https://Foo.trycloudflare.com'), false);
  assert.equal(TRYCLOUDFLARE_URL_RE.test('https://foo-1.trycloudflare.com'), true);
});

// --- 死んだトンネル検証の閾値判定 -----------------------------------------

test('elapsedBelowThreshold: 未満のみ true', () => {
  assert.equal(elapsedBelowThreshold(100, 240_000), true);
  assert.equal(elapsedBelowThreshold(240_000, 240_000), false);
  assert.equal(elapsedBelowThreshold(300_000, 240_000), false);
  assert.equal(elapsedBelowThreshold(NaN, 240_000), false);
  assert.equal(elapsedBelowThreshold(100, Infinity), false);
});

test('judgeDeadTunnel: 高速失敗は合格', () => {
  const r = judgeDeadTunnel({ exitCode: 1, elapsedMs: 120, thresholdMs: 240_000 });
  assert.equal(r.pass, true);
});

test('judgeDeadTunnel: exit 0（到達不能なのに成功）は不合格', () => {
  const r = judgeDeadTunnel({ exitCode: 0, elapsedMs: 120, thresholdMs: 240_000 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /exit 0/);
});

test('judgeDeadTunnel: 閾値以上かかったら不合格', () => {
  const r = judgeDeadTunnel({ exitCode: 1, elapsedMs: 245_000, thresholdMs: 240_000 });
  assert.equal(r.pass, false);
  assert.match(r.reason, /閾値/);
});

test('judgeDeadTunnel: タイムアウト（elapsedMs 非有限）は不合格', () => {
  const r = judgeDeadTunnel({ exitCode: null, elapsedMs: NaN, thresholdMs: 240_000 });
  assert.equal(r.pass, false);
});

// --- proxy 3段チェーン（ステータス → 判定 の写像）------------------------

test('classifyProxyListener: proxy.mjs を含めば ok', () => {
  assert.equal(
    classifyProxyListener('/opt/homebrew/.../node /Users/x/susumai/rehearsal/proxy.mjs').ok,
    true,
  );
});

test('classifyProxyListener: 別プロセスは halt', () => {
  const r = classifyProxyListener('nginx: master process /usr/sbin/nginx');
  assert.equal(r.ok, false);
  assert.equal(r.halt, true);
});

test('classifyProxyListener: 空は halt', () => {
  assert.equal(classifyProxyListener('').ok, false);
  assert.equal(classifyProxyListener(null).ok, false);
});

test('classifyProxyAuth: 200 かつ token あり → ok', () => {
  assert.equal(classifyProxyAuth(200, true).ok, true);
});

test('classifyProxyAuth: token 無し → halt（トークン不明）', () => {
  const r = classifyProxyAuth(200, false);
  assert.equal(r.ok, false);
  assert.match(r.reason, /トークンが不明/);
});

test('classifyProxyAuth: 401 と 5xx はメッセージを分ける', () => {
  const a = classifyProxyAuth(401, true);
  const b = classifyProxyAuth(502, true);
  assert.equal(a.ok, false);
  assert.equal(b.ok, false);
  assert.match(a.reason, /401/);
  assert.match(b.reason, /上流 Ollama/);
  assert.notEqual(a.reason, b.reason);
});

test('classifyProxyAuth: 予期しないステータス（2xx/3xx/4xx 他）は halt', () => {
  for (const s of [204, 302, 418, 429, null]) {
    const r = classifyProxyAuth(s, true);
    assert.equal(r.ok, false, `status=${s}`);
    assert.equal(r.halt, true, `status=${s}`);
    assert.match(r.reason, /予期しない/);
  }
});

test('classifyProxyAllowlist: 403 のみ ok', () => {
  assert.equal(classifyProxyAllowlist(403).ok, true);
  assert.equal(classifyProxyAllowlist(200).ok, false);
  assert.equal(classifyProxyAllowlist(404).ok, false);
});

test('decideProxyReuse: 3段成立で reuse', () => {
  const r = decideProxyReuse({
    listenerPsCommand: 'node /x/susumai/rehearsal/proxy.mjs',
    hasToken: true,
    tagsStatus: 200,
    pullStatus: 403,
  });
  assert.equal(r.action, 'reuse');
  assert.equal(r.step, 3);
});

test('decideProxyReuse: 第1段で落ちる', () => {
  const r = decideProxyReuse({
    listenerPsCommand: 'some-other-server',
    hasToken: true,
    tagsStatus: 200,
    pullStatus: 403,
  });
  assert.equal(r.action, 'halt');
  assert.equal(r.step, 1);
});

test('decideProxyReuse: 第2段で落ちる（401）', () => {
  const r = decideProxyReuse({
    listenerPsCommand: 'node /x/rehearsal/proxy.mjs',
    hasToken: true,
    tagsStatus: 401,
    pullStatus: null,
  });
  assert.equal(r.action, 'halt');
  assert.equal(r.step, 2);
});

test('decideProxyReuse: 第3段で落ちる（pull が遮断されていない）', () => {
  const r = decideProxyReuse({
    listenerPsCommand: 'node /x/rehearsal/proxy.mjs',
    hasToken: true,
    tagsStatus: 200,
    pullStatus: 200,
  });
  assert.equal(r.action, 'halt');
  assert.equal(r.step, 3);
});

// --- cloudflared コマンドライン判定 --------------------------------------

test('isPort8787TunnelCmd: :8787 トンネルだけ true', () => {
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel --url http://localhost:8787'), true);
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel --url http://127.0.0.1:8787'), true);
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel --url localhost:8787/path'), true);
  // ポート番号の部分一致で誤爆しない
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel --url http://localhost:87870'), false);
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel --url http://127.0.0.1:87870'), false);
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel --url http://127.0.0.1:88787'), false);
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel --url http://localhost:9999'), false);
  assert.equal(isPort8787TunnelCmd('cloudflared tunnel run my-prod-tunnel'), false);
  assert.equal(isPort8787TunnelCmd(undefined), false);
});

// --- /api/tags 形状チェック --------------------------------------------

test('tagsHasModel: name / model どちらの一致も拾う', () => {
  assert.equal(tagsHasModel({ models: [{ name: 'deepseek-r1:8b' }] }, 'deepseek-r1:8b'), true);
  assert.equal(tagsHasModel({ models: [{ model: 'deepseek-r1:8b' }] }, 'deepseek-r1:8b'), true);
  assert.equal(tagsHasModel({ models: [{ name: 'llama3:8b' }] }, 'deepseek-r1:8b'), false);
  assert.equal(tagsHasModel(null, 'deepseek-r1:8b'), false);
  assert.equal(tagsHasModel({ models: 'nope' }, 'deepseek-r1:8b'), false);
});
