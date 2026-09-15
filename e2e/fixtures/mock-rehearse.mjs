// e2e/fixtures/mock-rehearse.mjs — `npm run rehearse`（rehearsal/rehearse.mjs）の
// 代わりに使う、数秒で完了する偽の rehearse コマンド。本物の rehearsal/rehearse.mjs
// は一切呼び出さない。dashboard.mjs から SUSUMAI_DASHBOARD_REHEARSE_CMD 経由での
// み起動される想定（Playwright e2e テスト専用）。
console.log('[mock-rehearse] phase 1: ok');
console.log('[mock-rehearse] phase 2: ok');
setTimeout(() => {
  console.log('[mock-rehearse] done');
  process.exit(0);
}, 300);
