/*
 * susumai 本番 proxy シム（段階3 / identity 分離）
 * ============================================================================
 * 役割:
 *   launchd から起動される本番 proxy のエントリポイント。単一ソースである
 *   ../rehearsal/proxy.mjs の startServer() を **dynamic import** で呼ぶだけの数行の
 *   シム。ロジックはここに一切持たない。
 *
 * なぜシムを挟むか（rehearse からの identity 分離）:
 *   launchd の ProgramArguments は [<node>, <repo>/ops/proxy-prod.mjs] になる。
 *   → `ps -o command=` に出るのは `ops/proxy-prod.mjs` だけで、`rehearsal/proxy.mjs`
 *     は出ない（dynamic import した子モジュールのパスは argv に出ない）。
 *   → rehearse の `classifyProxyListener`（`cmd.includes('rehearsal/proxy.mjs')`）と
 *     RUNBOOK の `pkill -f "rehearsal/proxy.mjs"` が本番プロセスにヒットしない。
 *   rehearse 除外の拠り所はこのファイルパス。process.title は belt-and-suspenders。
 *
 * env（launchd の EnvironmentVariables で渡す。plist テンプレート参照）:
 *   SUSUMAI_PROXY_LOG   必須。本番アクセスログの出力先パス。未設定ならこのシムが
 *                       起動を拒否する（本番ログを rehearsal/proxy.log に混ぜない保証）。
 *   SUSUMAI_ALLOWLIST   GitHub アカウント許可リスト JSON のパス（github モード有効化）。
 *   SUSUMAI_PROD=1      このシムが自前で立てる（呼び出し側で設定不要）。
 *   SUSUMAI_TOKEN       **渡さない。** 本番は github モードのみ。渡すと proxy.mjs 側の
 *                       buildConfig が ConfigError で起動を拒否する。
 * ============================================================================
 */

// belt-and-suspenders: ps / pkill 上の識別子。rehearse 除外の一次拠り所はファイルパス。
process.title = 'susumai-proxy';

// 本番ログパスは環境非依存に決められない。plist で必ず渡す前提。未設定なら起動拒否。
if (!process.env.SUSUMAI_PROXY_LOG) {
  process.stderr.write(
    'FATAL: ops/proxy-prod.mjs は SUSUMAI_PROXY_LOG（本番アクセスログのパス）が必須です。\n' +
      '  launchd の EnvironmentVariables で渡してください。' +
      'rehearsal/proxy.log に本番ログを混ぜないための保証です。\n',
  );
  process.exit(1);
}

// 本番モードを宣言してから単一ソースを dynamic import で呼ぶ。
process.env.SUSUMAI_PROD = '1';

try {
  const { startServer } = await import('../rehearsal/proxy.mjs');
  startServer();
} catch (err) {
  // startServer は ConfigError を自前で exit(1) に変換する。ここに来るのは import 失敗や
  // 想定外の同期例外のみ（fail-closed フォールバック）。
  process.stderr.write(`FATAL: ${err && err.message ? err.message : err}\n`);
  process.exit(1);
}
