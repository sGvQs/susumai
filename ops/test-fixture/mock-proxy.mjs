/*
 * ops/test-fixture/mock-proxy.mjs — hosting.sh 検証用のモック proxy（本番とは無関係）。
 * ============================================================================
 * 目的:
 *   ops/hosting.sh を「本番の com.susumai.proxy / :8787 / llm.susumai.net」に一切
 *   触れずに検証するためのスタンドイン。依存なし（Node.js 標準ライブラリのみ）。
 *
 * 起動:
 *   MOCK_PROXY_PORT=18787 node ops/test-fixture/mock-proxy.mjs
 *
 * 挙動:
 *   - MOCK_PROXY_PORT（既定 18787）で HTTP サーバを起動する。
 *   - GET /api/tags には 401 を返す。本番 proxy の「到達OK=401」という健全性判定
 *     規約（ops/hosting.sh の health()）と一致させ、health() のロジックを一切
 *     変更せずにテストで通せるようにするため。
 *   - process.title を "mock-susumai-proxy" にする。本番の "susumai-proxy" とは
 *     文字列として別物にし、ps / pgrep 上で本番プロセスと誤認されないようにする。
 *   - SIGTERM / SIGINT を捕捉し、server.close() 完了後に process.exit(0) する
 *     （本番 rehearsal/proxy.mjs の既存シャットダウン挙動 [SIGINT/SIGTERM →
 *     server.close(() => process.exit(0))] を模す）。
 *   - MOCK_PROXY_SHUTDOWN_DELAY_MS（既定 0）でシャットダウンの実処理を意図的に
 *     遅延できる。hosting.sh の grace-timeout 超過 → 強制 kill 経路のテストに使う。
 * ============================================================================
 */

import http from 'node:http';

process.title = 'mock-susumai-proxy';

const PORT = Number(process.env.MOCK_PROXY_PORT || '18787');
const SHUTDOWN_DELAY_MS = Number(process.env.MOCK_PROXY_SHUTDOWN_DELAY_MS || '0');

const server = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized (mock-susumai-proxy)\n');
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found (mock-susumai-proxy)\n');
});

server.listen(PORT, () => {
  process.stdout.write(`[mock-susumai-proxy] listening on :${PORT} (pid=${process.pid})\n`);
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(
    `[mock-susumai-proxy] received ${signal}, shutting down (delay=${SHUTDOWN_DELAY_MS}ms)\n`,
  );
  const doClose = () => {
    server.close(() => process.exit(0));
  };
  if (SHUTDOWN_DELAY_MS > 0) {
    setTimeout(doClose, SHUTDOWN_DELAY_MS);
  } else {
    doClose();
  }
}

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => shutdown(sig));
}
