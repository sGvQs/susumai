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
  tunnelPollDelayMs,
  isTunnelFatalStatus,
  classifyTunnelProbe,
  shouldRestartCloudflared,
  classifyGivenCloudflaredIdentity,
  describeTunnelProbe,
  isPerRunCloudflaredLog,
  dnsFailureHint,
  shouldTryPublicDns,
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

// --- トンネル検証のバックオフ・応答分類 --------------------------------

test('tunnelPollDelayMs: 最初の30秒は2s、その後5s', () => {
  assert.equal(tunnelPollDelayMs(0), 2000);
  assert.equal(tunnelPollDelayMs(29_999), 2000);
  assert.equal(tunnelPollDelayMs(30_000), 5000);
  assert.equal(tunnelPollDelayMs(120_000), 5000);
});

test('isTunnelFatalStatus: 401 のみ即打ち切り', () => {
  assert.equal(isTunnelFatalStatus(401), true);
  assert.equal(isTunnelFatalStatus(200), false);
  assert.equal(isTunnelFatalStatus(403), false);
  assert.equal(isTunnelFatalStatus(502), false);
  assert.equal(isTunnelFatalStatus(null), false);
});

test('classifyTunnelProbe: shaped は SUCCESS（status を問わず優先）', () => {
  assert.equal(classifyTunnelProbe({ status: 200, shaped: true }), 'SUCCESS');
  assert.equal(classifyTunnelProbe({ status: null, shaped: true }), 'SUCCESS');
});

test('classifyTunnelProbe: 401 は shaped でなければ FATAL', () => {
  assert.equal(classifyTunnelProbe({ status: 401, shaped: false }), 'FATAL');
});

test('classifyTunnelProbe: 5xx は特別扱いせず PENDING（伝播成立と断定しない）', () => {
  assert.equal(classifyTunnelProbe({ status: 502, shaped: false }), 'PENDING');
  assert.equal(classifyTunnelProbe({ status: 503, shaped: false }), 'PENDING');
  assert.equal(classifyTunnelProbe({ status: 504, shaped: false }), 'PENDING');
});

test('classifyTunnelProbe: DNS 失敗（status なし）・その他 4xx も PENDING', () => {
  assert.equal(classifyTunnelProbe({ status: null, shaped: false }), 'PENDING');
  assert.equal(classifyTunnelProbe({ status: 404, shaped: false }), 'PENDING');
  assert.equal(classifyTunnelProbe({ status: 403, shaped: false }), 'PENDING');
});

test('shouldRestartCloudflared: PENDING かつ canAutoRestart かつ STALL 到達かつ上限未満で true', () => {
  assert.equal(
    shouldRestartCloudflared({
      classification: 'PENDING',
      attemptElapsedMs: 50_000,
      stallMs: 50_000,
      restartCount: 0,
      maxRestarts: 2,
      canAutoRestart: true,
    }),
    true,
  );
});

test('shouldRestartCloudflared: SUCCESS/FATAL は false（分類が PENDING でなければ再起動しない）', () => {
  const base = {
    attemptElapsedMs: 60_000,
    stallMs: 50_000,
    restartCount: 0,
    maxRestarts: 2,
    canAutoRestart: true,
  };
  assert.equal(shouldRestartCloudflared({ ...base, classification: 'SUCCESS' }), false);
  assert.equal(shouldRestartCloudflared({ ...base, classification: 'FATAL' }), false);
});

test('shouldRestartCloudflared: canAutoRestart=false は false（given 再利用中は自動再起動しない）', () => {
  assert.equal(
    shouldRestartCloudflared({
      classification: 'PENDING',
      attemptElapsedMs: 60_000,
      stallMs: 50_000,
      restartCount: 0,
      maxRestarts: 2,
      canAutoRestart: false,
    }),
    false,
  );
});

test('shouldRestartCloudflared: STALL 未到達・非有限は false', () => {
  const base = {
    classification: 'PENDING',
    stallMs: 50_000,
    restartCount: 0,
    maxRestarts: 2,
    canAutoRestart: true,
  };
  assert.equal(shouldRestartCloudflared({ ...base, attemptElapsedMs: 49_999 }), false);
  assert.equal(shouldRestartCloudflared({ ...base, attemptElapsedMs: NaN }), false);
});

test('shouldRestartCloudflared: restartCount が maxRestarts 以上なら false（再起動上限）', () => {
  const base = {
    classification: 'PENDING',
    attemptElapsedMs: 60_000,
    stallMs: 50_000,
    maxRestarts: 2,
    canAutoRestart: true,
  };
  assert.equal(shouldRestartCloudflared({ ...base, restartCount: 2 }), false);
  assert.equal(shouldRestartCloudflared({ ...base, restartCount: 3 }), false);
  assert.equal(shouldRestartCloudflared({ ...base, restartCount: 1 }), true);
});

