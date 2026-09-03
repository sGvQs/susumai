/*
 * susumai リハーサル用 allowlist プロキシ
 * ----------------------------------------------------------------------------
 * 役割:
 *   別PCから Cloudflare Tunnel 経由で Ollama (DeepSeek R1) にアクセスする際の
 *   前段ゲート。ローカルの Ollama (127.0.0.1:11434) を外部バインドせずに、
 *   このプロキシ (0.0.0.0 相当 / :8787) だけをトンネルへ晒す。
 *
 * allowlist (これ以外はパス・メソッド問わず 403 即返し):
 *   - POST /api/chat   … 推論ストリーミング
 *   - GET  /api/tags   … モデル一覧
 *   → /api/pull /api/delete /api/create /api/generate /api/copy /api/push 等の
 *     モデル改変・別系統エンドポイントはすべて 403 で遮断。
 *
 * トークンの渡し方:
 *   起動時に環境変数 SUSUMAI_TOKEN を必須とする（未設定なら stderr にエラーを
 *   出して exit(1)。フェイルクローズ）。
 *   全リクエストで `Authorization: Bearer <SUSUMAI_TOKEN>` を検証。
 *   欠落・不一致は 401。
 *   例: SUSUMAI_TOKEN=xxxxx node rehearsal/proxy.mjs
 *
 * 落とし方:
 *   フォアグラウンドなら Ctrl+C。バックグラウンドなら kill <pid>。
 *
 * 運用上の約束:
 *   - トンネル稼働中はこの端末を無人にしない。
 *   - セッション終了後は必ず cloudflared と本プロキシの両方を落とす。
 *   - Ollama は 127.0.0.1 のまま。OLLAMA_HOST=0.0.0.0 にはしない。
 * ----------------------------------------------------------------------------
 */

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';

const LISTEN_PORT = 8787;
const UPSTREAM_HOST = '127.0.0.1';
const UPSTREAM_PORT = 11434;

const TOKEN = process.env.SUSUMAI_TOKEN;
if (!TOKEN) {
  process.stderr.write(
    'FATAL: 環境変数 SUSUMAI_TOKEN が未設定です。起動を中止します (fail-closed)。\n' +
      '  例: SUSUMAI_TOKEN=<token> node rehearsal/proxy.mjs\n',
  );
  process.exit(1);
}

// Bearer 検証は非定数時間比較を避ける。両者を sha256 で固定長(32byte)ダイジェスト
// 化してから timingSafeEqual で比較する（長さ差での throw も、早期 return による
// タイミングリークも起きない）。スキーム名 "Bearer" は RFC 7235 に従い大小無視。
const EXPECTED_TOKEN_DIGEST = crypto.createHash('sha256').update(TOKEN, 'utf8').digest();

function bearerOk(authHeader) {
  const m = /^\s*bearer\s+(.+?)\s*$/i.exec(authHeader || '');
  if (!m) return false;
  const got = crypto.createHash('sha256').update(m[1], 'utf8').digest();
  return crypto.timingSafeEqual(got, EXPECTED_TOKEN_DIGEST);
}

// 最小限のアクセスログ（proxy.log へ追記）: `<ISO時刻> <method> <path> -> <status>`
const accessLog = fs.createWriteStream(new URL('./proxy.log', import.meta.url), { flags: 'a' });
accessLog.on('error', () => {}); // ログ書き込み失敗でプロセスを落とさない
function logAccess(method, path, status) {
  accessLog.write(`${new Date().toISOString()} ${method} ${path} -> ${status}\n`);
}

// allowlist: メソッド + 正確なパス（クエリは無視）
const ALLOWLIST = new Set(['POST /api/chat', 'GET /api/tags']);

function isAllowed(method, path) {
  return ALLOWLIST.has(`${method} ${path}`);
}

function deny(res, code, msg) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: msg }));
}

const server = http.createServer((req, res) => {
  const method = req.method || 'GET';
  const path = (req.url || '/').split('?')[0];

  // アクセスログは応答クローズ時に最終ステータスで 1 行。
  res.on('close', () => logAccess(method, path, res.statusCode));

  // クライアントの生 TCP リセット等で write が EPIPE/ECONNRESET/
  // ERR_STREAM_DESTROYED を投げても、未処理 error でプロセスを落とさない。
  req.on('error', () => {});
  res.on('error', () => {});

  // 1) Bearer 検証（allowlist 判定より先に。存在秘匿のため）
  if (!bearerOk(req.headers['authorization'])) {
    return deny(res, 401, 'unauthorized');
  }

  // 2) allowlist 判定
  if (!isAllowed(method, path)) {
    return deny(res, 403, 'forbidden: path/method not in allowlist');
  }

  // 3) 透過プロキシ
  const headers = { ...req.headers };
  headers.host = `${UPSTREAM_HOST}:${UPSTREAM_PORT}`;
  // プロキシで認証済み。上流(Ollama)へ秘密を伝播させない。
  delete headers.authorization;

  const upstreamReq = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method,
      path: req.url,
      headers,
    },
    (upstreamRes) => {
      // 上流のステータス・ヘッダをそのまま転送
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      // バッファせずそのまま pipe（ストリーミングを殺さない）
      upstreamRes.pipe(res);
      upstreamRes.on('error', () => res.destroy());
    },
  );

  upstreamReq.on('error', (err) => {
    if (!res.headersSent) deny(res, 502, `upstream error: ${err.code || 'unknown'}`);
    else res.destroy();
  });

  // 中断伝播: クライアントが「途中で」切断したときだけ上流を破棄する。
  //   - req 'close': ボディを最後まで受け取る前に閉じた = アップロード中断
  //   - res 'close': レスポンスを最後まで書き切る前に閉じた = ダウンロード中断
  // 正常完了(req.readableEnded / res.writableFinished)では destroy しない。
  // ※ Node は POST ボディを読み切った時点で req 'close' を発火させるため、
  //   無条件 destroy にすると /api/chat が即 ECONNRESET になる。
  req.on('close', () => {
    if (!req.readableEnded) upstreamReq.destroy();
  });
  res.on('close', () => {
    if (!res.writableFinished) upstreamReq.destroy();
  });

  // ボディがある時だけ pipe。GET 等の空ボディを chunked 化して上流(Go net/http)に
  // RST を食らわないよう、明示的に end する。
  if (req.headers['content-length'] || req.headers['transfer-encoding']) {
    req.pipe(upstreamReq);
  } else {
    upstreamReq.end();
  }
});

server.listen(LISTEN_PORT, () => {
  process.stdout.write(
    `listening on :${LISTEN_PORT} → ${UPSTREAM_HOST}:${UPSTREAM_PORT} ` +
      `(allowlist: POST /api/chat, GET /api/tags)\n`,
  );
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