test('describeTunnelProbe: fetch cause code → 文言', () => {
  assert.match(describeTunnelProbe({ errCode: 'ENOTFOUND' }), /ENOTFOUND.*DNS/);
  assert.match(describeTunnelProbe({ errCode: 'UND_ERR_HEADERS_TIMEOUT' }), /ヘッダ応答なし/);
  assert.match(describeTunnelProbe({ errCode: 'SOMETHING_NEW' }), /SOMETHING_NEW.*接続失敗/);
});

test('describeTunnelProbe: HTTP ステータス → 文言（+ 本文先頭）', () => {
  assert.match(describeTunnelProbe({ status: 502 }), /502.*上流待ち/);
  assert.match(describeTunnelProbe({ status: 401 }), /401.*トークン不一致/);
  const d200 = describeTunnelProbe({ status: 200, bodyPrefix: '<!DOCTYPE html>' });
  assert.match(d200, /200.*想定と異なる/);
  assert.match(d200, /<!DOCTYPE html>/);
  assert.equal(describeTunnelProbe({ status: 418 }), 'HTTP 418');
});

test('describeTunnelProbe: 情報なしは 不明', () => {
  assert.equal(describeTunnelProbe(), '不明');
  assert.equal(describeTunnelProbe({}), '不明');
});

test('isPerRunCloudflaredLog: cloudflared.<pid>.<ts>.log だけ true', () => {
  assert.equal(isPerRunCloudflaredLog('cloudflared.12345.1700000000000.log'), true);
  assert.equal(isPerRunCloudflaredLog('cloudflared.1.2.log'), true);
  // 共有ログ・別プロセスのログ・config は対象外
  assert.equal(isPerRunCloudflaredLog('cloudflared.log'), false);
  assert.equal(isPerRunCloudflaredLog('tunnel.log'), false);
  assert.equal(isPerRunCloudflaredLog('proxy.12345.1700000000000.log'), false);
  assert.equal(isPerRunCloudflaredLog('cloudflared.12345.1700000000000.log.bak'), false);
  assert.equal(isPerRunCloudflaredLog('config.json'), false);
});

// --- トンネル host の DNS 解決待ち（c-ares）の純関数 --------------------

test('dnsFailureHint: c-ares コード → 文言', () => {
  assert.match(dnsFailureHint('ENOTFOUND'), /ENOTFOUND.*未公開/);
  assert.match(dnsFailureHint('ENODATA'), /ENODATA.*未伝播/);
  assert.match(dnsFailureHint('ETIMEOUT'), /ETIMEOUT.*タイムアウト/);
  assert.match(dnsFailureHint('ESERVFAIL'), /SERVFAIL/);
  assert.match(dnsFailureHint('EREFUSED'), /ブロック網/);
  assert.match(dnsFailureHint('SOMETHING_NEW'), /SOMETHING_NEW.*DNS 解決失敗/);
});

test('shouldTryPublicDns: fallbackAfterMs 以上でのみ true', () => {
  assert.equal(shouldTryPublicDns(0, 20_000), false);
  assert.equal(shouldTryPublicDns(19_999, 20_000), false);
  assert.equal(shouldTryPublicDns(20_000, 20_000), true);
  assert.equal(shouldTryPublicDns(60_000, 20_000), true);
  assert.equal(shouldTryPublicDns(NaN, 20_000), false);
  assert.equal(shouldTryPublicDns(20_000, Infinity), false);
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

// --- given cloudflared の身元判定（乗っ取り前後の SIGTERM/SIGKILL 直前確認） ------------

test('classifyGivenCloudflaredIdentity: :8787 トンネルの cloudflared は ok', () => {
  const r = classifyGivenCloudflaredIdentity('cloudflared tunnel --url http://localhost:8787');
  assert.equal(r.ok, true);
});

test('classifyGivenCloudflaredIdentity: cloudflared でなければ ok=false', () => {
  const r = classifyGivenCloudflaredIdentity('nginx: master process /usr/sbin/nginx');
  assert.equal(r.ok, false);
  assert.match(r.reason, /cloudflared ではありません/);
});

test('classifyGivenCloudflaredIdentity: cloudflared だが :8787 以外は ok=false', () => {
  const r = classifyGivenCloudflaredIdentity('cloudflared tunnel run my-prod-tunnel');
  assert.equal(r.ok, false);
  assert.match(r.reason, /:8787 向けトンネルではありません/);
});

test('classifyGivenCloudflaredIdentity: 空/null は ok=false（プロセス消失想定）', () => {
  assert.equal(classifyGivenCloudflaredIdentity('').ok, false);
  assert.equal(classifyGivenCloudflaredIdentity(null).ok, false);
  assert.match(classifyGivenCloudflaredIdentity('').reason, /プロセス消失/);
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
